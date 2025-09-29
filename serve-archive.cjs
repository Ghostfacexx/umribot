#!/usr/bin/env node
/**
 * Static Archive Server for Outnet Mirror
 *
 * Features:
 *  - Directory -> index.html mapping
 *  - Trailing slash normalization (301 redirect when needed)
 *  - Manifest browse/search UI (/ _browse)
 *  - Raw manifest JSON (/ _manifest)
 *  - Simple search endpoint (/ _search?q=term)
 *  - Optional gzip/brotli compression (on-the-fly)
 *  - In-memory LRU-ish cache (size + entry limits)
 *  - Auto-reloads manifest.json on change
 *  - Link-safe path normalization + traversal guard
 *  - Basic security headers
 *
 * ENV:
 *   PORT=8080
 *   HOST=0.0.0.0
 *   ARCHIVE_ROOT=/var/www/outnet-archive
 *   DISABLE_COMPRESSION=1   (to turn off gzip/br)
 *   CACHE_MAX_ENTRIES=800
 *   CACHE_MAX_BYTES=67108864  (64MB)
 *   NO_CACHE=1                (disable in-memory cache)
 *
 * START:
 *   node serve-archive.cjs
 *
 * Or specify custom:
 *   PORT=8080 ARCHIVE_ROOT=/var/www/outnet-archive node serve-archive.cjs
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const url = require('url');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ARCHIVE_ROOT = process.env.ARCHIVE_ROOT || '/var/www/outnet-archive';
const MANIFEST_PATH = path.join(ARCHIVE_ROOT, 'manifest.json');
const DISABLE_COMPRESSION = !!process.env.DISABLE_COMPRESSION;
const CACHE_MAX_ENTRIES = parseInt(process.env.CACHE_MAX_ENTRIES || '800', 10);
const CACHE_MAX_BYTES = parseInt(process.env.CACHE_MAX_BYTES || (64*1024*1024), 10);
const NO_CACHE = !!process.env.NO_CACHE;

if (!fs.existsSync(ARCHIVE_ROOT)) {
  console.error('Archive root does not exist:', ARCHIVE_ROOT);
  process.exit(1);
}

let manifest = [];
let manifestMtime = 0;

function loadManifest(force=false) {
  try {
    const st = fs.statSync(MANIFEST_PATH);
    if (force || st.mtimeMs !== manifestMtime) {
      const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
      manifest = JSON.parse(raw);
      manifestMtime = st.mtimeMs;
      console.log(`[manifest] loaded (${manifest.length} entries)`);
    }
  } catch (e) {
    console.warn('[manifest] load failed:', e.message);
  }
}
loadManifest(true);
fs.watch(path.dirname(MANIFEST_PATH), { persistent: false }, (evt, fname) => {
  if (fname === 'manifest.json') loadManifest();
});

const mimeMap = {
  '.html':'text/html; charset=utf-8',
  '.css':'text/css; charset=utf-8',
  '.js':'application/javascript; charset=utf-8',
  '.mjs':'application/javascript; charset=utf-8',
  '.json':'application/json; charset=utf-8',
  '.png':'image/png',
  '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg',
  '.webp':'image/webp',
  '.gif':'image/gif',
  '.svg':'image/svg+xml',
  '.ico':'image/x-icon',
  '.woff':'font/woff',
  '.woff2':'font/woff2',
  '.ttf':'font/ttf',
  '.otf':'font/otf',
  '.txt':'text/plain; charset=utf-8',
  '.xml':'application/xml; charset=utf-8'
};

function contentType(p) {
  return mimeMap[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

/* Simple LRU-ish cache */
const cache = {
  bytes:0,
  map:new Map(), // key -> {buf, ctype, mtime, etag}
};
function cacheGet(key) {
  if (NO_CACHE) return null;
  const v = cache.map.get(key);
  if (v) {
    // refresh order
    cache.map.delete(key);
    cache.map.set(key, v);
  }
  return v;
}
function cacheSet(key,obj) {
  if (NO_CACHE) return;
  if (obj.buf.length > CACHE_MAX_BYTES / 4) return; // don't store huge single
  if (cache.map.has(key)) {
    const old = cache.map.get(key);
    cache.bytes -= old.buf.length;
    cache.map.delete(key);
  }
  cache.map.set(key,obj);
  cache.bytes += obj.buf.length;
  while (cache.bytes > CACHE_MAX_BYTES || cache.map.size > CACHE_MAX_ENTRIES) {
    const firstKey = cache.map.keys().next().value;
    if (!firstKey) break;
    const old = cache.map.get(firstKey);
    cache.bytes -= old.buf.length;
    cache.map.delete(firstKey);
  }
}

