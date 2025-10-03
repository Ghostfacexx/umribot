#!/usr/bin/env node
// server.cjs � Static host with resilient asset resolution and HTML fixes.
// Resolves asset 404s for Shopware paths by:
// 1) direct static (preserved paths)
// 2) basename alias (first match by filename)
// 3) SHA-1 alias: assets/<sha16(fullUrl)><ext> (same scheme as archiver)
// 4) live fetch-from-origin on miss, then cache into assets/ (subsequent loads are offline)
//
// Also injects a tiny script into HTML to remove common consent overlays and the
// Trusted Shops badge, and to clear blur/scroll locks.
//
// Env:
//   ARCHIVE_ROOT=/path/to/run
//   PORT=8081
//   DEFAULT_VARIANT=desktop|mobile
//   DISABLE_HTML_INJECT=true   # optional, disable HTML script injection
//   DISABLE_FETCH_CACHE=true   # optional, disable live fetch on miss

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const express = require('express');
const cp = require('child_process');

const ROOT = path.resolve(process.env.ARCHIVE_ROOT || '');
const PORT = parseInt(process.env.PORT || '8081', 10);
const DEFAULT_VARIANT = (process.env.DEFAULT_VARIANT || 'desktop').toLowerCase();
const START_PATH = process.env.START_PATH || '';
const DISABLE_HTML_INJECT = String(process.env.DISABLE_HTML_INJECT || '').toLowerCase() === 'true';
const DISABLE_FETCH_CACHE = String(process.env.DISABLE_FETCH_CACHE || '').toLowerCase() === 'true';
// When true, redirect commerce interactions (cart/checkout/payment) to live origin (disabled by default per user request)
const LIVE_PASSTHROUGH = String(process.env.LIVE_PASSTHROUGH || 'false').toLowerCase() === 'true';
// Optional: enable graph.json-aware routing and client-side navigation guard
const ENABLE_GRAPH_ROUTING = String(process.env.ENABLE_GRAPH_ROUTING || 'true').toLowerCase() !== 'false';
// Optional: prevent SPA hydration/scripts from mutating SSR content (helps when client JS replaces lists with "No items found")
// Default true for archive browsing; set to false if you want full interactivity
const DISABLE_SPA_SCRIPTS = String(process.env.DISABLE_SPA_SCRIPTS || 'true').toLowerCase() !== 'false';
// Optional: run bake-static on host start and expose live logs via SSE
const BAKE_ON_HOST = String(process.env.BAKE_ON_HOST || 'true').toLowerCase() !== 'false';
const BAKE_SCRIPT = path.join(__dirname, 'tools', 'bake-static.cjs');

if (!ROOT || !fs.existsSync(ROOT)) {
  console.error('[SERVER_FATAL] ARCHIVE_ROOT not found:', ROOT);
  process.exit(2);
}

const app = express();

// Optional compression
try {
  const compression = require('compression');
  app.use(compression());
  console.log('[SERVER] Compression enabled');
} catch {
  console.log('[SERVER] compression not installed');
}

// Lightweight proxy for select GET requests (used for protocol-relative fixes)
async function proxyGet(fullUrl, res) {
  return new Promise((resolve) => {
    try {
      const proto = fullUrl.startsWith('https:') ? https : http;
      const req = proto.get(fullUrl, { timeout: 20000, headers: { 'User-Agent': 'ArchiveHost/1.0' } }, (r) => {
        if (r.statusCode && r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
          const loc = r.headers.location.startsWith('http') ? r.headers.location : new URL(r.headers.location, fullUrl).toString();
          r.resume();
          return resolve(proxyGet(loc, res));
        }
        try {
          const status = r.statusCode || 200;
          const headers = {};
          for (const [k, v] of Object.entries(r.headers || {})) {
            if (!/^transfer-encoding|connection|keep-alive|content-length$/i.test(k)) headers[k] = v;
          }
          res.status(status).set(headers);
          r.pipe(res);
          r.on('end', () => resolve(true));
          r.on('error', () => { try { res.status(204).end(); } catch {} resolve(false); });
        } catch {
          try { res.status(204).end(); } catch {}
          resolve(false);
        }
      });
      req.on('error', () => { try { res.status(204).end(); } catch {} resolve(false); });
      req.on('timeout', () => { try { req.destroy(); } catch {} try { res.status(204).end(); } catch {} resolve(false); });
    } catch {
      try { res.status(204).end(); } catch {}
      resolve(false);
    }
  });
}

// Normalize bad protocol-relative paths that became "/undefined//host/..."
// Example from logs: /en-us/desktop/undefined//accdn.lpsnmedia.net/api/... -> https://accdn.lpsnmedia.net/api/...
app.get(/undefined\/\/[A-Za-z0-9.-]+\//i, async (req, res, next) => {
  try {
    const m = req.path.match(/undefined\/\/([^/]+)(\/.*)$/i);
    if (!m) return next();
    const host = m[1];
    const rest = m[2] || '/';
    const scheme = primaryOrigin().startsWith('https://') ? 'https:' : 'http:';
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const full = scheme + '//' + host + rest + qs;
    return await proxyGet(full, res);
  } catch {
    return next();
  }
});

