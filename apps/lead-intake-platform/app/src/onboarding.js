// Onboarding workflow: generated the moment a quote is accepted, from
// config/onboarding.json (common tasks + per-service tasks). Client-owned
// tasks are completed in the self-serve portal; team-owned tasks are closed
// by staff or automations via the inbound webhook.

import { evaluate } from './flow-engine.js';

export function createOnboarding({ store, cfg, lead, quote, baseUrl }) {
  const tasks = [...cfg.common, ...(cfg.services[quote.service] ?? [])]
    .filter((t) => evaluate(t.when, lead.answers))
    .map((t, i) => ({
      id: t.id,
      order: i,
      label: t.label,
      description: t.description ?? '',
      owner: t.owner ?? 'client',
      type: t.type ?? 'info',
      fields: t.fields ?? [],
      link: t.type === 'pay' ? payLink(cfg, quote) : t.link ?? null,
      dueAt: new Date(Date.now() + (t.dueDays ?? 3) * 864e5).toISOString(),
      status: 'open',
      data: null,
    }));
  const id = store.id('ob');
  return store.put('onboarding', {
    id,
    leadId: lead.id,
    quoteId: quote.id,
    service: quote.service,
    status: 'active',
    tasks,
    url: `${baseUrl}/#/onboarding/${id}`,
  });
}

function payLink(cfg, quote) {
  if (!cfg.paymentLinkBase) return null;
  const u = new URL(cfg.paymentLinkBase);
  u.searchParams.set('client_reference_id', quote.id);
  return u.toString();
}

export function progress(ob) {
  const done = ob.tasks.filter((t) => t.status === 'done').length;
  return { done, total: ob.tasks.length, pct: Math.round((done / Math.max(ob.tasks.length, 1)) * 100) };
}

export function completeTask(store, ob, taskId, data, { byTeam = false } = {}) {
  const task = ob.tasks.find((t) => t.id === taskId);
  if (!task) return { error: 'Unknown task' };
  if (task.owner === 'team' && !byTeam) return { error: 'This step is completed by our team' };
  for (const f of task.fields) {
    if (f.required && (data?.[f.id] == null || data[f.id] === '')) return { error: `${f.label} is required` };
  }
  const tasks = ob.tasks.map((t) => (t.id === taskId
    ? { ...t, status: 'done', data: data ?? null, completedAt: new Date().toISOString() } : t));
  const all = tasks.every((t) => t.status === 'done');
  const updated = store.patch('onboarding', ob.id, { tasks, status: all ? 'complete' : 'active' });
  return { onboarding: updated, task: tasks.find((t) => t.id === taskId), complete: all };
}
