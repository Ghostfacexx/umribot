/**
 * lib/hostingPrep.cjs
 * SMART hosting preparation core (CommonJS).
 *
 * prepareHosting(runDir, outDir, options, logFn) returns:
 *   { outDir, pages, zipPath }
 *
 * Options:
 *   mode: "switch" | "desktop" | "both"
 *   stripAnalytics: bool
 *   precompress: bool           (gzip + brotli)
 *   noServiceWorker: bool
 *   baseUrl: string             (sitemap + robots if provided and !noSitemap)
 *   noSitemap: bool
 *   noMobile: bool
 *   extraAnalyticsRegex: string (source for additional JS regex)
 *   platform: "generic" | "netlify" | "cloudflare" | "s3" | "shopify"
 *   addShopifyEmbed: bool
 *   createZip: bool
 *
 * The function is defensive: if manifest lacks mobile entries but the filesystem
 * contains `rel/mobile/index.html`, it still treats mobile as available.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function ensureDir(p){ fs.mkdirSync(p,{recursive:true}); }
function fileExists(p){ try { return fs.statSync(p).isFile(); } catch { return false; } }
function dirExists(p){ try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function readJSON(p){
  return JSON.parse(fs.readFileSync(p,'utf8'));
}

/* ----- Analytics Stripping ----- */
function stripAnalytics(html, regexExtra){
  const patterns = [
    /<script[^>]+googletagmanager[^>]*>[\s\S]*?<\/script>/gi,
    /<script[^>]*src=["'][^"']*googletagmanager[^"']*["'][^>]*>\s*<\/script>/gi,
    /<script[^>]*src=["'][^"']*(?:gtag|analytics|ga\.js)[^"']*["'][^>]*>\s*<\/script>/gi,
    /<script[^>]+facebook\.net[^>]*>[\s\S]*?<\/script>/gi,
    /<script[^>]*src=["'][^"']*(?:hotjar|clarity|segment|fullstory)[^"']*["'][^>]*>\s*<\/script>/gi
  ];
  if(regexExtra){
    try {
      const extra = new RegExp(`<script[^>]*src=["'][^"']*${regexExtra}[^"']*["'][^>]*>\\s*</script>`,'gi');
      patterns.push(extra);
    } catch {}
  }
  let out=html;
  for(const p of patterns) out=out.replace(p,'');
  return out;
}

function createSwitchPage(){
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Variant Switch</title>
<style>body{font-family:system-ui,Arial,sans-serif;margin:2rem}a{display:inline-block;margin:.6rem 1rem .6rem 0;padding:.65rem 1.1rem;background:#0a57ff;color:#fff;text-decoration:none;border-radius:5px;font-weight:500}</style>
<script>(function(){var ua=navigator.userAgent.toLowerCase();var mobile=/iphone|android|ipad|ipod|mobile/.test(ua);var t=(mobile?'mobile/':'desktop/');fetch(t,{method:'HEAD'}).then(r=>{if(r.ok)location.replace(t);});})();</script>
</head><body>
<h1>Archived Variants</h1>
<p>If you are not redirected, choose a version:</p>
<p><a href="desktop/">Desktop</a><a href="mobile/">Mobile</a></p>
</body></html>`;
}

/* ----- Page Enumeration ----- */
function enumeratePages(manifest, runDir, noMobile){
  // Collect rel paths from manifest (desktop entries)
  const set = new Set();
  for(const rec of manifest){
    // prefer desktop to define canonical rel path
    if(rec.profile==='desktop'){
      set.add(rec.relPath || 'index');
    }
  }
  // If no desktop page discovered (rare), fallback to any relPath
  if(set.size===0){
    for(const rec of manifest){
      set.add(rec.relPath || 'index');
    }
  }
  // Also, scan filesystem for directories containing /mobile/index.html not in set
  if(!noMobile){
    try {
      const idxDir=path.join(runDir,'index','mobile');
      if(dirExists(idxDir) && !set.has('index')) set.add('index');
    } catch {}
    // Optional deeper scan (only shallow / top-level)
    try {
      const rootEntries=fs.readdirSync(runDir,{withFileTypes:true});
      for(const e of rootEntries){
        if(!e.isDirectory()) continue;
        const rel=e.name;
        if(rel==='index') continue;
        const mobilePath=path.join(runDir,rel,'mobile','index.html');
        if(fileExists(mobilePath) && !set.has(rel)) set.add(rel);
      }
    } catch {}
  }
  return [...set];
}

function readVariant(runDir, rel, profile){
  let fp;
  if(rel==='index'){ fp=path.join(runDir,'index',profile,'index.html'); }
  else { fp=path.join(runDir,rel,profile,'index.html'); }
  if(fileExists(fp)) return fs.readFileSync(fp,'utf8');
  return null;
}

function writeFile(fp,data){
  ensureDir(path.dirname(fp));
  fs.writeFileSync(fp,data);
}

function buildPage(outRoot, runDir, rel, desktopHTML, mobileHTML, mode, strip, regexExtra){
  const baseDir = (rel==='index') ? outRoot : path.join(outRoot, rel);
  ensureDir(baseDir);

  if(desktopHTML){
    writeFile(path.join(baseDir,'desktop','index.html'), strip?stripAnalytics(desktopHTML, regexExtra):desktopHTML);
  }
  if(mobileHTML){
    writeFile(path.join(baseDir,'mobile','index.html'), strip?stripAnalytics(mobileHTML, regexExtra):mobileHTML);
  }

  if(mode==='desktop'){
    const chosen = desktopHTML || mobileHTML;
    if(chosen) writeFile(path.join(baseDir,'index.html'), strip?stripAnalytics(chosen, regexExtra):chosen);
  } else if(mode==='both'){
    const primary = desktopHTML || mobileHTML;
    if(primary) writeFile(path.join(baseDir,'index.html'), strip?stripAnalytics(primary, regexExtra):primary);
  } else { // switch
    if(desktopHTML && mobileHTML){
      writeFile(path.join(baseDir,'index.html'), createSwitchPage());
    } else {
      const onlyOne=desktopHTML||mobileHTML;
      if(onlyOne) writeFile(path.join(baseDir,'index.html'), strip?stripAnalytics(onlyOne, regexExtra):onlyOne);
    }
  }
}

function copyDir(src,dest){
  if(!dirExists(src)) return;
  ensureDir(dest);
  for(const e of fs.readdirSync(src,{withFileTypes:true})){
    const s=path.join(src,e.name);
    const d=path.join(dest,e.name);
    if(e.isDirectory()) copyDir(s,d);
    else if(e.isFile()){
      ensureDir(path.dirname(d));
      fs.copyFileSync(s,d);
    }
  }
}

function generateSitemap(outRoot, baseUrl, rels){
  if(!baseUrl) return;
  const norm=baseUrl.replace(/\/+$/,'');
  const body=rels.map(r=>{
    const suffix = r==='index' ? '' : r+'/';
    return `<url><loc>${norm}/${suffix}</loc><changefreq>weekly</changefreq><priority>0.6</priority></url>`;
  }).join('');
  const xml=`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>`;
  writeFile(path.join(outRoot,'sitemap.xml'), xml);
  writeFile(path.join(outRoot,'robots.txt'),
`User-agent: *
Allow: /
Sitemap: ${norm}/sitemap.xml
`);
}

function generateServiceWorker(outRoot, rels){
  const pages = rels.map(r=> r==='index' ? '/' : `/${r}/`);
  function gather(dirRel){
    const abs=path.join(outRoot,dirRel);
    if(!dirExists(abs)) return [];
    let collected=[];
    for(const e of fs.readdirSync(abs,{withFileTypes:true})){
      const rel=path.join('/',dirRel,e.name).replace(/\\/g,'/');
      const absE=path.join(abs,e.name);
      if(e.isDirectory()) collected=collected.concat(gather(path.join(dirRel,e.name)));
      else if(e.isFile()) collected.push(rel);
    }
    return collected;
  }
  let assets=[];
  ['assets','_ext'].forEach(d=> assets=assets.concat(gather(d)));
  const sw=`/* generated service worker */
const CACHE='archive-v1';
const PRELOAD=${JSON.stringify(pages.concat(assets).slice(0,6000))};
self.addEventListener('install',e=>{
 e.waitUntil(caches.open(CACHE).then(c=>c.addAll(PRELOAD)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
 e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
 if(e.request.method!=='GET') return;
 const accept=e.request.headers.get('accept')||'';
 if(accept.includes('text/html')){
  e.respondWith(fetch(e.request).then(r=>{
    const clone=r.clone(); caches.open(CACHE).then(c=>c.put(e.request,clone)); return r;
  }).catch(()=>caches.match(e.request)));
 } else {
  e.respondWith(caches.match(e.request).then(hit=>hit||fetch(e.request).then(r=>{
    if(r.ok) caches.open(CACHE).then(c=>c.put(e.request,r.clone()));
    return r;
  })));
 }
});
`;
  writeFile(path.join(outRoot,'sw.js'), sw);
}

function precompress(outRoot){
  const exts=/\.(?:html?|css|js|mjs|cjs)$/i;
  function walk(dir){
    for(const e of fs.readdirSync(dir,{withFileTypes:true})){
      const p=path.join(dir,e.name);
      if(e.isDirectory()) walk(p);
      else if(e.isFile() && exts.test(e.name)){
        const buf=fs.readFileSync(p);
        try { fs.writeFileSync(p+'.gz', zlib.gzipSync(buf,{level:9})); } catch {}
        try { fs.writeFileSync(p+'.br', zlib.brotliCompressSync(buf,{
          params:{[zlib.constants.BROTLI_PARAM_QUALITY]:11}
        })); } catch {}
      }
    }
  }
  walk(outRoot);
}

function writePlatformDocs(outRoot, platform, options){
  const lines=[];
  lines.push(`# Deployment (${platform})`);
  switch(platform){
    case 'netlify':
      lines.push('1. netlify deploy --prod --dir=.');
      lines.push('2. Netlify auto-compresses; extra precompressed files optional.');
      break;
    case 'cloudflare':
      lines.push('1. wrangler pages deploy .');
      lines.push('2. Edge Brotli compression automatic; local .br optional.');
      break;
    case 's3':
      lines.push('1. aws s3 sync . s3://YOUR_BUCKET/ --delete');
      lines.push('2. Enable compression in CloudFront; default root object index.html');
      break;
    case 'shopify':
      lines.push('1. Upload /assets to theme assets.');
      lines.push('2. Use shopify-snippet.liquid or SHOPIFY_EMBED_SNIPPET.html for embedding.');
      break;
    default:
      lines.push('1. Copy all files to static host root.');
      lines.push('2. Ensure server falls back to index.html for directories.');
  }
  if(options.mode==='switch') lines.push('Variant switching enabled (UA detection).');
  if(options.stripAnalytics) lines.push('Common analytics scripts stripped.');
  fs.writeFileSync(path.join(outRoot,`DEPLOY-${platform.toUpperCase()}.md`), lines.join('\n')+'\n');

  if(platform==='shopify'){
    fs.writeFileSync(path.join(outRoot,'shopify-snippet.liquid'),
`{% comment %} Archive Embed Snippet {% endcomment %}
<div class="archive-wrapper">
  <iframe src="{{ 'archive/index.html' | asset_url }}" style="width:100%;min-height:1400px;border:0;"></iframe>
</div>
`);
  }
}

function writeReadme(outRoot, runDir, options, rels){
  fs.writeFileSync(path.join(outRoot,'README-hosting.md'),
`# Hosting Package
Origin: ${runDir}
Mode: ${options.mode}
Pages: ${rels.length}
Include Mobile: ${!options.noMobile}
Strip Analytics: ${options.stripAnalytics}
Service Worker: ${!options.noServiceWorker}
Precompressed: ${options.precompress}
Platform: ${options.platform}
Generated: ${new Date().toISOString()}

See DEPLOY-${options.platform.toUpperCase()}.md for deployment notes.
`);
}

function zipDirectory(sourceDir, outZip, log){
  let crcLib;
  try { crcLib=require('crc'); }
  catch { log && log('crc module missing; skipping zip'); return null; }

  const files=[];
  function walk(rel){
    const abs=path.join(sourceDir,rel);
    for(const e of fs.readdirSync(abs,{withFileTypes:true})){
      const r=path.join(rel,e.name);
      if(e.isDirectory()) walk(r);
      else if(e.isFile()) files.push(r);
    }
  }
  walk('');
  const buffers=[], central=[];
  let offset=0;
  for(const rel of files){
    const data=fs.readFileSync(path.join(sourceDir,rel));
    const name=rel.replace(/\\/g,'/');
    const nameBuf=Buffer.from(name);
    const header=Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50,0);
    header.writeUInt16LE(20,4);
    header.writeUInt16LE(0,6);
    header.writeUInt16LE(0,8);
    header.writeUInt16LE(0,10);
    header.writeUInt16LE(0,12);
    const crc=crcLib.crc32(data);
    header.writeUInt32LE(crc>>>0,14);
    header.writeUInt32LE(data.length,18);
    header.writeUInt32LE(data.length,22);
    header.writeUInt16LE(nameBuf.length,26);
    header.writeUInt16LE(0,28);
    buffers.push(header,nameBuf,data);

    const c=Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50,0);
    c.writeUInt16LE(20,4);
    c.writeUInt16LE(20,6);
    c.writeUInt16LE(0,8);
    c.writeUInt16LE(0,10);
    c.writeUInt16LE(0,12);
    c.writeUInt16LE(0,14);
    c.writeUInt32LE(crc>>>0,16);
    c.writeUInt32LE(data.length,20);
    c.writeUInt32LE(data.length,24);
    c.writeUInt16LE(nameBuf.length,28);
    c.writeUInt16LE(0,30);
    c.writeUInt16LE(0,32);
    c.writeUInt16LE(0,34);
    c.writeUInt32LE(0,36);
    c.writeUInt32LE(offset,42);
    central.push(c,nameBuf);
    offset += header.length + nameBuf.length + data.length;
  }
  const centralSize=central.reduce((s,b)=>s+b.length,0);
  const centralOffset=offset;
  const end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);
  end.writeUInt16LE(0,4);
  end.writeUInt16LE(0,6);
  end.writeUInt16LE(files.length,8);
  end.writeUInt16LE(files.length,10);
  end.writeUInt32LE(centralSize,12);
  end.writeUInt32LE(centralOffset,16);
  end.writeUInt16LE(0,20);
  fs.writeFileSync(outZip, Buffer.concat([...buffers,...central,end]));
  return outZip;
}

/* ----- Prepare Core ----- */
async function prepareHosting(runDir, outDir, options={}, log=()=>{}) {
  if(!dirExists(runDir)) throw new Error('runDir not found: '+runDir);
  const manifestPath=path.join(runDir,'manifest.json');
  if(!fileExists(manifestPath)) throw new Error('manifest.json missing in runDir');
  const manifest=readJSON(manifestPath);

  const rels=enumeratePages(manifest, runDir, options.noMobile);
  log('Pages detected='+rels.length);

  ensureDir(outDir);

  ['assets','_ext'].forEach(d=>{
    const src=path.join(runDir,d);
    if(dirExists(src)){
      log('Copy dir: '+d);
      copyDir(src, path.join(outDir,d));
    }
  });

  const extraRegex=options.extraAnalyticsRegex||null;

  for(const rel of rels){
    const desktopHTML = readVariant(runDir, rel, 'desktop');
    const mobileHTML  = options.noMobile ? null : readVariant(runDir, rel, 'mobile');
    buildPage(outDir, runDir, rel, desktopHTML, mobileHTML, options.mode, options.stripAnalytics, extraRegex);
  }

  if(options.baseUrl && !options.noSitemap){
    log('Generating sitemap + robots');
    generateSitemap(outDir, options.baseUrl, rels);
  }

  if(!options.noServiceWorker){
    log('Generating service worker');
    generateServiceWorker(outDir, rels);
  }

  if(options.precompress){
    log('Precompressing (gzip + brotli)');
    precompress(outDir);
  }

  writePlatformDocs(outDir, options.platform||'generic', options);
  writeReadme(outDir, runDir, options, rels);

  if(options.platform==='shopify' && options.addShopifyEmbed){
    fs.writeFileSync(path.join(outDir,'SHOPIFY_EMBED_SNIPPET.html'),
`<!-- Shopify Embed Example -->
<div style="width:100%;min-height:1200px;">
  <iframe src="https://YOUR_DEPLOYED_ARCHIVE_DOMAIN/index.html" style="border:0;width:100%;min-height:1200px;"></iframe>
</div>
`);
  }

  let zipPath=null;
  if(options.createZip){
    zipPath=path.join(path.dirname(outDir), path.basename(outDir)+'.zip');
    log('Creating ZIP (store)');
    zipPath=zipDirectory(outDir, zipPath, log);
  }

  return { outDir, pages: rels, zipPath };
}

module.exports = { prepareHosting };