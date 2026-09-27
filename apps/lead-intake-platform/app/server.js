// Entry point: wires config, store, LLM router, integrations and the API.

import { createServer } from 'node:http';
import { createApp } from './src/app.js';
import { loadBusinessConfig, settings } from './src/config.js';
import { EventBus } from './src/events.js';
import { GHLClient } from './src/integrations/ghl.js';
import { WebhookFanout } from './src/integrations/webhooks.js';
import { LLMRouter } from './src/llm.js';
import { Store } from './src/store.js';

const store = new Store(settings.dataDir);
const llm = new LLMRouter();
const bus = new EventBus({
  store,
  handlers: {
    ghl: new GHLClient(settings.ghl),
    webhooks: new WebhookFanout({ urls: settings.webhooks, twinUrl: settings.twinWebhookUrl, secret: settings.webhookSecret }),
  },
});

const server = createServer(createApp({ store, biz: loadBusinessConfig(), llm, bus, settings }));
server.listen(settings.port, () => {
  console.log(`[intake] ${settings.businessName} listening on :${settings.port}`);
  console.log(`[intake] LLM providers: ${llm.providers.map((p) => `${p.name}(${p.model})`).join(' -> ') || 'none (rules-only mode)'}`);
  console.log(`[intake] integrations: ${Object.entries(bus.handlers).filter(([, h]) => h.enabled).map(([n]) => n).join(', ') || 'none'}`);
});

const retry = setInterval(() => bus.retryDue().catch((e) => console.error('[outbox]', e)), 30_000);

function shutdown() {
  clearInterval(retry);
  store.flushAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
