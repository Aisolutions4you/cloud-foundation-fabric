// Rules-based estimating + quoting. Prices come from config/pricing.json so
// owners edit numbers, never code. The LLM never invents prices: it only
// collects the inputs this engine needs.

import { evaluate, get } from './flow-engine.js';

const round = (n, step = 1) => Math.round(n / step) * step;
const money = (n) => Math.round(n * 100) / 100;

function qtyOf(item, answers) {
  if (item.qty != null) return item.qty;
  if (item.qtyField) {
    const raw = get(answers, item.qtyField);
    // qtyMap turns bucketed answers ("medium") into quantities (2000 sqft).
    if (item.qtyMap) return item.qtyMap[raw] ?? item.defaultQty ?? 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : (item.defaultQty ?? 0);
  }
  return 1;
}

// Standard amortized payment; shown as "as low as $X/mo" to lower sticker shock.
export function monthlyPayment(total, financing) {
  if (!financing) return null;
  const n = financing.months;
  const r = financing.apr / 12;
  return round(r === 0 ? total / n : (total * r) / (1 - (1 + r) ** -n), 1);
}

export function estimate(pricing, answers) {
  const svc = pricing.services[answers.service];
  if (!svc) return { ok: false, error: `No pricing configured for service "${answers.service}"` };

  const lineItems = svc.lineItems
    .filter((li) => evaluate(li.when, answers))
    .map((li) => {
      const qty = qtyOf(li, answers);
      const total = Math.max(li.min ?? 0, qty * li.rate);
      return { id: li.id, label: li.label, unit: li.unit ?? 'ea', qty, rate: li.rate, total: money(total) };
    })
    .filter((li) => li.total > 0 || li.rate === 0);

  let subtotal = lineItems.reduce((s, li) => s + li.total, 0);
  const adjustments = [];
  for (const m of [...(svc.multipliers ?? []), ...(pricing.globalMultipliers ?? [])]) {
    if (evaluate(m.when, answers)) {
      const delta = subtotal * (m.factor - 1);
      subtotal += delta;
      adjustments.push({ label: m.label, factor: m.factor, amount: money(delta) });
    }
  }
  if (svc.minimum && subtotal < svc.minimum) {
    adjustments.push({ label: 'Minimum job charge', amount: money(svc.minimum - subtotal) });
    subtotal = svc.minimum;
  }

  const discounts = (pricing.discounts ?? []).filter((d) => evaluate(d.when, answers))
    .map((d) => ({ label: d.label, pct: d.pct }));

  const packages = (pricing.packages ?? [{ id: 'standard', label: 'Standard', factor: 1 }])
    .filter((p) => evaluate(p.when, answers))
    .map((p) => {
      const base = subtotal * p.factor;
      const disc = discounts.reduce((s, d) => s + base * d.pct, 0);
      const pre = base - disc;
      const tax = pre * (pricing.taxRate ?? 0);
      const total = round(pre + tax, pricing.roundTo ?? 1);
      return {
        id: p.id, label: p.label, tagline: p.tagline, includes: p.includes ?? [],
        recommended: !!p.recommended, subtotal: money(base), discount: money(disc),
        tax: money(tax), total, deposit: round(total * (pricing.depositPct ?? 0), 1),
        monthly: monthlyPayment(total, pricing.financing),
      };
    });

  const rec = packages.find((p) => p.recommended) ?? packages[0];
  const spread = pricing.rangeSpread ?? { low: 0.9, high: 1.15 };
  return {
    ok: true,
    service: answers.service,
    serviceLabel: svc.label,
    currency: pricing.currency ?? 'USD',
    lineItems,
    adjustments,
    discounts,
    packages,
    recommended: rec?.id,
    range: rec ? { low: round(rec.total * spread.low, 100), high: round(rec.total * spread.high, 100) } : null,
    assumptions: svc.assumptions ?? [],
    disclaimer: pricing.disclaimer,
  };
}

export function buildQuote({ store, pricing, lead, est, packageId, baseUrl }) {
  const pkg = est.packages.find((p) => p.id === packageId) ?? est.packages.find((p) => p.id === est.recommended);
  if (!pkg) throw new Error('No package available for quote');
  const seq = store.list('quotes').length + 1001;
  const validDays = pricing.validDays ?? 14;
  const id = store.id('q');
  const quote = {
    id,
    number: `Q-${new Date().getFullYear()}-${seq}`,
    leadId: lead.id,
    status: 'sent',
    service: est.service,
    serviceLabel: est.serviceLabel,
    currency: est.currency,
    lineItems: est.lineItems,
    adjustments: est.adjustments,
    discounts: est.discounts,
    package: pkg,
    alternatives: est.packages.filter((p) => p.id !== pkg.id),
    assumptions: est.assumptions,
    terms: pricing.terms ?? [],
    guarantee: pricing.guarantee,
    expiresAt: new Date(Date.now() + validDays * 864e5).toISOString(),
    url: `${baseUrl}/#/quote/${id}`,
  };
  return store.put('quotes', quote);
}
