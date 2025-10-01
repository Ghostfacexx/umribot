/* Injects "Pre‑mirror target" dropdown and ensures /api/run includes options.targetPlatform. */
(function () {
  const STORAGE_KEY = 'premirror_target_platform';

  function getSaved() {
    try { return localStorage.getItem(STORAGE_KEY) || 'generic'; } catch { return 'generic'; }
  }
  function save(val) { try { localStorage.setItem(STORAGE_KEY, val); } catch {} }

  function currentValue() {
    const sel = document.getElementById('premirror-target-select');
    return (sel && sel.value) || getSaved();
  }

  function insertUI() {
    const ta = document.querySelector('textarea');
    const host = (ta && ta.parentElement) ? ta.parentElement : document.body;

    const wrap = document.createElement('div');
    wrap.id = 'premirror-target-wrap';
    wrap.style.margin = '8px 0 6px 0';
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '8px';

    const label = document.createElement('label');
    label.textContent = 'Pre‑mirror target';
    label.setAttribute('for', 'premirror-target-select');
    label.style.fontWeight = '600';

    const sel = document.createElement('select');
    sel.id = 'premirror-target-select';
    sel.className = 'form-select';
    sel.style.maxWidth = '260px';

    const opts = [
      { v: 'generic', t: 'Generic' },
      { v: 'woocommerce', t: 'WooCommerce (WXR pages)' },
      { v: 'shopify', t: 'Shopify (Liquid sections)' }
    ];
    const saved = getSaved();
    opts.forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.v; opt.textContent = o.t;
      if (o.v === saved) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => save(sel.value));

    const hint = document.createElement('span');
    hint.textContent = 'Determines how the mirror is prepped during capture.';
    hint.style.color = '#666';
    hint.style.fontSize = '12px';

    wrap.appendChild(label);
    wrap.appendChild(sel);
    wrap.appendChild(hint);

    if (ta && ta.parentNode) ta.parentNode.insertBefore(wrap, ta.nextSibling);
    else document.body.prepend(wrap);
  }

  function patchFetch() {
    if (!window.fetch || window.__premirror_fetch_patched__) return;
    const orig = window.fetch.bind(window);
    window.__premirror_fetch_patched__ = true;

    window.fetch = async function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const isRun = url.includes('/api/run');

        if (isRun && init && typeof init.body === 'string') {
          try {
            const payload = JSON.parse(init.body);
            payload.options = payload.options || {};
            payload.options.targetPlatform = currentValue() || 'generic';
            init.body = JSON.stringify(payload);
          } catch {}
        }
      } catch {}
      return orig(input, init);
    };
  }

  function start() { insertUI(); patchFetch(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();