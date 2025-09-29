#!/usr/bin/env node
/**
 * products-scrape.cjs (HTTP-first, aggressive product discovery + product_id sweep)
 *
 * Usage:
 *   node bin/products-scrape.cjs --seed <seedUrl> <runDir>
 *   OR (legacy) node bin/products-scrape.cjs <urls.txt> <runDir>
 *
 * Strategy:
 *   - Start from seed + OpenCart hints (sitemap, category root)
 *   - HTTP fetch with keep-alive + compression (fast); Playwright fallback if needed (assets blocked)
 *   - EXPAND from category pages:
 *       * decode &amp; to & before URL parsing
 *       * collect product/category links from hrefs
 *       * regex-scan HTML for product_id=NNN anywhere (href, scripts, data-attrs) and enqueue product detail URLs
 *   - Enumerative sweep of product_id when site uses OpenCart product_id param:
 *       * Automatic for teashop.bg: 30..440 (from your note)
 *       * Optional override via ENV ENUM_ID_HINT="MIN-MAX" (e.g., 30-440)
 *       * If no hint: derive a range from discovered ids (min-100 .. max+200), fallback 1..500
 *   - On product pages, extract full product (JSON-LD/OG/OpenCart)
 *   - Dedup by SKU or (url+title). Outputs _data/products.ndjson
 *   - Writes _crawl/urls.txt (visited order) for debugging
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { chromium } = require('playwright');

const arg1 = process.argv[2];
const arg2 = process.argv[3];
const arg3 = process.argv[4];
const usingSeed = arg1 === '--seed';

const urlsFile = usingSeed ? null : arg1;
const runDir = usingSeed ? arg3 : arg2;
const seedUrl = usingSeed ? arg2 : null;

if (!runDir || (usingSeed && !seedUrl) || (!usingSeed && !urlsFile)) {
  console.error('Usage: node bin/products-scrape.cjs --seed <seedUrl> <runDir>\n   or: node bin/products-scrape.cjs <urls.txt> <runDir>');
  process.exit(2);
}

const CONC = parseInt(process.env.CONCURRENCY || '12', 10);
const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT_MS || '9000', 10);
const WAIT_EXTRA = parseInt(process.env.WAIT_EXTRA || '30', 10);
const MAX_VISITS = parseInt(process.env.MAX_VISITS_PONLY || '1500', 10);
const FAST_HTTP_FETCH = /^(1|true|yes|on)$/i.test(process.env.FAST_HTTP_FETCH || 'true');
const ENUM_ID_HINT = process.env.ENUM_ID_HINT || '';              // e.g., "30-440"
const ENUM_FORCE_SWEEP = /^(1|true|yes|on)$/i.test(process.env.ENUM_FORCE_SWEEP || 'false');

const extractor = require(path.join(process.cwd(), 'lib', 'product-extract.cjs'));
const outDataDir = path.join(runDir, '_data');
const outNdjson = path.join(outDataDir, 'products.ndjson');

function ensureDir(d){ fs.mkdirSync(d, { recursive: true }); }
function readUrls(file){
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).map(s=>s.trim()).filter(Boolean); }
  catch { return []; }
}
function writeVisited(list){
  try {
    ensureDir(path.join(runDir, '_crawl'));
    fs.writeFileSync(path.join(runDir, '_crawl', 'urls.txt'), list.join('\n')+'\n', 'utf8');
  } catch {}
}
function parseRange(s){
  const m = String(s||'').trim().match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (!m) return null;
  const a = parseInt(m[1],10), b = parseInt(m[2],10);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a<1 || b<a) return null;
  return { min:a, max:b };
}

function urlKind(u){
  try {
    const url = new URL(u);
    const route = url.searchParams.get('route') || '';
    if (/^product\/product$/i.test(route)) return 'product';
    if (/^product\/category$/i.test(route)) return 'category';
  } catch {}
  return 'other';
}

/* ---------- HTTP keep-alive + compression ---------- */
const agentHttp = new http.Agent({ keepAlive:true, maxSockets:256 });
const agentHttps = new https.Agent({ keepAlive:true, maxSockets:256 });

