// Front end: landing, conversational AI chat, conditional estimate wizard,
// quote + e-sign, onboarding portal, admin KPIs. No build step, no framework.
// All user/server text is rendered via textContent (never innerHTML).

const $ = (s) => document.querySelector(s);
const view = $('#view');
const fmt = (n, cur = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

async function api(path, body, opts = {}) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(`intake:${k}`)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`intake:${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
};

// Attribution: keep UTM/referrer so GHL knows which ad paid for the lead.
const source = (() => {
  const p = new URLSearchParams(location.search);
  const utm = Object.fromEntries([...p].filter(([k]) => k.startsWith('utm_') || ['gclid', 'fbclid'].includes(k)));
  const s = Object.keys(utm).length ? { ...utm, referrer: document.referrer, landing: location.pathname } : store.get('source');
  if (s) store.set('source', s);
  return s ?? { referrer: document.referrer };
})();

let CFG = null;

// ---------------------------------------------------------------- landing
function renderLanding() {
  const L = CFG.landing;
  view.replaceChildren(
    h('section', { class: 'hero' },
      h('div', {},
        h('h1', {}, L.headline),
        h('p', { class: 'sub' }, L.subhead),
        h('div', { class: 'cta-row' },
          h('a', { class: 'btn btn-primary btn-lg', href: '#/estimate' }, L.cta),
          h('button', { class: 'btn btn-ghost btn-lg', onclick: () => openChat('Show me how this works') }, 'Watch a 60-sec demo')),
        h('ul', {}, L.bullets.map((b) => h('li', {}, b)))),
      h('div', { class: 'card stack' },
        h('h3', {}, `Why homeowners choose ${CFG.business.name}`),
        CFG.business.proof.map((p) => h('div', { class: 'proof-row' }, h('span', { class: 'badge' }, '★'), h('span', {}, p))),
        h('p', { class: 'small muted' }, CFG.guarantee))),
    h('section', { class: 'proof' },
      CFG.packages.map((p) => h('div', { class: 'card' },
        h('h3', {}, p.label), h('p', { class: 'muted small' }, p.tagline),
        h('ul', { class: 'small' }, p.includes.map((i) => h('li', {}, i)))))),
    h('p', { class: 'small muted', style: 'margin-top:24px' }, `Service area: ${CFG.business.serviceArea}`),
  );
}

// ----------------------------------------------------------------- wizard
const wiz = { answers: store.get('answers') ?? {}, stepIdx: 0, steps: [], errors: {} };

async function refreshSteps(stepId) {
  const r = await api('/api/survey/step', { answers: wiz.answers, stepId });
  wiz.steps = r.steps;
  wiz.answers = r.answers;
  store.set('answers', wiz.answers);
  return r.errors;
}

async function renderWizard() {
  await refreshSteps();
  wiz.stepIdx = Math.min(wiz.stepIdx, wiz.steps.length - 1);
  drawWizard();
}

function drawWizard() {
  const qIndex = Object.fromEntries(CFG.flow.questions.map((q) => [q.id, q]));
  const step = wiz.steps[wiz.stepIdx];
  const pct = Math.round((wiz.stepIdx / wiz.steps.length) * 100);
  const setAnswer = async (id, v) => {
    wiz.answers[id] = v;
    delete wiz.errors[id];
    await refreshSteps(); // conditional logic: re-evaluate visible steps/questions
    drawWizard();
  };

  const field = (q) => {
    const v = wiz.answers[q.id];
    let input;
    if (q.type === 'single' || q.type === 'multi') {
      input = h('div', { class: 'opts', role: 'group', 'aria-label': q.label },
        q.options.map((o) => {
          const on = q.type === 'multi' ? (v ?? []).includes(o.value) : v === o.value;
          return h('button', {
            type: 'button', class: 'opt', 'aria-pressed': String(on),
            onclick: () => setAnswer(q.id, q.type === 'multi'
              ? (on ? v.filter((x) => x !== o.value) : [...(v ?? []), o.value]) : o.value),
          }, o.label);
        }));
    } else {
      const type = { email: 'email', phone: 'tel', number: 'number' }[q.type] ?? 'text';
      input = h('input', {
        type, value: v ?? '', min: q.min, max: q.max, id: `f-${q.id}`,
        inputmode: q.type === 'number' ? 'numeric' : null,
        autocomplete: { email: 'email', phone: 'tel', name: 'given-name', zip: 'postal-code' }[q.id] ?? null,
        onchange: (e) => { wiz.answers[q.id] = q.type === 'number' ? Number(e.target.value) : e.target.value; store.set('answers', wiz.answers); },
      });
    }
    return h('div', { class: 'q' },
      h('label', { class: 'q-label', for: `f-${q.id}` }, q.label, q.required ? '' : ' (optional)'),
      input,
      wiz.errors[q.id] && h('div', { class: 'err' }, wiz.errors[q.id]));
  };

  const next = async () => {
    const errs = await refreshSteps(step.id);
    wiz.errors = errs;
    if (Object.keys(errs).length) return drawWizard();
    if (wiz.stepIdx < wiz.steps.length - 1) { wiz.stepIdx += 1; return drawWizard(); }
    submitWizard();
  };

  view.replaceChildren(h('section', { class: 'card', style: 'max-width:720px;margin:0 auto' },
    h('div', { class: 'row' }, h('h2', {}, step.title), h('span', { class: 'spacer' }),
      h('span', { class: 'muted small' }, `Step ${wiz.stepIdx + 1} of ${wiz.steps.length}`)),
    h('div', { class: 'progress' }, h('span', { style: `width:${pct}%` })),
    step.questions.map((id) => field(qIndex[id])),
    h('div', { class: 'row' },
      wiz.stepIdx > 0 && h('button', { class: 'btn btn-ghost', onclick: () => { wiz.stepIdx -= 1; drawWizard(); } }, 'Back'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-primary', onclick: next }, wiz.stepIdx === wiz.steps.length - 1 ? 'See my estimate →' : 'Continue →'))));
}

async function submitWizard() {
  try {
    const r = await api('/api/survey/submit', { answers: wiz.answers, leadId: store.get('leadId'), source });
    if (r.leadId) store.set('leadId', r.leadId);
    renderOutcome(r);
  } catch (e) {
    alert(e.message);
  }
}

function renderOutcome(r) {
  if (r.outcome.action !== 'estimate' || !r.estimate) {
    view.replaceChildren(h('section', { class: 'card', style: 'max-width:640px;margin:0 auto' },
      h('h2', {}, 'Thanks — here’s the next step'),
      h('p', {}, r.outcome.message),
      r.outcome.action === 'book_call' && CFG.business.bookingUrl
        && h('a', { class: 'btn btn-primary', href: CFG.business.bookingUrl, target: '_blank', rel: 'noopener' }, 'Pick a time')));
    return;
  }
  view.replaceChildren(renderEstimate(r.estimate, r.leadId));
}

function renderEstimate(est, leadId) {
  const choose = async (pkgId, btn) => {
    btn.disabled = true;
    try {
      const q = await api('/api/quotes', { leadId, packageId: pkgId });
      location.hash = `#/quote/${q.id}`;
    } catch (e) { alert(e.message); btn.disabled = false; }
  };
  return h('section', { class: 'stack' },
    h('div', { class: 'card' },
      h('h2', {}, `Your instant ${est.serviceLabel.toLowerCase()} estimate`),
      h('p', { class: 'muted' }, `Typical range: ${fmt(est.range.low)} – ${fmt(est.range.high)}`),
      h('p', { class: 'small muted' }, est.disclaimer)),
    h('div', { class: 'packages' }, est.packages.map((p) => h('div', { class: `card pkg${p.recommended ? ' rec' : ''}` },
      p.recommended && h('span', { class: 'ribbon' }, 'Most popular'),
      h('h3', {}, p.label),
      h('div', { class: 'price' }, fmt(p.total)),
      p.monthly && h('div', { class: 'small muted' }, `or as low as ${fmt(p.monthly)}/mo`),
      h('p', { class: 'small muted' }, p.tagline),
      h('ul', { class: 'small' }, p.includes.map((i) => h('li', {}, i))),
      h('button', { class: `btn ${p.recommended ? 'btn-primary' : 'btn-ghost'}`, style: 'width:100%', onclick: (e) => choose(p.id, e.target) }, `Lock ${p.label} quote`)))),
    h('details', { class: 'card' }, h('summary', {}, 'See line items & assumptions'), lineItemsTable(est), h('ul', { class: 'small muted' }, est.assumptions.map((a) => h('li', {}, a)))));
}

