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

const ROOT = path.resolve(process.env.ARCHIVE_ROOT || '');
const PORT = parseInt(process.env.PORT || '8081', 10);
const DEFAULT_VARIANT = (process.env.DEFAULT_VARIANT || 'desktop').toLowerCase();
const START_PATH = process.env.START_PATH || '';
const DISABLE_HTML_INJECT = String(process.env.DISABLE_HTML_INJECT || '').toLowerCase() === 'true';
const DISABLE_FETCH_CACHE = String(process.env.DISABLE_FETCH_CACHE || '').toLowerCase() === 'true';

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

// Static (direct matches)
app.use(express.static(ROOT, {
  extensions: ['html'],
  fallthrough: true,
  setHeaders(res, file) {
    if (/\.(html?)$/i.test(file)) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (/\.(?:css|js|mjs|cjs|json|ico|png|jpe?g|webp|gif|svg|woff2?|ttf|otf|mp4|webm)$/i.test(file)) {
      res.setHeader('Cache-Control', 'public,max-age=31536000,immutable');
    } else {
      res.setHeader('Cache-Control', 'public,max-age=86400');
    }
  }
}));

// Universal asset resolver: preserved -> basename alias -> SHA alias -> live fetch+cache
app.get(/\.[a-z0-9]+$/i, async (req, res, next) => {
  if (!EXT_RE.test(req.path)) return next();

  // 1) preserved path
  const preserved = path.join(ROOT, req.path.replace(/^\//, ''));
  if (fileExists(preserved)) return res.sendFile(preserved);

  // 2) basename alias
  const base = path.basename(req.path).toLowerCase();
  const byBase = ASSET_INDEX.get(base);
  if (byBase && fileExists(byBase)) {
    return res.sendFile(byBase);
  }

  // 3) SHA alias for any known origin
  const extReq = path.extname(req.path) || '';
  for (const origin of ORIGINS) {
    const cand = shaCandidateFor(origin, req.path, extReq);
    if (fileExists(cand)) {
      return res.sendFile(cand);
    }
  }

  // 4) Live fetch and cache
  if (!DISABLE_FETCH_CACHE && ORIGINS.length) {
    for (const origin of ORIGINS) {
      const fullUrl = origin.replace(/\/+$/, '') + req.path;
      // Decide save path: prefer requested ext; if none, try to infer after fetch (simple)
      let cand = shaCandidateFor(origin, req.path, extReq);
      if (!extReq) {
        // No extension in path (rare for these). We will still save with no ext or infer by content-type
        // but most Shopware assets do have ext, so this is fine.
      }
      const saved = await fetchAndCache(fullUrl, cand);
      if (saved && fileExists(saved)) {
        console.log('[FETCH_CACHE]', req.path, '->', path.relative(ROOT, saved));
        return res.sendFile(saved);
      }
    }
  }

  return next();
});

// Optional stub endpoints some sites expect
app.get(/^\/save_captcha_token.*$/i, (req, res) => res.status(204).end());

// Optional root redirect
if (START_PATH && START_PATH !== '/') {
  app.get('/', (req, res, next) => {
    if (req.originalUrl === '/' || req.originalUrl === '') {
      return res.redirect(302, START_PATH);
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

  const resolved = resolveHtml(req);
  if (!resolved) return next();

  if (DISABLE_HTML_INJECT) {
    return res.sendFile(resolved);
  }

  try {
    let html = fs.readFileSync(resolved, 'utf8');
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
    if (html.includes('</head>')) html = html.replace('</head>', injectTag + '\n</head>');
    else if (html.includes('<body')) html = html.replace('<body', '<body>' + injectTag);
    else html += injectTag;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
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