/* Fast Woo preset:
   - Only affects POST /api/run when options.targetPlatform === 'woocommerce'
   - Keeps your chosen Depth / Max pages (does NOT change them)
   - Sets fast/safe defaults to match generic archiver speed
   - Skips if disabled via ?no_fast_woo=1 or localStorage.FAST_WOO_DISABLE === '1'
*/
(function () {
  const OFF =
    /\bno_fast_woo=1\b/i.test(location.search) ||
    (typeof localStorage !== 'undefined' && localStorage.getItem('FAST_WOO_DISABLE') === '1');

  if (OFF) return;

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    try {
      const url = (typeof input === 'string') ? input : (input && input.url) || '';
      const isRun = /\/api\/run(?:\?|$)/.test(url);
      if (!isRun || !init || !init.method || String(init.method).toUpperCase() !== 'POST') {
        return origFetch.apply(this, arguments);
      }

      // Read JSON body safely
      let bodyObj = null;
      if (init.body && typeof init.body === 'string') {
        try { bodyObj = JSON.parse(init.body); } catch {}
      } else if (init.body && init.body instanceof Blob) {
        const text = await init.body.text();
        try { bodyObj = JSON.parse(text); } catch {}
      } else if (init.body && typeof init.body === 'object') {
        bodyObj = init.body; // already an object (rare)
      }

      if (!bodyObj || typeof bodyObj !== 'object') {
        return origFetch.apply(this, arguments);
      }

      const opts = bodyObj.options = bodyObj.options || {};
      const target = String(opts.targetPlatform || '').toLowerCase();
      if (target !== 'woocommerce') {
        return origFetch.apply(this, arguments);
      }

      // Do not override user’s Depth/Max pages — only fast toggles.
      const setIfUndef = (k, v) => { if (opts[k] === undefined) opts[k] = v; };

      // Run as fast as generic archiver
      setIfUndef('profiles', 'desktop');               // desktop only unless user changed it
      setIfUndef('aggressiveCapture', false);          // no broad expansion
      setIfUndef('scrollPasses', 1);                   // minimal scroll
      setIfUndef('waitExtra', 120);                    // short post-load wait
      setIfUndef('navTimeout', 9000);
      setIfUndef('pageTimeout', 25000);
      setIfUndef('engine', 'chromium');                // keep chromium for JS sites

      // Scope — keep it tight
      setIfUndef('autoExpandSameHostOnly', true);
      setIfUndef('autoExpandSubdomains', false);
      setIfUndef('mirrorSubdomains', false);
      setIfUndef('mirrorCrossOrigin', false);
      setIfUndef('includeCrossOrigin', false);

      // Don’t waste time on products here; use the Products-only tool if needed
      setIfUndef('mirrorProducts', false);

      // Archiver work — keep light; exporter will inline/bake CSS later
      setIfUndef('rewriteHtmlAssets', false);          // avoid heavy HTML asset rewriting
      setIfUndef('rewriteInternal', true);
      setIfUndef('inlineSmallAssets', 0);
      setIfUndef('assetMaxBytes', 2 * 1024 * 1024);    // 2MB cap is plenty for CSS/JS

      // Consent handling off (fast path)
      setIfUndef('consentRetryAttempts', 0);
      setIfUndef('consentIframeScan', false);
      setIfUndef('consentDebug', false);
      setIfUndef('consentDebugScreenshot', false);

      // Keep unlimited time budget unless user set it (0 means unlimited)
      if (opts.maxCaptureMs === undefined) opts.maxCaptureMs = 0;

      // Optionally keep product routes out of expansion to accelerate coverage
      if (!opts.autoExpandDenyRegex) {
        // Don’t touch the user’s own denyRegex if they already set one
        opts.autoExpandDenyRegex = '(?:\\?|&)route=product\\/(?:product|category)(?:&|$)|(?:\\?|&)product_id=\\d+|captcha|\\/cart|\\/checkout|\\/account';
      }

      const newInit = { ...init };
      const headers = new Headers(init.headers || {});
      headers.set('Content-Type', 'application/json');
      newInit.headers = headers;
      newInit.body = JSON.stringify(bodyObj);
      return origFetch.call(this, input, newInit);
    } catch (e) {
      // If anything goes wrong, do not block the request
      return origFetch.apply(this, arguments);
    }
  };
})();