function safeJoin(root, reqPath) {
  const decoded = decodeURIComponent(reqPath);
  const norm = path.posix.normalize(decoded.replace(/\/+$/,''));
  const full = path.join(root, norm);
  if (!full.startsWith(path.resolve(root))) return null;
  return { norm, full };
}

function sendCompression(req,res,data,ctype,etag) {
  if (DISABLE_COMPRESSION) {
    res.writeHead(200, {
      'Content-Type': ctype,
      'Content-Length': data.length,
      'ETag': etag
    });
    return res.end(data);
  }
  const ae = req.headers['accept-encoding'] || '';
  if (/\bbr\b/.test(ae)) {
    zlib.brotliCompress(data, (err, br) => {
      if (err) return sendRaw();
      res.writeHead(200, {
        'Content-Type': ctype,
        'Content-Encoding': 'br',
        'Vary': 'Accept-Encoding',
        'ETag': etag
      });
      res.end(br);
    });
  } else if (/\bgzip\b/.test(ae)) {
    zlib.gzip(data, (err, gz) => {
      if (err) return sendRaw();
      res.writeHead(200, {
        'Content-Type': ctype,
        'Content-Encoding': 'gzip',
        'Vary': 'Accept-Encoding',
        'ETag': etag
      });
      res.end(gz);
    });
  } else {
    sendRaw();
  }
  function sendRaw() {
    res.writeHead(200, {
      'Content-Type': ctype,
      'Content-Length': data.length,
      'ETag': etag
    });
    res.end(data);
  }
}