// Quiet common trackers/pixels that aren't needed in an offline archive
app.all(/^\/akam\//i, (req, res) => res.status(204).end());
// Random hashed BIN beacons observed in logs -> no-op
app.all(/^\/[A-Za-z0-9]{8,}\/.*\.bin$/i, (req, res) => res.status(204).end());

// Minimal stubs for YOOX/THE OUTNET JSON APIs to prevent error overlays
app.get(/^\/api\/yoox\/ton\/search\/resources\/store\/[^/]+\/productview\/byCategory/i, (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(200).send(JSON.stringify({ products: [], facets: [], total: 0 }));
});
app.get(/^\/api\/yoox\/ton\/blueprint\/servlet\/contentbyurl\/v2\/store\/[^?]+/i, (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(200).send(JSON.stringify({ content: {}, ok: true }));
});

// Helpers
function fileExists(f) { try { return fs.statSync(f).isFile(); } catch { return false; } }
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function tryFiles(list) { for (const f of list) { if (fileExists(f)) return f; } return null; }
function sha16(s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16); }
function guessExtByCT(ct, fallback) {
  const c = (ct || '').toLowerCase();
  if (c.includes('image/png')) return '.png';
  if (c.includes('image/jpeg')) return '.jpg';
  if (c.includes('image/webp')) return '.webp';
  if (c.includes('image/gif')) return '.gif';
  if (c.includes('image/svg')) return '.svg';
  if (c.includes('font/ttf') || c.includes('application/x-font-ttf')) return '.ttf';
  if (c.includes('font/woff2') || c.includes('application/font-woff2')) return '.woff2';
  if (c.includes('font/woff')) return '.woff';
  if (c.includes('text/css')) return '.css';
  if (c.includes('javascript')) return '.js';
  if (c.includes('application/json')) return '.json';
  return fallback || '';
}
const EXT_RE = /\.(?:js|mjs|cjs|css|map|json|ico|png|jpe?g|webp|gif|svg|woff2?|ttf|otf|mp4|webm|wav|mp3)$/i;

// Build an index of captured HTML directories (paths that contain an index.html under desktop/mobile or flat)
function buildHtmlIndex(root){
  const set = new Set();
  function addFrom(absFile){
    try{
      if(!absFile) return;
      let rel = path.relative(root, path.dirname(absFile));
      if (!rel) return;
      // strip variant folder if present
      const parts = rel.split(path.sep);
      const last = parts[parts.length-1];
      if(last==='desktop' || last==='mobile'){ parts.pop(); }
      // rebuild web path
      const clean = parts.join('/');
      const web = '/' + (clean ? clean + '/' : '');
      set.add(web);
    }catch{}
  }
  function walk(dir){
    let list;
    try{ list = fs.readdirSync(dir,{ withFileTypes:true }); }catch{ return; }
    let hasIndex = false;
    for(const e of list){ if(e.isFile() && e.name==='index.html') { hasIndex = true; break; } }
    if(hasIndex){ addFrom(path.join(dir,'index.html')); }
    for(const e of list){ if(e.isDirectory()){ walk(path.join(dir, e.name)); } }
  }
  walk(root);
  return set;
}

function loadGraphPaths(root){
  if(!ENABLE_GRAPH_ROUTING) return new Set();
  const set = new Set();
  try{
    const gp = path.join(root, '_crawl', 'graph.json');
    const txt = fs.readFileSync(gp,'utf8');
    const j = JSON.parse(txt);
    if(j && j.nodes && typeof j.nodes === 'object'){
      for(const u of Object.keys(j.nodes)){
        try{
          const p = new URL(u).pathname || '/';
          const norm = p.endsWith('/')? p : (p + '/');
          set.add(norm);
        }catch{}
      }
    }
  }catch{}
  return set;
}
const HTML_INDEX = buildHtmlIndex(ROOT);
const GRAPH_PATHS = loadGraphPaths(ROOT);
if (ENABLE_GRAPH_ROUTING) {
  console.log('[SERVER] Graph routing:', GRAPH_PATHS.size ? ('paths=' + GRAPH_PATHS.size) : 'no graph.json');
}

// ---- Bake static integration (SSE logs) ----
let bakeProc = null;
let bakeClients = new Set();
let bakeLogBuf = [];
const BAKE_LOG_MAX = 500;
let bakeState = { running:false, startedAt:0, finishedAt:0, scanned:null, updated:null, lastCode:null };

function bakeLog(line){
  line = String(line||'').replace(/\r/g,'');
  const parts = line.split('\n');
  for (let L of parts){ if(!L) continue; bakeLogBuf.push(L); if (bakeLogBuf.length>BAKE_LOG_MAX) bakeLogBuf.shift();
    const data = 'data: ' + L.replace(/\n/g,' ') + '\n\n';
    for(const res of bakeClients){ try{ res.write(data);}catch(e){} }
  }
}
function startBake(reason){
  if (bakeProc) return false;
  if (!fs.existsSync(BAKE_SCRIPT)) { bakeLog('[BAKE] script not found: '+BAKE_SCRIPT); return false; }
  bakeState = { running:true, startedAt:Date.now(), finishedAt:0, scanned:null, updated:null, lastCode:null };
  bakeLog(`[BAKE] start reason=${reason||'manual'} root=${ROOT}`);
  try{
    bakeProc = cp.spawn(process.execPath, [BAKE_SCRIPT, ROOT], { stdio:['ignore','pipe','pipe'] });
    bakeProc.stdout.on('data', d=> bakeLog(d.toString()));
    bakeProc.stderr.on('data', d=> bakeLog('[err] '+d.toString()));
    bakeProc.on('close', code=>{
      bakeState.running=false; bakeState.finishedAt=Date.now(); bakeState.lastCode=code;
      // try to parse summary
      try{ const m = (bakeLogBuf.slice(-5).join('\n').match(/\[BAKE\]\s*scanned:\s*(\d+)\s*updated:\s*(\d+)/i)); if(m){ bakeState.scanned=Number(m[1]); bakeState.updated=Number(m[2]); } }catch{}
      bakeLog('[BAKE] exit code=' + code);
      bakeProc=null;
    });
    return true;
  }catch(e){ bakeLog('[BAKE_ERR] spawn: '+(e&&e.message||e)); bakeProc=null; bakeState.running=false; return false; }
}

