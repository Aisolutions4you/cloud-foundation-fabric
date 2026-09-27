// Conditional-logic engine shared by the survey wizard, the estimator and the
// conversational agent. One condition DSL drives everything:
//
//   { "field": "service", "op": "eq", "value": "roofing" }
//   { "all": [cond, ...] }   { "any": [cond, ...] }   { "not": cond }
//
// Ops: eq neq in nin gt gte lt lte between exists empty contains regex

export function get(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

export function evaluate(cond, answers) {
  if (cond == null || cond === true) return true;
  if (cond === false) return false;
  if (Array.isArray(cond)) return cond.every((c) => evaluate(c, answers));
  if (cond.all) return cond.all.every((c) => evaluate(c, answers));
  if (cond.any) return cond.any.some((c) => evaluate(c, answers));
  if (cond.not) return !evaluate(cond.not, answers);

  const v = get(answers, cond.field);
  const t = cond.value;
  const num = (x) => (x === '' || x == null ? NaN : Number(x));
  switch (cond.op ?? 'eq') {
    case 'eq': return Array.isArray(v) ? v.includes(t) : v === t;
    case 'neq': return Array.isArray(v) ? !v.includes(t) : v !== t;
    case 'in': return Array.isArray(v) ? v.some((x) => t.includes(x)) : t.includes(v);
    case 'nin': return Array.isArray(v) ? !v.some((x) => t.includes(x)) : !t.includes(v);
    case 'gt': return num(v) > t;
    case 'gte': return num(v) >= t;
    case 'lt': return num(v) < t;
    case 'lte': return num(v) <= t;
    case 'between': return num(v) >= t[0] && num(v) <= t[1];
    case 'exists': return !isEmpty(v);
    case 'empty': return isEmpty(v);
    case 'contains': return String(v ?? '').toLowerCase().includes(String(t).toLowerCase());
    case 'regex': return new RegExp(t, 'i').test(String(v ?? ''));
    default: throw new Error(`unknown op: ${cond.op}`);
  }
}

export function questionIndex(flow) {
  return Object.fromEntries(flow.questions.map((q) => [q.id, q]));
}

// Steps and questions visible for the current answers.
export function visibleSteps(flow, answers) {
  const qi = questionIndex(flow);
  return flow.steps
    .filter((s) => evaluate(s.showIf, answers))
    .map((s) => ({
      ...s,
      questions: s.questions.map((id) => qi[id])
        .filter((q) => q && evaluate(q.showIf, answers)),
    }))
    .filter((s) => s.questions.length > 0);
}

// Drops answers to questions that are now hidden (e.g. user changed service
// from roofing to HVAC) so stale branches never leak into pricing.
export function prune(flow, answers) {
  const visible = new Set(visibleSteps(flow, answers)
    .flatMap((s) => s.questions.map((q) => q.id)));
  const out = {};
  for (const [k, v] of Object.entries(answers)) {
    if (visible.has(k) || !questionIndex(flow)[k]) out[k] = v;
  }
  return out;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateQuestion(q, v) {
  if (isEmpty(v)) return q.required ? 'This field is required' : null;
  if (q.pattern && !new RegExp(q.pattern).test(String(v).trim())) return q.patternError ?? 'Invalid format';
  switch (q.type) {
    case 'email': return EMAIL_RE.test(v) ? null : 'Enter a valid email';
    case 'phone': return String(v).replace(/\D/g, '').length >= 10 ? null : 'Enter a valid phone number';
    case 'number':
    case 'scale': {
      const n = Number(v);
      if (Number.isNaN(n)) return 'Enter a number';
      if (q.min != null && n < q.min) return `Minimum is ${q.min}`;
      if (q.max != null && n > q.max) return `Maximum is ${q.max}`;
      return null;
    }
    case 'single':
      return q.options.some((o) => o.value === v) ? null : 'Pick one of the options';
    case 'multi':
      return Array.isArray(v) && v.every((x) => q.options.some((o) => o.value === x))
        ? null : 'Pick from the options';
    default: return null;
  }
}

export function validateStep(flow, stepId, answers) {
  const step = visibleSteps(flow, answers).find((s) => s.id === stepId);
  if (!step) return {};
  const errors = {};
  for (const q of step.questions) {
    const e = validateQuestion(q, answers[q.id]);
    if (e) errors[q.id] = e;
  }
  return errors;
}

export function missingRequired(flow, answers) {
  return visibleSteps(flow, answers).flatMap((s) => s.questions)
    .filter((q) => q.required && validateQuestion(q, answers[q.id]))
    .map((q) => q.id);
}

// Lead score = sum of matching rules (+ per-option scores), mapped to a tier.
export function score(flow, answers) {
  const reasons = [];
  let total = 0;
  for (const q of flow.questions) {
    const v = answers[q.id];
    for (const o of q.options ?? []) {
      const hit = Array.isArray(v) ? v.includes(o.value) : v === o.value;
      if (hit && o.score) {
        total += o.score;
        reasons.push(`${q.id}=${o.value} (${o.score > 0 ? '+' : ''}${o.score})`);
      }
    }
  }
  for (const r of flow.scoring?.rules ?? []) {
    if (evaluate(r.when, answers)) {
      total += r.points;
      reasons.push(`${r.reason} (${r.points > 0 ? '+' : ''}${r.points})`);
    }
  }
  const tiers = [...(flow.scoring?.tiers ?? [])].sort((a, b) => b.min - a.min);
  const tier = tiers.find((t) => total >= t.min)?.label ?? 'cold';
  return { total, tier, reasons };
}

// First matching outcome decides the next move: estimate, book a call,
// nurture, or politely disqualify.
export function outcome(flow, answers) {
  return (flow.outcomes ?? []).find((o) => evaluate(o.when, answers))
    ?? { action: 'estimate', message: '' };
}
