// GoHighLevel (LeadConnector API v2) sync: contact upsert, tags, pipeline
// stage, notes. GHL stays the system of record for sales follow-up; this app
// is the 24/7 front door that feeds it clean, scored, quoted leads.

const STAGE_BY_EVENT = {
  'lead.created': 'new',
  'lead.qualified': 'qualified',
  'quote.sent': 'quoted',
  'quote.accepted': 'won',
};

export class GHLClient {
  constructor(cfg, fetchImpl = fetch) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
  }

  get enabled() {
    return Boolean(this.cfg.apiKey && this.cfg.locationId);
  }

  async #req(method, path, body) {
    const res = await this.fetch(`${this.cfg.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        Version: this.cfg.version,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GHL ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  async upsertContact(lead, tags = []) {
    const [firstName, ...rest] = String(lead.answers.name ?? '').split(' ');
    const r = await this.#req('POST', '/contacts/upsert', {
      locationId: this.cfg.locationId,
      firstName: firstName || undefined,
      lastName: rest.join(' ') || undefined,
      email: lead.answers.email,
      phone: lead.answers.phone,
      postalCode: lead.answers.zip,
      source: 'AI Intake',
      tags: [...new Set(['ai-intake', `svc-${lead.answers.service ?? 'unknown'}`, `tier-${lead.score?.tier ?? 'cold'}`, ...tags])],
    });
    return r.contact?.id ?? r.id;
  }

  async addNote(contactId, body) {
    return this.#req('POST', `/contacts/${contactId}/notes`, { body });
  }

  async upsertOpportunity(lead, stageKey, monetaryValue) {
    const stageId = this.cfg.stages[stageKey];
    if (!this.cfg.pipelineId || !stageId) return null;
    const body = {
      pipelineId: this.cfg.pipelineId,
      locationId: this.cfg.locationId,
      pipelineStageId: stageId,
      name: `${lead.answers.name ?? 'Lead'} — ${lead.answers.service ?? 'inquiry'}`,
      status: stageKey === 'won' ? 'won' : 'open',
      contactId: lead.ghl.contactId,
      monetaryValue,
    };
    if (lead.ghl.opportunityId) {
      const { pipelineId, locationId, contactId, ...patch } = body;
      await this.#req('PUT', `/opportunities/${lead.ghl.opportunityId}`, patch);
      return lead.ghl.opportunityId;
    }
    const r = await this.#req('POST', '/opportunities/', body);
    return r.opportunity?.id ?? r.id;
  }

  // Event handler: returns fields to persist on the lead (ghl ids).
  async handle(event, lead) {
    if (!this.enabled || !lead || !(lead.answers.email || lead.answers.phone)) return null;
    const ghl = { ...(lead.ghl ?? {}) };
    ghl.contactId = await this.upsertContact({ ...lead, ghl }, event.tags ?? []);
    const stage = STAGE_BY_EVENT[event.type];
    if (stage) {
      const value = event.data?.quote?.package?.total ?? lead.estimate?.range?.low ?? 0;
      ghl.opportunityId = await this.upsertOpportunity({ ...lead, ghl }, stage, value);
    }
    if (event.note) await this.addNote(ghl.contactId, event.note);
    return { ghl };
  }
}