app.get('/__bake/logs', (req,res)=>{
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.flushHeaders && res.flushHeaders();
  // send backlog
  for(const L of bakeLogBuf){ res.write('data: '+L.replace(/\n/g,' ')+'\n\n'); }
  bakeClients.add(res);
  req.on('close', ()=>{ try{ bakeClients.delete(res); }catch(e){} });
});
app.get('/__bake/status', (req,res)=>{
  res.json({ running:bakeState.running, startedAt:bakeState.startedAt, finishedAt:bakeState.finishedAt, scanned:bakeState.scanned, updated:bakeState.updated, lastCode:bakeState.lastCode });
});
app.post('/__bake/start', (req,res)=>{
  if (bakeState.running) return res.status(409).json({ running:true });
  const ok = startBake('api');
  return res.json({ started: !!ok });
});

// Resolve HTML variant (supports query-string routers like index.php?route=...)
function resolveHtml(reqOrPath) {
  const hasReq = typeof reqOrPath === 'object' && reqOrPath !== null;
  const reqPath = hasReq ? (reqOrPath.path || reqOrPath.url || '/') : reqOrPath;
  const rawQuery = hasReq ? String((reqOrPath.originalUrl||'').split('?')[1]||'') : '';

  let p = decodeURIComponent(reqPath || '/').split('?')[0];
  p = p.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  if (!p.endsWith('/') && !/\.[a-zA-Z0-9]+$/.test(p)) p += '/';

  if (p === '/' || p === '') {
    // Legacy order: per-profile folders under /index, then a flat root index.html as last fallback
    return tryFiles([
      path.join(ROOT, 'index', DEFAULT_VARIANT, 'index.html'),
      path.join(ROOT, 'index', 'desktop', 'index.html'),
      path.join(ROOT, 'index', 'mobile', 'index.html'),
      path.join(ROOT, 'index.html')
    ]);
  }

  const relDir = p.replace(/^\/+/, '').replace(/\/+$/, '');
  const base = path.join(ROOT, relDir);
  const ordered = (DEFAULT_VARIANT === 'mobile')
    ? [path.join(base, 'mobile', 'index.html'), path.join(base, 'desktop', 'index.html'), path.join(base, 'index.html')]
    : [path.join(base, 'desktop', 'index.html'), path.join(base, 'mobile', 'index.html'), path.join(base, 'index.html')];

  // First try the plain directory mapping
  const plain = tryFiles(ordered);
  if (plain) return plain;

  // If this is a script-like path with a query (OpenCart, Woo, etc.), try query-derived variants
  if (rawQuery && /\.(php|asp|aspx|jsp|cgi)$/i.test(relDir)) {
    function sanitizeSeg(s){
      // prevent path traversal and normalize to safe segments
      return s.replace(/\.+/g,'').replace(/[^A-Za-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'');
    }
    function slugifyQueryLikeArchiver(qs){
      try{
        const sp = new URLSearchParams(qs);
        const entries=[]; for(const [k,v] of sp.entries()) entries.push([k,v]);
        entries.sort((a,b)=> a[0]===b[0] ? String(a[1]).localeCompare(String(b[1])) : a[0].localeCompare(b[0]));
        const parts = entries.map(([k,v])=>{
          const kk=String(k).toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
          const vv=String(v).toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
          return kk + (vv?('_'+vv):'');
        }).filter(Boolean);
        if(!parts.length) return '';
        const slug = parts.join('__');
        return slug.length>120 ? (slug.slice(0,100)+'__'+sha16(slug)) : slug;
      }catch{ return ''; }
    }
    // Variant A: key/value pairs as nested segments: route/product/category/path/85
    const kvPairs = [];
    try{
      for (const part of rawQuery.split('&')){
        if(!part) continue;
        const [k,v=''] = part.split('=');
        const ks = sanitizeSeg(decodeURIComponent(k||''));
        let vs = decodeURIComponent(v||'');
        // values may contain slashes (e.g., product/category) -> keep as nested dirs with sanitized tokens
        const vParts = vs.split('/').map(sanitizeSeg).filter(Boolean);
        if(ks) kvPairs.push(ks, ...vParts);
      }
    }catch{}
    const varA = kvPairs.filter(Boolean).join(path.sep);

  // Variant B: archiver-style slug appended to the base name
  const varBslug = slugifyQueryLikeArchiver(rawQuery);

    const variants = [];
    if (varA) variants.push(varA);
  if (varBslug && varBslug !== varA) variants.push(varBslug);

    for (const v of variants){
  // If v is the archiver slug (no path separators), try base+'__'+slug; otherwise treat as nested folders
  const qb = /\//.test(v) ? path.join(base, v) : path.join(path.dirname(base), path.basename(base) + '__' + v);
      const qOrdered = (DEFAULT_VARIANT === 'mobile')
        ? [path.join(qb, 'mobile', 'index.html'), path.join(qb, 'desktop', 'index.html'), path.join(qb, 'index.html')]
        : [path.join(qb, 'desktop', 'index.html'), path.join(qb, 'mobile', 'index.html'), path.join(qb, 'index.html')];
      const hit = tryFiles(qOrdered);
      if (hit) return hit;
    }
  }

  // Fallback: if graph.json is present, try the longest graph node prefix that maps to a captured page
  if (ENABLE_GRAPH_ROUTING && GRAPH_PATHS.size) {
    try {
      const reqPath = '/' + relDir.replace(/\\/g,'/');
      // candidates: graph paths that are a prefix of the request path (path-segment aligned)
      const cands = [];
      for (const gp of GRAPH_PATHS) {
        if (reqPath === gp || reqPath.startsWith(gp)) cands.push(gp);
      }
      cands.sort((a,b)=> b.length - a.length);
      for (const gp of cands) {
        const rel = gp.replace(/^\/+|\/+$/g,'');
        const base2 = path.join(ROOT, rel);
        const ord2 = (DEFAULT_VARIANT === 'mobile')
          ? [path.join(base2, 'mobile', 'index.html'), path.join(base2, 'desktop', 'index.html'), path.join(base2, 'index.html')]
          : [path.join(base2, 'desktop', 'index.html'), path.join(base2, 'mobile', 'index.html'), path.join(base2, 'index.html')];
        const hit = tryFiles(ord2);
        if (hit) return hit;
      }
    } catch {}
  }

  // Last-resort: walk up path segments and try parents that exist in HTML index
  try{
    let parts = relDir.split('/').filter(Boolean);
    while(parts.length){
      const web = '/' + parts.join('/') + '/';
      if (HTML_INDEX.has(web)){
        const base3 = path.join(ROOT, parts.join('/'));
        const ord3 = (DEFAULT_VARIANT === 'mobile')
          ? [path.join(base3, 'mobile', 'index.html'), path.join(base3, 'desktop', 'index.html'), path.join(base3, 'index.html')]
          : [path.join(base3, 'desktop', 'index.html'), path.join(base3, 'mobile', 'index.html'), path.join(base3, 'index.html')];
        const parentHit = tryFiles(ord3);
        if (parentHit) return parentHit;
      }
      parts.pop();
    }
  }catch{}

  return null;
}

// Build basename alias index
function buildAssetIndex(root) {
  const map = new Map();
  function walk(dir) {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && EXT_RE.test(e.name)) {
        const base = e.name.toLowerCase();
        if (!map.has(base)) map.set(base, full); // keep first match
      }
    }
  }
  walk(root);
  console.log('[SERVER] Asset alias index entries:', map.size);
  return map;
}
const ASSET_INDEX = buildAssetIndex(ROOT);

