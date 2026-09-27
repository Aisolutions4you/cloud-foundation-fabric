// HTTP API + static front end. Zero runtime dependencies (Node >= 20).
//
// Funnel: attention (landing/chat/survey) -> capture -> qualify -> estimate
//         -> quote -> accept -> onboarding. Every step emits an event that
//         syncs GoHighLevel and fans out to twin.so / n8n / Make webhooks.

import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { IntakeAgent } from './agent.js';
import { estimate, buildQuote } from './estimator.js';
import { missingRequired, outcome, prune, score, validateStep, visibleSteps } from './flow-engine.js';
import { completeTask, createOnboarding, progress } from './onboarding.js';
import { verify } from './integrations/webhooks.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};
const MAX_BODY = 64 * 1024;
const STAGE_RANK = ['new', 'qualified', 'estimated', 'quoted', 'won', 'onboarding', 'active'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createApp({ store, biz, llm, bus, settings }) {
  const { flow, pricing, onboarding: obCfg, agent: agentCfg } = biz;
  agentCfg.business.name = agentCfg.business.name || settings.businessName;
  agentCfg.business.bookingUrl = settings.bookingUrl || agentCfg.business.bookingUrl;
  obCfg.paymentLinkBase = settings.stripePaymentLinkBase || obCfg.paymentLinkBase;
  const agent = new IntakeAgent({ flow, pricing, agentCfg, llm });
  const buckets = new Map();

  // --- helpers -------------------------------------------------------------
  function rateLimit(ip, limit = 30, windowMs = 60_000) {
    const now = Date.now();
    const b = buckets.get(ip) ?? { n: 0, reset: now + windowMs };
    if (now > b.reset) Object.assign(b, { n: 0, reset: now + windowMs });
    b.n += 1;
    buckets.set(ip, b);
    if (b.n > limit) throw new HttpError(429, 'Too many requests, slow down a little.');
  }

  const advance = (lead, stage) => (STAGE_RANK.indexOf(stage) > STAGE_RANK.indexOf(lead.stage) ? stage : lead.stage);
  const hasContact = (a) => Boolean(a.email || a.phone);

  // Creates/updates the lead and emits each lifecycle event exactly once.
  async function syncLead({ leadId, sessionId, answers, source, est }) {
    let lead = leadId ? store.get('leads', leadId) : null;
    if (!lead) {
      if (!hasContact(answers)) return null;
      lead = { id: store.id('lead'), stage: 'new', sessionId, source: source ?? {}, timeline: [], ghl: {}, emitted: [] };
    }
    const sc = score(flow, answers);
    const complete = missingRequired(flow, answers).length === 0;
    const out = complete ? outcome(flow, answers) : null;
    let stage = lead.stage;
    if (out?.action === 'disqualify') stage = 'disqualified';
    else if (complete && ['hot', 'warm'].includes(sc.tier)) stage = advance({ stage }, 'qualified');
    if (est?.ok && stage !== 'disqualified') stage = advance({ stage }, 'estimated');
    lead = store.put('leads', { ...lead, answers, score: sc, stage, outcome: out, estimate: est?.ok ? est : lead.estimate });

    const once = async (type, opts) => {
      const cur = store.get('leads', lead.id);
      if (cur.emitted?.includes(type)) return;
      store.patch('leads', lead.id, { emitted: [...(cur.emitted ?? []), type] });
      await bus.emit(type, { leadId: lead.id, ...opts });
    };
    await once('lead.created', {
      tags: ['new-lead'],
      note: `New AI intake lead (${sc.tier}, score ${sc.total}). Service: ${answers.service ?? 'n/a'}.`,
      suggestedAction: 'Send a personal text within 5 minutes.',
    });
    if (complete && stage !== 'disqualified' && ['hot', 'warm'].includes(sc.tier)) {
      await once('lead.qualified', {
        tags: [`tier-${sc.tier}`],
        note: `Qualified (${sc.total}): ${sc.reasons.join(', ')}`,
        suggestedAction: sc.tier === 'hot' ? 'Call now — hot lead.' : 'Enroll in follow-up sequence.',
      });
    }
    if (est?.ok && stage !== 'disqualified') {
      await once('estimate.ready', {
        data: { range: est.range, packages: est.packages },
        note: `Estimate ${est.serviceLabel}: $${est.range.low}–$${est.range.high}`,
        suggestedAction: 'Offer a formal quote or on-site visit.',
      });
    }
    if (stage === 'disqualified') {
      await once('lead.disqualified', { tags: ['disqualified'], note: out?.message, suggestedAction: 'Add to nurture list.' });
    }
    return store.get('leads', lead.id);
  }

  async function createQuote(lead, packageId) {
    const est = estimate(pricing, lead.answers);
    if (!est.ok) throw new HttpError(422, est.error);
    if (lead.stage === 'disqualified') throw new HttpError(422, 'lead is not eligible for a quote');
    const quote = buildQuote({ store, pricing, lead, est, packageId, baseUrl: settings.publicBaseUrl });
    store.patch('leads', lead.id, { stage: advance(lead, 'quoted'), quoteId: quote.id });
    await bus.emit('quote.sent', {
      leadId: lead.id, data: { quote }, tags: ['quote-sent'],
      note: `Quote ${quote.number} sent: ${quote.package.label} $${quote.package.total} — ${quote.url}`,
      suggestedAction: 'Follow up in 24h if not accepted; 72h: offer a call.',
    });
    return quote;
  }

  // --- routes --------------------------------------------------------------
  const routes = [
    ['GET', /^\/healthz$/, () => ({ ok: true, llm: llm.enabled ? llm.health : 'rules-only', handlers: Object.keys(bus.handlers).filter((k) => bus.handlers[k].enabled) })],

    ['GET', /^\/api\/config$/, () => ({
      business: { name: agentCfg.business.name, pitch: agentCfg.business.pitch, proof: agentCfg.business.proof, serviceArea: agentCfg.business.serviceArea, bookingUrl: agentCfg.business.bookingUrl },
      persona: { name: agentCfg.persona.name, greeting: agentCfg.persona.greeting, starters: agentCfg.starters },
      landing: agentCfg.landing,
      flow: { id: flow.id, title: flow.title, steps: flow.steps, questions: flow.questions },
      packages: pricing.packages?.map(({ id, label, tagline, includes }) => ({ id, label, tagline, includes })),
      guarantee: pricing.guarantee,
    })],

    ['POST', /^\/api\/chat$/, async ({ body, ip }) => {
      rateLimit(ip);
      const message = String(body.message ?? '').slice(0, 2000).trim();
      if (!message) throw new HttpError(400, 'message is required');
      let session = body.sessionId ? store.get('sessions', body.sessionId) : null;
      if (!session) {
        session = store.put('sessions', { id: store.id('s'), messages: [], answers: {}, source: body.source ?? {}, leadId: null });
      }
      const r = await agent.turn(session, message);
      const lead = await syncLead({ leadId: session.leadId, sessionId: session.id, answers: r.answers, source: session.source, est: r.estimate });
      if (r.intent === 'human' && lead) {
        await bus.emit('handoff.requested', { leadId: lead.id, tags: ['wants-human'], note: `Prospect asked for a human: "${message}"`, suggestedAction: 'Call or text back ASAP.' });
      }
      let quote = null;
      let reply = r.reply;
      if (r.wantsQuote && lead) {
        const existing = lead.quoteId ? store.get('quotes', lead.quoteId) : null;
        quote = existing?.status === 'sent' ? existing : await createQuote(lead, body.packageId);
        reply = `Done — your quote ${quote.number} is locked at $${quote.package.total.toLocaleString()} (${quote.package.label}). Review and e-sign here: ${quote.url}`;
      }
      store.put('sessions', {
        ...session,
        estimateShown: session.estimateShown || Boolean(r.estimate),
        leadId: lead?.id ?? session.leadId,
        answers: r.answers,
        lastQuestionId: r.nextQuestion?.id ?? null,
        messages: [...session.messages, { role: 'user', content: message }, { role: 'assistant', content: reply }].slice(-60),
      });
      return {
        sessionId: session.id, leadId: lead?.id ?? null, reply, quote,
        nextQuestion: r.nextQuestion, score: r.score, outcome: r.outcome,
        estimate: r.estimate, complete: r.complete, answers: r.answers,
      };
    }],

    ['POST', /^\/api\/survey\/step$/, ({ body }) => {
      const answers = prune(flow, body.answers ?? {});
      return { errors: body.stepId ? validateStep(flow, body.stepId, answers) : {}, steps: visibleSteps(flow, answers).map((s) => ({ ...s, questions: s.questions.map((q) => q.id) })), answers };
    }],

    ['POST', /^\/api\/survey\/submit$/, async ({ body, ip }) => {
      rateLimit(ip, 20);
      const answers = prune(flow, body.answers ?? {});
      const missing = missingRequired(flow, answers);
      if (missing.length) throw new HttpError(422, `Missing: ${missing.join(', ')}`);
      const out = outcome(flow, answers);
      const est = out.action === 'estimate' ? estimate(pricing, answers) : null;
      const lead = await syncLead({ leadId: body.leadId, sessionId: body.sessionId, answers, source: body.source, est });
      return { leadId: lead?.id, score: lead?.score, outcome: out, estimate: est?.ok ? est : null };
    }],

    ['POST', /^\/api\/estimate$/, ({ body }) => estimate(pricing, prune(flow, body.answers ?? {}))],

    ['POST', /^\/api\/quotes$/, async ({ body }) => {
      const lead = store.get('leads', body.leadId);
      if (!lead) throw new HttpError(404, 'lead not found');
      return createQuote(lead, body.packageId);
    }],

    ['GET', /^\/api\/quotes\/([\w-]+)$/, ({ params }) => {
      const q = store.get('quotes', params[0]);
      if (!q) throw new HttpError(404, 'quote not found');
      if (!q.viewedAt) store.patch('quotes', q.id, { viewedAt: new Date().toISOString() });
      return { ...q, expired: q.status === 'sent' && q.expiresAt < new Date().toISOString() };
    }],

    ['POST', /^\/api\/quotes\/([\w-]+)\/accept$/, async ({ params, body, ip }) => {
      const q = store.get('quotes', params[0]);
      if (!q) throw new HttpError(404, 'quote not found');
      if (q.status === 'accepted') return { quote: q, onboarding: store.get('onboarding', q.onboardingId) };
      if (q.expiresAt < new Date().toISOString()) throw new HttpError(410, 'This quote has expired — ask us to refresh it.');
      if (!body.agree || !String(body.signature ?? '').trim()) throw new HttpError(400, 'Type your full name and accept the terms to sign.');
      const lead = store.get('leads', q.leadId);
      const ob = createOnboarding({ store, cfg: obCfg, lead, quote: q, baseUrl: settings.publicBaseUrl });
      const signed = store.patch('quotes', q.id, {
        status: 'accepted', onboardingId: ob.id,
        acceptance: { signature: String(body.signature).slice(0, 120), ip, at: new Date().toISOString() },
      });
      store.patch('leads', lead.id, { stage: 'onboarding', onboardingId: ob.id });
      await bus.emit('quote.accepted', {
        leadId: lead.id, data: { quote: signed, onboardingUrl: ob.url }, tags: ['customer', 'won'],
        note: `WON: ${q.number} $${q.package.total}. Onboarding: ${ob.url}`,
        suggestedAction: 'Send welcome SMS + schedule kickoff.',
      });
      return { quote: signed, onboarding: ob };
    }],

    ['POST', /^\/api\/quotes\/([\w-]+)\/decline$/, async ({ params, body }) => {
      const q = store.get('quotes', params[0]);
      if (!q) throw new HttpError(404, 'quote not found');
      const d = store.patch('quotes', q.id, { status: 'declined', declineReason: String(body.reason ?? '').slice(0, 500) });
      await bus.emit('quote.declined', { leadId: q.leadId, data: { reason: d.declineReason }, tags: ['quote-declined'], note: `Declined: ${d.declineReason}`, suggestedAction: 'Win-back: offer the lower package or financing.' });
      return d;
    }],

    ['GET', /^\/api\/onboarding\/([\w-]+)$/, ({ params }) => {
      const ob = store.get('onboarding', params[0]);
      if (!ob) throw new HttpError(404, 'onboarding not found');
      return { ...ob, progress: progress(ob), business: agentCfg.business.name };
    }],

    ['POST', /^\/api\/onboarding\/([\w-]+)\/tasks\/([\w-]+)$/, async ({ params, body }) => {
      const ob = store.get('onboarding', params[0]);
      if (!ob) throw new HttpError(404, 'onboarding not found');
      const r = completeTask(store, ob, params[1], body.data ?? {});
      if (r.error) throw new HttpError(422, r.error);
      await bus.emit('onboarding.task_completed', { leadId: ob.leadId, data: { onboardingId: ob.id, task: r.task }, note: `Onboarding step done: ${r.task.label}` });
      if (r.complete) {
        store.patch('leads', ob.leadId, { stage: 'active' });
        await bus.emit('onboarding.completed', { leadId: ob.leadId, data: { onboardingId: ob.id }, tags: ['onboarded'], note: 'Onboarding complete — ready to schedule work.', suggestedAction: 'Dispatch crew / schedule job.' });
      }
      return { ...r.onboarding, progress: progress(r.onboarding) };
    }],

    // Automations (GHL workflows, twin.so agents, n8n) push updates back in.
    ['POST', /^\/api\/webhooks\/inbound$/, async ({ body, raw, headers }) => {
      if (!verify(settings.inboundWebhookSecret, headers['x-timestamp'], raw, headers['x-signature'])) {
        throw new HttpError(401, 'bad signature');
      }
      if (body.type === 'onboarding.task_complete') {
        const ob = store.get('onboarding', body.onboardingId);
        if (!ob) throw new HttpError(404, 'onboarding not found');
        const r = completeTask(store, ob, body.taskId, body.data, { byTeam: true });
        if (r.error) throw new HttpError(422, r.error);
        if (r.complete) {
          store.patch('leads', ob.leadId, { stage: 'active' });
          await bus.emit('onboarding.completed', { leadId: ob.leadId, data: { onboardingId: ob.id } });
        }
        return { ok: true };
      }
      if (body.type === 'lead.update') {
        const lead = store.get('leads', body.leadId);
        if (!lead) throw new HttpError(404, 'lead not found');
        const allowed = ['stage', 'owner', 'notes'];
        const patch = Object.fromEntries(Object.entries(body.fields ?? {}).filter(([k]) => allowed.includes(k)));
        return store.patch('leads', lead.id, patch);
      }
      throw new HttpError(400, `unsupported type ${body.type}`);
    }],

    ['GET', /^\/api\/admin\/leads$/, ({ headers }) => {
      requireAdmin(headers);
      return store.list('leads').slice(0, 500);
    }],

    ['GET', /^\/api\/admin\/metrics$/, ({ headers }) => {
      requireAdmin(headers);
      const leads = store.list('leads');
      const quotes = store.list('quotes');
      const count = (s) => leads.filter((l) => STAGE_RANK.indexOf(l.stage) >= STAGE_RANK.indexOf(s)).length;
      const won = quotes.filter((q) => q.status === 'accepted');
      const sessions = store.list('sessions').length;
      return {
        funnel: { conversations: sessions, leads: leads.length, qualified: count('qualified'), estimated: count('estimated'), quoted: count('quoted'), won: count('won') },
        rates: {
          captureRate: sessions ? +(leads.length / sessions).toFixed(3) : 0,
          closeRate: quotes.length ? +(won.length / quotes.length).toFixed(3) : 0,
        },
        revenue: { booked: won.reduce((s, q) => s + q.package.total, 0), pipeline: quotes.filter((q) => q.status === 'sent').reduce((s, q) => s + q.package.total, 0) },
        afterHoursLeads: leads.filter((l) => { const h = new Date(l.createdAt).getHours(); return h < 8 || h >= 18; }).length,
        outbox: { pending: store.list('outbox', (e) => e.pending?.length && !e.deadLetter).length, deadLetter: store.list('outbox', (e) => e.deadLetter).length },
      };
    }],
  ];

  function requireAdmin(headers) {
    if (!settings.adminToken || headers.authorization !== `Bearer ${settings.adminToken}`) {
      throw new HttpError(401, 'admin token required');
    }
  }

  async function serveStatic(pathname, res) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = normalize(join(settings.publicDir, rel));
    if (!file.startsWith(settings.publicDir)) return false;
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new HttpError(413, 'payload too large')); req.destroy(); } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function send(res, status, obj) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end(JSON.stringify(obj));
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Signature, X-Timestamp' });
        return res.end();
      }
      for (const [method, re, fn] of routes) {
        const m = url.pathname.match(re);
        if (!m || method !== req.method) continue;
        const raw = method === 'POST' ? await readBody(req) : '';
        let body = {};
        if (raw) {
          try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'invalid JSON'); }
        }
        const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
        return send(res, 200, await fn({ body, raw, params: m.slice(1), headers: req.headers, ip, query: url.searchParams }));
      }
      if (req.method === 'GET' && !url.pathname.startsWith('/api/') && await serveStatic(url.pathname, res)) return;
      throw new HttpError(404, 'not found');
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      send(res, err.status ?? 500, { error: err instanceof HttpError ? err.message : 'internal error' });
    }
  };
}
