#!/usr/bin/env node
/**
 * Outnet Archiver (archiver.cjs)
 *
 * Consolidated "v6+" script with:
 *  - Proxy support (stable or rotating session usernames)
 *  - Optional engine selection: ENGINE=chromium|firefox|webkit
 *  - Optional cross-origin asset capture
 *  - Optional scroll passes
 *  - Per-page fresh browser (max isolation) OR pooled mode (BROWSER_POOL=true)
 *  - Robust navigation (waitUntil=commit) + fallback attempts
 *  - Raw proxied fetch fallback using HttpsProxyAgent (proper proxy auth) if browser navigation fails
 *  - Rich client hints / Sec-Fetch headers
 *  - HTTP/2 disable toggle for Chromium (--disable-http2)
 *  - Incremental JSONL log (manifest.partial.jsonl) + final manifest.json
 *
 * IMPORTANT: The target currently returns HTTP/2 INTERNAL_ERROR / EMPTY_RESPONSE for your proxy IPs.
 * This script adds maximum flexibility; success still depends on unblocked egress.
 *
 * ENV VARIABLES (defaults shown):
 *  ENGINE=chromium                  # chromium | firefox | webkit
 *  CONCURRENCY=2
 *  HEADLESS=true
 *  INCLUDE_CROSS_ORIGIN=false
 *  WAIT_EXTRA=700                   # ms passive wait after basic load steps
 *  NAV_TIMEOUT_MS=20000
 *  PAGE_TIMEOUT_MS=40000
 *  SCROLL_PASSES=0
 *  SCROLL_DELAY=250
 *  ASSET_MAX_BYTES=3145728          # 3MB
 *  PROXIES_FILE=/root/SingleFile/SingleFile/proxies.json
 *  STABLE_SESSION=true              # keep base username session chunk
 *  ROTATE_EVERY=0                   # rotate base proxy index every N pages (0 = never)
 *  ROTATE_SESSION=false             # mutate session-* suffix each page (ignored if STABLE_SESSION=true)
 *  DISABLE_HTTP2=false              # chromium only; true adds --disable-http2
 *  BROWSER_POOL=false               # if true, reuse a small pool of browsers (one per worker)
 *  RAW_ONLY=false                   # if true, skip browser entirely; just raw fetch via proxy
 *  RETRIES=1                        # extra browser nav attempts
 *  ALT_USER_AGENTS=""               # comma-separated list of UAs to rotate (chromium-like)
 *  HAR_CAPTURE=false                # if true, saves simplistic request list per page (_debug/<hash>.requests)
 *
 * USAGE:
 *   node archiver.cjs seeds.txt /var/www/outnet-archive
 *
 * RETRY FAILED:
 *   jq -r '.[] | select((.status|startswith("error")) or (.assets==0)) .url' manifest.json > retry.txt
 *   ENGINE=chromium STABLE_SESSION=true CONCURRENCY=1 node archiver.cjs retry.txt /var/www/outnet-archive
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium, firefox, webkit } = require('playwright');
const { HttpsProxyAgent } = require('https-proxy-agent');
const https = require('https');

// ---------- ARG / ENV ----------
const seedsFile = process.argv[2];
const outputRoot = process.argv[3];
if (!seedsFile || !outputRoot) {
  console.error('Usage: node archiver.cjs <seedsFile> <outputRoot>');
  process.exit(1);
}

const ENGINE            = (process.env.ENGINE || 'chromium').toLowerCase();
const CONCURRENCY       = parseInt(process.env.CONCURRENCY || '2', 10);
const HEADLESS          = (process.env.HEADLESS || 'true').toLowerCase() !== 'false';
const INCLUDE_CROSS     = (process.env.INCLUDE_CROSS_ORIGIN || 'false').toLowerCase() === 'true';
const WAIT_EXTRA        = parseInt(process.env.WAIT_EXTRA || '700', 10);
const NAV_TIMEOUT       = parseInt(process.env.NAV_TIMEOUT_MS || '20000', 10);
const PAGE_TIMEOUT      = parseInt(process.env.PAGE_TIMEOUT_MS || '40000', 10);
const SCROLL_PASSES     = parseInt(process.env.SCROLL_PASSES || '0', 10);
const SCROLL_DELAY      = parseInt(process.env.SCROLL_DELAY || '250', 10);
const ASSET_MAX_BYTES   = parseInt(process.env.ASSET_MAX_BYTES || (3*1024*1024), 10);
const PROXIES_FILE      = process.env.PROXIES_FILE || '/root/SingleFile/SingleFile/proxies.json';
const STABLE_SESSION    = (process.env.STABLE_SESSION || 'true').toLowerCase() === 'true';
const ROTATE_EVERY      = parseInt(process.env.ROTATE_EVERY || '0', 10);
const ROTATE_SESSION    = (process.env.ROTATE_SESSION || 'false').toLowerCase() === 'true';
const DISABLE_HTTP2     = (process.env.DISABLE_HTTP2 || 'false').toLowerCase() === 'true';
const BROWSER_POOL      = (process.env.BROWSER_POOL || 'false').toLowerCase() === 'true';
const RAW_ONLY          = (process.env.RAW_ONLY || 'false').toLowerCase() === 'true';
const RETRIES           = parseInt(process.env.RETRIES || '1', 10);
const ALT_USER_AGENTS   = (process.env.ALT_USER_AGENTS || '').split(',').map(s => s.trim()).filter(Boolean);
const HAR_CAPTURE       = (process.env.HAR_CAPTURE || 'false').toLowerCase() === 'true';

// ---------- UTIL ----------
function readSeeds(file) {
  return [...new Set(
    fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && /theoutnet\.com/.test(l))
  )];
}
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function localPath(u) {
  const x = new URL(u);
  let p = x.pathname.replace(/\/+$/,'');
  if (p === '') p = '/index';
  return p.replace(/^\/+/, '');
}
function shortHash(str) {
  return crypto.createHash('sha1').update(str).digest('hex').slice(0,16);
}
function randSession() {
  return crypto.randomBytes(4).toString('hex');
}
function guessExt(url,ct) {
  let m;
  try { m=(new URL(url).pathname.match(/(\.[a-z0-9]{2,6})(?:$|[?#])/i)||[])[1]; } catch {}
  if (m) return m.toLowerCase();
  ct=ct||'';
  if (/png/.test(ct)) return '.png';
  if (/jpe?g/.test(ct)) return '.jpg';
  if (/webp/.test(ct)) return '.webp';
  if (/gif/.test(ct)) return '.gif';
  if (/css/.test(ct)) return '.css';
  if (/javascript|ecmascript/.test(ct)) return '.js';
  if (/woff2/.test(ct)) return '.woff2';
  if (/woff/.test(ct)) return '.woff';
  if (/ttf/.test(ct)) return '.ttf';
  if (/svg/.test(ct)) return '.svg';
  return '.bin';
}
function isLikelyAsset(url,ct) {
  if (/\.(png|jpe?g|webp|gif|svg|css|js|mjs|cjs|woff2?|ttf|otf)$/i.test(url)) return true;
  if (/^(image|font)\//.test(ct)) return true;
  if (/css/.test(ct) || /javascript|ecmascript/.test(ct)) return true;
  return false;
}
async function safeScroll(page) {
  for (let i=0;i<SCROLL_PASSES;i++) {
    try {
      await page.evaluate(() => {
        const s = document.scrollingElement || document.documentElement;
        if (s) s.scrollBy(0, s.scrollHeight);
      });
    } catch {}
    await page.waitForTimeout(SCROLL_DELAY);
  }
}

// ---------- PROXY MGMT ----------
let proxies = [];
try {
  proxies = JSON.parse(fs.readFileSync(PROXIES_FILE,'utf8'));
  if (!Array.isArray(proxies) || proxies.length === 0) throw new Error();
} catch {
  console.error('Failed to parse proxies file:', PROXIES_FILE);
  process.exit(1);
}
let proxyIndex = 0;

function nextProxy(pageNumber) {
  // Rotate base proxy index every ROTATE_EVERY pages if not stable.
  if (!STABLE_SESSION && ROTATE_EVERY > 0 && pageNumber % ROTATE_EVERY === 0) {
    proxyIndex++;
  }
  const base = proxies[proxyIndex % proxies.length];
  let username = base.username;
  if (!STABLE_SESSION && ROTATE_SESSION) {
    username = username.replace(/(session-)[A-Za-z0-9_-]+/, (_,p)=> p + randSession());
  }
  return { server: base.server, username, password: base.password };
}

// ---------- RAW FETCH VIA PROXY ----------
function rawFetchProxy(url, proxy) {
  return new Promise((resolve,reject)=>{
    const proxyUrl = `http://${proxy.username}:${proxy.password}@${proxy.server.replace(/^https?:\/\//,'')}`;
    const agent = new HttpsProxyAgent(proxyUrl);
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      method: 'GET',
      headers: {
        'User-Agent': chooseUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      agent,
      timeout: 20000
    };
    const req = https.request(opts, res => {
      let chunks=[];
      res.on('data', c=>chunks.push(c));
      res.on('end', ()=> resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    req.setTimeout(20000, ()=> { req.destroy(new Error('rawFetch timeout')); });
    req.end();
  });
}

// ---------- ENGINE / USER AGENTS ----------
const engineMap = { chromium, firefox, webkit };
const engine = engineMap[ENGINE] || chromium;

const BASE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
function chooseUserAgent() {
  if (ALT_USER_AGENTS.length) {
    const idx = Math.floor(Math.random()*ALT_USER_AGENTS.length);
    return ALT_USER_AGENTS[idx];
  }
  return BASE_UA;
}

const EXTRA_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.theoutnet.com/',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-User': '?1',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Sec-CH-UA': '"Chromium";v="124", "Google Chrome";v="124", "Not.A/Brand";v="24"',
  'Sec-CH-UA-Platform': '"Windows"',
  'Sec-CH-UA-Mobile': '?0'
};

// ---------- BROWSER CREATION (POOL MODE) ----------
async function createBrowserInstance(proxyObj) {
  const argsChromium = [
    '--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'
  ];
  if (DISABLE_HTTP2 && ENGINE === 'chromium') argsChromium.push('--disable-http2');

  const launchOptions = {
    headless: HEADLESS,
    proxy: {
      server: proxyObj.server,
      username: proxyObj.username,
      password: proxyObj.password
    }
  };
  if (ENGINE === 'chromium') launchOptions.args = argsChromium;

  return engine.launch(launchOptions);
}

// ---------- CAPTURE A SINGLE URL ----------
async function capture(pageNumber, url, out) {
  const proxy = nextProxy(pageNumber);
  const dir = path.join(out, localPath(url));
  const assetsDir = path.join(dir,'assets');
  ensureDir(dir); ensureDir(assetsDir);

  const record = {
    url,
    proxyUser: proxy.username,
    status: 'ok',
    mainStatus: null,
    finalURL: null,
    assets: 0,
    rawUsed: false,
    reasons: [],
    attempts: 0,
    durationMs: 0
  };
  const startTime = Date.now();
  const deadline = Date.now() + PAGE_TIMEOUT;

  if (RAW_ONLY) {
    try {
      const raw = await rawFetchProxy(url, proxy);
      record.rawUsed = true;
      record.mainStatus = raw.status;
      record.reasons.push('rawOnly mode');
      fs.writeFileSync(path.join(dir,'index.html'), raw.body, 'utf8');
    } catch(e) {
      record.status = 'error:rawOnly '+e.message;
      record.reasons.push('rawErr:'+e.message);
    }
    record.durationMs = Date.now()-startTime;
    return record;
  }

  // Browser nav attempts (fresh browser per attempt unless pooling)
  let browser, context, page;
  let assetMap = new Map();
  let requestsList = [];
  let navSucceeded = false;

  for (let attempt=1; attempt<=RETRIES+1; attempt++) {
    record.attempts = attempt;
    if (Date.now() > deadline) {
      record.status = record.status.startsWith('error') ? record.status : 'error:pageTimeout';
      record.reasons.push('pageDeadline');
      break;
    }

    try {
      if (!BROWSER_POOL) {
        browser = await createBrowserInstance(proxy);
        context = await browser.newContext({
          userAgent: chooseUserAgent(),
          locale:'en-US',
          viewport:{ width:1366, height:900 },
          extraHTTPHeaders: EXTRA_HEADERS
        });
      } else {
        // In pool mode, provide externally (handled in worker) – not implemented here for simplicity.
        browser = await createBrowserInstance(proxy);
        context = await browser.newContext({
            userAgent: chooseUserAgent(),
            locale:'en-US',
            viewport:{ width:1366, height:900 },
            extraHTTPHeaders: EXTRA_HEADERS
        });
      }

      await context.addInitScript(() => {
        Object.defineProperty(navigator,'webdriver',{get:()=>false});
        window.chrome={ runtime:{} };
        Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});
        Object.defineProperty(navigator,'platform',{get:()=> 'Win32'});
      });

      page = await context.newPage();
      page.setDefaultNavigationTimeout(NAV_TIMEOUT);

      page.on('requestfailed', r => {
        const msg = `REQ_FAIL ${r.url()} ${r.failure()?.errorText||''}`;
        record.reasons.push(msg);
        if (HAR_CAPTURE) requestsList.push({ type:'fail', url:r.url(), error:r.failure()?.errorText });
      });

      page.on('request', r => {
        if (HAR_CAPTURE) requestsList.push({ type:'req', url:r.url(), method:r.method(), resource:r.resourceType() });
      });

      page.on('response', r => {
        if (HAR_CAPTURE) requestsList.push({ type:'resp', url:r.url(), status:r.status(), resource:r.request().resourceType() });
        try {
          const req = r.request();
          const rUrl = req.url();
          const ct = (r.headers()['content-type'] || '').toLowerCase();
          if (!INCLUDE_CROSS) {
            const mh=(new URL(url)).host;
            const rh=(new URL(rUrl)).host;
            if (rh!==mh && !rh.endsWith('theoutnet.com')) return;
          }
          if (!isLikelyAsset(rUrl, ct)) return;
          if (assetMap.has(rUrl)) return;
          r.body().then(buf=>{
            if (buf.length > ASSET_MAX_BYTES) return;
            const fname = shortHash(rUrl)+guessExt(rUrl, ct);
            fs.writeFileSync(path.join(assetsDir,fname), buf);
            assetMap.set(rUrl,'assets/'+fname);
          }).catch(()=>{});
        } catch {}
      });

      // Attempt navigation
      const navStart = Date.now();
      let resp;
      try {
        resp = await page.goto(url, { waitUntil:'commit', timeout:NAV_TIMEOUT });
      } catch (navErr) {
        record.reasons.push('navPrimary:'+navErr.message);
        throw navErr;
      }

      record.mainStatus = resp?.status() || null;
      record.finalURL = resp?.url() || page.url();

      // Body wait
      try {
        await page.waitForSelector('body', { timeout: 10000 });
      } catch {
        record.reasons.push('noBody');
      }

      // Optional scroll
      if (SCROLL_PASSES > 0) await safeScroll(page);

      // Passive wait
      if (WAIT_EXTRA > 0) await page.waitForTimeout(WAIT_EXTRA);

      // Rewrite internal links
      try {
        await page.evaluate(()=>{
          if(!document.body)return;
          const fix = href=>{
            try{
              const u=new URL(href,location.href);
              if(u.hostname.endsWith('theoutnet.com')){
                let p=u.pathname.replace(/\/+$/,'');
                if(!p)p='/index';
                return p+'/';
              }
            }catch{}
            return href;
          };
          document.querySelectorAll('a[href]').forEach(a=>a.setAttribute('href', fix(a.getAttribute('href'))));
        });
      } catch(e) {
        record.reasons.push('rewriteErr:'+e.message);
      }

      // Save HTML
      try {
        const html = await page.content();
        fs.writeFileSync(path.join(dir,'index.html'), html, 'utf8');
      } catch(e) {
        record.reasons.push('htmlSaveErr:'+e.message);
      }

      navSucceeded = true;
      if (browser) await browser.close();
      break;
    } catch (e) {
      record.status = 'error:nav '+e.message;
      record.reasons.push('attemptFail:'+e.message);
      try { if (browser) await browser.close(); } catch {}
      // Retry loop continues if attempts remain
    }
  }

  // Fallback raw fetch if nav failed or no mainStatus
  if (!navSucceeded || record.mainStatus == null) {
    try {
      const raw = await rawFetchProxy(url, proxy);
      record.rawUsed = true;
      record.reasons.push('rawFetch '+raw.status);
      if (!fs.existsSync(path.join(dir,'index.html'))) {
        fs.writeFileSync(path.join(dir,'index.html'), raw.body, 'utf8');
      } else {
        // Keep as a sidecar
        fs.writeFileSync(path.join(dir,'raw.html'), raw.body, 'utf8');
      }
      if (!record.mainStatus) record.mainStatus = raw.status;
      if (!record.status.startsWith('error')) {
        record.status = 'okRaw';
      }
    } catch (rawErr) {
      record.reasons.push('rawFetchFail:'+rawErr.message);
      if (!record.status.startsWith('error')) record.status = 'error:raw '+rawErr.message;
    }
  }

  record.assets = assetMap.size;
  record.durationMs = Date.now()-startTime;

  // HAR-like debug if requested
  if (HAR_CAPTURE) {
    const debugDir = path.join(out,'_debug');
    ensureDir(debugDir);
    fs.writeFileSync(
      path.join(debugDir, shortHash(url)+'.requests.json'),
      JSON.stringify({ url, proxyUser: proxy.username, requests: requestsList }, null, 2)
    );
  }

  return record;
}

// ---------- MAIN ----------
(async () => {
  const urls = readSeeds(seedsFile);
  ensureDir(outputRoot);
  const partialPath = path.join(outputRoot,'manifest.partial.jsonl');
  const manifest = [];
  let idx = 0;

  console.log(`ARCHIVER start: urls=${urls.length} engine=${ENGINE} concurrency=${CONCURRENCY} stableSession=${STABLE_SESSION} rotateEvery=${ROTATE_EVERY} rotateSession=${ROTATE_SESSION} disableHTTP2=${DISABLE_HTTP2} rawOnly=${RAW_ONLY}`);

  async function worker(id) {
    while (true) {
      let url;
      // synchronization
      if (idx >= urls.length) break;
      url = urls[idx++];
      const pageNum = idx;
      process.stdout.write(`[W${id}] (${pageNum}/${urls.length}) ${url}\n`);

      const rec = await capture(pageNum, url, outputRoot);
      manifest.push(rec);
      fs.appendFileSync(partialPath, JSON.stringify(rec)+'\n');
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_,i)=>worker(i+1)));

  manifest.sort((a,b)=>a.url.localeCompare(b.url));
  fs.writeFileSync(path.join(outputRoot,'manifest.json'), JSON.stringify(manifest,null,2));

  const failures = manifest.filter(m => !m.status.startsWith('ok'));
  const totalAssets = manifest.reduce((s,m)=>s+m.assets,0);

  console.log(`DONE pages=${manifest.length} failures=${failures.length} assetsTotal=${totalAssets}`);
  if (failures.length) {
    console.log('Sample failures:');
    failures.slice(0,10).forEach(f => console.log('-', f.url, f.status));
  }
})().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});