function serveFile(req,res,absPath,stat) {
  const ctype = contentType(absPath);
  const etag = `"${stat.size}-${stat.mtimeMs}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { 'ETag': etag });
    return res.end();
  }

  const key = absPath;
  const cached = cacheGet(key);
  if (cached && cached.mtime === stat.mtimeMs) {
    return sendCompression(req,res,cached.buf,cached.ctype,cached.etag);
  }

  fs.readFile(absPath, (err,data)=>{
    if (err) return notFound(req,res);
    cacheSet(key, { buf:data, ctype, mtime:stat.mtimeMs, etag });
    sendCompression(req,res,data,ctype,etag);
  });
}

function notFound(req,res) {
  const body = `<!DOCTYPE html><html><head><meta charset=utf-8><title>404</title><style>
  body{font:14px/1.4 system-ui;margin:40px;color:#333}
  h1{margin-top:0}
  a{color:#06c}
  </style></head><body><h1>404 Not Found</h1><p>${escapeHtml(req.url||'')}</p>
  <p><a href="/_browse">Browse index</a></p></body></html>`;
  res.writeHead(404, {
    'Content-Type':'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function escapeHtml(s){
  return s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

// -------- Browse UI --------
function browsePage(query) {
  const q = (query || '').trim().toLowerCase();
  const rows = [];
  let shown=0;
  for (const m of manifest) {
    const u = m.url;
    if (q && !u.toLowerCase().includes(q)) continue;
    const local = '/' + m.localPath + '/';
    const status = m.status;
    const assets = m.assets;
    rows.push(`<tr>
      <td>${escapeHtml(status)}</td>
      <td><a href="${local}">${escapeHtml(local)}</a></td>
      <td>${assets}</td>
      <td>${m.mainStatus==null?'':m.mainStatus}</td>
      <td>${m.rawUsed?'raw':''}</td>
    </tr>`);
    shown++;
    if (shown>1000) { rows.push(`<tr><td colspan=5>... truncated ...</td></tr>`); break; }
  }
  return `<!DOCTYPE html><html><head><meta charset=utf-8>
<title>Archive Browser</title>
<style>
body{font:14px system-ui;margin:20px;}
table{border-collapse:collapse;width:100%;font-size:13px;}
th,td{border:1px solid #ccc;padding:4px;text-align:left;}
input[type=text]{width:260px;padding:4px;}
.status-bad{background:#fee;}
.status-okRaw{background:#eef;}
</style></head><body>
<h1>Archive Browser</h1>
<form method="GET" action="/_browse">
<input type="text" name="q" value="${escapeHtml(q)}" placeholder="filter (substring)">
<button type="submit">Search</button>
<span style="margin-left:1em;font-size:12px;color:#666">${manifest.length} total entries</span>
</form>
<table>
<thead><tr><th>Status</th><th>Local</th><th>Assets</th><th>HTTP</th><th>Flags</th></tr></thead>
<tbody>${rows.join('\n')}</tbody>
</table>
</body></html>`;
}

// -------- Search JSON endpoint --------
function searchManifest(q) {
  const qq = q.toLowerCase();
  return manifest.filter(m => m.url.toLowerCase().includes(qq) || ('/'+m.localPath+'/').includes(qq)).slice(0,500);
}

// -------- Request Handler --------
const server = http.createServer((req,res)=>{
  // Basic security headers
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('X-Frame-Options','SAMEORIGIN');

  const parsed = url.parse(req.url || '/', true);
  const pathnameRaw = parsed.pathname || '/';

  if (pathnameRaw === '/robots.txt') {
    const r = 'User-agent: *\nDisallow: /\n';
    res.writeHead(200, {'Content-Type':'text/plain; charset=utf-8','Content-Length':Buffer.byteLength(r)});
    return res.end(r);
  }

  if (pathnameRaw === '/_manifest') {
    loadManifest();
    const json = JSON.stringify(manifest);
    res.writeHead(200, {'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(json)});
    return res.end(json);
  }

  if (pathnameRaw === '/_search') {
    loadManifest();
    const q = (parsed.query.q || '').toString();
    const results = searchManifest(q);
    const json = JSON.stringify({ query:q, count:results.length, results });
    res.writeHead(200, {'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(json)});
    return res.end(json);
  }

  if (pathnameRaw === '/_browse') {
    loadManifest();
    const q = (parsed.query.q || '').toString();
    const html = browsePage(q);
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Content-Length':Buffer.byteLength(html)});
    return res.end(html);
  }

  // Normalize & map
  let requestPath = pathnameRaw;

  // Guarantee leading slash
  if (!requestPath.startsWith('/')) requestPath = '/' + requestPath;

  // If someone requests root without trailing slash (rare), keep as is.
  const mapping = safeJoin(ARCHIVE_ROOT, requestPath);
  if (!mapping) return notFound(req,res);

  let { norm, full } = mapping;

  // Directory logic:
  // If path corresponds to directory with index.html but no trailing slash -> redirect.
  let candidateDir = full;
  try {
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      // Must end with slash for relative assets; if not, redirect
      if (!requestPath.endsWith('/')) {
        res.writeHead(301, { 'Location': requestPath + '/' });
        return res.end();
      }
      // serve index.html inside that directory
      const idxPath = path.join(full,'index.html');
      if (fs.existsSync(idxPath)) {
        const idxStat = fs.statSync(idxPath);
        return serveFile(req,res,idxPath,idxStat);
      }
      // If directory but no index -> maybe show listing? (Disable for now)
      return notFound(req,res);
    } else {
      // It’s a file directly
      return serveFile(req,res,full,stat);
    }
  } catch {
    // Try implicit directory (e.g. /en-us/shop/bags/ -> localPath mapping)
    // Possibly requested a path with trailing slash but dir not existing
  }

  // If request ends with '/', map to directory + index.html
  if (requestPath.endsWith('/')) {
    const idxPath = path.join(ARCHIVE_ROOT, requestPath.replace(/^\//,'') ,'index.html');
    if (fs.existsSync(idxPath)) {
      const st = fs.statSync(idxPath);
      return serveFile(req,res,idxPath,st);
    }
  } else {
    // If file not found, but directory with index exists + missing slash -> redirect
    const altDir = path.join(ARCHIVE_ROOT, requestPath.replace(/^\//,''));
    if (fs.existsSync(altDir) && fs.statSync(altDir).isDirectory() && fs.existsSync(path.join(altDir,'index.html'))) {
      res.writeHead(301, { 'Location': requestPath + '/' });
      return res.end();
    }
    // If there's a .html file matching
    const htmlCandidate = full + '.html';
    if (fs.existsSync(htmlCandidate)) {
      const st = fs.statSync(htmlCandidate);
      return serveFile(req,res,htmlCandidate,st);
    }
  }

  return notFound(req,res);
});

server.listen(PORT, HOST, () => {
  console.log(`Archive server listening on http://${HOST}:${PORT}`);
  console.log(`Root: ${ARCHIVE_ROOT}`);
  console.log('Browse: http://HOST:PORT/_browse');
});
