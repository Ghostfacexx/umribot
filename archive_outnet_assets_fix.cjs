#!/usr/bin/env node
/**
 * Outnet Archiver v4 - Hardened
 *
 * PURPOSE:
 *  - Crawl a list of theoutnet.com category/listing pages.
 *  - Save rendered HTML (index.html) for each URL under a mirrored path.
 *  - Capture static assets (css/js/images/fonts/svg) into an assets/ folder.
 *  - Rewrite internal links to local relative form with trailing slash normalization.
 *  - Avoid hangs via per-page watchdog + navigation timeout.
 *  - Produce manifest.json summarizing status, HTTP status, final URL, asset counts.
 *
 * KEY ENV VARIABLES (override defaults):
 *   CONCURRENCY=4
 *   WAIT_EXTRA=800                     (ms passive wait after initial load)
 *   NAV_TIMEOUT_MS=20000               (per navigation timeout)
 *   OVERALL_PAGE_TIMEOUT_MS=45000      (total per page watchdog)
 *   SCROLL_PASSES=0                    (0 = no scrolling; increase if lazy content)
 *   SCROLL_DELAY=300
 *   ASSET_MAX_BYTES=4194304            (4 MB cap per asset)
 *   INCLUDE_CROSS_ORIGIN=true|false    (capture off-host assets)
 *   HEADLESS=false                     (to debug visually; default true)
 *
 * USAGE:
 *   node archive_outnet_assets_v4.cjs seeds.txt /var/www/outnet-archive
 *
 * RETRY FAILED OR ASSET-EMPTY PAGES:
 *   jq -r '.[] | select((.assets==0) or (.status|startswith("error"))) .url' manifest.json > retry.txt
 *   CONCURRENCY=2 WAIT_EXTRA=1500 SCROLL_PASSES=2 node archive_outnet_assets_v4.cjs retry.txt /var/www/outnet-archive
 *
 * NOTE:
 *  - Manifest written only at end (for streaming, adapt to JSONL if needed).
 *  - Script intentionally minimal in anti-bot countermeasures; add proxy/cookies if required.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

// ---------- CONFIG & ARG VALIDATION ----------
const seedsFile  = process.argv[2];
const outputRoot = process.argv[3];
if (!seedsFile || !outputRoot) {
  console.error('Usage: node archive_outnet_assets_v4.cjs <seeds.txt> <outputRoot>');
  process.exit(1);
}

const CONCURRENCY          = parseInt(process.env.CONCURRENCY || '4', 10);
const WAIT_EXTRA           = parseInt(process.env.WAIT_EXTRA || '800', 10);
const NAV_TIMEOUT          = parseInt(process.env.NAV_TIMEOUT_MS || '20000', 10);
const OVERALL_PAGE_TIMEOUT = parseInt(process.env.OVERALL_PAGE_TIMEOUT_MS || '45000', 10);
const SCROLL_PASSES        = parseInt(process.env.SCROLL_PASSES || '0', 10);
const SCROLL_DELAY         = parseInt(process.env.SCROLL_DELAY || '300', 10);
const ASSET_MAX_BYTES      = parseInt(process.env.ASSET_MAX_BYTES || (4 * 1024 * 1024), 10);
const INCLUDE_CROSS        = (process.env.INCLUDE_CROSS_ORIGIN || 'false').toLowerCase() === 'true';
const HEADLESS             = (process.env.HEADLESS || 'true').toLowerCase() !== 'false';

// ---------- HELPERS ----------
function readSeeds(file) {
  return [...new Set(
    fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && /theoutnet\.com/.test(l))
  )];
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function urlToLocal(u) {
  const x = new URL(u);
  let p = x.pathname.replace(/\/+$/, '');
  if (p === '') p = '/index';
  return p.replace(/^\/+/, '');
}

function hashShort(str) {
  return crypto.createHash('sha1').update(str).digest('hex').slice(0, 16);
}

function guessExt(url, ct) {
  // Try explicit path extension first
  let ext = '';
  try {
    const p = new URL(url).pathname;
    const m = p.match(/(\.[a-z0-9]{2,6})(?:$|[?#])/i);
    if (m) ext = (m[1] || '').toLowerCase();
  } catch {
    // ignore
  }
  if (ext) return ext;
  ct = ct || '';
  if (/image\/png/.test(ct)) return '.png';
  if (/image\/jpe?g/.test(ct)) return '.jpg';
  if (/image\/webp/.test(ct)) return '.webp';
  if (/image\/gif/.test(ct)) return '.gif';
  if (/text\/css/.test(ct)) return '.css';
  if (/javascript|ecmascript/.test(ct)) return '.js';
  if (/font\/woff2/.test(ct)) return '.woff2';
  if (/font\/woff/.test(ct)) return '.woff';
  if (/font\/ttf/.test(ct)) return '.ttf';
  if (/svg/.test(ct)) return '.svg';
  return '.bin';
}

function isLikelyAsset(url, ct) {
  const ext = guessExt(url, ct);
  if (/\.(png|jpe?g|webp|gif|svg|css|js|mjs|cjs|woff2?|ttf|otf)$/i.test(ext)) return true;
  if (/^(image|font)\//.test(ct)) return true;
  if (/text\/css/.test(ct)) return true;
  if (/javascript|ecmascript/.test(ct)) return true;
  return false;
}

// ---------- SCROLL ----------
async function safeScroll(page) {
  for (let i = 0; i < SCROLL_PASSES; i++) {
    try {
      await page.evaluate(() => {
        const s = document.scrollingElement || document.documentElement;
        if (s) s.scrollBy(0, s.scrollHeight);
      });
    } catch {
      // ignore
    }
    await page.waitForTimeout(SCROLL_DELAY);
  }
}

// ---------- CAPTURE ----------
async function capture(context, url, outRoot) {
  const localPath = urlToLocal(url);
  const pageDir = path.join(outRoot, localPath);
  const assetsDir = path.join(pageDir, 'assets');
  ensureDir(pageDir);
  ensureDir(assetsDir);

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  const assetMap = new Map();
  let status = 'ok';
  let finalURL = null;
  let mainStatus = null;
  let timedOut = false;
  const deadline = Date.now() + OVERALL_PAGE_TIMEOUT;

  // Asset response listener
  page.on('response', async resp => {
    try {
      const req = resp.request();
      const rUrl = req.url();
      const ct = (resp.headers()['content-type'] || '').toLowerCase();

      // Host filtering
      if (!INCLUDE_CROSS) {
        const mh = (new URL(url)).host;
        const rh = (new URL(rUrl)).host;
        if (rh !== mh && !rh.endsWith('theoutnet.com')) return;
      }
      if (assetMap.has(rUrl)) return;

      if (!isLikelyAsset(rUrl, ct)) return;

      const hdrLen = resp.headers()['content-length'];
      if (hdrLen && Number(hdrLen) > ASSET_MAX_BYTES) return;

      const buf = await resp.body();
      if (buf.length > ASSET_MAX_BYTES) return;

      const filename = hashShort(rUrl) + guessExt(rUrl, ct);
      fs.writeFileSync(path.join(assetsDir, filename), buf);
      assetMap.set(rUrl, 'assets/' + filename);
    } catch {
      // ignore single asset errors
    }
  });

  try {
    const navResp = await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (navResp) {
      mainStatus = navResp.status();
      finalURL = navResp.url();
    } else {
      finalURL = page.url();
    }

    // Wait for <body> if possible
    await page.waitForSelector('body', { timeout: 10000 }).catch(() => {});

    if (SCROLL_PASSES > 0) {
      await safeScroll(page);
    }

    if (WAIT_EXTRA > 0) {
      await page.waitForTimeout(WAIT_EXTRA);
    }

    // Rewrite internal links safely
    await page.evaluate(() => {
      if (!document.body) return;
      const fix = href => {
        try {
          const u = new URL(href, location.href);
            if (u.hostname.endsWith('theoutnet.com')) {
              let p = u.pathname.replace(/\/+$/, '');
              if (p === '') p = '/index';
              return p + '/';
            }
        } catch {}
        return href;
      };
      document.querySelectorAll('a[href]').forEach(a => {
        a.setAttribute('href', fix(a.getAttribute('href')));
      });
    }).catch(() => {});
  } catch (e) {
    status = 'error:' + e.message;
  } finally {
    if (Date.now() > deadline && !status.startsWith('error')) {
      status = 'error:timeout';
      timedOut = true;
    }
  }

  // Persist HTML even if error
  try {
    const html = await page.content();
    fs.writeFileSync(path.join(pageDir, 'index.html'), html, 'utf8');
  } catch {
    // ignored
  }

  await page.close();
  return {
    url,
    localPath,
    status,
    mainStatus,
    finalURL,
    assets: assetMap.size,
    timedOut
  };
}

// ---------- MAIN ----------
(async () => {
  const urls = readSeeds(seedsFile);
  console.log(`Total URLs: ${urls.length}  Concurrency: ${CONCURRENCY}`);
  ensureDir(outputRoot);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    locale: 'en-US',
    viewport: { width: 1366, height: 900 }
  });

  // Light stealth
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
  });

  const queue = [...urls];
  const manifest = [];
  let processed = 0;

  async function worker(id) {
    while (queue.length) {
      const u = queue.shift();
      processed++;
      process.stdout.write(`[W${id}] (${processed}/${urls.length}) ${u}\n`);
      const res = await capture(context, u, outputRoot);
      manifest.push(res);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));

  manifest.sort((a, b) => a.url.localeCompare(b.url));
  fs.writeFileSync(path.join(outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const failures = manifest.filter(m => !m.status.startsWith('ok'));
  console.log(`Done. Pages: ${manifest.length}, Failures: ${failures.length}, TotalAssets: ${manifest.reduce((s,m)=>s+m.assets,0)}`);
  if (failures.length) {
    console.log('First few failures:');
    failures.slice(0, 10).forEach(f => console.log(' -', f.url, f.status));
  }

  await browser.close();
})().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});