function lineItemsTable(q) {
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', { class: 'num' }, 'Qty'), h('th', { class: 'num' }, 'Rate'), h('th', { class: 'num' }, 'Amount'))),
    h('tbody', {},
      q.lineItems.map((li) => h('tr', {}, h('td', {}, li.label), h('td', { class: 'num' }, `${li.qty.toLocaleString()} ${li.unit}`), h('td', { class: 'num' }, fmt(li.rate)), h('td', { class: 'num' }, li.total ? fmt(li.total) : 'Included'))),
      q.adjustments.map((a) => h('tr', {}, h('td', { colspan: 3 }, a.label), h('td', { class: 'num' }, fmt(a.amount)))))));
}

// ------------------------------------------------------------------ quote
async function renderQuote(id) {
  const q = await api(`/api/quotes/${id}`);
  const p = q.package;
  const sig = h('input', { placeholder: 'Type your full legal name', 'aria-label': 'Signature' });
  const agree = h('input', { type: 'checkbox', style: 'width:auto' });
  const msg = h('div', { class: 'err' });
  const accept = async (e) => {
    e.target.disabled = true;
    try {
      const r = await api(`/api/quotes/${id}/accept`, { signature: sig.value, agree: agree.checked });
      location.hash = `#/onboarding/${r.onboarding.id}`;
    } catch (err) { msg.textContent = err.message; e.target.disabled = false; }
  };
  view.replaceChildren(h('section', { class: 'card stack', style: 'max-width:820px;margin:0 auto' },
    h('div', { class: 'row' }, h('h2', {}, `Quote ${q.number}`), h('span', { class: 'spacer' }),
      h('span', { class: 'badge' }, q.expired ? 'Expired' : q.status)),
    h('p', { class: 'muted' }, `${q.serviceLabel} — ${p.label} package. Valid until ${new Date(q.expiresAt).toLocaleDateString()}.`),
    lineItemsTable(q),
    h('table', {}, h('tbody', {},
      (p.discount > 0 || p.tax > 0) && h('tr', {}, h('td', {}, `${p.label} package subtotal`), h('td', { class: 'num' }, fmt(p.subtotal))),
      p.discount > 0 && h('tr', {}, h('td', {}, q.discounts.map((d) => d.label).join(', ')), h('td', { class: 'num' }, `−${fmt(p.discount)}`)),
      p.tax > 0 && h('tr', {}, h('td', {}, 'Tax'), h('td', { class: 'num' }, fmt(p.tax))),
      h('tr', {}, h('th', {}, 'Total'), h('th', { class: 'num' }, fmt(p.total))),
      h('tr', {}, h('td', {}, 'Deposit due to reserve your date'), h('td', { class: 'num' }, fmt(p.deposit))),
      p.monthly && h('tr', {}, h('td', { class: 'muted' }, 'Financing available from'), h('td', { class: 'num muted' }, `${fmt(p.monthly)}/mo`)))),
    h('h3', {}, 'What’s included'), h('ul', {}, p.includes.map((i) => h('li', {}, i))),
    q.guarantee && h('p', { class: 'card small' }, '🛡️ ', q.guarantee),
    h('h3', {}, 'Terms'), h('ul', { class: 'small muted' }, q.terms.map((t) => h('li', {}, t))),
    q.status === 'accepted'
      ? h('a', { class: 'btn btn-accent', href: `#/onboarding/${q.onboardingId}` }, 'Signed ✓ — continue onboarding')
      : q.expired ? h('p', {}, 'This quote expired. Chat with us to refresh it at current pricing.')
        : h('div', { class: 'card stack' },
          h('h3', {}, 'Approve & e-sign'),
          sig,
          h('label', { class: 'row small' }, agree, 'I agree to the quote, terms and deposit amount above.'),
          h('button', { class: 'btn btn-primary btn-lg', onclick: accept }, `Approve & reserve my date`),
          msg,
          q.alternatives.length > 0 && h('p', { class: 'small muted' }, `Other options: ${q.alternatives.map((a) => `${a.label} ${fmt(a.total)}`).join(' · ')}`))));
}

