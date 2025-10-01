/**
 * Robust, framework-agnostic consent automation for Puppeteer or Playwright pages.
 * No configuration required. Will:
 *  - Try to click "accept all" for common CMPs (in all frames)
 *  - Retry upon DOM mutations for a while (late banners)
 *  - Force-remove overlays if clicking fails
 *  - Mark consent in storage/cookies for many libraries to prevent re-appearance
 *
 * Usage:
 *   const consent = require('./lib/consent-automation.cjs');
 *   await consent.handleConsent(page, { debug:true });
 *
 * Works with both Puppeteer and Playwright because it only uses shared APIs:
 *   - page.frames()
 *   - frame.evaluate()
 *   - page.addInitScript / page.evaluateOnNewDocument (best-effort)
 */

const DEFAULTS = {
  retryAttempts: parseInt(process.env.CONSENT_RETRY_ATTEMPTS || '15', 10),
  retryInterval: parseInt(process.env.CONSENT_RETRY_INTERVAL || '800', 10), // ms
  mutationWindow: parseInt(process.env.CONSENT_MUTATION_WINDOW || '7000', 10),
  iframeScan: (process.env.CONSENT_IFRAME_SCAN || 'true').toLowerCase() !== 'false',
  forceWaitMs: parseInt(process.env.FORCE_CONSENT_WAIT_MS || process.env.FORCE_CONSENT_WAIT || '0', 10),
  debug: (process.env.CONSENT_DEBUG || 'false').toLowerCase() === 'true',
  debugScreenshot: (process.env.CONSENT_DEBUG_SCREENSHOT || 'false').toLowerCase() === 'true',
  // Optional user-provided lists (newline or comma separated)
  extraSelectors: (process.env.CONSENT_EXTRA_SELECTORS || '').trim(),
  forceRemoveSelectors: (process.env.CONSENT_FORCE_REMOVE_SELECTORS || '').trim(),
  buttonTexts: (process.env.CONSENT_BUTTON_TEXTS || '').trim(),
};

const BUILTIN_BUTTON_TEXTS = [
  // German
  'alle cookies akzeptieren','accept all','allow all','akzeptieren','zustimmen','einverstanden','alles akzeptieren','einwilligen',
  // English
  'accept','agree','i agree','got it','allow','yes, i agree','ok','okay',
  // Spanish/Portuguese/Italian/French/etc.
  'aceptar','aceitar','aceptar todo','aceitar tudo','aceptar todas','aceitar todos',
  'accetta','accetta tutti','j\'accepte','tout accepter',
  // Nordics / Dutch
  'akzeptér alle','godta alle','tillåt alla','accepteren','alles toestaan'
];

const BUILTIN_SELECTORS = [
  // OneTrust
  '#onetrust-accept-btn-handler', '.ot-pc-accept-all', '.ot-sdk-container #accept-recommended-btn-handler',
  // Usercentrics
  'button[data-testid="uc-accept-all-button"]', 'button[id^="uc-center-container"] button[aria-label*="accept" i]',
  // Cookiebot
  '#CybotCookiebotDialogBodyLevelButtonAccept', '#CybotCookiebotDialogBodyButtonAccept',
  // consentmanager / Sourcepoint
  'button.sp_choice_type_11', '.sp-message-button[data-qa="accept-all"]', '.sp_msg_choice.sp_choice_type_11',
  // Klaro
  '.klaro .cm-btn-accept', '.klaro .cookie-modal-accept-all',
  // Didomi
  'div#didomi-host button[aria-label*="acept" i], #didomi-accept-button, .didomi-accept-button',
  // Complianz
  '.cmplz-accept', '.cmplz-btn-accept',
  // Generic accept labels
  'button[aria-label*="accept" i]', 'button[id*="accept" i]', 'button[class*="accept" i]',
  'button[aria-label*="zustimm" i]', 'button[class*="zustimm" i]'
];

const BUILTIN_FORCE_REMOVE = [
  // Common containers
  '#onetrust-banner-sdk', '#usercentrics-root', '#CybotCookiebotDialog',
  'div[id^="sp_message_container_"]', '.sp-message-container',
  '.cm-wrapper', '.cm__container', '.cc-window', '.cookie-consent', '.cookieconsent', '.cookiebar',
  'div[id*="cookie"]', 'div[class*="cookie"]', 'div[id*="consent"]', 'div[class*="consent"]',
  // Trusted Shops badges etc.
  '.ts-trustbadge', 'iframe[src*="trustedshops"]', '.trustbadge'
];

