// Drop-in widget for any site (GoHighLevel funnels, WordPress, Wix, Webflow):
//   <script src="https://YOUR-APP-URL/embed.js" defer></script>
// Adds a floating "Get a price now" button that opens the AI advisor in an
// iframe. UTM params from the host page are forwarded for attribution.
(() => {
  const origin = new URL(document.currentScript.src).origin;
  const params = new URLSearchParams(location.search);
  params.set('embed', '1');
  const btn = document.createElement('button');
  btn.textContent = '💬 Get a price now';
  btn.setAttribute('aria-label', 'Open estimate chat');
  Object.assign(btn.style, {
    position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483646, border: '0',
    borderRadius: '999px', padding: '14px 20px', background: '#0b6bcb', color: '#fff',
    font: '600 15px system-ui, sans-serif', boxShadow: '0 8px 30px rgba(0,0,0,.2)', cursor: 'pointer',
  });
  let frame;
  btn.onclick = () => {
    if (!frame) {
      frame = document.createElement('iframe');
      frame.src = `${origin}/?${params}`;
      frame.title = 'Instant estimate chat';
      Object.assign(frame.style, {
        position: 'fixed', right: '16px', bottom: '80px', width: 'min(400px, calc(100vw - 32px))',
        height: 'min(620px, calc(100vh - 110px))', border: '1px solid #dde1e8', borderRadius: '16px',
        zIndex: 2147483647, background: '#fff', boxShadow: '0 8px 30px rgba(0,0,0,.2)',
      });
      document.body.appendChild(frame);
    } else {
      frame.hidden = !frame.hidden;
    }
  };
  document.body.appendChild(btn);
})();
