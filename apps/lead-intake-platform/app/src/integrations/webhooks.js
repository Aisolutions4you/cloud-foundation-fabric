// Signed outbound webhooks. One payload shape for every automation target:
// twin.so agents, n8n, Make, Zapier catch hooks, Slack relays, etc.
// Receivers verify: HMAC-SHA256(secret, `${timestamp}.${body}`) == X-Signature.

import { createHmac, timingSafeEqual } from 'node:crypto';

export function sign(secret, timestamp, body) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function verify(secret, timestamp, body, signature) {
  if (!secret || !signature || !timestamp) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const a = Buffer.from(sign(secret, timestamp, body));
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

export class WebhookFanout {
  constructor({ urls = [], twinUrl = '', secret = '' }, fetchImpl = fetch) {
    this.targets = [...urls.map((url) => ({ name: 'webhook', url })),
      ...(twinUrl ? [{ name: 'twin', url: twinUrl }] : [])];
    this.secret = secret;
    this.fetch = fetchImpl;
  }

  get enabled() {
    return this.targets.length > 0;
  }

  async handle(event, lead) {
    const body = JSON.stringify({
      id: event.id,
      type: event.type,
      occurredAt: event.at,
      lead: lead && {
        id: lead.id, stage: lead.stage, answers: lead.answers, score: lead.score,
        estimate: lead.estimate && { range: lead.estimate.range, recommended: lead.estimate.recommended },
      },
      data: event.data ?? {},
      // Hint for agentic receivers (e.g. a twin.so agent): what a human would
      // do next. Receivers are free to ignore it.
      suggestedAction: event.suggestedAction ?? null,
    });
    const ts = Math.floor(Date.now() / 1000);
    const results = await Promise.allSettled(this.targets.map(async (t) => {
      const res = await this.fetch(t.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Event-Type': event.type,
          'X-Event-Id': event.id,
          'X-Timestamp': String(ts),
          ...(this.secret ? { 'X-Signature': sign(this.secret, ts, body) } : {}),
        },
        body,
      });
      if (!res.ok) throw new Error(`${t.name} ${res.status}`);
    }));
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) throw new Error(failed.map((f) => f.reason.message).join('; '));
    return null;
  }
}