function mergeList(a, b) {
  const A = (Array.isArray(a) ? a : parseList(a)).filter(Boolean);
  const B = (Array.isArray(b) ? b : parseList(b)).filter(Boolean);
  return Array.from(new Set([...A, ...B]));
}
function parseList(text) {
  if (!text) return [];
  return text.split(/\r?\n|,/).map(s => s.trim()).filter(Boolean);
}

async function handleConsent(page, opts={}) {
  const cfg = {
    ...DEFAULTS,
    ...opts,
  };

  // Best effort: add a small init script that marks our intent and removes "overflow:hidden" lock patterns later
  try {
    if (page.addInitScript) {
      await page.addInitScript(() => {
        try { window.__ARCHIVER_AUTO_CONSENT__ = true; } catch {}
      });
    } else if (page.evaluateOnNewDocument) {
      await page.evaluateOnNewDocument(() => { try { window.__ARCHIVER_AUTO_CONSENT__ = true; } catch {} });
    }
  } catch {}

  if (cfg.forceWaitMs > 0) { await safeWait(page, cfg.forceWaitMs); }

  // Try sequence: click → retry on mutations → force remove → storage flags
  const clicked = await tryClickAllFrames(page, cfg);
  if (!clicked) {
    if (cfg.debug) console.log('[CONSENT] no click, will retry with mutations');
    const retried = await retryWithMutations(page, cfg);
    if (!retried) {
      if (cfg.debug) console.log('[CONSENT] fallback: force remove overlays');
      await forceRemoveOverlays(page, cfg);
    }
  }

  // Set storage/cookies flags to prevent reappearing on inner navigations
  await setStorageFlags(page, cfg);

  // Finally, remove scroll locks
  await unlockScrolling(page);

  if (cfg.debugScreenshot && page.screenshot) {
    try {
      await page.screenshot({ path: `consent-after-${Date.now()}.png`, fullPage: true });
    } catch {}
  }
}

/* ---------- Core routines ---------- */