// Load origins from manifest.json to compute SHA aliases and for live fetch
function loadOrigins(root) {
  const origins = new Set();
  try {
    const manPath = path.join(root, 'manifest.json');
    const txt = fs.readFileSync(manPath, 'utf8');
    const arr = JSON.parse(txt);
    for (const rec of Array.isArray(arr) ? arr : []) {
      const u = rec && rec.url;
      if (!u) continue;
      try {
        const o = new URL(u).origin;
        origins.add(o);
        // Add scheme variants
        if (o.startsWith('https://')) origins.add('http://' + o.slice('https://'.length));
        if (o.startsWith('http://')) origins.add('https://' + o.slice('http://'.length));
      } catch {}
    }
  } catch (e) {
    console.warn('[SERVER] Could not read manifest origins:', e.message);
  }
  const list = [...origins];
  console.log('[SERVER] Origins for alias/fetch:', list.join(', ') || '(none)');
  return list;
}
const ORIGINS = loadOrigins(ROOT);

// Optional payment mapping: ROOT/_payment-map.json
// Example: { provider: "paypal", target: "_blank", map: { "318": "paypal:HOSTED_ID", "413": "https://buy.stripe.com/xyz" } }
function loadPaymentMap(root){
  try{
    const p = path.join(root, '_payment-map.json');
    const txt = fs.readFileSync(p, 'utf8');
    const obj = JSON.parse(txt);
    if (obj && typeof obj === 'object' && obj.map) return obj;
  }catch{}
  return null;
}
const PAYMENT_MAP = loadPaymentMap(ROOT);

function primaryOrigin() {
  // Prefer https if present
  const httpsFirst = ORIGINS.find(o => o.startsWith('https://'));
  return httpsFirst || ORIGINS[0] || '';
}

function isAjax(req) {
  const xr = String(req.get('x-requested-with') || '').toLowerCase();
  const acc = String(req.get('accept') || '').toLowerCase();
  return xr === 'xmlhttprequest' || acc.includes('application/json') || /\.json$|\.js$/i.test(req.path || '');
}

function normalizeNestedIndexPhp(originalUrlPath) {
  // Collapse /index.php__slug.../index.php -> /index.php
  try {
    const p = originalUrlPath || '';
    const low = p.toLowerCase();
    if (low.includes('/index.php__')) {
      const j = low.lastIndexOf('/index.php');
      if (j >= 0) return p.slice(j);
    }
  } catch {}
  return originalUrlPath;
}

function buildOriginUrl(req) {
  const origin = primaryOrigin();
  if (!origin) return '';
  const u = req.originalUrl || req.url || '/';
  const parsed = new URL(origin);
  const pathOnly = u.split('?')[0];
  const qsOnly = u.includes('?') ? u.slice(u.indexOf('?')) : '';
  let pathFixed = normalizeNestedIndexPhp(pathOnly);
  parsed.pathname = pathFixed;
  const full = parsed.toString().replace(/\/?$/, '');
  return full + qsOnly;
}

function isCommerceRoute(req) {
  const url = String(req.originalUrl || req.url || '');
  const q = String(url.split('?')[1] || '');
  const sp = new URLSearchParams(q);
  const route = (sp.get('route') || '').toLowerCase();
  const path = (url.split('?')[0] || '').toLowerCase();
  // OpenCart common
  if (/^checkout\//.test(route)) return true;
  if (/^extension\/(?:module\/)?..*payment/.test(route)) return true;
  if (route === 'product/product/review' || route === 'product/product/write') return true;
  // WooCommerce
  if (sp.has('add-to-cart')) return true;
  if (/\/cart(\/.+)?$/.test(path) || /\/checkout(\/.+)?$/.test(path)) return true;
  // Shopify
  if (/\/cart\/(add(\.js)?|update(\.js)?)/.test(path)) return true;
  if (/\/checkout(\/.+)?$/.test(path)) return true;
  return false;
}

// Passthrough middleware (before any stubs)
if (LIVE_PASSTHROUGH) {
  app.all(/.*/, express.urlencoded({ extended: true }), express.json({ strict: false }), (req, res, next) => {
    if (!isCommerceRoute(req)) return next();
    const dest = buildOriginUrl(req);
    if (!dest) return next();
    if (req.method === 'GET') {
      // Header-only redirect to avoid Express' default HTML body
      res.status(302).set('Location', dest);
      return res.end();
    }
    // For POST/PUT etc., if it's an AJAX call, return a JSON with redirect hint; else 307
    if (isAjax(req)) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('X-Archive-Redirect', 'commerce');
      return res.status(200).send(JSON.stringify({ redirect: dest }));
    }
    res.status(307).set('Location', dest);
    return res.end();
  });
}