// ------------------------------------------------------------- onboarding
async function renderOnboarding(id, openTask) {
  const ob = await api(`/api/onboarding/${id}`);
  const taskEl = (t) => {
    const done = t.status === 'done';
    const body = [];
    if (!done && t.owner === 'client' && openTask === t.id) {
      const inputs = {};
      const err = h('div', { class: 'err' });
      body.push(h('form', {
        class: 'stack', onsubmit: async (e) => {
          e.preventDefault();
          const data = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
          try { await api(`/api/onboarding/${id}/tasks/${t.id}`, { data }); renderOnboarding(id); } catch (x) { err.textContent = x.message; }
        },
      },
      t.fields.map((f) => {
        inputs[f.id] = f.type === 'textarea' ? h('textarea', { rows: 3 })
          : f.type === 'select' ? h('select', {}, h('option', { value: '' }, 'Choose…'), f.options.map((o) => h('option', { value: o }, o)))
            : h('input', {});
        return h('label', { class: 'stack small' }, `${f.label}${f.required ? ' *' : ''}`, inputs[f.id]);
      }),
      h('button', { class: 'btn btn-primary' }, t.type === 'pay' ? 'I’ve paid' : 'Save & complete'), err));
    }
    return h('div', { class: `task${done ? ' done' : ''}` },
      h('span', { class: 'dot' }, done ? '✓' : ''),
      h('div', {},
        h('div', { class: 'row' }, h('strong', {}, t.label), h('span', { class: 'spacer' }),
          h('span', { class: 'badge' }, t.owner === 'team' ? 'Our team' : done ? 'Done' : `Due ${new Date(t.dueAt).toLocaleDateString()}`)),
        t.description && h('div', { class: 'small muted' }, t.description),
        !done && t.owner === 'client' && openTask !== t.id && h('div', { class: 'row', style: 'margin-top:8px' },
          t.link && h('a', { class: 'btn btn-accent', href: t.link, target: '_blank', rel: 'noopener' }, 'Pay securely'),
          h('button', { class: 'btn btn-ghost', onclick: () => renderOnboarding(id, t.id) }, t.type === 'pay' ? 'Mark as paid' : 'Start')),
        body));
  };
  view.replaceChildren(h('section', { class: 'card', style: 'max-width:760px;margin:0 auto' },
    h('h2', {}, ob.status === 'complete' ? 'You’re all set 🎉' : `Welcome aboard — let’s get you scheduled`),
    h('p', { class: 'muted' }, `${ob.progress.done} of ${ob.progress.total} steps complete. Our crew is in the field — this portal keeps everything moving 24/7.`),
    h('div', { class: 'progress' }, h('span', { style: `width:${ob.progress.pct}%` })),
    ob.tasks.map(taskEl)));
}