function decompress(body, encoding){
  return new Promise((resolve)=>{
    if (!encoding) return resolve(body);
    const enc = String(encoding).toLowerCase();
    if (enc.includes('br')) return zlib.brotliDecompress(body, (e,b)=>resolve(e?body:b));
    if (enc.includes('gzip')) return zlib.gunzip(body, (e,b)=>resolve(e?body:b));
    if (enc.includes('deflate')) return zlib.inflate(body, (e,b)=>resolve(e?body:b));
    resolve(body);
  });
}

function simpleFetch(url, timeoutMs=7000){
  return new Promise((resolve) => {
    try {
      const U = new URL(url);
      const mod = U.protocol === 'https:' ? https : http;
      const agent = U.protocol === 'https:' ? agentHttps : agentHttp;
      const req = mod.request({
        hostname: U.hostname,
        port: U.port || (U.protocol === 'https:' ? 443 : 80),
        path: (U.pathname || '/') + (U.search || ''),
        method: 'GET',
        agent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (products-scrape)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive'
        },
        timeout: timeoutMs
      }, async (res) => {
        const ct = (res.headers['content-type'] || '').toLowerCase();
        const ce = res.headers['content-encoding'] || '';
        const status = res.statusCode || 0;
        const chunks=[];
        res.on('data', c => { chunks.push(c); });
        res.on('end', async () => {
          const raw = Buffer.concat(chunks);
          const bodyBuf = await decompress(raw, ce);
          const body = bodyBuf.toString('utf8');
          resolve({ ok:true, status, ct, body });
        });
      });
      req.on('timeout', () => { try{ req.destroy(); }catch{} resolve({ ok:false }); });
      req.on('error', () => resolve({ ok:false }));
      req.end();
    } catch {
      resolve({ ok:false });
    }
  });
}

function looksLikeHTML(resp){
  if (!resp || !resp.ok) return false;
  if (resp.status >= 400) return false;
  if (/text\/html|application\/xhtml\+xml/.test(resp.ct)) return true;
  return /<html[\s>]/i.test(resp.body || '');
}

/* ---------- helpers ---------- */
function htmlDecodeEntities(s){ return String(s||'').replace(/&amp;/g,'&'); }

/* Grab product_id numbers from anywhere in HTML (hrefs, scripts, data-attrs) */
function extractProductIds(html){
  const ids = new Set();
  const re = /(product_id|productId|data-product-id|data-id|prodid|product-id)[^0-9]{0,10}(\d{1,8})/gi;
  let m;
  while ((m = re.exec(html))){
    const id = m[2];
    if (id) ids.add(String(id));
  }
  // Also parse explicit ...product_id=123...
  const re2 = /(?:\?|&|&amp;)product_id=(\d{1,8})/gi;
  while ((m = re2.exec(html))){
    const id = m[1];
    if (id) ids.add(String(id));
  }
  return [...ids];
}

/* Build canonical product detail URLs for OpenCart (path param is optional/ignored) */
function buildProductUrlsFromIds(origin, ids){
  const out = [];
  for (const id of ids){
    try {
      out.push(new URL(`/index.php?route=product/product&product_id=${id}`, origin).toString());
      out.push(new URL(`/index.php?route=product/product&path=0_0&product_id=${id}`, origin).toString());
    } catch {}
  }
  return out;
}

/* Collect product/category links from a category page (decode &amp;) */
function extractLinksFromCategory(html, baseUrl, maxAdd=200){
  const out = new Set();
  const re = /href=("([^"]+)"|'([^']+)')/gi;
  let m, added=0;
  while ((m = re.exec(html)) && added < maxAdd){
    const raw0 = m[2] || m[3] || '';
    if (!raw0) continue;
    const raw = htmlDecodeEntities(raw0);
    let abs;
    try { abs = new URL(raw, baseUrl).toString(); } catch { continue; }
    try {
      const u = new URL(abs);
      const route = u.searchParams.get('route') || '';
      if (/^product\/product$/i.test(route) || /^product\/category$/i.test(route)) {
        if (!out.has(abs)) { out.add(abs); added++; }
      } else {
        // SEO-like slugs without route param: accept deep paths
        if (!u.searchParams.has('route') && /\/[^/?#]+\/[^/?#]+$/.test(u.pathname)) {
          if (!out.has(abs)) { out.add(abs); added++; }
        }
      }
      // pagination hint
      if (/^product\/category$/i.test(route) && (u.searchParams.has('page') || /[?&]page=\d+/i.test(abs))) {
        out.add(abs);
      }
    } catch {}
  }
  return [...out];
}