// SHA alias helper
function shaCandidateFor(origin, reqPath, extFromReq) {
  // Build full URL as the archiver saw it (origin + path)
  const fullUrl = origin.replace(/\/+$/, '') + reqPath;
  const sh = sha16(fullUrl);
  const ext = extFromReq || path.extname(reqPath) || '';
  return path.join(ROOT, 'assets', sh + ext);
}

// Live fetch and cache on disk (assets/<sha>.ext), returns absolute file path or null
function fetchAndCache(fullUrl, targetAbsPath) {
  return new Promise((resolve) => {
    try {
      const proto = fullUrl.startsWith('https:') ? https : http;
      proto.get(fullUrl, { timeout: 20000, headers: { 'User-Agent': 'ArchiveHost/1.0' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow simple redirects
          const loc = res.headers.location.startsWith('http') ? res.headers.location
            : new URL(res.headers.location, fullUrl).toString();
          res.resume(); // drain
          return resolve(fetchAndCache(loc, targetAbsPath));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        ensureDir(path.dirname(targetAbsPath));
        const tmp = targetAbsPath + '.part';
        const out = fs.createWriteStream(tmp);
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            try { fs.renameSync(tmp, targetAbsPath); } catch {}
            resolve(targetAbsPath);
          });
        });
        out.on('error', () => { try { fs.unlinkSync(tmp); } catch {} resolve(null); });
      }).on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

// Static (assets only). Let catch-all serve HTML so we can inject and strip meta refresh redirects.
const __static = express.static(ROOT, {
  fallthrough: true,
  redirect: false,
  setHeaders(res, file) {
    if (/\.(?:css|js|mjs|cjs|json|ico|png|jpe?g|webp|gif|svg|woff2?|ttf|otf|mp4|webm)$/i.test(file)) {
      res.setHeader('Cache-Control', 'public,max-age=31536000,immutable');
    } else if (/\.(html?)$/i.test(file)) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public,max-age=86400');
    }
  }
});
app.use((req, res, next) => {
  const p = req.path || '';
  const hasExt = /\.[a-z0-9]+$/i.test(p);
  const isHtml = /\.html?$/i.test(p) || !hasExt;
  if (isHtml) return next();
  return __static(req, res, next);
});

// Universal asset resolver: preserved -> basename alias -> SHA alias -> live fetch+cache
app.get(/\.[a-z0-9]+$/i, async (req, res, next) => {
  if (!EXT_RE.test(req.path)) return next();

  // Some assets are requested from inside a query-slug folder, e.g.:
  //   /index.php__product_id_318__route_product_product/image/catalog/teacup.png
  // Normalize to the original origin path (e.g., /image/catalog/teacup.png)
  function normalizeNestedAssetPath(p) {
    try {
      const parts = String(p || '').split('/').filter(Boolean);
      const idx = parts.findIndex(seg => /__route_/i.test(seg));
      if (idx >= 0 && idx < parts.length - 1) {
        return '/' + parts.slice(idx + 1).join('/');
      }
    } catch {}
    return p;
  }

  const reqPath = normalizeNestedAssetPath(req.path);

  // 1) preserved path
  const preserved = path.join(ROOT, reqPath.replace(/^\//, ''));
  if (fileExists(preserved)) return res.sendFile(preserved);

  // 2) basename alias
  const base = path.basename(reqPath).toLowerCase();
  const byBase = ASSET_INDEX.get(base);
  if (byBase && fileExists(byBase)) {
    return res.sendFile(byBase);
  }

  // 3) SHA alias for any known origin
  const extReq = path.extname(reqPath) || '';
  for (const origin of ORIGINS) {
    const cand = shaCandidateFor(origin, reqPath, extReq);
    if (fileExists(cand)) {
      return res.sendFile(cand);
    }
  }

  // 4) Live fetch and cache
  if (!DISABLE_FETCH_CACHE && ORIGINS.length) {
    for (const origin of ORIGINS) {
      const fullUrl = origin.replace(/\/+$/, '') + reqPath;
      // Decide save path: prefer requested ext; if none, try to infer after fetch (simple)
      let cand = shaCandidateFor(origin, req.path, extReq);
      if (!extReq) {
        // No extension in path (rare for these). We will still save with no ext or infer by content-type
        // but most Shopware assets do have ext, so this is fine.
      }
      const saved = await fetchAndCache(fullUrl, cand);
      if (saved && fileExists(saved)) {
        console.log('[FETCH_CACHE]', reqPath, '->', path.relative(ROOT, saved));
        return res.sendFile(saved);
      }
    }
  }

  return next();
});

// Optional stub endpoints some sites expect
app.get(/^\/save_captcha_token.*$/i, (req, res) => res.status(204).end());

// OpenCart-friendly AJAX stubs to avoid 404 alerts in archived views
// These endpoints usually return JSON or small HTML snippets. We reply with
// harmless placeholders to keep the UI calm when a user clicks "Buy" etc.
function queryParam(originalUrl, key) {
  try {
    const qs = String(originalUrl.split('?')[1] || '');
    const sp = new URLSearchParams(qs);
    return sp.get(key) || '';
  } catch { return ''; }
}

// Match both /index.php?... and nested .../index.php?... within query-slug dirs
app.all(/index\.php$/i, express.urlencoded({ extended: true }), express.json({ strict: false }), (req, res, next) => {
  if (LIVE_PASSTHROUGH) return next(); // passthrough handler earlier will catch if needed
  const route = (queryParam(req.originalUrl, 'route') || '').toLowerCase();
  if (!route) return next();

  // Common cart endpoints (OpenCart 2/3 and some theme variants)
  const cartRoutes = new Set([
    'checkout/cart/add',
    'checkout/cart/remove',
    'checkout/cart/clear',
    'common/cart/info',
    'extension/module/cart/add',
    'extension/cart/add',
    'extension/quickcheckout/cart/add',
    'extension/occart/cart/add',
  ]);

  if (cartRoutes.has(route)) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Archive-Stub', 'opencart-cart');
    // Basic, non-persistent response: pretend action succeeded but do not track state
    const productId = req.body?.product_id || queryParam(req.originalUrl, 'product_id') || '';
    const qty = Number(req.body?.quantity || queryParam(req.originalUrl, 'quantity') || 1) || 1;
    const successMsg = `Archive: item${productId ? ' #' + productId : ''} x${qty} (cart disabled in archive)`;
    return res.status(200).send(JSON.stringify({ success: successMsg, total: '0 item(s) - 0.00' }));
  }

  if (route === 'product/product/review') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Archive-Stub', 'opencart-review');
    return res.status(200).send('<div class="alert alert-info">Reviews are disabled in the archived preview.</div>');
  }

  if (route === 'product/product/write') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Archive-Stub', 'opencart-review-write');
    return res.status(200).send(JSON.stringify({ success: 'Review submission disabled in archive.' }));
  }

  if (route === 'account/wishlist/add' || route === 'product/compare/add') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Archive-Stub', 'opencart-misc');
    return res.status(200).send(JSON.stringify({ success: 'Action disabled in archive.' }));
  }

  return next();
});

