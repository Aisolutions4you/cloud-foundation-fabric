import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBusinessConfig } from '../src/config.js';
import { evaluate, missingRequired, outcome, prune, score, visibleSteps } from '../src/flow-engine.js';
import { estimate, monthlyPayment } from '../src/estimator.js';
import { heuristicExtract, numericOption } from '../src/agent.js';
import { sign, verify } from '../src/integrations/webhooks.js';
import { LLMRouter } from '../src/llm.js';

const { flow, pricing } = loadBusinessConfig();

test('condition DSL', () => {
  const a = { service: 'roofing', n: 5, tags: ['x', 'y'] };
  assert.ok(evaluate({ field: 'service', value: 'roofing' }, a));
  assert.ok(evaluate({ all: [{ field: 'n', op: 'gte', value: 5 }, { not: { field: 'service', value: 'hvac' } }] }, a));
  assert.ok(evaluate({ any: [{ field: 'n', op: 'lt', value: 1 }, { field: 'tags', op: 'in', value: ['y'] }] }, a));
  assert.ok(evaluate({ field: 'zip', op: 'empty' }, a));
  assert.ok(!evaluate({ field: 'n', op: 'between', value: [6, 9] }, a));
  assert.throws(() => evaluate({ field: 'n', op: 'nope', value: 1 }, a));
});

test('branching shows only relevant steps and prunes stale answers', () => {
  const roof = visibleSteps(flow, { service: 'roofing' }).map((s) => s.id);
  assert.ok(roof.includes('roof') && !roof.includes('hvac'));
  const hvac = visibleSteps(flow, { service: 'hvac', hvac_system: 'mini_split' });
  const hvacQs = hvac.find((s) => s.id === 'hvac').questions.map((q) => q.id);
  assert.deepEqual(hvacQs, ['hvac_system', 'hvac_zones']);
  const pruned = prune(flow, { service: 'hvac', roof_issue: 'leak', name: 'A' });
  assert.equal(pruned.roof_issue, undefined);
  assert.equal(pruned.name, 'A');
});

const ROOF = {
  service: 'roofing', name: 'Dana', roof_issue: 'full_replacement', roof_size: 'medium',
  roof_material: 'asphalt', stories: '2', property_type: 'single_family', owner: 'yes',
  zip: '78704', timeline: 'asap', budget: '10_25k', decision_maker: 'just_me',
  email: 'dana@example.com', phone: '512-555-0142',
};

test('scoring, required fields and outcomes', () => {
  assert.deepEqual(missingRequired(flow, ROOF), []);
  const s = score(flow, ROOF);
  assert.equal(s.tier, 'hot');
  assert.equal(outcome(flow, ROOF).action, 'estimate');
  assert.equal(outcome(flow, { ...ROOF, zip: '10001' }).action, 'disqualify');
  assert.equal(outcome(flow, { ...ROOF, property_type: 'commercial' }).action, 'book_call');
  assert.ok(missingRequired(flow, { ...ROOF, zip: 'banana' }).includes('zip'));
});

test('estimate math is deterministic and package-ordered', () => {
  const e = estimate(pricing, ROOF);
  assert.ok(e.ok);
  // tear-off 2600*1.25 + shingles 2600*4.25 + permit 450 = 14750; x1.1 two-story; x1.05 asap
  const base = 14750 * 1.1 * 1.05;
  assert.equal(e.packages[0].subtotal, Math.round(base * 100) / 100);
  assert.ok(e.packages[0].total < e.packages[1].total && e.packages[1].total < e.packages[2].total);
  assert.equal(e.recommended, 'preferred');
  assert.ok(e.range.low < e.packages[1].total && e.range.high > e.packages[1].total);
  assert.equal(estimate(pricing, { service: 'pools' }).ok, false);
  assert.equal(monthlyPayment(12000, { months: 12, apr: 0 }), 1000);
});

test('minimum job charge applies', () => {
  const e = estimate(pricing, { service: 'roofing', roof_issue: 'inspection', stories: '1' });
  assert.equal(e.packages[0].subtotal, 450);
});

test('heuristic extraction without an LLM', () => {
  const a = heuristicExtract(flow, "Hi I'm Sam, my AC died. sam@x.io 512 555 0100, zip 78701");
  assert.equal(a.service, 'hvac');
  assert.equal(a.name, 'Sam');
  assert.equal(a.email, 'sam@x.io');
  assert.equal(a.zip, '78701');
  assert.ok(a.phone);
  const size = flow.questions.find((q) => q.id === 'roof_size');
  assert.equal(numericOption(size, 'about 2,000 sq ft'), 'medium');
  assert.equal(numericOption(size, '4000'), 'xl');
  const budget = flow.questions.find((q) => q.id === 'budget');
  assert.equal(numericOption(budget, 'around $18k'), '10_25k');
  // "1,500" must not answer the stories question when it wasn't asked
  assert.equal(heuristicExtract(flow, 'about 1,500 sq ft', { service: 'roofing' }).stories, undefined);
});

test('webhook signatures', () => {
  const ts = Math.floor(Date.now() / 1000);
  const sig = sign('s3cret', ts, '{"a":1}');
  assert.ok(verify('s3cret', ts, '{"a":1}', sig));
  assert.ok(!verify('s3cret', ts, '{"a":2}', sig));
  assert.ok(!verify('s3cret', ts - 1000, '{"a":1}', sign('s3cret', ts - 1000, '{"a":1}')));
});

test('LLM router fails over between portable providers', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization, model: JSON.parse(init.body).model });
    if (url.startsWith('https://openrouter')) return new Response('rate limited', { status: 429 });
    return Response.json({ choices: [{ message: { content: '{"answers":{"service":"hvac"},"intent":"answer"}' } }] });
  };
  const llm = new LLMRouter({
    fetchImpl,
    providers: [
      { name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'or', model: 'x/y', headers: {} },
      { name: 'local', baseUrl: 'http://localhost:11434/v1/', apiKey: 'local', model: 'llama3.1:8b', headers: {} },
    ],
  });
  const r = await llm.chatJson([{ role: 'user', content: 'hi' }]);
  assert.equal(r.provider, 'local');
  assert.equal(r.data.answers.service, 'hvac');
  assert.equal(seen[1].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(llm.health.openrouter.ok, false);
  assert.equal(await new LLMRouter({ providers: [] }).chat([]), null);
});
