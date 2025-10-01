/* Adds "Prime: Mirror products" toggle and patches /api/run to include options.mirrorProducts */
(function () {
  function insertToggle() {
    // Place near the "Pre‑mirror target" select if present; otherwise near the main textarea
    const anchor = document.getElementById('premirror-target-wrap') || (document.querySelector('textarea')?.parentElement) || document.body;
    const box = document.createElement('label');
    box.id = 'mirror-products-wrap';
    box.style.display = 'flex';
    box.style.alignItems = 'center';
    box.style.gap = '8px';
    box.style.margin = '6px 0 0';
    box.innerHTML = `<input id="mirror-products-toggle" type="checkbox"> <span>Prime: Mirror products</span>`;
    anchor.appendChild(box);
  }

  function patchFetch() {
    if (!window.fetch || window.__mirror_products_patched__) return;
    window.__mirror_products_patched__ = true;
    const orig = window.fetch.bind(window);
    window.fetch = async function(input, init){
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.includes('/api/run') && init && typeof init.body === 'string') {
          const payload = JSON.parse(init.body);
          payload.options = payload.options || {};
          payload.options.mirrorProducts = !!document.getElementById('mirror-products-toggle')?.checked;
          init.body = JSON.stringify(payload);
        }
      } catch {}
      return orig(input, init);
    };
  }

  function start(){ insertToggle(); patchFetch(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