// Optional root redirect
if (START_PATH && START_PATH !== '/') {
  app.get('/', (req, res, next) => {
    if (req.originalUrl === '/' || req.originalUrl === '') {
      res.status(302).set('Location', START_PATH).set('Content-Length','0');
      return res.end();
    }
    next();
  });
}

// Catch-all HTML with small injection to remove CMP/blur at view-time
app.get(/.*/, (req, res, next) => {
  if (req.method !== 'GET') return next();
  const accept = req.headers.accept || '';
  const isHtmlPreferred = accept.includes('text/html') || !/\.[a-zA-Z0-9]+$/.test(req.path);
  if (!isHtmlPreferred) return next();

  let resolved = resolveHtml(req);
  // If root is requested and a START_PATH is configured, internally resolve
  if ((!req.path || req.path === '/') && START_PATH && START_PATH !== '/') {
    const alt = resolveHtml(START_PATH);
    if (alt) resolved = alt;
  }
  if (!resolved) return next();

  if (DISABLE_HTML_INJECT) {
    return res.sendFile(resolved);
  }

  try {
    let html = fs.readFileSync(resolved, 'utf8');
    // Detect captured HTML redirect shims and convert them to header-only redirects
    try {
      const meta = html.match(/<meta[^>]+http-equiv\s*=\s*['"]?refresh['"]?[^>]+content\s*=\s*['"][^"']*url\s*=\s*([^"'>\s;]+)[^"']*['"][^>]*>/i);
      let target = meta && meta[1] ? meta[1].trim() : '';
      if (!target) {
        const a = html.match(/Redirecting\s+to\s+<a\s+href=["']([^"']+)["']/i);
        target = a && a[1] ? a[1].trim() : '';
      }
      if (target) {
        try {
          const base = `http://dummy${req.originalUrl || '/'}`;
          const u = new URL(target, base);
          const loc = u.pathname + (u.search || '') + (u.hash || '');
          // Avoid redirect loops
          const reqP = req.path || '/';
          const same = (p)=> {
            const addSlash = (s)=> /\.[a-z0-9]+$/i.test(s) ? s : (s.endsWith('/') ? s : s + '/');
            return addSlash(p.replace(/\\/g,'/')) === addSlash(reqP.replace(/\\/g,'/'));
          };
          if (!same(loc)) {
            // Prefer internal serve of target to avoid any redirect flash
            const altResolved = resolveHtml(loc);
            if (altResolved) {
              resolved = altResolved;
              html = fs.readFileSync(altResolved, 'utf8');
            } else {
              res.status(302).set('Location', loc).set('Content-Length','0');
              return res.end();
            }
          }
        } catch(_) {}
      }
    } catch(_) {}
    // Regardless, strip meta-refresh and common redirect stub snippet so nothing flashes
    try {
      html = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*>/ig, '');
      html = html.replace(/<p[^>]*>\s*Redirecting\s+to\s+<a[^>]*>.*?<\/a>\s*<\/p>/ig, '');
    } catch(_) {}
    // Build a small client-side guard to avoid SPA routers flipping to client 404s
    const CAPTURED = Array.from(HTML_INDEX);
    const injectTag = `<script>(function(){try{
      function rm(q,root){(root||document).querySelectorAll(q).forEach(function(n){try{n.remove()}catch(e){}})}
      function unlock(){
        try{document.documentElement.style.setProperty('overflow','', 'important');document.body&&document.body.style.setProperty('overflow','', 'important');}catch(e){}
        try{
          document.querySelectorAll('*').forEach(function(el){
            var st=getComputedStyle(el); 
            if((st.position==='fixed'||st.position==='sticky') && parseInt(st.zIndex||'0',10)>=1000){
              var txt=(el.innerText||'').toLowerCase();
              if(/cookie|consent|datenschutz/.test(txt)){ try{el.remove()}catch(e){} }
            }
            if(st.filter && st.filter.includes('blur')){ try{ el.style.setProperty('filter','none','important'); }catch(e){} }
            if(st.backdropFilter){ try{ el.style.setProperty('backdrop-filter','none','important'); }catch(e){} }
          });
        }catch(e){}
      }
      // Optionally freeze SPA to preserve SSR content (stop client JS from wiping lists)
      try{
        var FREEZE = ${DISABLE_SPA_SCRIPTS ? 'true' : 'false'};
        if(FREEZE){
          // 1) Disable dynamic script injection via document.createElement('script')
          try{
            var _ce = Document.prototype.createElement;
            Document.prototype.createElement = function(tag){ var el = _ce.apply(this, arguments); try{ if(String(tag).toLowerCase()==='script'){ Object.defineProperty(el,'src',{set:function(){},get:function(){return ''}}); el.type='application/ld+json'; } }catch(e){} return el; };
          }catch(e){}
          // 2) Neutralize existing <script src> that match app bundles by rewriting type
          try{
            var blockers = [/\/assets\/_next\//, /\/assets\/[A-Za-z0-9].*\.js$/, /ton-[a-z0-9]+\.js$/i, /vendors~[A-Za-z0-9_-]+\.js$/i, /PLPContainerTON.*\.js$/i, /PDPContainerTON.*\.js$/i, /DAZContainerTON.*\.js$/i, /SearchOverlay.*\.js$/i];
            document.querySelectorAll('script[src]')?.forEach(function(s){ try{ var src=s.getAttribute('src')||''; if(blockers.some(function(rx){ return rx.test(src); })){ s.setAttribute('type','application/ld+json'); s.removeAttribute('src'); } }catch(e){} });
          }catch(e){}
          // 3) Prevent eval/new Function which many loaders use
          try{ window.eval = function(){ return ''; }; }catch(e){}
          try{ window.Function = function(){ return function(){}; }; }catch(e){}
        }
      }catch(e){}
      
      // Graph/captured-path aware navigation: force full navigations to captured pages
      try{
        var CAP = ${JSON.stringify(CAPTURED)};
        var CAPSET = new Set(Array.isArray(CAP)?CAP:[]);
        function norm(p){ try{ p = String(p||'/'); }catch(e){ p='/'; } if(!p.startsWith('/')){ try{ p = new URL(p, location.href).pathname; }catch(_){ p = '/'; } } if(!p.endsWith('/')) p+='/'; return p; }
        function best(p){ p = norm(p); if(CAPSET.has(p)) return p; var seg = p.replace(/\/+$/,'').split('/'); while(seg.length>1){ seg.pop(); var cand = seg.join('/') + '/'; if(CAPSET.has(cand)) return cand; } return '/'; }
        function go(u){ try{ var url = new URL(u, location.href); var p = best(url.pathname); var out = p + (url.search||'') + (url.hash||''); location.href = out; }catch(e){ location.href = '/'; } }
        // Intercept same-origin anchor clicks early to avoid SPA hijack
        document.addEventListener('click', function(ev){ try{ var a = ev.target && ev.target.closest && ev.target.closest('a[href]'); if(!a) return; var href = a.getAttribute('href'); if(!href) return; var u = new URL(href, location.href); if(u.origin !== location.origin) return; ev.preventDefault(); ev.stopPropagation(); go(u.href); }catch(e){} }, true);
        // Downgrade history API to full navigations (prevents client routers from flipping to 404)
        try{ var _ps = history.pushState; history.pushState = function(s,t,u){ try{ if(u!=null){ go(u); return; } }catch(e){} try{ return _ps.apply(this, arguments); }catch(e){} } }catch(e){}
        try{ var _rs = history.replaceState; history.replaceState = function(s,t,u){ try{ if(u!=null){ go(u); return; } }catch(e){} try{ return _rs.apply(this, arguments); }catch(e){} } }catch(e){}
      }catch(e){}
      // Remove common CMP containers and Trusted Shops badge
      rm('#onetrust-banner-sdk'); rm('#usercentrics-root'); rm('#CybotCookiebotDialog');
      rm('div[id^="sp_message_container_],.sp-message-container,.cm-wrapper,.cm__container,.cc-window,.cookie-consent,.cookieconsent,.cookiebar,div[id*="cookie"],div[class*="cookie"],div[id*="consent"],div[class*="consent"]');
      rm('.ts-trustbadge'); rm('iframe[src*="trustedshops"]');
      unlock();
      // Retry after load in case JS re-adds overlays
      window.addEventListener('load', function(){ setTimeout(function(){ rm('#onetrust-banner-sdk'); rm('#usercentrics-root'); rm('.ts-trustbadge'); unlock(); }, 500); });
      // Also watch for late inserts for a short time
      var t0=Date.now(); var obs=new MutationObserver(function(){ if(Date.now()-t0>7000){ try{obs.disconnect()}catch(e){} return; } unlock(); });
      try{obs.observe(document.documentElement,{childList:true,subtree:true})}catch(e){}
    }catch(e){}})();</script>`;
    // Optional: inject payment-link rewriter if a mapping is present
    let payInject = '';
    if (PAYMENT_MAP && PAYMENT_MAP.map) {
      const pmStr = JSON.stringify(PAYMENT_MAP).replace(/</g,'\\u003c');
      payInject = `<script>(function(){try{
        var PM = window.__PAYMENT_MAP = ${pmStr};
        function ppUrl(v){
          if(typeof v!=='string') return '';
          // paypal:HOSTED_BUTTON_ID -> hosted button URL
          if(v.indexOf('paypal:')===0){ var id=v.slice(7); return 'https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id='+encodeURIComponent(id);} 
          return v; 
        }
        function domProdId(root){
          root = root||document;
          try{
            // OpenCart common hidden input
            var el = root.querySelector('input[name="product_id"], #product_id');
            if(el && el.value) return String(el.value);
            // WooCommerce add-to-cart hidden input on single product
            var woo = root.querySelector('form.cart input[name="add-to-cart"]');
            if(woo && woo.value) return String(woo.value);
            // data-product-id on buttons/containers
            var dataEl = root.querySelector('[data-product-id]');
            if(dataEl && dataEl.getAttribute('data-product-id')) return String(dataEl.getAttribute('data-product-id'));
            // Microdata
            var meta = root.querySelector('meta[itemprop="productID"],[itemprop="productID"]');
            if(meta){ var v = meta.content || meta.getAttribute('content') || meta.textContent; if(v) return String(v).trim(); }
          }catch(e){}
          return '';
        }
        function curProdId(){
          try{ 
            var sp=new URLSearchParams(location.search.slice(1));
            var pid=sp.get('product_id'); if(pid) return String(pid);
            var atc=sp.get('add-to-cart'); if(atc) return String(atc);
          }catch(e){}
          // fallback to DOM probing
          return domProdId(document);
        }
        function linkForId(id){ if(!id) return ''; var v=(PM.map && (PM.map[String(id)]||PM.map['product_id_'+id]))||''; return ppUrl(v); }
        function openPay(link){ if(!link) return false; try{ if(PM.target){ window.open(link, PM.target); } else { location.href = link; } return true; }catch(e){ try{ location.href = link; return true; }catch(_){} } return false; }
        function rewrite(root){ 
          root=root||document; 
          var pid=curProdId(); 
          var link=linkForId(pid);
          // If we have a link, hijack common buttons/forms early
          var btnSel = '#button-cart, button[name="button-add-to-cart"], button[name="add-to-cart"], .single_add_to_cart_button, .add_to_cart_button';
          var btn = root.querySelector(btnSel);
          if(btn && link){ btn.addEventListener('click', function(ev){ try{ev.preventDefault();ev.stopPropagation();}catch(e){} openPay(link); }, {capture:true}); }
          // WooCommerce form submit
          root.querySelectorAll('form.cart').forEach(function(f){ try{ if(!link){ var hid=f.querySelector('input[name="add-to-cart"]'); if(hid&&hid.value){ link = linkForId(hid.value); } } if(link){ f.addEventListener('submit', function(ev){ try{ev.preventDefault();ev.stopPropagation();}catch(e){} openPay(link); }, {capture:true}); } }catch(e){} });
          // Anchor-based add-to-cart/cart links
          root.querySelectorAll('a[href*="route=checkout/cart/add"], a[href*="add-to-cart="], a[href*="/cart/add"], a[href*="/cart?add="]').forEach(function(a){ 
            try{ 
              var u=new URL(a.getAttribute('href'), location.href); 
              var id=u.searchParams.get('product_id')||u.searchParams.get('add-to-cart')||u.searchParams.get('add'); 
              var L=linkForId(id||pid); 
              if(L){ a.setAttribute('href', L); a.setAttribute('target', PM.target||'_self'); a.addEventListener('click', function(ev){ try{ev.preventDefault();ev.stopPropagation();}catch(e){} openPay(L); }, {capture:true}); }
            }catch(e){} 
          });
        }
        document.addEventListener('DOMContentLoaded', function(){ rewrite(); });
        try{ var mo=new MutationObserver(function(){ rewrite(document); }); mo.observe(document.documentElement,{childList:true,subtree:true}); }catch(e){}
      }catch(e){}})();</script>`;
    }
    const fullInject = injectTag + (payInject||'');
    // If scripts are disabled, also inject CSS to unhide SSR and hide skeletons/overlays
    let cssPatch = '';
    if (DISABLE_SPA_SCRIPTS) {
      cssPatch = '<style id="__archive_css_patch">\n'
        + 'html,body{opacity:1!important;visibility:visible!important;filter:none!important;}\n'
        + '/* Hide skeletons/placeholders */\n'
        + '[class*="skeleton"],[class*="placeholder"],[class*="shimmer"],.skeleton,.placeholder,.shimmer{display:none!important;}\n'
        + '/* Unhide common content containers */\n'
        + '.plp,.plp-grid,.ProductList,.Products,[data-component="ProductList"],[id*="product"],[class*="product-list"],[class*="plp-grid"],[class*="results"],.ais-InfiniteHits,.ais-Hits{opacity:1!important;visibility:visible!important;filter:none!important;}\n'
        + '/* Remove common overlay containers */\n'
        + '[id*="overlay"],[class*="overlay"],.ts-trustbadge,#onetrust-banner-sdk,#usercentrics-root{display:none!important;}\n'
        + '</style>\n';
    }
    // Prefer to inject at the very start of <head> so it runs before site scripts/styles
    if (/\<head[^>]*\>/i.test(html)) html = html.replace(/\<head[^>]*\>/i, function(m){ return m + '\n' + cssPatch + fullInject + '\n'; });
    else if (html.includes('</head>')) html = html.replace('</head>', cssPatch + fullInject + '\n</head>');
    else if (html.includes('<body')) html = html.replace('<body', '<body>' + cssPatch + fullInject);
    else html += fullInject;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    if (DISABLE_SPA_SCRIPTS) {
      // Final safety net: block all scripts via CSP so nothing can execute
      res.setHeader('Content-Security-Policy', "script-src 'none'; object-src 'none'; base-uri 'self';");
    }
    return res.send(html);
  } catch (e) {
    console.error('[SERVER_ERR] inject/send error', e);
    return res.sendFile(resolved);
  }
});

// 404
app.use((req, res) => {
  console.warn('[404]', req.originalUrl);
  res.status(404).send('Not Found');
});

// Start
app.listen(PORT, '0.0.0.0', () => {
  console.log('[SERVER] Serving root:', ROOT);
  console.log('[SERVER] Listening on http://0.0.0.0:' + PORT);
  console.log('[SERVER] Default variant:', DEFAULT_VARIANT);
  if (START_PATH) console.log('[SERVER] Start path redirect:', START_PATH);
});