function seedHintsFromOrigin(origin){
  return [
    new URL('/index.php?route=information/sitemap', origin).toString(),
    new URL('/index.php?route=product/category', origin).toString()
  ];
}
function seedHintsIfTiny(list){
  if (!list.length) return list;
  if (list.length > 2) return list;
  try {
    const origin = new URL(list[0]).origin;
    const hints = seedHintsFromOrigin(origin);
    const out = Array.from(new Set([...list, ...hints]));
    console.log('[P_ONLY_SEED_HINTS] added', out.length - list.length);
    return out;
  } catch {
    return list;
  }
}

/* ---------- Playwright fallback (assets blocked) ---------- */
async function newContext(){
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (products-scrape)' });
  await ctx.route('**/*', (route) => {
    const req = route.request();
    const rt = req.resourceType();
    if (rt === 'image' || rt === 'font' || rt === 'stylesheet' || rt === 'media') return route.abort();
    const u = req.url();
    if (/google-analytics|gtag\/|googletagmanager|facebook\.com\/tr|hotjar|clarity/i.test(u)) return route.abort();
    route.continue();
  });
  return { browser, ctx };
}

/* ---------- Globals ---------- */
const seenUrls = new Set();
const visitedOrder = [];
const seenKeys = new Set();
const discoveredIds = new Set();
let totalFound = 0;

/* ---------- Worker ---------- */
async function worker(id, queue){
  let pw = null;

  async function getHTML(url){
    if (FAST_HTTP_FETCH){
      const r = await simpleFetch(url, 7000);
      if (looksLikeHTML(r)) return r.body || '';
    }
    if (!pw) pw = await newContext();
    const page = await pw.ctx.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);
    try {
      await page.goto(url, { waitUntil:'domcontentloaded' });
      if (WAIT_EXTRA > 0) await page.waitForTimeout(WAIT_EXTRA);
      return await page.content();
    } catch {
      return '';
    } finally {
      try { await page.close(); } catch {}
    }
  }

  async function closePW(){
    if (!pw) return;
    try { await pw.ctx.close(); } catch {}
    try { await pw.browser.close(); } catch {}
    pw = null;
  }

  while (true){
    const url = queue.shift();
    if (!url) break;
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    visitedOrder.push(url);
    if (seenUrls.size > MAX_VISITS) break;

    try {
      const html = await getHTML(url);
      if (!html) { console.log('[P_ONLY_ERR] empty', url); continue; }

      // Gather product ids from anywhere
      const ids = extractProductIds(html);
      for (const id of ids) discoveredIds.add(id);

      const kind = urlKind(url);
      if (kind === 'product'){
        const items = extractor.extractProductsFromHTML(html, url);
        const added = addProducts(items, url);
        totalFound += added;
        console.log(`[P_ONLY][product +${added}] ${url}`);
      } else if (kind === 'category'){
        const items = extractor.extractProductsFromHTML(html, url);
        const added = addProducts(items, url);
        totalFound += added;

        const links = extractLinksFromCategory(html, url, 300);
        for (const l of links){ if (!seenUrls.has(l)) queue.push(l); }
        console.log(`[P_ONLY][category +${added} next=${links.length} ids=${ids.length}] ${url}`);
      } else {
        const items = extractor.extractProductsFromHTML(html, url);
        const added = addProducts(items, url);
        totalFound += added;

        const links = extractLinksFromCategory(html, url, 60);
        for (const l of links){ if (!seenUrls.has(l)) queue.push(l); }
        console.log(`[P_ONLY][other +${added} next=${links.length} ids=${ids.length}] ${url}`);
      }
    } catch (e) {
      console.log('[P_ONLY_ERR]', url, e.message);
    }
  }

  await closePW();
  writeVisited(visitedOrder);
}