// ------------------------------------------------------------------ admin
async function renderAdmin() {
  const token = store.get('admin') ?? prompt('Admin token');
  if (!token) return;
  try {
    const headers = { Authorization: `Bearer ${token}` };
    const [m, leads] = await Promise.all([api('/api/admin/metrics', null, { headers }), api('/api/admin/leads', null, { headers })]);
    store.set('admin', token);
    const tile = (label, value) => h('div', { class: 'card' }, h('div', { class: 'muted small' }, label), h('div', { style: 'font-size:1.6rem;font-weight:800' }, value));
    view.replaceChildren(h('section', { class: 'stack' },
      h('h2', {}, 'Pipeline'),
      h('div', { class: 'proof' },
        tile('Conversations', m.funnel.conversations), tile('Leads captured', m.funnel.leads),
        tile('Qualified', m.funnel.qualified), tile('Quoted', m.funnel.quoted), tile('Won', m.funnel.won),
        tile('Booked revenue', fmt(m.revenue.booked)), tile('Open pipeline', fmt(m.revenue.pipeline)),
        tile('After-hours leads', m.afterHoursLeads), tile('Close rate', `${Math.round(m.rates.closeRate * 100)}%`)),
      h('div', { class: 'card table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Created', 'Name', 'Service', 'Tier', 'Stage', 'Est.'].map((c) => h('th', {}, c)))),
        h('tbody', {}, leads.map((l) => h('tr', {},
          h('td', {}, new Date(l.createdAt).toLocaleString()), h('td', {}, l.answers.name ?? '—'),
          h('td', {}, l.answers.service ?? '—'), h('td', {}, h('span', { class: `badge ${l.score?.tier}` }, l.score?.tier ?? '—')),
          h('td', {}, l.stage), h('td', {}, l.estimate?.range ? `${fmt(l.estimate.range.low)}+` : '—'))))))));
  } catch (e) {
    store.set('admin', null);
    view.replaceChildren(h('p', { class: 'err' }, e.message));
  }
}

