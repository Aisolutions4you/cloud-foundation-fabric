// Conversational intake agent: demos, qualifies, and walks the prospect into
// an estimate -> quote -> onboarding, 24/7.
//
// Design rule: the LLM handles language (understanding + tone); the flow
// engine and estimator own the logic (what to ask next, scores, prices).
// That keeps answers consistent, auditable and hallucination-free on money.

import { evaluate, missingRequired, outcome, prune, questionIndex, score, validateQuestion, visibleSteps } from './flow-engine.js';
import { estimate } from './estimator.js';

const norm = (s) => String(s ?? '').toLowerCase();

// Deterministic extractor: works with zero LLMs configured and backfills
// anything the model missed.
export function heuristicExtract(flow, text, answers = {}, focusId = null) {
  const out = {};
  const t = String(text ?? '');
  const lower = norm(t);
  const qi = questionIndex(flow);

  const email = t.match(/[^\s@]+@[^\s@]+\.[^\s@,;]+/);
  if (email && qi.email) out.email = email[0].replace(/[.)]+$/, '');
  const phone = t.match(/(\+?\d[\d\s().-]{8,}\d)/);
  if (phone && qi.phone && phone[1].replace(/\D/g, '').length >= 10) out.phone = phone[1].trim();
  const name = t.match(/\b(?:i am|i'm|im|my name is|this is|name's)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  if (name && qi.name) out.name = name[1].replace(/\b\w/g, (c) => c.toUpperCase());
  const zip = t.match(/\b(\d{5})(?:-\d{4})?\b/);
  if (zip && qi.zip) out.zip = zip[1];

  for (const q of flow.questions) {
    if (!evaluate(q.showIf, { ...answers, ...out })) continue;
    if (q.type === 'single' || q.type === 'multi') {
      const focused = q.id === focusId;
      // Bare option values like "1" or "no" only count when we just asked
      // that question; otherwise "1,500 sq ft" would answer "stories".
      const terms = (o) => [o.label, ...(o.synonyms ?? []),
        ...(focused || /^[a-z_]{4,}$/.test(o.value) ? [o.value.replace(/_/g, ' ')] : [])];
      const hits = q.options.filter((o) => terms(o)
        .some((s) => s && new RegExp(`(^|[^\\w,.])${norm(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w,.]\\d|\\w)`).test(lower)));
      if (hits.length && (q.type === 'multi' || hits.length === 1 || focused)) {
        out[q.id] = q.type === 'multi' ? hits.map((h) => h.value) : hits[0].value;
      } else if (focused && !hits.length && numericOption(q, t)) {
        out[q.id] = numericOption(q, t);
      } else if (focused && !hits.length && q.options.some((o) => o.value === 'yes')) {
        if (/\b(yes|yeah|yep|sure|correct|i do|i own)\b/i.test(t)) out[q.id] = 'yes';
        else if (/\b(no|nope|nah|not really|rent)\b/i.test(t) && q.options.some((o) => o.value === 'no')) out[q.id] = 'no';
      }
    } else if (q.type === 'number' || q.type === 'scale') {
      const unit = q.unitHint ? new RegExp(`([\\d,.]+)\\s*(?:${q.unitHint})`, 'i') : null;
      const m = (unit && t.match(unit)) || (q.id === focusId && t.match(/([\d,.]+)/));
      if (m) out[q.id] = Number(m[1].replace(/,/g, ''));
    } else if (q.id === focusId && !out[q.id] && ['text', 'address'].includes(q.type)
      && t.trim() && !t.includes('?') && t.trim().split(/\s+/).length <= (q.id === 'name' ? 4 : 30)) {
      out[q.id] = q.id === 'name'
        ? t.trim().replace(/^(hi|hey|hello|it's|its)[,!\s]+/i, '').replace(/[.!]+$/, '') : t.trim();
    }
  }
  return out;
}

// Maps "about 2,000 sq ft" or "$18k" onto bucket options such as
// "1,500–2,500 sq ft", "Under $10k", "3+ stories" or a bare value "2".
export function numericOption(q, text) {
  const m = String(text).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(k\b)?/i);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  const val = (s) => Number(s.replace(/[$,]/g, '').replace(/k$/i, '000'));
  for (const o of q.options) {
    const l = o.label.replace(/,/g, '');
    let r;
    if (o.value === String(n)) return o.value;
    if ((r = l.match(/under\s*\$?([\d.]+k?)/i)) && n < val(r[1])) return o.value;
    if ((r = l.match(/\$?([\d.]+k?)\s*[–-]\s*\$?([\d.]+k?)/i)) && n >= val(r[1]) && n <= val(r[2])) return o.value;
    if ((r = l.match(/\$?([\d.]+k?)\+/i)) && n >= val(r[1])) return o.value;
  }
  return null;
}

function sanitize(flow, extracted, answers) {
  const qi = questionIndex(flow);
  const clean = {};
  for (const [k, v] of Object.entries(extracted ?? {})) {
    const q = qi[k];
    if (!q || v == null || v === '') continue;
    const val = q.type === 'number' || q.type === 'scale' ? Number(v) : v;
    if (!evaluate(q.showIf, { ...answers, ...clean, [k]: val })) continue;
    if (!validateQuestion(q, val)) clean[k] = val;
  }
  return clean;
}

export function nextQuestion(flow, answers) {
  const missing = new Set(missingRequired(flow, answers));
  for (const s of visibleSteps(flow, answers)) {
    for (const q of s.questions) if (missing.has(q.id)) return q;
  }
  return null;
}

function schemaForPrompt(flow, answers) {
  return visibleSteps(flow, answers).flatMap((s) => s.questions).map((q) => ({
    id: q.id, type: q.type, question: q.label,
    ...(q.options ? { options: q.options.map((o) => o.value) } : {}),
  }));
}

function renderQuestion(q) {
  if (!q) return '';
  const opts = q.options ? ` (${q.options.map((o) => o.label).join(' / ')})` : '';
  return `${q.label}${opts}`;
}

export class IntakeAgent {
  constructor({ flow, pricing, agentCfg, llm }) {
    Object.assign(this, { flow, pricing, agentCfg, llm });
  }

  systemPrompt(ctx) {
    const a = this.agentCfg;
    return [
      `You are ${a.persona.name}, ${a.persona.role} for ${a.business.name}. ${a.persona.style}`,
      `Business: ${a.business.pitch}`,
      `Proof points you may use: ${a.business.proof.join(' | ')}`,
      `Service area: ${a.business.serviceArea}. Hours: crews in the field, you answer 24/7.`,
      'RULES:',
      '- Never invent prices, discounts, timelines or guarantees. Only quote numbers given in CONTEXT.',
      '- Ask exactly ONE question per message: the NEXT_QUESTION in CONTEXT (rephrase naturally).',
      '- Keep replies under 70 words. Warm, confident, direct. No markdown headers.',
      '- If the prospect asks for a demo, walk them through DEMO steps one at a time.',
      '- If they object, use the matching OBJECTION handler, then return to NEXT_QUESTION.',
      `DEMO: ${a.demo.map((d, i) => `${i + 1}. ${d}`).join(' ')}`,
      `OBJECTIONS: ${Object.entries(a.objections).map(([k, v]) => `${k}: ${v}`).join(' | ')}`,
      `CONTEXT: ${JSON.stringify(ctx)}`,
    ].join('\n');
  }

  async extract(text, answers, focus) {
    const base = heuristicExtract(this.flow, text, answers, focus?.id);
    if (!this.llm?.enabled) return { answers: base, intent: this.#intent(text) };
    const r = await this.llm.chatJson([
      {
        role: 'system',
        content: 'Extract structured intake data from the user message. Return JSON '
          + '{"answers":{<id>:<value>},"intent":"answer|demo|pricing|book|objection|question|human"}. '
          + 'Only include ids from SCHEMA; single/multi values MUST be one of the listed option values; '
          + 'numbers as numbers. Omit anything not clearly stated.\n'
          + `SCHEMA: ${JSON.stringify(schemaForPrompt(this.flow, answers))}\n`
          + `LAST_QUESTION_ID: ${focus?.id ?? 'none'}\nKNOWN: ${JSON.stringify(answers)}`,
      },
      { role: 'user', content: text },
    ], { temperature: 0, maxTokens: 400 });
    return {
      answers: { ...(r?.data?.answers ?? {}), ...base },
      intent: r?.data?.intent ?? this.#intent(text),
    };
  }

  #intent(text) {
    const l = norm(text);
    if (/\b(demo|show me|how does (it|this) work|walk me through)\b/.test(l)) return 'demo';
    if (/\b(human|person|someone|call me|agent|representative)\b/.test(l)) return 'human';
    if (/\b(book|schedule|appointment|visit|inspection)\b/.test(l)) return 'book';
    if (/\b(price|cost|how much|quote|estimate|ballpark)\b/.test(l)) return 'pricing';
    if (/\b(too expensive|cheaper|think about it|not sure|other quotes)\b/.test(l)) return 'objection';
    return 'answer';
  }

  // Main turn: returns everything the UI and the server need.
  async turn(session, userText) {
    const focus = session.lastQuestionId ? questionIndex(this.flow)[session.lastQuestionId] : null;
    const { answers: raw, intent } = await this.extract(userText, session.answers, focus);
    const answers = prune(this.flow, { ...session.answers, ...sanitize(this.flow, raw, session.answers) });

    const q = nextQuestion(this.flow, answers);
    const sc = score(this.flow, answers);
    const out = q ? null : outcome(this.flow, answers);
    const est = !q && out?.action === 'estimate' ? estimate(this.pricing, answers) : null;
    const newlyCaptured = Object.keys(answers).filter((k) => session.answers[k] !== answers[k]);

    const ctx = {
      captured: answers,
      next_question: q ? renderQuestion(q) : null,
      intent,
      qualification: sc,
      outcome: out,
      estimate: est?.ok ? {
        service: est.serviceLabel, range: est.range, packages: est.packages
          .map((p) => ({ name: p.label, total: p.total, monthly: p.monthly })),
      } : null,
      booking_url: this.agentCfg.business.bookingUrl || null,
    };

    // Prospect already saw the estimate and says "yes / lock it in".
    const wantsQuote = !q && est?.ok && session.estimateShown
      && /\b(yes|yeah|yep|sure|lock|quote|let'?s do|go ahead|sounds good|book)\b/i.test(userText);
    if (wantsQuote) ctx.quote_requested = true;
    ctx.understood_last_answer = !focus || answers[focus.id] != null || intent !== 'answer'
      || Object.keys(raw).length > 0;
    const reply = (await this.#llmReply(session, userText, ctx)) ?? this.#templateReply(ctx, q, intent, est, out);
    return {
      reply,
      answers,
      intent,
      newlyCaptured,
      nextQuestion: q ? { id: q.id, label: q.label, type: q.type, options: q.options ?? null } : null,
      score: sc,
      outcome: out,
      estimate: est?.ok ? est : null,
      complete: !q,
      wantsQuote: Boolean(wantsQuote),
    };
  }

  async #llmReply(session, userText, ctx) {
    if (!this.llm?.enabled) return null;
    const history = session.messages.slice(-10).map((m) => ({ role: m.role, content: m.content }));
    const r = await this.llm.chat([
      { role: 'system', content: this.systemPrompt(ctx) },
      ...history,
      { role: 'user', content: userText },
    ]);
    return r?.text?.trim() || null;
  }

  #templateReply(ctx, q, intent, est, out) {
    const a = this.agentCfg;
    const parts = [];
    if (intent === 'demo') parts.push(`Quick tour: ${a.demo.slice(0, 3).join(' → ')}.`);
    else if (intent === 'objection') parts.push(Object.values(a.objections)[0]);
    else if (intent === 'human') parts.push(`Got it — I've flagged this for our team and someone will reach out. Meanwhile I can get your numbers ready.`);
    else if (!ctx.understood_last_answer) parts.push("Sorry, I didn't quite catch that.");
    else if (Object.keys(ctx.captured).length) parts.push(a.acks[Object.keys(ctx.captured).length % a.acks.length]);
    if (q) {
      parts.push(renderQuestion(q));
    } else if (est) {
      const rec = est.packages.find((p) => p.id === est.recommended) ?? est.packages[0];
      parts.push(`Based on what you shared, a ${est.serviceLabel} typically runs $${est.range.low.toLocaleString()}–$${est.range.high.toLocaleString()}. `
        + `Our ${rec.label} package comes to $${rec.total.toLocaleString()}${rec.monthly ? ` (as low as $${rec.monthly}/mo)` : ''}. `
        + 'Want me to lock that into a formal quote?');
    } else if (out) {
      parts.push(out.message);
    }
    return parts.join(' ');
  }
}