function addProducts(items, pageUrl){
  if (!Array.isArray(items) || !items.length) return 0;
  ensureDir(outDataDir);
  let added = 0;
  for (const p of items){
    const key = (p.sku && String(p.sku).trim())
      ? `sku:${String(p.sku).trim().toLowerCase()}`
      : `u:${(p.url || pageUrl)}/${(p.title||'').toLowerCase()}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    fs.appendFileSync(outNdjson, JSON.stringify(p) + '\n', 'utf8');
    added++;
  }
  return added;
}

/* ---------- Enumerative product_id sweep ---------- */
function deriveSweepRange(originHost){
  // 1) ENV hint
  const r = parseRange(ENUM_ID_HINT);
  if (r) return r;

  // 2) Domain-specific default for teashop.bg (from your note)
  if (/^teashop\.bg$/i.test(originHost)) return { min: 30, max: 440 };

  // 3) Derived from discovered ids
  if (discoveredIds.size){
    const nums = Array.from(discoveredIds).map(x=>parseInt(x,10)).filter(n=>Number.isFinite(n));
    const min = Math.max(1, Math.min(...nums) - 100);
    const max = Math.max(...nums) + 200;
    return { min, max: Math.min(max, 2000) };
  }

  // 4) Generic fallback
  return { min: 1, max: 500 };
}

async function sweepById(origin){
  const host = (()=>{ try { return new URL(origin).hostname; } catch { return ''; }})();
  const { min, max } = deriveSweepRange(host);
  const total = max - min + 1;
  console.log('[P_ONLY_SWEEP]', { origin, min, max, total });

  const urls = buildProductUrlsFromIds(origin, Array.from({length:total},(_,i)=>String(min+i)));
  // Shuffle lightly to avoid hammering sequential ids
  for (let i=urls.length-1; i>0; i--){ const j=Math.floor(Math.random()*(i+1)); [urls[i],urls[j]]=[urls[j],urls[i]]; }

  // Process with the same worker logic but product-only
  const queue = urls.filter(u=>!seenUrls.has(u)); // skip already seen
  if (!queue.length) return;

  const workers = [];
  for (let i=0;i<Math.max(1, CONC);i++){
    workers.push((async ()=>{
      let pw = null;
      async function getHTML(u){
        if (FAST_HTTP_FETCH){
          const r = await simpleFetch(u, 7000);
          if (looksLikeHTML(r)) return r.body || '';
        }
        if (!pw) {
          const tmp = await newContext();
          pw = tmp;
        }
        const page = await pw.ctx.newPage();
        page.setDefaultNavigationTimeout(NAV_TIMEOUT);
        try {
          await page.goto(u, { waitUntil:'domcontentloaded' });
          if (WAIT_EXTRA > 0) await page.waitForTimeout(WAIT_EXTRA);
          return await page.content();
        } catch { return ''; }
        finally { try { await page.close(); } catch {} }
      }
      async function closePW(){ if (!pw) return; try { await pw.ctx.close(); } catch {}; try { await pw.browser.close(); } catch {}; pw=null; }

      while (true){
        const u = queue.shift();
        if (!u) break;
        if (seenUrls.has(u)) continue;
        seenUrls.add(u);
        visitedOrder.push(u);

        try {
          const html = await getHTML(u);
          if (!html) continue;
          const items = extractor.extractProductsFromHTML(html, u);
          const added = addProducts(items, u);
          totalFound += added;
          if (added) console.log(`[P_ONLY][sweep +${added}] ${u}`);
        } catch {}
      }
      await closePW();
    })());
  }
  await Promise.all(workers);
}

/* ---------- Main ---------- */
(async ()=>{
  let seeds = [];
  if (usingSeed) {
    let s = seedUrl;
    try { s = new URL(seedUrl).toString(); } catch { s = 'https://' + seedUrl.replace(/^https?:\/\//,''); }
    seeds = [s];
    try {
      const origin = new URL(s).origin;
      seeds.push(...seedHintsFromOrigin(origin));
    } catch {}
  } else {
    seeds = readUrls(urlsFile);
    seeds = seedHintsIfTiny(seeds);
  }

  if (!seeds.length) {
    console.error('[P_ONLY] No URLs to process');
    process.exit(2);
  }

  // Phase 1: BFS expand quickly
  const queue = seeds.slice(0);
  const workers = [];
  for (let i=0;i<Math.max(1, CONC);i++){
    workers.push(worker(i+1, queue));
  }
  await Promise.all(workers);

  // Phase 2: Enumerative sweep if needed or forced
  let origin = '';
  try { origin = new URL(seeds[0]).origin; } catch {}
  if (origin && (ENUM_FORCE_SWEEP || totalFound < 40)) {
    await sweepById(origin);
  }

  console.log('[P_ONLY_DONE] products=', totalFound, 'out=', outNdjson);
})();