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
const FLATTEN_ROOT_INDEX=envB('FLATTEN_ROOT_INDEX',false);

const PRESERVE_ASSET_PATHS=envB('PRESERVE_ASSET_PATHS',false);
const MIRROR_SUBDOMAINS=envB('MIRROR_SUBDOMAINS',true);
const MIRROR_CROSS_ORIGIN=envB('MIRROR_CROSS_ORIGIN',false);
const REWRITE_HTML_ASSETS=envB('REWRITE_HTML_ASSETS',true);
const INLINE_SMALL_ASSETS=envN('INLINE_SMALL_ASSETS',0);
const PAGE_WAIT_UNTIL=(process.env.PAGE_WAIT_UNTIL||'domcontentloaded');
let QUIET_MILLIS=envN('QUIET_MILLIS',1500);
let MAX_CAPTURE_MS=envN('MAX_CAPTURE_MS',20000);

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
  return [...new Set(lines)];
}
function localPath(uStr){
  const u=new URL(uStr);
  let p=u.pathname.replace(/\/+$/,'');
  if(p==='') return FLATTEN_ROOT_INDEX ? '' : 'index';
  return p.replace(/^\/+/,'');
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
  return SKIP_DOWNLOAD_PATTERNS.some(p=>p && url.includes(p));
}

/* ------------ HTML asset rewrite ------------ */
function rewriteHTML(html,assetIndex){
  if(!REWRITE_HTML_ASSETS) return html;
  const $=cheerio.load(html,{decodeEntities:false});
  function processAttr(el,attr){
    const val=$(el).attr(attr); if(!val) return;
    const cands=[val];
    if(/^\/\//.test(val)) cands.push('https:'+val,'http:'+val);
    for(const c of cands){
      const rec=assetIndex.get(c);
      if(rec){ $(el).attr(attr,rec.rewriteTo); return; }
    }
  }
  $('link,script,img,source,iframe,video,audio').each((_,el)=>{
    ['href','src','data-src','poster','srcset'].forEach(a=>processAttr(el,a));
  });
  $('img[srcset],source[srcset]').each((_,el)=>{
    const val=$(el).attr('srcset'); if(!val) return;
    const parts=val.split(',').map(p=>p.trim()).map(p=>{
      const seg=p.split(/\s+/); const rec=assetIndex.get(seg[0]); if(rec) seg[0]=rec.rewriteTo; return seg.join(' ');
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
  const pageDirBase = rel ? path.join(outRoot,rel) : outRoot;
  const pageDir = path.join(pageDirBase, profileDirName);
  ensureDir(pageDir);

  const record={
    url,
    relPath:rel,
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
          let p=u.pathname;
          if(!/\.[a-z0-9]{2,6}$/i.test(p) && !p.endsWith('/')) p+='/';
          $(a).attr('href',p);
        });
        html=$.html();
      }catch(e){ record.reasons.push('rewriteInternalErr:'+e.message); }
    }

    if(REWRITE_HTML_ASSETS){
      try{ html=rewriteHTML(html,sharedAssetIndex); }catch(e){ record.reasons.push('assetRewriteErr:'+e.message); }
    }

    // Inject offline fallback shim (preserves app logic; only falls back when live fails)
    try { html = injectOfflineFallbackShim(html, sharedAssetIndex, page.url()); } catch {}

    ensureDir(pageDir);
    fs.writeFileSync(path.join(pageDir,'index.html'), html,'utf8');

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
  const primary = manifest.find(r => r.profile === 'desktop') || manifest[0];
  if (!primary) return;
  const rel = (primary.relPath || '').replace(/^\/+/, '');
  const target = '/' + (rel ? rel + '/' : '');
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

/* ------------ Main ------------ */
(async()=>{
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

  const manifest=[];
  const partial=path.join(outputRoot,'manifest.partial.jsonl');
  let idx=0;
  async function worker(wid){
    while(true){
      if(idx>=seeds.length) break;
      const url=seeds[idx++];
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
  console.log(`DONE pages=${seeds.length} profiles=${PROFILES_LIST.length} records=${manifest.length} failures=${failures.length} (desktop assets approx=${totalAssets})`);

  // Guarantee a root index.html exists and redirects to the captured page
  ensureRootIndex(outputRoot, manifest);

  if(failures.length){
    console.log('Sample failures:');
    failures.slice(0,8).forEach(f=>console.log('-',f.url,f.profile,f.status));
  }
})().catch(e=>{
  console.error('FATAL',e);
  process.exit(1);
});