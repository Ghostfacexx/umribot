#!/usr/bin/env node
/**
 * archiver.cjs (Multi-Profile: Desktop + Mobile)
 *
 * Guarantees:
 *  - Always write a root index.html at the run root that redirects "/" to the first captured desktop page,
 *    regardless of the seed URL path (e.g., /fra-fr/homepage). No host-time tweaks required.
 *
 * Core features:
 *  - PROFILES env (e.g. desktop,mobile)
 *  - Per-profile rendering & output subfolders
 *  - Shared asset dedupe across profiles
 *  - Optional mobile meta viewport injection
 *  - Robust consent/cookie banner handling (multiple CMPs + generic heuristics)
 *  - Same-site handling (SAME_SITE_MODE, INTERNAL_HOSTS_REGEX) to treat fr., www., etc. as one site
 *  - Offline fallback shim injection: preserves page logic, but if a fetch/XHR fails or is blocked by origin,
 *    we auto-serve the locally captured equivalent from our asset map (no stripping, no CSP required).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium, firefox, webkit } = require('playwright');
const { HttpsProxyAgent } = require('https-proxy-agent');
const https = require('https');
const cheerio = require('cheerio');
const { buildSameSiteChecker, getETLDPlusOne } = require('./lib/domain.cjs');
const cp = require('child_process');

/* ------------ Utility ------------ */
function envB(name, def=false){ const v=process.env[name]; if(v==null) return def; return /^(1|true|yes|on)$/i.test(v); }
function envN(name, def){ const v=process.env[name]; if(v==null||v==='') return def; const n=parseInt(v,10); return isNaN(n)?def:n; }
function ensureDir(d){ fs.mkdirSync(d,{recursive:true}); }
function sha16(x){ return crypto.createHash('sha1').update(x).digest('hex').slice(0,16); }
function guessExt(url,ct){
  let m; try{ m=(new URL(url).pathname.match(/(\.[a-z0-9]{2,6})(?:$|[?#])/i)||[])[1]; }catch{}
  if(m) return m.toLowerCase();
  ct=ct||'';
  if(/png/i.test(ct)) return '.png';
  if(/jpe?g/i.test(ct)) return '.jpg';
  if(/webp/i.test(ct)) return '.webp';
  if(/gif/i.test(ct)) return '.gif';
  if(/css/i.test(ct)) return '.css';
  if(/javascript|ecmascript/i.test(ct)) return '.js';
  if(/woff2/i.test(ct)) return '.woff2';
  if(/woff(\D|$)/i.test(ct)) return '.woff';
  if(/ttf/i.test(ct)) return '.ttf';
  if(/svg/i.test(ct)) return '.svg';
  if(/pdf/i.test(ct)) return '.pdf';
  return '.bin';
}
function isLikelyAsset(u,ct){
  if(/\.(png|jpe?g|webp|gif|svg|css|js|mjs|cjs|woff2?|ttf|otf|pdf)$/i.test(u)) return true;
  if(/^(image|font|application\/pdf)/i.test(ct)) return true;
  if(/css/i.test(ct) || /javascript|ecmascript/i.test(ct)) return true;
  return false;
}

/* ------------ ENV ------------ */
const ENGINE=(process.env.ENGINE||'chromium').toLowerCase();
const CONCURRENCY=envN('CONCURRENCY',2);
const HEADLESS=envB('HEADLESS',true);
const INCLUDE_CROSS=envB('INCLUDE_CROSS_ORIGIN',false);
let WAIT_EXTRA=envN('WAIT_EXTRA',700);
const NAV_TIMEOUT=envN('NAV_TIMEOUT_MS',20000);
const PAGE_TIMEOUT=envN('PAGE_TIMEOUT_MS',45000);
let SCROLL_PASSES=envN('SCROLL_PASSES',0);
const SCROLL_DELAY=envN('SCROLL_DELAY',250);
const ASSET_MAX_BYTES=envN('ASSET_MAX_BYTES',3*1024*1024);
const PROXIES_FILE=process.env.PROXIES_FILE||'';
const STABLE_SESSION=envB('STABLE_SESSION',true);
const ROTATE_EVERY=envN('ROTATE_EVERY',0);
const ROTATE_SESSION=envB('ROTATE_SESSION',false);
const DISABLE_HTTP2=envB('DISABLE_HTTP2',false);
const RAW_ONLY=envB('RAW_ONLY',false);
const RETRIES=envN('RETRIES',1);
const ALT_USER_AGENTS=(process.env.ALT_USER_AGENTS||'').split(',').map(s=>s.trim()).filter(Boolean);
const DOMAIN_FILTER_ENV=process.env.DOMAIN_FILTER||'';
const REWRITE_INTERNAL=envB('REWRITE_INTERNAL',true);
const INTERNAL_REWRITE_REGEX=process.env.INTERNAL_REWRITE_REGEX||'';
// Default: use 'index' folder for root (do not flatten), to keep page variants under /index/desktop and /index/mobile
const FLATTEN_ROOT_INDEX=envB('FLATTEN_ROOT_INDEX',false);

// Mirror defaults: preserve original asset paths for same-site to achieve an identical structure
const PRESERVE_ASSET_PATHS=envB('PRESERVE_ASSET_PATHS',true);
const MIRROR_SUBDOMAINS=envB('MIRROR_SUBDOMAINS',true);
const MIRROR_CROSS_ORIGIN=envB('MIRROR_CROSS_ORIGIN',false);
const REWRITE_HTML_ASSETS=envB('REWRITE_HTML_ASSETS',true);
const INLINE_SMALL_ASSETS=envN('INLINE_SMALL_ASSETS',0);
const PAGE_WAIT_UNTIL=(process.env.PAGE_WAIT_UNTIL||'domcontentloaded');
// Primary submitted URL (from GUI). We guarantee it's captured and becomes the root redirect target.
const PRIMARY_START_URL = process.env.PRIMARY_START_URL || '';
// Optional tracker blocking (ads/analytics/pixels)
const BLOCK_TRACKERS = envB('BLOCK_TRACKERS', false);
const TRACKER_SKIP_PATTERNS = (process.env.TRACKER_SKIP_PATTERNS||'').split(',').map(s=>s.trim()).filter(Boolean);
let TRACKER_RX = null; try{
  TRACKER_RX = TRACKER_SKIP_PATTERNS.length ? new RegExp(TRACKER_SKIP_PATTERNS.map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'i') : null;
}catch{ TRACKER_RX = null; }
let QUIET_MILLIS=envN('QUIET_MILLIS',1500);
let MAX_CAPTURE_MS=envN('MAX_CAPTURE_MS',20000);

/* Payment map auto-generation (for host-time payment link rewrites) */
const PAYMENT_MAP_AUTO = envB('PAYMENT_MAP_AUTO', true);
const PAYMENT_PROVIDER = process.env.PAYMENT_PROVIDER || 'paypal';
const PAYMENT_TARGET = process.env.PAYMENT_TARGET || '_blank';
const PAYMENT_PLACEHOLDER = process.env.PAYMENT_PLACEHOLDER || 'paypal:HOSTED_BUTTON_ID_PLACEHOLDER';
// Also write a SKU-based payment map derived from the catalog (bySku)
const GENERATE_PAYMENT_MAP_FROM_CATALOG = envB('GENERATE_PAYMENT_MAP_FROM_CATALOG', true);
// Collected product IDs during capture: id -> { url, title }
const FOUND_PRODUCT_IDS = new Map();
/* Product catalog + local SKU registry */
const ENABLE_CATALOG = envB('ENABLE_CATALOG', true);
let CATALOG = [];
let SKU_MAP = { next: 1, byKey: {} };
const CATALOG_DIR_NAME = 'catalog';
function catalogDir(outRoot){ return path.join(outRoot, CATALOG_DIR_NAME); }
function skuString(n){ return 'SKU-' + String(n).padStart(6, '0'); }
function loadExistingCatalog(outDir){
  if (!ENABLE_CATALOG) return;
  try { ensureDir(catalogDir(outDir)); } catch {}
  try{
    const f = path.join(catalogDir(outDir), 'catalog.json');
    if (fs.existsSync(f)) { CATALOG = JSON.parse(fs.readFileSync(f,'utf8')) || []; }
  }catch{ CATALOG = []; }
  try{
    const f = path.join(catalogDir(outDir), 'sku-map.json');
    if (fs.existsSync(f)) { const o = JSON.parse(fs.readFileSync(f,'utf8')) || {}; SKU_MAP = { next: Number(o.next)||1, byKey: o.byKey||{} }; }
  }catch{ SKU_MAP = { next: 1, byKey: {} }; }
}
function saveCatalog(outDir){
  if (!ENABLE_CATALOG) return;
  try { ensureDir(catalogDir(outDir)); } catch {}
  try { fs.writeFileSync(path.join(catalogDir(outDir),'catalog.json'), JSON.stringify(CATALOG, null, 2)); } catch {}
  try { fs.writeFileSync(path.join(catalogDir(outDir),'sku-map.json'), JSON.stringify({ next: SKU_MAP.next, byKey: SKU_MAP.byKey }, null, 2)); } catch {}
}
function assignSkuForKey(key){
  if (!ENABLE_CATALOG) return '';
  if (!key) return '';
  const cur = SKU_MAP.byKey[key];
  if (cur) return cur;
  const sku = skuString(SKU_MAP.next++);
  SKU_MAP.byKey[key] = sku;
  return sku;
}
function normalizeProductKeyFromUrl(uStr){
  try{
    const u = new URL(uStr);
    // Prefer canonical pathname+query slug to be stable per page
    const pathOnly = (u.pathname||'').replace(/\/+$/,'');
    let key = pathOnly || '/';
    if (u.searchParams && u.searchParams.toString()) {
      key += '::' + [...u.searchParams.entries()].sort((a,b)=> a[0]===b[0] ? String(a[1]).localeCompare(String(b[1])) : a[0].localeCompare(b[0]))
                   .map(([k,v])=> `${k}=${v}`).join('&');
    }
    return key;
  }catch{ return String(uStr||''); }
}
function extractProductFromPage(html, pageUrl){
  try{
    const $ = cheerio.load(html, { decodeEntities: false });
    // 1) Try JSON-LD Product
    const ldBlocks = $('script[type="application/ld+json"]').toArray().map(s=>{ try { return JSON.parse($(s).contents().text()); } catch { return null; } }).filter(Boolean);
    function findProduct(obj){
      if(!obj) return null;
      if(Array.isArray(obj)){
        for(const it of obj){ const f=findProduct(it); if(f) return f; }
        return null;
      }
      const types = ([]).concat(obj['@type']||[]);
      if(types.includes('Product') || obj['@type']==='Product') return obj;
      if(obj['@graph']) return findProduct(obj['@graph']);
      return null;
    }
    let prodLD = null;
    for(const b of ldBlocks){ const f=findProduct(b); if(f){ prodLD=f; break; } }
    let name='', description='', currency='', price='';
    let images=[];
    if (prodLD){
      name = String(prodLD.name||'');
      description = String(prodLD.description||'');
      if (Array.isArray(prodLD.image)) images = prodLD.image.map(String);
      else if (prodLD.image) images=[String(prodLD.image)];
      const offers = Array.isArray(prodLD.offers)? prodLD.offers[0] : prodLD.offers;
      if (offers){
        currency = String(offers.priceCurrency||offers.price_currency||'');
        price = String(offers.price||offers.price_amount||'');
      }
    }
    // 2) Heuristics if missing
    if (!name) name = $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content') || '';
    if (!description) description = $('meta[name="description"]').attr('content') || '';
    if (!images.length) {
      const og = $('meta[property="og:image"]').attr('content'); if (og) images=[og];
    }
    if (!price) {
      // Common price spans
      const cand = $('[itemprop="price"],[data-price],[class*="price" i]').first().text().replace(/\s+/g,' ').trim();
      const m = cand.match(/([€$£]|USD|EUR|GBP)\s*([0-9]+(?:[.,][0-9]{2})?)/i);
      if (m) { currency = (m[1]||'').replace(/[^A-Z€$£]/gi,'').toUpperCase(); price = m[2].replace(',','.'); }
    }
    // If still no price, skip catalog entry
    if (!name || !price) return null;
    // Currency normalization
    if (!currency) {
      const cmeta = $('meta[itemprop="priceCurrency"]').attr('content') || '';
      currency = (cmeta||'USD').toUpperCase();
    }
    const key = normalizeProductKeyFromUrl(pageUrl);
    return { key, name, description, price: Number(price)||0, currency, images };
  }catch{ return null; }
}

/* Commerce flow discovery (external tool) */
const COMMERCE_FLOW = envB('COMMERCE_FLOW', false);
const COMMERCE_FLOW_MODE = process.env.COMMERCE_FLOW_MODE || 'once'; // 'once' | 'off'
const COMMERCE_PLATFORM_HINT = process.env.COMMERCE_PLATFORM_HINT || 'opencart';

// Pages are saved under per-profile subfolders (e.g., rel/desktop/index.html, rel/mobile/index.html)

/* Optional internal discovery (no external crawler) */
const DISCOVER_IN_ARCHIVER = envB('DISCOVER_IN_ARCHIVER', false);
const USE_DISCOVERY_GRAPH = envB('USE_DISCOVERY_GRAPH', true);
// Prefer using the entire graph (all doc-like nodes) rather than limiting to DISCOVER_MAX_PAGES
const DISCOVER_USE_GRAPH_FULL = envB('DISCOVER_USE_GRAPH_FULL', false);
// When selecting nodes from the graph, consider only document-like URLs (no file extensions)
const GRAPH_DOC_LIKE_ONLY = envB('GRAPH_DOC_LIKE_ONLY', true);
const DISCOVER_MAX_PAGES = envN('DISCOVER_MAX_PAGES', 50);
const DISCOVER_MAX_DEPTH = envN('DISCOVER_MAX_DEPTH', 1);
const DISCOVER_ALLOW_REGEX = process.env.DISCOVER_ALLOW_REGEX || '';
const DISCOVER_DENY_REGEX = process.env.DISCOVER_DENY_REGEX || '';
let DISCOVER_ALLOW_RX = null, DISCOVER_DENY_RX = null;
try { if (DISCOVER_ALLOW_REGEX) DISCOVER_ALLOW_RX = new RegExp(DISCOVER_ALLOW_REGEX, 'i'); } catch {}
try { if (DISCOVER_DENY_REGEX) DISCOVER_DENY_RX = new RegExp(DISCOVER_DENY_REGEX, 'i'); } catch {}
function isAllowedByDiscover(url){
  const a = DISCOVER_ALLOW_RX ? DISCOVER_ALLOW_RX.test(url) : true;
  const d = DISCOVER_DENY_RX ? !DISCOVER_DENY_RX.test(url) : true;
  return a && d;
}
function isDocLikeUrl(u){
  try { const p = new URL(u).pathname || '/'; return !/\.[a-z0-9]{2,6}$/i.test(p); } catch { return true; }
}

/* Same-site ENV */
const SAME_SITE_MODE=(process.env.SAME_SITE_MODE||'etld').toLowerCase(); // 'exact' | 'subdomains' | 'etld'
const INTERNAL_HOSTS_REGEX=(process.env.INTERNAL_HOSTS_REGEX||'');

/* Optional stealth for capture only (no host-time hacks) */
const STEALTH = envB('STEALTH', true);

/* Auto-offline fallback shim ENV (injected into saved HTML; preserves logic, only falls back when live fails) */
const OFFLINE_FALLBACK = envB('OFFLINE_FALLBACK', true);
const OFFLINE_MAP_STRIP_QUERY = envB('OFFLINE_MAP_STRIP_QUERY', true);

const CLICK_SELECTORS=(process.env.CLICK_SELECTORS||'').split(',').map(s=>s.trim()).filter(Boolean);
const REMOVE_SELECTORS=(process.env.REMOVE_SELECTORS||'').split(',').map(s=>s.trim()).filter(Boolean);
const SKIP_DOWNLOAD_PATTERNS=(process.env.SKIP_DOWNLOAD_PATTERNS||'').split(',').map(s=>s.trim()).filter(Boolean);

/* Profiles ENV */
const PROFILES_LIST=(process.env.PROFILES||'desktop').split(',').map(s=>s.trim()).filter(Boolean);
const PROFILE_ASSET_DEDUP=envB('PROFILE_ASSET_DEDUP',true);
const INJECT_MOBILE_META=envB('INJECT_MOBILE_META',true);

/* Consent ENV */
let CONSENT_BUTTON_TEXTS=(process.env.CONSENT_BUTTON_TEXTS||'').split(',').map(s=>s.trim()).filter(Boolean);
const CONSENT_EXTRA_SELECTORS=(process.env.CONSENT_EXTRA_SELECTORS||'').split(',').map(s=>s.trim()).filter(Boolean);
const CONSENT_FORCE_REMOVE_SELECTORS=(process.env.CONSENT_FORCE_REMOVE_SELECTORS||'').split(',').map(s=>s.trim()).filter(Boolean);
const CONSENT_RETRY_ATTEMPTS=envN('CONSENT_RETRY_ATTEMPTS',18);
const CONSENT_RETRY_INTERVAL_MS=envN('CONSENT_RETRY_INTERVAL_MS',600);
const CONSENT_IFRAME_SCAN=envB('CONSENT_IFRAME_SCAN',true);
const CONSENT_MUTATION_WINDOW_MS=envN('CONSENT_MUTATION_WINDOW_MS',12000);
const FORCE_CONSENT_WAIT_MS=envN('FORCE_CONSENT_WAIT_MS',800);
const INJECT_ACCEPT_COOKIE=envB('INJECT_ACCEPT_COOKIE',false);
const CONSENT_DEBUG=envB('CONSENT_DEBUG',false);
const CONSENT_DEBUG_SCREENSHOT=envB('CONSENT_DEBUG_SCREENSHOT',false);

/* Popup ENV */
const POPUP_CLOSE_SELECTORS=(process.env.POPUP_CLOSE_SELECTORS||'').split(',').map(s=>s.trim()).filter(Boolean);
const POPUP_FORCE_REMOVE_SELECTORS=(process.env.POPUP_FORCE_REMOVE_SELECTORS||'').split(',').map(s=>s.trim()).filter(Boolean);
const POPUP_RETRY_ATTEMPTS=envN('POPUP_RETRY_ATTEMPTS',10);
const POPUP_RETRY_INTERVAL_MS=envN('POPUP_RETRY_INTERVAL_MS',400);
const POPUP_MUTATION_WINDOW_MS=envN('POPUP_MUTATION_WINDOW_MS',6000);
const POPUP_DEBUG=envB('POPUP_DEBUG',false);
const POPUP_DEBUG_SCREENSHOT=envB('POPUP_DEBUG_SCREENSHOT',false);

/* Aggressive capture adjustments */
const AGGRESSIVE_CAPTURE=envB('AGGRESSIVE_CAPTURE',false);
if(AGGRESSIVE_CAPTURE){
  if(SCROLL_PASSES<2) SCROLL_PASSES=2;
  if(WAIT_EXTRA<1200) WAIT_EXTRA=1200;
  if(QUIET_MILLIS<2000) QUIET_MILLIS=2000;
  if(MAX_CAPTURE_MS<30000) MAX_CAPTURE_MS=30000;
}

/* Consent defaults */
if(!CONSENT_BUTTON_TEXTS.length){
  CONSENT_BUTTON_TEXTS=[
    // English
    'allow all','accept all','accept','agree','ok','okay','got it',
    'allow cookies','accept cookies',
    // German
    'alle cookies akzeptieren','akzeptieren','zustimmen','einverstanden','alles akzeptieren','einwilligen',
    // ES/PT/IT/FR
    'aceptar','aceitar','aceptar todo','aceitar tudo','aceptar todas','aceitar todos',
    'accetta','accetta tutti',"j'accepte",'tout accepter',
    // Nordics / Dutch
    'godta alle','till?t alla','accepteren','alles toestaan'
  ];
}
function normalizeBtnText(t){ return t.replace(/\u00A0/g,' ').replace(/\s+/g,' ').trim().toLowerCase(); }
function simplifyForMatch(t){ return normalizeBtnText(t).replace(/[0-9]/g,'').replace(/[|:;,.()<>??"']/g,'').replace(/\s+/g,' ').trim(); }
const CONSENT_TEXTS_NORM=CONSENT_BUTTON_TEXTS.map(normalizeBtnText);
const CONSENT_PRIORITY=[
  'allow all','accept all','accept','agree','einwilligen','zustimmen','alles akzeptieren'
].map(simplifyForMatch);

/* ------------ Args ------------ */
const seedsFile=process.argv[2];
const outputRoot=process.argv[3];
console.log('[ARCHIVER_BOOT]',{
  pid:process.pid,seedsFile,outputRoot,ENGINE,CONCURRENCY,HEADLESS,
  RAW_ONLY,AGGRESSIVE_CAPTURE,PROFILES:PROFILES_LIST
});
if(!seedsFile||!outputRoot){
  console.error('Usage: node archiver.cjs <seedsFile> <outputDir>');
  process.exit(1);
}

/* ------------ Profiles Loading ------------ */
// Optional external device profiles
let PROFILE_DATA={};
try{
  const p=path.join(__dirname,'device-profiles.json');
  if(fs.existsSync(p)){
    PROFILE_DATA=JSON.parse(fs.readFileSync(p,'utf8'));
  }
}catch(e){ console.warn('[PROFILE_WARN] unable to load device-profiles.json',e.message); }
function resolveProfile(name){
  const base=PROFILE_DATA[name]||null;
  if(!base){
    if(name==='mobile') return {
      name:'mobile',viewport:{width:390,height:844},
      userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      deviceScaleFactor:3,isMobile:true,hasTouch:true
    };
    return {
      name:'desktop',viewport:{width:1366,height:900},
      userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      deviceScaleFactor:1,isMobile:false,hasTouch:false
    };
  }
  return base;
}

/* ------------ Seeds ------------ */
function readSeeds(f){
  let lines=[];
  try{ lines=fs.readFileSync(f,'utf8').split(/\r?\n/).map(l=>l.trim()).filter(Boolean); }
  catch(e){ console.error('[SEEDS_READ_ERR]',e.message); process.exit(1); }
  if(DOMAIN_FILTER_ENV){
    try{ const rx=new RegExp(DOMAIN_FILTER_ENV,'i'); lines=lines.filter(l=>rx.test(l)); }catch{}
  }
  // Ensure PRIMARY_START_URL is included and first, if provided
  try{
    if (PRIMARY_START_URL) {
      const set = new Set(lines);
      set.delete(PRIMARY_START_URL);
      return [PRIMARY_START_URL, ...set];
    }
  } catch {}
  return [...new Set(lines)];
}
function localPath(uStr){
  const u=new URL(uStr);
  return pageRelFromUrl(u);
}

// Include query params in page path to uniquely map dynamic routes (e.g., index.php?route=category)
const INCLUDE_PAGE_QUERY_IN_PATH = envB('INCLUDE_PAGE_QUERY_IN_PATH', true);
function slugifyQuery(searchParams){
  try{
    const entries = [];
    for (const [k,v] of searchParams.entries()) entries.push([k,v]);
    entries.sort((a,b)=> a[0]===b[0] ? String(a[1]).localeCompare(String(b[1])) : a[0].localeCompare(b[0]));
    const parts = entries.map(([k,v])=>{
      const kk=String(k).replace(/[^a-z0-9]+/gi,'_').replace(/^_+|_+$/g,'');
      const vv=String(v).replace(/[^a-z0-9]+/gi,'_').replace(/^_+|_+$/g,'');
      return kk + (vv?('_'+vv):'');
    }).filter(Boolean);
    if(!parts.length) return '';
    const slug = parts.join('__');
    return slug.length>120 ? (slug.slice(0,100)+'__'+sha16(slug)) : slug;
  }catch{ return ''; }
}
function pageRelFromUrl(u){
  let p=(u.pathname||'').replace(/\/+$/,'');
  if(p==='') p = FLATTEN_ROOT_INDEX ? '' : 'index';
  else p = p.replace(/^\/+/,'');
  if(INCLUDE_PAGE_QUERY_IN_PATH){
    try{
      const qs = slugifyQuery(u.searchParams||new URLSearchParams());
      if(qs){ p = (p||'index') + '__' + qs; }
    }catch{}
  }
  return p;
}

/* ------------ Proxies ------------ */
let proxies=[];
if(PROXIES_FILE){
  try{ proxies=JSON.parse(fs.readFileSync(PROXIES_FILE,'utf8')); if(!Array.isArray(proxies)) proxies=[]; }catch{}
}
let proxyIndex=0;
function randSession(){ return crypto.randomBytes(4).toString('hex'); }
function nextProxy(pageNum){
  if(!proxies.length) return null;
  if(!STABLE_SESSION && ROTATE_EVERY>0 && pageNum%ROTATE_EVERY===0) proxyIndex++;
  const base=proxies[proxyIndex % proxies.length];
  let username=base.username||'';
  if(!STABLE_SESSION && ROTATE_SESSION){
    username=username.replace(/(session-)[A-Za-z0-9_-]+/,(_,p)=>p+randSession());
  }
  return {server:base.server, username, password:base.password};
}

/* ------------ Raw fallback ------------ */
function rawFetchProxy(url,proxy){
  return new Promise((resolve,reject)=>{
    if(!proxy) return reject(new Error('No proxy'));
    const proxyUrl=`http://${proxy.username}:${proxy.password}@${proxy.server.replace(/^https?:\/\//,'')}`;
    const agent=new HttpsProxyAgent(proxyUrl);
    const U=new URL(url);
    const opts={
      hostname:U.hostname,
      path:U.pathname+(U.search||''),
      method:'GET',
      headers:{
        'User-Agent':'Mozilla/5.0',
        'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      agent, timeout:20000
    };
    const req=https.request(opts,res=>{
      const chunks=[]; res.on('data',c=>chunks.push(c));
      res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error',reject);
    req.setTimeout(20000,()=>req.destroy(new Error('raw timeout')));
    req.end();
  });
}

/* ------------ Engine ------------ */
const engineMap={chromium,firefox,webkit};
const engine=engineMap[ENGINE]||chromium;
function chooseUA(profile){
  if(profile && profile.userAgent) return profile.userAgent;
  if(ALT_USER_AGENTS.length) return ALT_USER_AGENTS[Math.floor(Math.random()*ALT_USER_AGENTS.length)];
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
}
async function createBrowser(proxyObj){
  const args=['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'];
  if(DISABLE_HTTP2 && ENGINE==='chromium'){
    args.push('--disable-http2');
    args.push('--disable-quic');
    args.push('--disable-features=UseChromeLayeredNetworkStack');
  }
  const launch={ headless:HEADLESS };
  if(proxyObj) launch.proxy={ server:proxyObj.server, username:proxyObj.username, password:proxyObj.password };
  if(ENGINE==='chromium') launch.args=args;
  return engine.launch(launch);
}

/* ------------ Stealth (capture-time only) ------------ */
async function applyStealth(context){
  try {
    // navigator.webdriver
    await context.addInitScript(() => {
      try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}
    });
    // Languages
    await context.addInitScript(() => {
      try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] }); } catch {}
    });
    // Plugins length
    await context.addInitScript(() => {
      try { Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] }); } catch {}
    });
    // WebGL vendor/renderer spoof (heuristic)
    await context.addInitScript(() => {
      try {
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(param) {
          if (param === 37445) return 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
          if (param === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
          return getParameter.apply(this, [param]);
        };
      } catch {}
    });
    try { await context.grantPermissions(['geolocation','notifications']); } catch {}
  } catch {}
}

/* ------------ Humanization (light) ------------ */
function rint(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }
async function humanizePage(page, profile){
  try{
    const w = (profile?.viewport?.width)||1366, h=(profile?.viewport?.height)||900;
    const steps = rint(3,6);
    await page.mouse.move(rint(10,w-10), rint(10,h-10), { steps:rint(8,18) });
    for(let i=0;i<steps;i++){
      await page.waitForTimeout(rint(120,320));
      await page.mouse.move(rint(10,w-10), rint(10,h-10), { steps:rint(5,12) });
      if(Math.random()<0.4){
        await page.mouse.wheel({ deltaY: rint(150, 600) });
      }
    }
    if(Math.random()<0.25){ try{ await page.keyboard.press('PageDown'); }catch{} }
    if(Math.random()<0.15){ try{ await page.mouse.click(rint(40,w-40), rint(80,h-80)); }catch{} }
  }catch{}
}

/* ------------ Same-site checker ------------ */
let isSameSite = (_)=>true;

/* ------------ Asset path decision ------------ */
function decideAssetLocalPath(targetUrl, baseOrigin){
  const inSame = (()=>{ try{ return isSameSite(targetUrl); }catch{ return false; } })();
  const u=new URL(targetUrl, baseOrigin);
  const host=u.hostname;
  const pathname=u.pathname;

  if(PRESERVE_ASSET_PATHS && inSame){
    let rel=pathname.replace(/^\/+/,'');
    if(rel.endsWith('/')) rel+='index';
    if(!/\.[a-z0-9]{2,6}$/i.test(rel)) rel+=guessExt(targetUrl,'');
    return { localPath:rel, rewriteTo:'/'+rel.replace(/\\/g,'/'), group:'same' };
  }
  if(MIRROR_CROSS_ORIGIN && !inSame){
    let rel=pathname.replace(/^\/+/,'');
    if(rel.endsWith('/')) rel+='index';
    if(!/\.[a-z0-9]{2,6}$/i.test(rel)) rel+=guessExt(targetUrl,'');
    const local=path.join('_ext',host,rel);
    return { localPath:local, rewriteTo:'/'+local.replace(/\\/g,'/'), group:'cross' };
  }
  const file='assets/'+sha16(new URL(targetUrl, baseOrigin).toString())+guessExt(targetUrl,'');
  return { localPath:file, rewriteTo:file, group:'hashed' };
}
function shouldSkipDownloadUrl(url){
  if (SKIP_DOWNLOAD_PATTERNS.some(p=>p && url.includes(p))) return true;
  if (BLOCK_TRACKERS && TRACKER_RX && TRACKER_RX.test(url)) return true;
  return false;
}

/* ------------ HTML asset rewrite ------------ */
function rewriteHTML(html,assetIndex, baseOrigin){
  if(!REWRITE_HTML_ASSETS) return html;
  const $=cheerio.load(html,{decodeEntities:false});
  function processAttr(el,attr){
    const val=$(el).attr(attr); if(!val) return;
    // Resolve relative values to absolute to match assetIndex keys
    const cands=[];
    try{ cands.push(new URL(val, baseOrigin).toString()); }catch{ cands.push(val); }
    if(/^\/\//.test(val)) { cands.push('https:'+val,'http:'+val); }
    for(const c of cands){ const rec=assetIndex.get(c); if(rec){ $(el).attr(attr,rec.rewriteTo); return; } }
  }
  $('link,script,img,source,iframe,video,audio').each((_,el)=>{
    ['href','src','data-src','poster','srcset'].forEach(a=>processAttr(el,a));
  });
  $('img[srcset],source[srcset]').each((_,el)=>{
    const val=$(el).attr('srcset'); if(!val) return;
    const parts=val.split(',').map(p=>p.trim()).map(p=>{
      const seg=p.split(/\s+/);
      let abs=seg[0];
      try{ abs=new URL(seg[0], baseOrigin).toString(); }catch{}
      const rec=assetIndex.get(abs); if(rec) seg[0]=rec.rewriteTo; return seg.join(' ');
    });
    $(el).attr('srcset',parts.join(', '));
  });
  return $.html();
}

/* ------------ Offline fallback shim injection ------------ */
function injectOfflineFallbackShim(html, assetIndex, baseOrigin) {
  if (!OFFLINE_FALLBACK) return html;

  // Build a compact URL -> local rewriteTo map
  const mapObj = {};
  for (const [orig, rec] of assetIndex.entries()) {
    if (!rec || !rec.rewriteTo) continue;
    try {
      const abs = new URL(orig, baseOrigin).href;
      mapObj[abs] = rec.rewriteTo;
      if (OFFLINE_MAP_STRIP_QUERY) {
        const noQ = abs.split(/[?#]/)[0];
        if (!mapObj[noQ]) mapObj[noQ] = rec.rewriteTo;
      }
    } catch {}
  }
  const inlineMap = JSON.stringify(mapObj);

  const shim = `
<script>
(()=>{try{
  if (window.__OFFLINE_FALLBACK__) return; window.__OFFLINE_FALLBACK__=1;
  const MAP = ${inlineMap};
  const toAbs = (u)=>{ try { return new URL(u, location.href).href; } catch { return String(u||''); } };
  const lookup = (u)=>{
    const abs = toAbs(u);
    if (MAP[abs]) return MAP[abs];
    const noQ = abs.split(/[?#]/)[0];
    return MAP[noQ] || null;
  };

  // fetch
  const origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = async function(input, init){
      const url = (typeof input === 'string') ? input : (input && input.url) || '';
      const local = lookup(url);
      // Prefer local if we have a mapping to avoid tripping origin edge logic
      if (local) {
        try { return await origFetch(local, init); } catch(e) { /* fall through to network */ }
      }
      try {
        const res = await origFetch(input, init);
        if (!res || (res.status >= 400 && local)) {
          try { return await origFetch(local, init); } catch(_) {}
        }
        return res;
      } catch(err) {
        if (local) {
          try { return await origFetch(local, init); } catch(_) {}
        }
        throw err;
      }
    };
  }

  // XHR
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function(method, url){
      this.__offline_url = url;
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function(body){
      const url = this.__offline_url || '';
      const local = lookup(url);
      if (!local) return origSend.apply(this, arguments);

      try {
        fetch(local).then(async r=>{
          const ct = r.headers.get('content-type') || '';
          let payload;
          if (/application\\/json|text\\/json|\\+json/i.test(ct)) {
            payload = await r.text();
            Object.defineProperty(this, 'response', { get: ()=> payload });
            Object.defineProperty(this, 'responseText', { get: ()=> payload });
          } else if (/text\\//i.test(ct) || /\\.((html?)|(css)|(js))$/i.test(local)) {
            payload = await r.text();
            Object.defineProperty(this, 'response', { get: ()=> payload });
            Object.defineProperty(this, 'responseText', { get: ()=> payload });
          } else {
            const buf = await r.arrayBuffer();
            Object.defineProperty(this, 'response', { get: ()=> buf });
          }
          Object.defineProperty(this, 'status', { get: ()=> 200 });
          Object.defineProperty(this, 'readyState', { get: ()=> 4 });
          this.onreadystatechange && this.onreadystatechange();
          this.onload && this.onload();
        }).catch(()=> origSend.apply(this, arguments));
        return;
      } catch(e) { /* fall back to network */ }
      return origSend.apply(this, arguments);
    };
  }
}catch(e){/* silent */}})();
</script>`.trim();

  try {
    const $ = cheerio.load(html, { decodeEntities: false });
    if ($('head').length) $('head').prepend(shim);
    else $('html').prepend('<head>'+shim+'</head>');
    return $.html();
  } catch {
    return html.replace(/<head[^>]*>/i, m => m + '\n' + shim + '\n');
  }
}

/* ------------ Consent logic (robust, all-frames) ------------ */
async function attemptConsent(page){
  const DEBUG = CONSENT_DEBUG;

  const BUILTIN_SELECTORS = [
    // OneTrust
    '#onetrust-accept-btn-handler','.ot-pc-accept-all','.ot-sdk-container #accept-recommended-btn-handler',
    // Usercentrics
    'button[data-testid="uc-accept-all-button"]','button[id^="uc-center-container"] button[aria-label*="accept" i]',
    // Cookiebot
    '#CybotCookiebotDialogBodyLevelButtonAccept','#CybotCookiebotDialogBodyButtonAccept',
    // consentmanager / Sourcepoint
    'button.sp_choice_type_11','.sp-message-button[data-qa="accept-all"]','.sp_msg_choice.sp_choice_type_11',
    // Klaro
    '.klaro .cm-btn-accept','.klaro .cookie-modal-accept-all',
    // Didomi
    '#didomi-accept-button','.didomi-accept-button',
    // Complianz
    '.cmplz-accept','.cmplz-btn-accept',
    // Generic
    'button[aria-label*="accept" i]','button[id*="accept" i]','button[class*="accept" i]',
    'button[aria-label*="zustimm" i]','button[class*="zustimm" i]'
  ];
  const BUILTIN_CONTAINERS = [
    '#onetrust-banner-sdk','#CybotCookiebotDialog','#usercentrics-root',
    'div[id^="sp_message_container_"]','.sp-message-container',
    '.cm-wrapper','.cm__container','.cc-window','.cookie-consent','.cookieconsent','.cookiebar'
  ];
  const BUILTIN_FORCE_REMOVE = [
    '#onetrust-banner-sdk','#usercentrics-root','#CybotCookiebotDialog',
    'div[id^="sp_message_container_"]','.sp-message-container',
    '.cm-wrapper','.cm__container','.cc-window','.cookie-consent','.cookieconsent','.cookiebar',
    'div[id*="cookie"]','div[class*="cookie"]','div[id*="consent"]','div[class*="consent"]',
    '.ts-trustbadge','iframe[src*="trustedshops"]','.trustbadge'
  ];

  const btnTexts = Array.from(new Set([
    ...CONSENT_TEXTS_NORM,
    'accept all','allow all','accept','agree','i agree','got it',
    'alle cookies akzeptieren','alles akzeptieren','akzeptieren','zustimmen','einverstanden',
    'aceptar','aceptar todo','aceitar','aceitar tudo',
    'accetta','accetta tutti',"j'accepte",'tout accepter',
    'godta alle','till?t alla','accepteren','alles toestaan'
  ].map(normalizeBtnText)));

  const selCatalog = Array.from(new Set([...BUILTIN_SELECTORS, ...CONSENT_EXTRA_SELECTORS].filter(Boolean)));
  const forceRemoveCatalog = Array.from(new Set([...BUILTIN_FORCE_REMOVE, ...CONSENT_FORCE_REMOVE_SELECTORS].filter(Boolean)));
  const containers = BUILTIN_CONTAINERS;

  if (DEBUG) console.log('[CONSENT] start, frames=', page.frames?.().length || 'n/a');

  const attempts = Math.max(1, CONSENT_RETRY_ATTEMPTS);
  let clicked = false;

  function orderFrames(frames){
    if(!frames || !frames.length) return [];
    const main = page.mainFrame?.() || frames[0];
    const rest = frames.filter(f=>f !== main);
    return [main, ...rest];
  }

  async function tryFrame(frame){
    try{
      const res = await frame.evaluate((btnTexts, selectors, containers) => {
        const norm=s=>s.replace(/\u00A0/g,' ').replace(/\s+/g,' ').trim().toLowerCase();
        function clickable(el){
          if(!el) return false;
          const r=el.getBoundingClientRect();
          const st=getComputedStyle(el);
          if(!r || r.width===0 || r.height===0) return false;
          if(st.display==='none' || st.visibility==='hidden' || st.opacity==='0') return false;
          return true;
        }
        function trySelectors(){
          for(const sel of selectors){
            try{
              const el = document.querySelector(sel);
              if(el && clickable(el)){ el.click(); return {ok:true,how:'selector',sel}; }
            }catch{}
          }
          return {ok:false};
        }
        function gatherButtonish(root){
          const set=new Set();
          root.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"],a').forEach(b=>set.add(b));
          return [...set];
        }
        function tryByText(){
          const candidates=gatherButtonish(document);
          for(const el of candidates){
            const label = norm(el.innerText||el.textContent||el.value||'');
            if(!label) continue;
            for(const t of btnTexts){ if(label.includes(t)){ if(clickable(el)){ el.click(); return {ok:true,how:'text',label}; } } }
          }
          return {ok:false};
        }
        function tryContainers(){
          for(const c of containers){
            try{
              const box=document.querySelector(c); if(!box) continue;
              const buttons = box.querySelectorAll('button,[role="button"],a');
              for(const el of buttons){
                const label = norm(el.innerText||el.textContent||'');
                if(!label) continue;
                for(const t of btnTexts){ if(label.includes(t)){ if(clickable(el)){ el.click(); return {ok:true,how:'container',sel:c,label}; } } }
              }
            }catch{}
          }
          return {ok:false};
        }
        const bySel=trySelectors(); if(bySel.ok) return bySel;
        const byTxt=tryByText();   if(byTxt.ok) return byTxt;
        const byBox=tryContainers(); if(byBox.ok) return byBox;

        // Shadow DOM sweep (heuristic)
        const shadowHosts=[...document.querySelectorAll('*')].filter(e=>e.shadowRoot);
        for(const host of shadowHosts){
          const root=host.shadowRoot;
          for(const sel of ['button','.accept','.ok','.agree']){
            try{
              const el=root.querySelector(sel);
              const label = norm(el?.innerText||el?.textContent||'');
              if(el && clickable(el) && (sel!=='button' ? true : btnTexts.some(t=>label.includes(t)))){
                el.click(); return {ok:true,how:'shadow',sel};
              }
            }catch{}
          }
        }
        return {ok:false};
      }, btnTexts, selCatalog, containers);
      if (res?.ok) { if (DEBUG) console.log('[CONSENT] clicked in frame', res); return true; }
    }catch(e){
      if (DEBUG) console.log('[CONSENT] frame eval error:', e?.message);
    }
    return false;
  }

  async function tryAllFramesOnce(){
    const frames = orderFrames(page.frames ? page.frames() : []);
    for(const f of frames){
      const ok = await tryFrame(f);
      if (ok) return true;
    }
    return false;
  }

  for (let i=0;i<attempts && !clicked;i++){
    clicked = await tryAllFramesOnce();
    if (!clicked){
      if (CONSENT_IFRAME_SCAN){
        // tryFrame already visits frames
      }
      if (!clicked){
        await page.waitForTimeout(CONSENT_RETRY_INTERVAL_MS).catch(()=>{});
      }
    }
  }

  // If still visible, force remove common overlays
  let removed=false;
  if (!clicked){
    try{
      await page.evaluate((sels)=>{
        let cnt=0;
        const kill=(root)=>{
          for(const sel of sels){
            try{ root.querySelectorAll(sel).forEach(el=>{ el.remove(); cnt++; }); }catch{}
          }
        };
        kill(document);
        const ifr=document.querySelectorAll('iframe');
        for(const fr of ifr){
          try{ if(fr.contentDocument){ kill(fr.contentDocument); } }catch{}
        }
        return cnt;
      }, BUILTIN_FORCE_REMOVE).then(n=>{ removed = (n>0); if (DEBUG) console.log('[CONSENT] removed=',n); });
    }catch(e){ if (DEBUG) console.log('[CONSENT] force-remove error:', e?.message); }
  }

  // Persist "accepted" state
  try{
    await page.evaluate(()=>{
      try {
        localStorage.setItem('cookieconsent_status','allow');
        localStorage.setItem('cmplz_consentstatus','allow');
        localStorage.setItem('uc_user_interaction','true');
        localStorage.setItem('didomi_token','{"purposes":{"consent":{"all":true}}}');
        sessionStorage.setItem('cookieconsent_status','allow');
        const oneYear = 60*60*24*365;
        document.cookie = 'cookieconsent_status=allow; path=/; max-age='+oneYear;
        document.cookie = 'cmplz_consentstatus=allow; path=/; max-age='+oneYear;
      } catch {}
    });
  }catch{}

  // Remove scroll locks
  try{
    await page.evaluate(()=>{
      const clear = (el)=>{ if(!el) return; el.style.setProperty('overflow','', 'important'); el.style.setProperty('position','', 'important'); el.style.setProperty('height','', 'important'); };
      clear(document.documentElement); clear(document.body);
      const classes=['modal-open','no-scroll','overflow-hidden','overflowHidden','fixed','stop-scrolling'];
      classes.forEach(c=>document.documentElement.classList.remove(c));
      classes.forEach(c=>document.body?.classList.remove(c));
    });
  }catch{}

  if (CONSENT_DEBUG_SCREENSHOT) {
    try { await page.screenshot({ path:`consent-after-${Date.now()}.png`, fullPage:true }); } catch {}
  }

  return { clicked, removed };
}

/* ------------ Popup handling ------------ */
async function handlePopups(page){
  if(!POPUP_CLOSE_SELECTORS.length && !POPUP_FORCE_REMOVE_SELECTORS.length) return {acted:false};
  const cfg={
    closeSelectors:POPUP_CLOSE_SELECTORS,
    forceRemoveSelectors:POPUP_FORCE_REMOVE_SELECTORS,
    retry:POPUP_RETRY_ATTEMPTS,
    interval:POPUP_RETRY_INTERVAL_MS,
    mutation:POPUP_MUTATION_WINDOW_MS,
    debug:POPUP_DEBUG
  };
  const script=async(cfg)=>{
    const {closeSelectors,forceRemoveSelectors,retry,interval,mutation,debug}=cfg;
    const log=(...a)=>{ if(debug) console.log('[POPUP]',...a); };
    const xRegex=/^\s*[x???]\s*$/i;
    const closeWords=['close','dismiss','schlie?en','schliessen','cerrar','fermer','chiudi','???????','bez?r'];
    function trySelectors(root){
      for(const sel of closeSelectors){
        if(!sel) continue;
        const el=root.querySelector(sel);
        if(el){ try{ el.click(); log('clicked selector',sel); return true; }catch{} }
      }
      return false;
    }
    function tryText(root){
      const els=root.querySelectorAll('button,a,span,div,[role="button"]');
      for(const el of els){
        const raw=(el.innerText||el.textContent||'').trim();
        const lc=raw.toLowerCase();
        if(xRegex.test(raw) || closeWords.some(w=>lc.includes(w))){
          try{ el.click(); log('clicked text',raw); return true; }catch{}
        }
      }
      return false;
    }
    function forceRemove(root){
      let removed=false;
      for(const sel of forceRemoveSelectors){
        if(!sel) continue;
        root.querySelectorAll(sel).forEach(n=>{ n.remove(); removed=true; });
      }
      if(removed) log('force removed');
      return removed;
    }
    let acted=false, mutationActed=false;
    if(mutation>0){
      try{
        const obs=new MutationObserver(()=>{
          if(mutationActed) return;
          if(trySelectors(document)||tryText(document)){
            mutationActed=true; acted=true; obs.disconnect();
          }
        });
        obs.observe(document.documentElement,{childList:true,subtree:true});
        setTimeout(()=>{ try{ obs.disconnect(); }catch{} }, mutation);
      }catch{}
    }
    for(let i=0;i<retry && !acted;i++){
      if(trySelectors(document)||tryText(document)){ acted=true; break; }
      await new Promise(r=>setTimeout(r,interval));
    }
    if(!acted) forceRemove(document);
    return { acted: acted || mutationActed };
  };
  try{
    const result=await page.evaluate(script,cfg);
    if(POPUP_DEBUG) console.log('[POPUP_RESULT]',result);
    if(!result.acted && POPUP_DEBUG_SCREENSHOT){
      try{ await page.screenshot({path:'popup_debug_'+Date.now()+'.png'}); }catch{}
    }
    return result;
  }catch(e){
    if(POPUP_DEBUG) console.log('[POPUP_ERR]',e.message);
    return { acted:false, error:e.message };
  }
}

/* ------------ Per-Profile Capture Core ------------ */
async function captureProfile(pageNum,url,outRoot,rel,profile,sharedAssetIndex){
  const profileDirName = profile.name === 'desktop' ? 'desktop' : profile.name;
  // Normalize base dir: when rel==='' (flatten root), store under /index/<profile>/ to keep layout consistent
  const pageDirBase = (rel==='' ? path.join(outRoot,'index') : (rel ? path.join(outRoot,rel) : outRoot));
  const pageDir = path.join(pageDirBase, profileDirName);
  ensureDir(pageDir);
  const relDir = (rel === '' ? 'index' : (rel || 'index'));
  const pageLocalPath = path.posix.join(relDir, profileDirName);

  const record={
    url,
    relPath:rel,
    localPath: pageLocalPath,
    profile:profile.name,
    status:'ok',
    mainStatus:null,
    finalURL:null,
    assets:0,
    rawUsed:false,
    reasons:[],
    durationMs:0
  };

  const start=Date.now();
  if(RAW_ONLY){
    try{
      const raw=await rawFetchProxy(url,null);
      record.rawUsed=true;
      record.mainStatus=raw.status;
      fs.writeFileSync(path.join(pageDir,'index.html'), raw.body,'utf8');
    }catch(e){
      record.status='error:rawOnly '+e.message;
      record.reasons.push('rawErr:'+e.message);
    }
    record.durationMs=Date.now()-start;
    return record;
  }

  const proxy=nextProxy(pageNum);
  let browser,context,page;
  let inflight=0;
  let lastActivity=Date.now();
  function activity(){ lastActivity=Date.now(); }

  try{
    browser=await createBrowser(proxy);
    context=await browser.newContext({
      userAgent:chooseUA(profile),
      viewport:profile.viewport,
      deviceScaleFactor:profile.deviceScaleFactor||1,
      isMobile:profile.isMobile||false,
      hasTouch:profile.hasTouch||false,
      locale:'en-US'
    });
    if (STEALTH) { try { await applyStealth(context); } catch {} }

    page=await context.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);

    page.on('request',req=>{
      inflight++; activity();
      // Drop tracker/analytics requests early
      try{
        if (BLOCK_TRACKERS && TRACKER_RX && TRACKER_RX.test(req.url())){
          req.abort(); inflight--; return;
        }
      }catch{}
      if(shouldSkipDownloadUrl(req.url()) && req.resourceType()==='document'){
        try{ req.abort(); }catch{} inflight--;
      }
    });
    const dec=()=>{ inflight=Math.max(0,inflight-1); activity(); };
    page.on('requestfinished',dec);
    page.on('requestfailed',dec);

    page.on('response',resp=>{
      activity();
      const rq=resp.request();
      const rUrl=rq.url();
      const ct=(resp.headers()['content-type']||'').toLowerCase();
      if(!isLikelyAsset(rUrl,ct)) return;
      if(!INCLUDE_CROSS){
        try { if(!isSameSite(rUrl)) return; } catch {}
      }
      if(sharedAssetIndex.has(rUrl)) return;
      resp.body().then(buf=>{
        if(buf.length>ASSET_MAX_BYTES) return;
        if(INLINE_SMALL_ASSETS>0 && buf.length<=INLINE_SMALL_ASSETS && /^image\//i.test(ct)){
          sharedAssetIndex.set(rUrl,{rewriteTo:`data:${ct};base64,${buf.toString('base64')}`,inlineDataUri:true});
          return;
        }
        const { localPath:lp, rewriteTo }=decideAssetLocalPath(rUrl, url);
        const full=path.join(outRoot,lp); ensureDir(path.dirname(full));
        if(!(PROFILE_ASSET_DEDUP && fs.existsSync(full))){
          fs.writeFileSync(full,buf);
        }
        sharedAssetIndex.set(rUrl,{localPath:lp,rewriteTo});
      }).catch(()=>{});
    });

    let resp;
    try{
      resp=await page.goto(url,{waitUntil:PAGE_WAIT_UNTIL, timeout:NAV_TIMEOUT});
    }catch(navErr){
      record.reasons.push('navAttempt:'+navErr.message);
      throw navErr;
    }
    record.mainStatus=resp?.status()||null;
    record.finalURL=resp?.url()||page.url();
  try{ await page.waitForSelector('body',{timeout:10000}); }catch{ record.reasons.push('noBody'); }

  // Human-like interaction to help pass simple bot gates
  try{ await humanizePage(page, profile); }catch{}

    for(const sel of CLICK_SELECTORS){
      if(!sel) continue;
      try{ const el=await page.$(sel); if(el){ await el.click(); await page.waitForTimeout(150);} }catch{}
    }

    const consent=await attemptConsent(page);
    if(consent.clicked && FORCE_CONSENT_WAIT_MS>0) await page.waitForTimeout(FORCE_CONSENT_WAIT_MS);

    try{ await handlePopups(page); }catch(e){ record.reasons.push('popupErr:'+e.message); }

    if(REMOVE_SELECTORS.length){
      try{
        await page.evaluate(sels=>{
          sels.forEach(s=>document.querySelectorAll(s).forEach(n=>n.remove()));
        }, REMOVE_SELECTORS);
      }catch{}
    }

    for(let i=0;i<SCROLL_PASSES;i++){
      try{
        await page.evaluate(()=>{ const s=document.scrollingElement||document.documentElement; if(s) s.scrollBy(0,s.scrollHeight); });
      }catch{}
      await page.waitForTimeout(SCROLL_DELAY);
    }

    if(WAIT_EXTRA>0) await page.waitForTimeout(WAIT_EXTRA);

    const capDeadline=Date.now()+MAX_CAPTURE_MS;
    while(Date.now()<capDeadline){
      const quiet=(Date.now()-lastActivity)>=QUIET_MILLIS && inflight===0;
      if(quiet) break;
      await page.waitForTimeout(300);
    }

    let html=await page.content();

    // Record product IDs for auto payment-map (OpenCart and Woo patterns)
    try{
      const u = new URL(page.url());
      const route = (u.searchParams.get('route')||'').toLowerCase();
      let pid = '';
      if (/product\/product/.test(route)) pid = String(u.searchParams.get('product_id')||'');
      if (!pid) pid = String(u.searchParams.get('add-to-cart')||'');
      if (pid) {
        let title='';
        try{
          const $ = cheerio.load(html,{decodeEntities:false});
          title = $('#content h1').first().text().trim() || $('h1').first().text().trim() || '';
        }catch{}
        if (!FOUND_PRODUCT_IDS.has(pid)) FOUND_PRODUCT_IDS.set(pid, { url: page.url(), title });
      }
    }catch{}

    // Inject mobile meta viewport if mobile & missing
    if(profile.isMobile && INJECT_MOBILE_META){
      try{
        const $=cheerio.load(html,{decodeEntities:false});
        if($('meta[name="viewport"]').length===0){
          $('head').prepend('<meta name="viewport" content="width=device-width,initial-scale=1">');
          html=$.html();
        }
      }catch{}
    }

    if(REWRITE_INTERNAL){
      try{
        const baseUrl=page.url();
        const baseOrigin=(()=>{ try{return new URL(baseUrl).origin;}catch{return '';} })();
        const hostRegexSrc=INTERNAL_REWRITE_REGEX;
        const hostRx=hostRegexSrc?(()=>{ try{return new RegExp(hostRegexSrc,'i');}catch{return null;} })():null;
        const $=cheerio.load(html,{decodeEntities:false});
        $('a[href]').each((_,a)=>{
          const v=$(a).attr('href'); if(!v) return;
          if(/^(mailto:|tel:|javascript:|#)/i.test(v)) return;
          let u; try{ u=new URL(v,baseOrigin); }catch{return;}
          const internal = hostRx ? hostRx.test(u.hostname) : isSameSite(u);
          if(!internal) return;
          // If it looks like a document (no asset extension) OR it has query params, point to our local saved directory
          const hasExt=/\.[a-z0-9]{2,6}$/i.test(u.pathname||'');
          if(!hasExt || (u.search && u.search.length>1)){
            const rel = pageRelFromUrl(u);
            const href = '/' + (rel ? (rel + '/') : '');
            $(a).attr('href', href + (u.hash||''));
          } else {
            // For direct files (e.g., PDF), keep as is relative to origin
            let p=u.pathname; if(!p) p='/';
            $(a).attr('href', p + (u.hash||''));
          }
        });
        html=$.html();
      }catch(e){ record.reasons.push('rewriteInternalErr:'+e.message); }
    }

    if(REWRITE_HTML_ASSETS){
      try{ html=rewriteHTML(html,sharedAssetIndex, page.url()); }catch(e){ record.reasons.push('assetRewriteErr:'+e.message); }
    }

    // Inject offline fallback shim (preserves app logic; only falls back when live fails)
    try { html = injectOfflineFallbackShim(html, sharedAssetIndex, page.url()); } catch {}

    // Inject meta tag with SKU if we already extracted before writing HTML
    try {
      if (ENABLE_CATALOG) {
        const prodPre = extractProductFromPage(html, record.finalURL || url);
        if (prodPre) {
          const skuPre = assignSkuForKey(prodPre.key);
          if (skuPre) {
            try {
              const $ = cheerio.load(html, { decodeEntities: false });
              $('head').prepend(`<meta name="x-archived-sku" content="${skuPre}">`);
              html = $.html();
            } catch {}
          }
        }
      }
    } catch {}
    ensureDir(pageDir);
    fs.writeFileSync(path.join(pageDir,'index.html'), html,'utf8');

    // Also write a per-page JSON metadata file next to the HTML
    try {
      let title = '';
      try { const $ = cheerio.load(html,{decodeEntities:false}); title = $('title').first().text().trim() || ''; } catch {}
      const pageJson = {
        url,
        finalURL: record.finalURL || page.url?.() || undefined,
        relPath: record.relPath || rel,
        localPath: record.localPath,
        profile: record.profile,
        status: record.status,
        mainStatus: record.mainStatus,
        reasons: record.reasons,
        durationMs: record.durationMs,
        capturedAt: new Date().toISOString(),
        title
      };
      // If catalog is enabled and this looks like a product page, extract and attach SKU reference
      if (ENABLE_CATALOG) {
        try {
          const prod = extractProductFromPage(html, record.finalURL || url);
          if (prod) {
            const sku = assignSkuForKey(prod.key);
            // Upsert into CATALOG (by sku)
            const existingIdx = CATALOG.findIndex(e => e && e.sku === sku);
            const entry = {
              sku,
              name: prod.name,
              description: prod.description,
              price: { amount: prod.price, currency: prod.currency },
              images: prod.images,
              source: { url: record.finalURL || url, relPath: record.relPath || rel }
            };
            if (existingIdx >= 0) CATALOG[existingIdx] = entry; else CATALOG.push(entry);
            // Keep a reference in page json
            pageJson.productRefs = [sku];
          }
        } catch {}
      }
      fs.writeFileSync(path.join(pageDir, 'index.json'), JSON.stringify(pageJson, null, 2), 'utf8');
    } catch(e) { console.warn('[PAGE_JSON_ERR]', e.message); }

    // Write/refresh a per-page redirect stub at the base directory so /<rel>/ resolves to the default profile.
    // Preference: desktop wins; if desktop arrives later, it overwrites any earlier stub.
    try {
      const stubPath = path.join(pageDirBase, 'index.html');
      const target = '/' + pageLocalPath.replace(/\\/g,'/') + '/';
      const stubHtml = [
        '<!doctype html>',
        '<meta charset="utf-8">',
        `<title>Redirect</title>`,
        `<meta http-equiv="refresh" content="0; url=${target}">`,
        `<link rel="canonical" href="${target}">`,
        `<script>location.replace(${JSON.stringify(target)} + location.search + location.hash)</script>`,
        `<p>Redirecting to <a href="${target}">${target}</a></p>`
      ].join('\n');
      if (profileDirName === 'desktop') {
        // Desktop is the canonical default; overwrite to ensure it points to desktop.
        fs.writeFileSync(stubPath, stubHtml, 'utf8');
      } else if (!fs.existsSync(stubPath)) {
        // No stub yet: create one pointing to the first captured profile.
        fs.writeFileSync(stubPath, stubHtml, 'utf8');
      }
    } catch (e) {
      console.warn('[STUB_REDIRECT_ERR]', e.message);
    }

    await browser.close();
  }catch(e){
    record.status='error:nav '+e.message;
    record.reasons.push('attemptFail:'+e.message);
    try{ if(browser) await browser.close(); }catch{}
  }

  if((!record.mainStatus || record.status.startsWith('error')) && !record.rawUsed){
    try{
      const raw=await rawFetchProxy(url,nextProxy(pageNum));
      record.rawUsed=true;
      if(!record.mainStatus) record.mainStatus=raw.status;
      const baseDir=rel? path.join(outRoot,rel) : outRoot;
      const profDir=path.join(baseDir,profileDirName);
      ensureDir(profDir);
      if(!fs.existsSync(path.join(profDir,'index.html'))){
        fs.writeFileSync(path.join(profDir,'index.html'), raw.body,'utf8');
      }
      if(!record.status.startsWith('error')) record.status='okRaw';
    }catch(e){ record.reasons.push('rawFail:'+e.message); }
  }

  record.assets=[...sharedAssetIndex.values()].filter(v=>!v.inlineDataUri).length;
  record.durationMs=Date.now()-start;
  return record;
}

/* ------------ Multi-profile wrapper ------------ */
async function capture(pageNum,url,outRoot){
  const rel=localPath(url);
  const sharedAssetIndex=new Map();
  const profileRecords=[];
  for(const profName of PROFILES_LIST){
    const profile=resolveProfile(profName);
    const rec=await captureProfile(pageNum,url,outRoot,rel,profile,sharedAssetIndex);
    profileRecords.push(rec);
  }
  const desktopRec=profileRecords.find(r=>r.profile==='desktop')||profileRecords[0];
  console.log(`[RESULT] profiles=${profileRecords.map(r=>r.profile+':'+r.status).join(',')} url=${url} assets=${desktopRec.assets} saved=${rel||'(root)'}`);
  return profileRecords;
}

/* ------------ Root entry generator (redirect "/" smartly) ------------ */
function ensureRootIndex(outDir, manifest){
  const rootIndex = path.join(outDir, 'index.html');
  if (fs.existsSync(rootIndex)) return; // don?t overwrite
  // Prefer the explicitly submitted URL (PRIMARY_START_URL) if available in manifest
  let primary = null;
  let rel = '';
  if (PRIMARY_START_URL) {
    try {
      const u = new URL(PRIMARY_START_URL);
      const desiredRel = pageRelFromUrl(u);
      // find matching desktop record by relPath
      primary = manifest.find(r => r.profile === 'desktop' && (r.relPath||'') === desiredRel)
             || manifest.find(r => (r.relPath||'') === desiredRel)
             || null;
      rel = desiredRel;
    } catch {}
  }
  if (!primary) {
    primary = manifest.find(r => r.profile === 'desktop') || manifest[0];
    if (!primary) return;
    rel = (primary.relPath || '').replace(/^\/+/, '');
  } else {
    rel = (rel || '').replace(/^\/+/, '');
  }
  // Compute actual target from localPath if available; this points to the profile directory.
  const fallback = '/' + (rel ? rel + '/' : 'index/');
  const target = (primary && primary.localPath) ? ('/' + String(primary.localPath).replace(/^\/+/,'') + '/') : fallback;
  const title = (() => {
    try { return new URL(primary.url).hostname + ' snapshot'; } catch { return 'Snapshot'; }
  })();

  const html = [
    '<!doctype html>',
    '<meta charset="utf-8">',
    `<title>${title}</title>`,
    `<meta http-equiv="refresh" content="0; url=${target}">`,
    `<link rel="canonical" href="${target}">`,
    '<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:2rem}</style>',
    `<script>location.replace(${JSON.stringify(target)} + location.search + location.hash)</script>`,
    `<p>Redirecting to <a href="${target}">${target}</a> ?</p>`
  ].join('\n');

  try {
    fs.writeFileSync(rootIndex, html, 'utf8');
    console.log('[ROOT_INDEX] created ->', target);
  } catch (e) {
    console.warn('[ROOT_INDEX_ERR]', e.message);
  }
}

/* ------------ Payment map writer ------------ */
function writeAutoPaymentMap(outDir){
  if (!PAYMENT_MAP_AUTO) return;
  if (!FOUND_PRODUCT_IDS.size) return;
  const file = path.join(outDir, '_payment-map.json');
  let obj = { provider: PAYMENT_PROVIDER, target: PAYMENT_TARGET, map: {} };
  try{
    if (fs.existsSync(file)){
      const current = JSON.parse(fs.readFileSync(file,'utf8')) || {};
      obj.provider = current.provider || obj.provider;
      obj.target = current.target || obj.target;
      obj.map = current.map || {};
    }
  }catch{}
  let added = 0;
  for (const [pid] of FOUND_PRODUCT_IDS){
    if (!pid) continue;
    if (!obj.map[pid] && !obj.map['product_id_'+pid]){
      obj.map[pid] = PAYMENT_PLACEHOLDER;
      added++;
    }
  }
  if (added>0){
    try{
      fs.writeFileSync(file, JSON.stringify(obj,null,2));
      console.log('[PAYMENT_MAP]', 'written', path.relative(outDir,file), 'added', added, 'totalKeys', Object.keys(obj.map||{}).length);
    }catch(e){ console.warn('[PAYMENT_MAP_ERR]', e.message); }
  } else {
    console.log('[PAYMENT_MAP]', 'no new products to add');
  }
}

// SKU-based payment map derived from captured catalog; merges into _payment-map.json under bySku
function writeSkuPaymentMap(outDir){
  if (!GENERATE_PAYMENT_MAP_FROM_CATALOG) return;
  if (!ENABLE_CATALOG || !Array.isArray(CATALOG) || !CATALOG.length) return;
  const file = path.join(outDir, '_payment-map.json');
  let obj = { provider: PAYMENT_PROVIDER, target: PAYMENT_TARGET, map: {}, bySku: {} };
  try{
    if (fs.existsSync(file)){
      const current = JSON.parse(fs.readFileSync(file,'utf8')) || {};
      obj.provider = current.provider || obj.provider;
      obj.target = current.target || obj.target;
      obj.map = current.map || {};
      obj.bySku = current.bySku || {};
    }
  }catch{}
  let added = 0;
  for (const p of CATALOG){
    const sku = p && p.sku; if (!sku) continue;
    if (!obj.bySku[sku]){ obj.bySku[sku] = PAYMENT_PLACEHOLDER; added++; }
  }
  if (added>0){
    try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); console.log('[PAYMENT_MAP_SKU]', 'updated', added, 'entries'); } catch(e){ console.warn('[PAYMENT_MAP_SKU_ERR]', e.message); }
  }
}

/* ------------ Main ------------ */
;(async()=>{
  const seeds=readSeeds(seedsFile);
  console.log(`[ARCHIVER_SEEDS] count=${seeds.length}`);
  if(!seeds.length){ console.error('No seeds'); process.exit(2); }

  isSameSite = buildSameSiteChecker(seeds, { mode: SAME_SITE_MODE, extraRegex: INTERNAL_HOSTS_REGEX });
  try {
    const apex = getETLDPlusOne(new URL(seeds[0]).hostname);
    console.log('[SAMESITE]', { mode: SAME_SITE_MODE, apex });
  } catch {}

  ensureDir(outputRoot);
  console.log(`ARCHIVER start: urls=${seeds.length} engine=${ENGINE} concurrency=${CONCURRENCY} profiles=${PROFILES_LIST.join(',')}`);
  // Load existing catalog (if any) to maintain stable SKUs
  try { loadExistingCatalog(outputRoot); } catch {}

  // Determine capture order
  let finalSeeds = seeds.slice();
  if (USE_DISCOVERY_GRAPH) {
    try {
      let gPath = path.join(outputRoot, '_crawl', 'graph.json');
      if (!fs.existsSync(gPath)) {
        const alt = path.join(outputRoot, '_plan', 'graph.json');
        if (fs.existsSync(alt)) gPath = alt;
      }
      if (fs.existsSync(gPath)) {
        const g = JSON.parse(fs.readFileSync(gPath, 'utf8')) || {};
        const nodes = g.nodes || {};
        const edges = Array.isArray(g.edges) ? g.edges : [];
        const start = g.start || PRIMARY_START_URL || seeds[0] || '';
        const adj = new Map();
        for (const e of edges) {
          const from = e && e.from; const to = e && e.to; if (!from || !to) continue;
          if (!adj.has(from)) adj.set(from, new Set());
          adj.get(from).add(to);
        }
        // Prefill product IDs from graph nodes (OpenCart/Woo common params)
        try {
          for (const u of Object.keys(nodes)) {
            try {
              const U = new URL(u);
              const route = (U.searchParams.get('route')||'').toLowerCase();
              let pid = '';
              if (/product\/product/.test(route)) pid = String(U.searchParams.get('product_id')||'');
              if (!pid) pid = String(U.searchParams.get('add-to-cart')||'');
              if (pid && !FOUND_PRODUCT_IDS.has(pid)) FOUND_PRODUCT_IDS.set(pid, { url: u, title: '' });
            } catch {}
          }
        } catch {}
        let ordered = [];
        if (start && adj.size) {
          const seen = new Set([start]);
          const q = [start];
          while (q.length && ordered.length < DISCOVER_MAX_PAGES) {
            const cur = q.shift();
            let ok = true;
            try { if (!isSameSite(cur)) ok = false; } catch {}
            if (ok && DISCOVER_DENY_REGEX && new RegExp(DISCOVER_DENY_REGEX,'i').test(cur)) ok = false;
            if (ok && DISCOVER_ALLOW_REGEX && !(new RegExp(DISCOVER_ALLOW_REGEX,'i').test(cur))) ok = false;
            if (ok) ordered.push(cur);
            const nexts = Array.from(adj.get(cur) || []);
            for (const n of nexts) { if (!seen.has(n)) { seen.add(n); q.push(n); } }
          }
        }
        if (!ordered.length) {
          ordered = Object.keys(nodes).sort((a,b)=>{
            const da = (nodes[a] && nodes[a].depth)||9999;
            const db = (nodes[b] && nodes[b].depth)||9999;
            if (da!==db) return da-db; return String(a).localeCompare(String(b));
          }).slice(0, DISCOVER_MAX_PAGES);
        }
        // If enabled, rebuild ordered as full set of doc-like nodes sorted by depth then URL
        if (DISCOVER_USE_GRAPH_FULL) {
          const all = Object.keys(nodes).filter(u => {
            if (GRAPH_DOC_LIKE_ONLY && !isDocLikeUrl(u)) return false;
            try { if (!isSameSite(u)) return false; } catch {}
            if (DISCOVER_DENY_REGEX && new RegExp(DISCOVER_DENY_REGEX,'i').test(u)) return false;
            if (DISCOVER_ALLOW_REGEX && !(new RegExp(DISCOVER_ALLOW_REGEX,'i').test(u))) return false;
            return true;
          });
          all.sort((a,b)=>{
            const da=(nodes[a]?.depth)||9999, db=(nodes[b]?.depth)||9999;
            if(da!==db) return da-db; return String(a).localeCompare(String(b));
          });
          ordered = all;
        }
        try {
          if (PRIMARY_START_URL) {
            const set = new Set(ordered);
            set.delete(PRIMARY_START_URL);
            ordered = [PRIMARY_START_URL, ...set];
          }
        } catch {}
        if (ordered.length) {
          finalSeeds = ordered;
          console.log('[DISCOVER_GRAPH] using prebuilt graph for capture order', { nodes: Object.keys(nodes).length || 0, edges: edges.length || 0, seeds: finalSeeds.length });
        }
      }
    } catch (e) {
      console.warn('[DISCOVER_GRAPH_ERR]', e.message);
    }
  }

  // Internal discovery (BFS) before capture when enabled and no graph-derived order was set
  if (DISCOVER_IN_ARCHIVER && finalSeeds.length === seeds.length) {
    console.log(`[DISCOVER] start inside archiver maxPages=${DISCOVER_MAX_PAGES} maxDepth=${DISCOVER_MAX_DEPTH}`);
  const crawlDir = path.join(outputRoot, '_crawl');
  ensureDir(crawlDir);
    // Discovery graph: nodes (url -> depth) and edges (from -> to with optional anchor text)
    const graphNodeDepth = new Map();
    const graphEdges = [];
    const edgeSeen = new Set();
    const parentOf = new Map(); // childUrl -> parentUrl (first discoverer)
    function recordNode(u, d){
      if(!u) return;
      const cur = graphNodeDepth.get(u);
      if(cur==null || d < cur) graphNodeDepth.set(u, d);
    }
    function recordEdge(from, to, text, dFrom){
      if(!from || !to) return;
      const key = from + ' -> ' + to;
      if(edgeSeen.has(key)) return;
      edgeSeen.add(key);
      const t = (text||'').replace(/\s+/g,' ').trim().slice(0, 160);
      graphEdges.push({ from, to, text: t });
      if(typeof dFrom==='number') recordNode(from, dFrom);
    }
    const visited = new Set();
    const queue = [];
    const depths = new Map();
    const pushQ = (u, d, parent) => {
      if (!u) return;
      if (visited.has(u)) return;
      if (d > DISCOVER_MAX_DEPTH) return;
      visited.add(u);
      depths.set(u, d);
      if (parent!=null && !parentOf.has(u)) parentOf.set(u, parent);
      queue.push({ url: u, depth: d });
    };
    for (const s of seeds) pushQ(s, 0);

    const proxy = nextProxy(0);
    let browser, context, page;
    try {
      browser = await createBrowser(proxy);
      const prof = resolveProfile('desktop');
      context = await browser.newContext({
        userAgent: chooseUA(prof),
        viewport: prof.viewport,
        deviceScaleFactor: prof.deviceScaleFactor||1,
        isMobile: false,
        hasTouch: false,
        locale: 'en-US'
      });
      if (STEALTH) { try { await applyStealth(context); } catch {} }
      page = await context.newPage();
      page.setDefaultNavigationTimeout(NAV_TIMEOUT);

    const discovered = [];
      while (queue.length && discovered.length < DISCOVER_MAX_PAGES) {
        const { url, depth } = queue.shift();
        // Navigate with fallback to commit if needed
        let navigated = false;
        try {
          await page.goto(url, { waitUntil: PAGE_WAIT_UNTIL, timeout: NAV_TIMEOUT });
          navigated = true;
        } catch (e) {
          console.log(`[DISCOVER_WARN] goto (${PAGE_WAIT_UNTIL}) failed ${e.message}`);
          try {
            await page.goto(url, { waitUntil: 'commit', timeout: Math.min(15000, NAV_TIMEOUT) });
            navigated = true;
            try { await page.waitForLoadState('domcontentloaded', { timeout: Math.min(10000, NAV_TIMEOUT) }); } catch {}
          } catch (e2) {
            console.log('[DISCOVER_ERR]', e2.message);
          }
        }

        // Consent attempt to reveal links
        if (navigated) {
          try { await attemptConsent(page); } catch {}
          try { await page.waitForTimeout(300); } catch {}
        }

        // Extract anchors (DOM if navigated, fallback to regex from page.content())
        let hrefs = [];
        let linkPairs = [];
        try {
          if (navigated) {
            try { await page.waitForSelector('a[href]', { timeout: 5000 }); } catch {}
            // Collect href + anchor text to preserve some context for the graph
            linkPairs = await page.$$eval('a[href]', as => as.map(a => ({
              href: a.getAttribute('href'),
              text: (a.textContent||'').replace(/\s+/g,' ').trim().slice(0,160)
            })).filter(x=>x && x.href));
            hrefs = linkPairs.map(x=>x.href);
          }
        } catch {}
        if (!hrefs.length) {
          try {
            const html = navigated ? await page.content() : '';
            const re = /href\s*=\s*([\"'])(.*?)\1/gi;
            let m; while ((m = re.exec(html))) { hrefs.push(m[2]); if (hrefs.length > 2000) break; }
          } catch {}
        }

        // Normalize and enqueue
        const baseOrigin = (()=>{ try { return new URL(url).origin; } catch { return ''; } })();
        const normed = [];
        const textByAbs = new Map();
        const pairMap = new Map();
        try{ for(const lp of linkPairs){
          try{ const abs = new URL(lp.href, baseOrigin).toString();
            textByAbs.set(abs, textByAbs.get(abs)||lp.text||'');
            pairMap.set(lp.href, abs);
          }catch{}
        } }catch{}
        for (const raw of hrefs) {
          let abs;
          try {
            abs = pairMap.has(raw) ? pairMap.get(raw) : new URL(raw, baseOrigin).toString();
          } catch { continue; }
          // strip hash
          try { const u = new URL(abs); u.hash=''; abs=u.toString(); } catch {}
          // same-site check
          try { if (!isSameSite(abs)) continue; } catch {}
          // For traversal: respect deny strictly, but don't require allow to expand (we may need intermediates)
          if (DISCOVER_DENY_RX && DISCOVER_DENY_RX.test(abs)) continue;
          normed.push(abs);
          // Graph: record edge from current URL -> normalized absolute with anchor text when available
          try { recordEdge(url, abs, textByAbs.get(abs)||'', depth); } catch {}
        }
        // Record (only if allowed) and expand next depth
        if (!DISCOVER_ALLOW_RX && !DISCOVER_DENY_RX) {
          discovered.push(url);
        } else {
          // Allow recording only when the current URL matches filters; seed (depth 0) is not forced
          if (isAllowedByDiscover(url)) discovered.push(url);
        }
        // Graph: ensure node (url) is recorded with depth
        try { recordNode(url, depth); } catch {}
        if (depth < DISCOVER_MAX_DEPTH) {
          for (const n of normed) {
            if (discovered.length + queue.length >= DISCOVER_MAX_PAGES) break;
            if (!visited.has(n)) pushQ(n, depth + 1, url);
          }
        }
        console.log(`[DISCOVER] d=${depth} url=${url} +links=${normed.length} total=${discovered.length}`);
      }

      finalSeeds = discovered.slice(0, DISCOVER_MAX_PAGES);
      // Make sure PRIMARY_START_URL stays first and present
      try {
        if (PRIMARY_START_URL) {
          const set = new Set(finalSeeds);
          set.delete(PRIMARY_START_URL);
          finalSeeds = [PRIMARY_START_URL, ...set];
        }
      } catch {}
      // Persist for transparency
      try { fs.writeFileSync(path.join(crawlDir, 'urls.txt'), finalSeeds.join('\n') + '\n', 'utf8'); } catch {}
      // Persist link graph (nodes + edges)
      try {
        const nodes = {};
        for (const [u,d] of graphNodeDepth.entries()) nodes[u] = { depth: d };
        const tree = {};
        for (const [child, parent] of parentOf.entries()) { tree[child] = parent; }
        const graph = {
          start: PRIMARY_START_URL || seeds[0] || '',
          counts: { nodes: Object.keys(nodes).length, edges: graphEdges.length },
          nodes,
          edges: graphEdges,
          tree,
          config: {
            maxDepth: DISCOVER_MAX_DEPTH,
            maxPages: DISCOVER_MAX_PAGES,
            allow: DISCOVER_ALLOW_REGEX || null,
            deny: DISCOVER_DENY_REGEX || null,
            sameSiteMode: SAME_SITE_MODE
          },
          createdAt: new Date().toISOString()
        };
        fs.writeFileSync(path.join(crawlDir, 'graph.json'), JSON.stringify(graph, null, 2), 'utf8');
      } catch(e) {
        console.warn('[DISCOVER_GRAPH_ERR]', e.message);
      }
      console.log(`[DISCOVER_DONE] seeds=${finalSeeds.length}`);
      await browser.close();
    } catch (e) {
      console.log('[DISCOVER_FATAL]', e.message);
      try { if (browser) await browser.close(); } catch {}
    }
  }

  // Optional: run external commerce flow to discover product->cart->checkout URLs and add to seeds
  if (COMMERCE_FLOW && COMMERCE_FLOW_MODE !== 'off') {
    try {
      const tool = path.join(__dirname, 'tools', 'commerce-flow.cjs');
      const baseStart = (PRIMARY_START_URL || finalSeeds[0] || seeds[0] || '').trim();
      if (fs.existsSync(tool) && baseStart) {
        const outDir = path.join(outputRoot, '_commerce');
        ensureDir(outDir);
        const args = [tool, '--start', baseStart, '--platform', COMMERCE_PLATFORM_HINT, '--out', outDir, '--mode', COMMERCE_FLOW_MODE];
        console.log('[COMMERCE_FLOW] run', 'node', path.relative(process.cwd(), tool), args.slice(1).join(' '));
        cp.execFileSync(process.execPath, args, { stdio: 'inherit' });
        const f = path.join(outDir, 'urls.txt');
        if (fs.existsSync(f)) {
          const extra = fs.readFileSync(f, 'utf8').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
          if (extra.length) {
            const set = new Set(finalSeeds);
            for (const u of extra) set.add(u);
            finalSeeds = Array.from(set);
            console.log('[COMMERCE_FLOW] merged URLs', extra.length, 'totalSeeds', finalSeeds.length);
          }
        }
      }
    } catch (e) {
      console.warn('[COMMERCE_FLOW_ERR]', e.message);
    }
  }

  const manifest=[];
  const partial=path.join(outputRoot,'manifest.partial.jsonl');
  let idx=0;
  async function worker(wid){
    while(true){
      if(idx>=finalSeeds.length) break;
      const url=finalSeeds[idx++];
      console.log(`[W${wid}] (${idx}/${seeds.length}) ${url}`);
      const recs=await capture(idx,url,outputRoot);
      for(const r of recs){
        manifest.push(r);
        try{ fs.appendFileSync(partial, JSON.stringify(r)+'\n'); }catch{}
      }
    }
  }
  await Promise.all(Array.from({length:CONCURRENCY},(_,i)=>worker(i+1)));

  manifest.sort((a,b)=> (a.url===b.url ? a.profile.localeCompare(b.profile) : a.url.localeCompare(b.url)));
  const manifestPath = path.join(outputRoot,'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest,null,2));
  const failures=manifest.filter(m=>!String(m.status||'').startsWith('ok'));
  const totalAssets=[...new Set(manifest.filter(m=>m.profile==='desktop').map(m=>m.assets))].reduce((a,b)=>a+b,0);
  console.log(`DONE pages=${finalSeeds.length} profiles=${PROFILES_LIST.length} records=${manifest.length} failures=${failures.length} (desktop assets approx=${totalAssets})`);

  // Guarantee a root index.html exists and redirects to the captured page
  ensureRootIndex(outputRoot, manifest);

  // Write/merge _payment-map.json with placeholders for discovered product IDs
  try { writeAutoPaymentMap(outputRoot); } catch {}

  // Persist catalog + SKU map
  try { saveCatalog(outputRoot); console.log('[CATALOG] entries=', CATALOG.length, 'nextSku=', SKU_MAP.next); } catch {}
  // Derive/merge SKU-based payment mappings for host-time rewrites
  try { writeSkuPaymentMap(outputRoot); } catch {}

  if(failures.length){
    console.log('Sample failures:');
    failures.slice(0,8).forEach(f=>console.log('-',f.url,f.profile,f.status));
  }
})().catch(e=>{
  console.error('FATAL',e);
  process.exit(1);
});