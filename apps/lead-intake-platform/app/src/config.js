// Runtime configuration: env vars + JSON business configs (flows, pricing,
// onboarding, agent persona). Everything business-specific lives in
// config/*.json so a new client/vertical is a config swap, not a code change.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_DIR = process.env.CONFIG_DIR || join(ROOT, 'config');

const env = (k, d = '') => (process.env[k] ?? d).trim();

function loadJson(name) {
  return JSON.parse(readFileSync(join(CONFIG_DIR, name), 'utf8'));
}

export function loadBusinessConfig() {
  return {
    flow: loadJson('flow.json'),
    pricing: loadJson('pricing.json'),
    onboarding: loadJson('onboarding.json'),
    agent: loadJson('agent.json'),
  };
}

// LLM providers are tried in order; the first one with credentials/URL that
// answers wins. All speak the OpenAI-compatible /chat/completions dialect, so
// "portable" local models (Ollama, LM Studio, vLLM, llama.cpp) and hosted
// routers (OpenRouter) are interchangeable.
export function llmProviders() {
  const order = env('LLM_PROVIDER_ORDER', 'openrouter,local,openai')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const all = {
    openrouter: {
      name: 'openrouter',
      baseUrl: env('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
      apiKey: env('OPENROUTER_API_KEY'),
      model: env('OPENROUTER_MODEL', 'anthropic/claude-sonnet-4'),
      headers: {
        'HTTP-Referer': env('PUBLIC_BASE_URL', 'http://localhost:8080'),
        'X-Title': env('BUSINESS_NAME', 'Lead Intake Platform'),
      },
      requiresKey: true,
    },
    local: {
      // Ollama default; point at LM Studio (:1234/v1), vLLM, llama.cpp, etc.
      name: 'local',
      baseUrl: env('LOCAL_LLM_BASE_URL'),
      apiKey: env('LOCAL_LLM_API_KEY', 'local'),
      model: env('LOCAL_LLM_MODEL', 'llama3.1:8b'),
      headers: {},
      requiresKey: false,
    },
    openai: {
      name: 'openai',
      baseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
      apiKey: env('OPENAI_API_KEY'),
      model: env('OPENAI_MODEL', 'gpt-4o-mini'),
      headers: {},
      requiresKey: true,
    },
  };
  return order
    .map((n) => all[n])
    .filter((p) => p && p.baseUrl && (!p.requiresKey || p.apiKey));
}

export const settings = {
  port: Number(env('PORT', '8080')),
  dataDir: env('DATA_DIR', join(ROOT, 'data')),
  publicDir: join(ROOT, 'public'),
  publicBaseUrl: env('PUBLIC_BASE_URL', 'http://localhost:8080'),
  businessName: env('BUSINESS_NAME', 'Summit Field Services'),
  adminToken: env('ADMIN_TOKEN'),
  llmTimeoutMs: Number(env('LLM_TIMEOUT_MS', '20000')),
  ghl: {
    apiKey: env('GHL_API_KEY'),
    locationId: env('GHL_LOCATION_ID'),
    pipelineId: env('GHL_PIPELINE_ID'),
    stages: {
      new: env('GHL_STAGE_NEW'),
      qualified: env('GHL_STAGE_QUALIFIED'),
      quoted: env('GHL_STAGE_QUOTED'),
      won: env('GHL_STAGE_WON'),
    },
    baseUrl: env('GHL_BASE_URL', 'https://services.leadconnectorhq.com'),
    version: env('GHL_API_VERSION', '2021-07-28'),
  },
  // Comma-separated list of outbound webhook targets (twin.so agents, n8n,
  // Make, Zapier catch hooks). Each receives every platform event, signed.
  webhooks: env('OUTBOUND_WEBHOOK_URLS').split(',').map((s) => s.trim())
    .filter(Boolean),
  webhookSecret: env('WEBHOOK_SIGNING_SECRET'),
  twinWebhookUrl: env('TWIN_WEBHOOK_URL'),
  inboundWebhookSecret: env('INBOUND_WEBHOOK_SECRET'),
  bookingUrl: env('BOOKING_URL'),
  stripePaymentLinkBase: env('STRIPE_PAYMENT_LINK'),
};
