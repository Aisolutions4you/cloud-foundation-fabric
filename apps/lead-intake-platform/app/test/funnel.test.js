// End-to-end: chat -> lead -> estimate -> quote -> e-sign -> onboarding,
// with GoHighLevel and twin.so/webhook calls captured by a fake fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { loadBusinessConfig, settings as baseSettings } from '../src/config.js';
import { EventBus } from '../src/events.js';
import { GHLClient } from '../src/integrations/ghl.js';
import { WebhookFanout, sign } from '../src/integrations/webhooks.js';
import { LLMRouter } from '../src/llm.js';
import { Store } from '../src/store.js';

function fakeFetch(calls, { failFirstWebhook = false } = {}) {
  let failed = false;
  return async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), method: init.method, body, headers: init.headers });
    if (failFirstWebhook && String(url).includes('hooks.example') && !failed) {
      failed = true;
      return new Response('boom', { status: 502 });
    }
    if (String(url).endsWith('/contacts/upsert')) return Response.json({ contact: { id: 'c_1' } });
    if (String(url).endsWith('/opportunities/')) return Response.json({ opportunity: { id: 'o_1' } });
    return Response.json({ ok: true });
  };
}

async function boot(opts = {}) {
  const calls = [];
  const f = fakeFetch(calls, opts);
  const settings = {
    ...baseSettings,
    dataDir: mkdtempSync(join(tmpdir(), 'intake-')),
    adminToken: 'admintok',
    inboundWebhookSecret: 'inbound',
    publicBaseUrl: 'https://intake.example',
  };
  const store = new Store(settings.dataDir);
  const bus = new EventBus({
    store,
    log: { warn() {} },
    handlers: {
      ghl: new GHLClient({ apiKey: 'k', locationId: 'loc', pipelineId: 'p', stages: { new: 's1', qualified: 's2', quoted: 's3', won: 's4' }, baseUrl: 'https://ghl.example', version: '2021-07-28' }, f),
      webhooks: new WebhookFanout({ urls: ['https://hooks.example/n8n'], twinUrl: 'https://twin.example/hook', secret: 'sig' }, f),
    },
  });
  const llm = new LLMRouter({ providers: [] }); // rules-only mode
  const server = createServer(createApp({ store, biz: loadBusinessConfig(), llm, bus, settings }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  return { server, call, calls, store, bus };
}

test('full funnel via chat', async () => {
  const { server, call, calls, store } = await boot();
  try {
    let sessionId;
    let last;
    const say = async (message) => {
      const r = await call('/api/chat', { sessionId, message });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      sessionId = r.data.sessionId;
      last = r.data;
      return r.data;
    };
    await say('I need a new roof');
    await say("I'm Dana");
    await say('Full replacement');
    await say('1,500 - 2,500');
    await say('metal');
    await say('2');
    await say('house');
    await say('yes');
    await say('78704');
    await say('asap');
    await say('$10k–$25k');
    await say('just me');
    await say('dana@example.com');
    assert.ok(last.leadId, 'lead created once email captured');
    await say('512-555-0142');
    assert.ok(last.complete && last.estimate, JSON.stringify(last));
    assert.equal(last.score.tier, 'hot');

    const lead = store.get('leads', last.leadId);
    assert.equal(lead.stage, 'estimated');
    assert.deepEqual(lead.emitted, ['lead.created', 'lead.qualified', 'estimate.ready']);

    // "yes" after seeing the estimate locks a quote straight from chat
    const q = (await say('yes, lock it in')).quote;
    assert.ok(q && q.number.startsWith('Q-'));
    assert.equal(q.package.id, 'preferred');
    const again = await say('yes');
    assert.equal(again.quote.id, q.id, 'no duplicate quotes');

    const bad = await call(`/api/quotes/${q.id}/accept`, { signature: '', agree: true });
    assert.equal(bad.status, 400);
    const acc = await call(`/api/quotes/${q.id}/accept`, { signature: 'Dana Smith', agree: true });
    assert.equal(acc.status, 200);
    const ob = acc.data.onboarding;
    assert.ok(ob.tasks.find((t) => t.id === 'hoa'), 'roofing-specific task');
    assert.ok(!ob.tasks.find((t) => t.id === 'insurance_docs'), 'conditional task hidden (no claim)');

    // client completes a task; team-only task is rejected from the portal
    const miss = await call(`/api/onboarding/${ob.id}/tasks/site_access`, { data: {} });
    assert.equal(miss.status, 422);
    const ok = await call(`/api/onboarding/${ob.id}/tasks/site_access`, { data: { preferred_days: 'Mon-Wed', contact_method: 'Text' } });
    assert.equal(ok.data.progress.done, 1);
    assert.equal((await call(`/api/onboarding/${ob.id}/tasks/materials`, { data: {} })).status, 422);

    // automation (e.g. twin.so agent / GHL workflow) closes a team task via signed inbound webhook
    const raw = JSON.stringify({ type: 'onboarding.task_complete', onboardingId: ob.id, taskId: 'materials' });
    const ts = Math.floor(Date.now() / 1000);
    assert.equal((await call('/api/webhooks/inbound', raw, { 'X-Timestamp': String(ts), 'X-Signature': 'nope' })).status, 401);
    assert.equal((await call('/api/webhooks/inbound', raw, { 'X-Timestamp': String(ts), 'X-Signature': sign('inbound', ts, raw) })).status, 200);

    // integrations fired
    const ghlUpserts = calls.filter((c) => c.url.endsWith('/contacts/upsert'));
    assert.ok(ghlUpserts.length >= 4);
    assert.equal(ghlUpserts[0].headers.Version, '2021-07-28');
    assert.ok(ghlUpserts[0].body.tags.includes('ai-intake'));
    assert.ok(calls.some((c) => c.url.includes('/opportunities/o_1') && c.body.pipelineStageId === 's4'), 'moved to won');
    const twin = calls.filter((c) => c.url === 'https://twin.example/hook').map((c) => c.body.type);
    assert.deepEqual(twin.slice(0, 5), ['lead.created', 'lead.qualified', 'estimate.ready', 'quote.sent', 'quote.accepted']);
    assert.ok(calls.find((c) => c.url === 'https://twin.example/hook').headers['X-Signature']);

    const m = await call('/api/admin/metrics', null, { Authorization: 'Bearer admintok' });
    assert.equal(m.data.funnel.won, 1);
    assert.equal((await call('/api/admin/metrics')).status, 401);
  } finally {
    server.close();
  }
});

test('survey path, disqualification and outbox retry', async () => {
  const { server, call, store, bus } = await boot({ failFirstWebhook: true });
  try {
    const answers = {
      service: 'hvac', name: 'Lee', hvac_system: 'heat_pump', hvac_tons: '3', ductwork: 'keep',
      property_type: 'single_family', owner: 'yes', zip: '10001', timeline: '30_days', budget: '10_25k',
      decision_maker: 'just_me', email: 'lee@example.com', phone: '2125550100',
    };
    assert.equal((await call('/api/survey/submit', { answers: { service: 'hvac' } })).status, 422);
    const r = await call('/api/survey/submit', { answers });
    assert.equal(r.data.outcome.action, 'disqualify');
    assert.equal(store.get('leads', r.data.leadId).stage, 'disqualified');

    const pending = store.list('outbox', (e) => e.pending.length);
    assert.equal(pending.length, 1, 'first webhook failure queued for retry');
    store.patch('outbox', pending[0].id, { nextAttemptAt: new Date(0).toISOString() });
    await bus.retryDue();
    assert.equal(store.list('outbox', (e) => e.pending.length).length, 0);

    const ok = await call('/api/survey/submit', { answers: { ...answers, zip: '78701', email: 'lee2@example.com' } });
    assert.equal(ok.data.outcome.action, 'estimate');
    assert.ok(ok.data.estimate.packages.length === 3);
    const step = await call('/api/survey/step', { answers: { service: 'remodel' }, stepId: 'remodel' });
    assert.ok(step.data.errors.remodel_room);
  } finally {
    server.close();
  }
});

test('static front end and config are served', async () => {
  const { server, call } = await boot();
  try {
    const cfg = await call('/api/config');
    assert.ok(cfg.data.flow.questions.length > 10);
    assert.equal(cfg.data.persona.name, 'Avery');
    assert.equal((await call('/api/nope')).status, 404);
    assert.equal((await call('/../package.json')).status, 404);
  } finally {
    server.close();
  }
});
