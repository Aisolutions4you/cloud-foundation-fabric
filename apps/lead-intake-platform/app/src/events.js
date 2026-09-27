// Event bus with a durable outbox. Every business moment (lead created,
// qualified, estimate ready, quote sent/accepted, onboarding step done) is an
// event; each integration handler is retried with backoff until it succeeds,
// so a GHL or webhook outage never loses a lead.

const BACKOFF_S = [10, 60, 300, 1800, 7200];

export class EventBus {
  constructor({ store, handlers = {}, log = console }) {
    this.store = store;
    this.handlers = handlers; // name -> { enabled, handle(event, lead) }
    this.log = log;
  }

  async emit(type, { leadId, data = {}, note, tags, suggestedAction } = {}) {
    const active = Object.entries(this.handlers).filter(([, h]) => h.enabled).map(([n]) => n);
    const event = this.store.put('outbox', {
      id: this.store.id('evt'),
      type, leadId, data, note, tags, suggestedAction,
      at: new Date().toISOString(),
      pending: active,
      attempts: 0,
      errors: {},
    });
    if (leadId) {
      const lead = this.store.get('leads', leadId);
      if (lead) {
        this.store.patch('leads', leadId, {
          timeline: [...(lead.timeline ?? []), { at: event.at, type }].slice(-100),
        });
      }
    }
    await this.deliver(event);
    return event;
  }

  async deliver(event) {
    const remaining = [];
    for (const name of event.pending) {
      const h = this.handlers[name];
      try {
        const lead = event.leadId ? this.store.get('leads', event.leadId) : null;
        const patch = await h.handle(event, lead);
        if (patch && event.leadId) this.store.patch('leads', event.leadId, patch);
      } catch (err) {
        remaining.push(name);
        event.errors[name] = String(err.message ?? err);
        this.log.warn?.(`[events] ${name} failed for ${event.type}: ${err.message}`);
      }
    }
    const attempts = event.attempts + 1;
    const delay = BACKOFF_S[Math.min(attempts - 1, BACKOFF_S.length - 1)];
    return this.store.patch('outbox', event.id, {
      pending: remaining,
      attempts,
      errors: event.errors,
      nextAttemptAt: remaining.length ? new Date(Date.now() + delay * 1000).toISOString() : null,
      deadLetter: remaining.length > 0 && attempts >= BACKOFF_S.length + 1,
    });
  }

  async retryDue() {
    const now = new Date().toISOString();
    const due = this.store.list('outbox', (e) => e.pending?.length && !e.deadLetter && e.nextAttemptAt <= now);
    for (const e of due) await this.deliver(e);
    return due.length;
  }
}