async function tryClickAllFrames(page, cfg) {
  const frames = page.frames ? page.frames() : [];
  const btnTexts = mergeList(BUILTIN_BUTTON_TEXTS, cfg.buttonTexts);
  const selectors = mergeList(BUILTIN_SELECTORS, cfg.extraSelectors);

  // include main frame first always
  const ordered = orderFrames(frames);
  for (const frame of ordered) {
    try {
      const res = await frame.evaluate(async (btnTexts, selectors) => {
        function findByText(root, texts) {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          const matchers = texts.map(t => t.trim().toLowerCase()).filter(Boolean);
          const candidates = [];
          while (walker.nextNode()) {
            const el = walker.currentNode;
            if (!(el instanceof HTMLElement)) continue;
            const label = (el.innerText || el.textContent || '').trim().toLowerCase();
            if (!label) continue;
            for (const t of matchers) {
              if (label.includes(t)) {
                // prefer button-like
                if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') candidates.unshift(el);
                else candidates.push(el);
                break;
              }
            }
          }
          return candidates;
        }

        function clickable(el) {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const invisible = rect.width === 0 || rect.height === 0;
          const style = getComputedStyle(el);
          const hidden = (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0');
          return !(invisible || hidden);
        }

        // 1) selector hits
        for (const sel of selectors) {
          try {
            const el = document.querySelector(sel);
            if (el && clickable(el)) { el.click(); return { ok:true, how:'selector', sel }; }
          } catch {}
        }
        // 2) text hits
        const textCandidates = findByText(document.documentElement, btnTexts);
        for (const el of textCandidates) {
          try { if (clickable(el)) { el.click(); return { ok:true, how:'text', label: (el.innerText||'').slice(0,80) }; } } catch {}
        }
        // 3) try visible buttons inside typical containers
        const containers = [
          '#onetrust-banner-sdk', '#CybotCookiebotDialog', '#usercentrics-root',
          'div[id^="sp_message_container_"]', '.sp-message-container', '.cm-wrapper', '.cc-window', '.cookie-consent'
        ];
        for (const c of containers) {
          try {
            const box = document.querySelector(c);
            if (!box) continue;
            const buttons = box.querySelectorAll('button, [role="button"]');
            for (const b of buttons) {
              const lbl = (b.innerText||b.textContent||'').toLowerCase();
              if (lbl && btnTexts.some(t => lbl.includes(t))) {
                b.click();
                return { ok:true, how:'container', sel:c };
              }
            }
          } catch {}
        }

        return { ok:false };
      }, btnTexts, selectors);

      if (res?.ok) {
        if (cfg.debug) console.log('[CONSENT] clicked via', res);
        return true;
      }
    } catch (e) {
      if (cfg.debug) console.log('[CONSENT] frame eval error', e?.message);
    }
  }
  return false;
}

function orderFrames(frames) {
  if (!frames || !frames.length) return [];
  // Put main frame first; then others
  const main = frames.find(f => f === f.page?.mainFrame?.() || f === f._page?.mainFrame?.()) || frames[0];
  const rest = frames.filter(f => f !== main);
  return [main, ...rest];
}

async function retryWithMutations(page, cfg) {
  const timeoutAt = Date.now() + cfg.mutationWindow;
  let attempts = 0;
  while (Date.now() < timeoutAt && attempts < cfg.retryAttempts) {
    await safeWait(page, cfg.retryInterval);
    const ok = await tryClickAllFrames(page, cfg);
    if (ok) return true;
    attempts++;
  }
  return false;
}

async function forceRemoveOverlays(page, cfg) {
  const removeSelectors = mergeList(BUILTIN_FORCE_REMOVE, cfg.forceRemoveSelectors);
  try {
    await page.evaluate((sels) => {
      let removed = 0;
      for (const sel of sels) {
        document.querySelectorAll(sel).forEach(el => { try { el.remove(); removed++; } catch {} });
      }
      // common scroll lock classes
      const classes = ['modal-open','no-scroll','overflow-hidden','overflowHidden','fixed','stop-scrolling'];
      classes.forEach(c => document.documentElement.classList.remove(c));
      classes.forEach(c => document.body?.classList.remove(c));
      document.documentElement.style.overflow = '';
      if (document.body) document.body.style.overflow = '';
      return removed;
    }, removeSelectors);
  } catch {}
}

async function setStorageFlags(page, cfg) {
  try {
    await page.evaluate(() => {
      try {
        localStorage.setItem('cookieconsent_status','allow');
        localStorage.setItem('cmplz_consentstatus','allow');
        localStorage.setItem('uc_user_interaction','true'); // usercentrics
        localStorage.setItem('didomi_token','{"purposes":{"consent":{"all":true}}}');
        sessionStorage.setItem('cookieconsent_status','allow');
      } catch {}
      try {
        document.cookie = 'cookieconsent_status=allow; path=/; max-age='+(3600*24*365);
        document.cookie = 'cmplz_consentstatus=allow; path=/; max-age='+(3600*24*365);
      } catch {}
      try { window.dispatchEvent(new StorageEvent('storage')); } catch {}
    });
  } catch {}
}

async function unlockScrolling(page) {
  try {
    await page.evaluate(() => {
      const clear = (el)=>{ if(!el) return; el.style.setProperty('overflow','', 'important'); el.style.setProperty('position','', 'important'); el.style.setProperty('height','', 'important'); };
      clear(document.documentElement); clear(document.body);
      // Remove overlays with full viewport
      document.querySelectorAll('*').forEach(el=>{
        const st = getComputedStyle(el);
        if (st.position==='fixed' && parseInt(st.zIndex||'0',10) >= 1000 && (el.offsetHeight||0) >= window.innerHeight*0.6) {
          if (el.innerText && /cookie|consent/i.test(el.innerText)) {
            el.remove();
          }
        }
      });
    });
  } catch {}
}

async function safeWait(page, ms) {
  try { await page.waitForTimeout ? page.waitForTimeout(ms) : new Promise(r=>setTimeout(r,ms)); } catch {}
}

module.exports = {
  handleConsent,
  forceRemoveOverlays,
};
