#!/usr/bin/env node
/**
 * Outnet Archiver v2 - with robust asset capture.
 *
 * Usage:
 *   CONCURRENCY=4 WAIT_EXTRA=1500 node archive_outnet_assets.cjs seeds.txt /var/www/outnet-archive
 *
 * Env:
 *   CONCURRENCY            workers (default 4)
 *   WAIT_EXTRA             ms after networkidle (default 1200)
 *   TIMEOUT_NAV            navigation timeout (default 45000)
 *   RETRIES                retries per page (default 1)
 *   ASSET_MAX_BYTES        max single asset size (default 5242880 = 5MB)
 *   INCLUDE_CROSS_ORIGIN   "true" to save assets from other origins (default false)
 *   EXTRA_WAIT_SCROLL      extra scroll passes (default 0)
 *
 * Output:
 *   /<root>/<path>/index.html
 *   /<root>/<path>/assets/<hash>.<ext>
 *   manifest.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

const seedsFile = process.argv[2];
const outputRoot = process.argv[3];
if (!seedsFile || !outputRoot) {
  console.error('Usage: node archive_outnet_assets.cjs seeds.txt /output/root');
  process.exit(1);
}

const CONCURRENCY = parseInt(process.env.CONCURRENCY || '4', 10);
const WAIT_EXTRA = parseInt(process.env.WAIT_EXTRA || '1200', 10);
const TIMEOUT_NAV = parseInt(process.env.TIMEOUT_NAV || '45000', 10);
const RETRIES = parseInt(process.env.RETRIES || '1', 10);
const ASSET_MAX_BYTES = parseInt(process.env.ASSET_MAX_BYTES || (5 * 1024 * 1024), 10);
const INCLUDE_CROSS = (process.env.INCLUDE_CROSS_ORIGIN || 'false').toLowerCase() === 'true';
const EXTRA_WAIT_SCROLL = parseInt(process.env.EXTRA_WAIT_SCROLL || '0', 10);

const ALLOWED_EXT = new Set([
  '.css','.js','.mjs','.cjs','.png','.jpg','.jpeg','.webp','.gif','.svg',
  '.woff2','.woff','.ttf','.otf'
]);

const BLOCK_PATTERNS = [
  /analytics/i,
  /doubleclick/i,
  /google-?tag/i,
  /gtm\.js/i,
  /facebook/i,
  /hotjar/i,
  /pixel/i
];

function readSeeds(f) {
  return [...new Set(
    fs.readFileSync(f,'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && /theoutnet\.com/.test(l))
  )];
}

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function urlToLocal(u) {
  const x = new URL(u);
  let p = x.pathname.replace(/\/+$/, '');
  if (p === '') p = '/index';
  return p.replace(/^\/+/, '');
}

function hashName(url, ext) {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0,16) + ext;
}

function shouldBlock(url) {
  return BLOCK_PATTERNS.some(r => r.test(url));
}

function getExtFromUrl(u) {
  try {
    const p = new URL(u).pathname;
    const m = p.match(/(\.[a-z0-9]{2,6})(?:$|[?#])/i);
    return m ? m[1].toLowerCase() : '';
  } catch { return ''; }
}

async function scrollPage(page, passes = 2, delay = 400) {
  for (let i=0;i<passes;i++) {
    await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
    await page.waitForTimeout(delay);
  }
}

async function capture(context, url, root) {
  const localPath = urlToLocal(url);
  const dir = path.join(root, localPath);
  const assetsDir = path.join(dir, 'assets');
  ensureDir(assetsDir);

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(TIMEOUT_NAV);

  const assetMap = new Map();
  const skipped = { blocked:0, size:0, type:0, cross:0 };

  page.on('response', async resp => {
    try {
      const req = resp.request();
      const rUrl = req.url();
      if (shouldBlock(rUrl)) { skipped.blocked++; return; }

      // Restrict same-origin unless INCLUDE_CROSS specified
      const mainHost = (new URL(url)).host;
      if (!INCLUDE_CROSS) {
        if ((new URL(rUrl)).host !== mainHost &&
            !(new URL(rUrl)).host.endsWith('theoutnet.com')) {
          skipped.cross++; return;
        }
      }
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      const extGuess = getExtFromUrl(rUrl);
      const isLikely =
        ALLOWED_EXT.has(extGuess) ||
        /image\//.test(ct) ||
        /font\//.test(ct) ||
        /javascript|ecmascript/.test(ct) ||
        /text\/css/.test(ct) ||
        (extGuess === '.svg');

      if (!isLikely) { skipped.type++; return; }

      if (assetMap.has(rUrl)) return;

      // Size check from header if available
      const hdrLen = resp.headers()['content-length'];
      if (hdrLen && Number(hdrLen) > ASSET_MAX_BYTES) { skipped.size++; return; }

      const buf = await resp.body();
      if (buf.length > ASSET_MAX_BYTES) { skipped.size++; return; }

      let ext = extGuess;
      if (!ext || ext === '.svg' && !/svg/.test(ct)) {
        if (/image\/png/.test(ct)) ext = '.png';
        else if (/image\/jpe?g/.test(ct)) ext = '.jpg';
        else if (/image\/gif/.test(ct)) ext = '.gif';
        else if (/image\/webp/.test(ct)) ext = '.webp';
        else if (/text\/css/.test(ct)) ext = '.css';
        else if (/javascript|ecmascript/.test(ct)) ext = '.js';
        else if (/font\/woff2/.test(ct)) ext = '.woff2';
        else if (/font\/woff/.test(ct)) ext = '.woff';
        else if (/font\/ttf/.test(ct)) ext = '.ttf';
        else if (/svg/.test(ct)) ext = '.svg';
      }

      if (!ext) ext = '.bin';
      const fname = hashName(rUrl, ext);
      fs.writeFileSync(path.join(assetsDir, fname), buf);
      assetMap.set(rUrl, 'assets/' + fname);
    } catch (_) {}
  });

  let status = 'ok';
  let attempts = 0;
  while (attempts <= RETRIES) {
    attempts++;
    try {
      await page.goto(url, { waitUntil: 'networkidle' });
      if (EXTRA_WAIT_SCROLL > 0) {
        await scrollPage(page, EXTRA_WAIT_SCROLL);
      }
      if (WAIT_EXTRA > 0) await page.waitForTimeout(WAIT_EXTRA);

      // Rewrite internal links
      await page.evaluate(() => {
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
      });

      // Rewrite asset references
      await page.evaluate((pairs) => {
        const m = new Map(pairs);
        const rules = [['img','src'],['script','src'],['link','href'],['source','src'],['video','poster']];
        for (const [sel, attr] of rules) {
          document.querySelectorAll(`${sel}[${attr}]`).forEach(el => {
            const v = el.getAttribute(attr);
            try {
              const abs = new URL(v, location.href).href;
              if (m.has(abs)) el.setAttribute(attr, m.get(abs));
            } catch {}
          });
        }
      }, Array.from(assetMap.entries()));

      // Save HTML
      const html = await page.content();
      ensureDir(dir);
      fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
      break;
    } catch (e) {
      if (attempts > RETRIES) {
        status = 'error:' + e.message;
      } else {
        await page.waitForTimeout(900);
      }
    }
  }
  await page.close();
  return {
    url,
    localPath,
    status,
    assets: assetMap.size,
    skipped,
    attempts
  };
}

(async () => {
  const urls = readSeeds(seedsFile);
  console.log(`Total URLs: ${urls.length}  Concurrency: ${CONCURRENCY}  Retries: ${RETRIES}  IncludeCross=${INCLUDE_CROSS}`);

  ensureDir(outputRoot);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    locale: 'en-US'
  });

  const queue = [...urls];
  const manifest = [];
  let done = 0;

  async function worker(id) {
    while (queue.length) {
      const u = queue.shift();
      done++;
      process.stdout.write(`[W${id}] (${done}/${urls.length}) ${u}\n`);
      const res = await capture(context, u, outputRoot);
      manifest.push(res);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i+1)));
  fs.writeFileSync(path.join(outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('Manifest updated:', path.join(outputRoot, 'manifest.json'));

  const failed = manifest.filter(m => !m.status.startsWith('ok'));
  if (failed.length) {
    console.log(`Failed (${failed.length}):`);
    failed.slice(0,20).forEach(f => console.log(' -', f.url, f.status));
  }
  await browser.close();
})();