// ------------------------------------------------------------------- chat
const chat = { sessionId: store.get('sessionId'), leadId: store.get('leadId'), busy: false };
const log = $('#chat-log');

function bubble(who, text, extra) {
  const el = h('div', { class: `msg ${who}` }, text, extra);
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function setChips(list) {
  $('#chat-chips').replaceChildren(...(list ?? []).map((c) => h('button', { class: 'chip', type: 'button', onclick: () => send(c) }, c)));
}

async function send(text) {
  text = String(text ?? '').trim();
  if (!text || chat.busy) return;
  chat.busy = true;
  bubble('me', text);
  setChips([]);
  const typing = bubble('bot typing', 'typing…');
  try {
    const r = await api('/api/chat', { sessionId: chat.sessionId, message: text, source });
    chat.sessionId = r.sessionId; store.set('sessionId', r.sessionId);
    if (r.leadId) { chat.leadId = r.leadId; store.set('leadId', r.leadId); }
    typing.remove();
    let extra = null;
    if (r.estimate && !r.quote) {
      extra = h('div', { class: 'mini-pkgs' }, r.estimate.packages.map((p) => h('button', {
        class: `btn ${p.recommended ? 'btn-primary' : 'btn-ghost'}`,
        onclick: async () => {
          const q = await api('/api/quotes', { leadId: chat.leadId, packageId: p.id });
          bubble('bot', `Locked! Quote ${q.number}: ${fmt(q.package.total)}. Opening it now so you can review & e-sign.`);
          location.hash = `#/quote/${q.id}`;
        },
      }, `${p.label} — ${fmt(p.total)}${p.monthly ? ` (${fmt(p.monthly)}/mo)` : ''}`)));
    }
    if (r.quote) extra = h('a', { class: 'btn btn-accent', href: `#/quote/${r.quote.id}`, style: 'margin-top:8px' }, 'Review & e-sign quote');
    bubble('bot', r.reply, extra);
    setChips(r.nextQuestion?.options?.map((o) => o.label));
  } catch (e) {
    typing.remove();
    bubble('bot', `Sorry — ${e.message}`);
  } finally {
    chat.busy = false;
  }
}

function openChat(prefill) {
  $('#chat').hidden = false;
  $('#chat-launcher').hidden = true;
  if (!log.childElementCount) {
    bubble('bot', CFG.persona.greeting);
    setChips(CFG.persona.starters);
  }
  if (prefill) send(prefill);
  $('#chat-text').focus();
}

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('#chat-text');
  send(t.value);
  t.value = '';
});
function closeChat() {
  $('#chat').hidden = true;
  $('#chat-launcher').hidden = false;
}
$('#chat-close').addEventListener('click', closeChat);
document.querySelectorAll('[data-open-chat]').forEach((b) => b.addEventListener('click', () => openChat()));

// ----------------------------------------------------------------- router
async function route() {
  const [, page, id] = location.hash.split('/');
  if (page) closeChat(); // never cover the wizard / quote / portal
  try {
    if (page === 'estimate') return await renderWizard();
    if (page === 'quote' && id) return await renderQuote(id);
    if (page === 'onboarding' && id) return await renderOnboarding(id);
    if (page === 'admin') return await renderAdmin();
    renderLanding();
  } catch (e) {
    view.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Something went wrong'), h('p', {}, e.message)));
  }
}

(async () => {
  CFG = await api('/api/config');
  document.title = `${CFG.business.name} — Instant Estimate`;
  $('#brand').textContent = CFG.business.name;
  $('#chat-name').textContent = `${CFG.persona.name} · ${CFG.business.name}`;
  if (new URLSearchParams(location.search).has('embed')) {
    document.body.classList.add('embed');
    openChat();
    return;
  }
  window.addEventListener('hashchange', route);
  route();
  // Proactive engagement: open chat after 20s idle on the landing page.
  setTimeout(() => { if (!location.hash || location.hash === '#/') openChat(); }, 20000);
})();
