#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const https = require('https');
const http = require('http');

/* Optional CSS baker (juice). If not installed, export still works via <style> + URL rewrite. */
let juice = null;
try { juice = require('juice'); } catch { /* optional dep */ }

/* ---------- fs + text helpers ---------- */
function ensureDir(p){ fs.mkdirSync(p,{recursive:true}); }
function readJSON(p, def=null){ try{ return JSON.parse(fs.readFileSync(p,'utf8')); }catch{ return def; } }
function readText(p, def=''){ try{ return fs.readFileSync(p,'utf8'); }catch{ return def; } }
function writeTextUtf8BOM(p, s){ ensureDir(path.dirname(p)); fs.writeFileSync(p, '\ufeff'+s, 'utf8'); } // BOM for Excel
function writeText(p, s){ ensureDir(path.dirname(p)); fs.writeFileSync(p, s, 'utf8'); }
function isHttp(u){ return /^https?:\/\//i.test(u||''); }
function cleanUrlToken(u){ return (u||'').trim().replace(/^['"]|['"]$/g,''); }
function toAbs(u, base){ if(isHttp(u)) return u; try{ return new URL(u, base).href; }catch{ return u; } }
function slugify(s=''){ return String(s).toLowerCase().replace(/https?:\/\/|[^a-z0-9]+/gi,'-').replace(/(^-|-$)/g,'').slice(0,80); }

/* ---------- simple HTTP text fetch (CSS etc.) ---------- */
function fetchRemoteText(url, timeoutMs=8000){
  return new Promise((resolve)=>{
    try{
      const U=new URL(url);
      const mod = U.protocol === 'https:' ? https : http;
      const req = mod.request({
        hostname: U.hostname, port: U.port || (U.protocol==='https:'?443:80),
        path: (U.pathname||'/')+(U.search||''), method:'GET', timeout: timeoutMs,
        headers: {
          'User-Agent': 'Mozilla/5.0 (ExporterCSSFetcher)',
          'Accept': 'text/css,*/*;q=0.1'
        }
      }, (res)=>{
        const chunks=[]; res.on('data', c=>chunks.push(c));
        res.on('end', ()=> resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', ()=>resolve(''));
      req.on('timeout', ()=>{ try{req.destroy();}catch{} resolve(''); });
      req.end();
    }catch{ resolve(''); }
  });
}

/* ---------- derive site origin for this run ---------- */
function getSiteOriginFromRun(runDir){
  const mf=readJSON(path.join(runDir,'manifest.json'),[]);
  const first = Array.isArray(mf) ? mf.find(r=>r && (r.finalURL || r.url)) : null;
  if (first && (first.finalURL || first.url)) {
    try{ return new URL(first.finalURL || first.url).origin; }catch{}
  }
  const seedLine = readText(path.join(runDir,'seeds.txt'),'').split(/\r?\n/).map(s=>s.trim()).find(Boolean);
  if (seedLine){ try{ return new URL(seedLine).origin; }catch{} }
  try{
    const fp = path.join(runDir,'_data','products.ndjson');
    const lines = readText(fp,'').split(/\r?\n/).filter(Boolean);
    if (lines.length){
      const p = JSON.parse(lines[0]);
      const u = p && p.url;
      if (u) { try { return new URL(u).origin; } catch {} }
    }
  }catch{}
  return '';
}

/* ---------- Asset map parsing from archiver fallback (optional) ---------- */
function parseAssetMapFromHTML(html){
  const m=html.match(/const\s+MAP\s*=\s*(\{[\s\S]*?\});/);
  if(!m) return null;
  try{ return JSON.parse(m[1]); }catch{ return null; }
}
function invertMap(origToLocal){
  if(!origToLocal) return null;
  const inv={};
  for(const [orig,local] of Object.entries(origToLocal||{})){
    const n=String(local||'').replace(/^[./\\]+/,'').replace(/\\/g,'/');
    if(!n) continue;
    inv[n]=orig; inv['/'+n]=orig;
  }
  return inv;
}
function resolveLocalByHref(href, runDir){
  if(!href) return null;
  const rel=href.replace(/^[./\\]+/,'').replace(/\\/g,'/');
  const fp=path.join(runDir, rel);
  return fs.existsSync(fp)?fp:null;
}

/* ---------- CSS rewriting and inlining (global) ---------- */
function rewriteCssUrls(cssText, cssBaseUrl){
  if(!cssText) return '';
  return cssText.replace(/url\(\s*([^)]+?)\s*\)/g,(m,g1)=>{
    const raw=cleanUrlToken(g1);
    if(!raw || raw.startsWith('data:') || isHttp(raw)) return `url(${raw})`;
    try{ return `url(${new URL(raw, cssBaseUrl).href})`; }catch{ return `url(${raw})`; }
  });
}
async function inlineCssImports(cssText, cssBaseUrl, runDir, mapLocalToOrig, depth=0, maxDepth=3, maxBytesLeft=300_000){
  if(!cssText || depth>=maxDepth || maxBytesLeft<=0) return cssText||'';
  const importRx = /@import\s+(?:url\()?['"]?([^'")]+)['"]?\)?[^;]*;/gi;
  let out=''; let lastIndex=0; let m;
  while((m=importRx.exec(cssText))){
    out += cssText.slice(lastIndex, m.index);
    lastIndex = importRx.lastIndex;
    const href = cleanUrlToken(m[1]||'');
    let absHref;
    try{ absHref = new URL(href, cssBaseUrl).href; }catch{ absHref = href; }

    let importedText = '';
    if (!isHttp(absHref)) {
      const local = resolveLocalByHref(href, runDir);
      if (local) importedText = readText(local,'');
    }
    if (!importedText && isHttp(absHref)) importedText = await fetchRemoteText(absHref);
    if (!importedText) continue;

    let imported = rewriteCssUrls(importedText, absHref);
    imported = await inlineCssImports(imported, absHref, runDir, mapLocalToOrig, depth+1, maxDepth, maxBytesLeft - Buffer.byteLength(out,'utf8'));
    out += '\n/* inlined: '+absHref+' */\n' + imported + '\n';
  }
  out += cssText.slice(lastIndex);
  return out;
}

async function collectAndInlineAllCssGlobal($, runDir, pageOrigin, mapLocalToOrig, { maxBytes=350_000 } = {}){
  const links = $('link[rel="stylesheet"][href]');
  let combined = '';
  const appendCss = (css, label) => {
    if (!css) return;
    const remaining = Math.max(0, maxBytes - Buffer.byteLength(combined, 'utf8'));
    if (remaining <= 0) return;
    const chunk = Buffer.byteLength(css,'utf8') > remaining ? css.slice(0, remaining) : css;
    combined += `\n/* ${label} */\n` + chunk + '\n';
  };

  for (const el of links.toArray()){
    const href = ($(el).attr('href')||'').trim();
    if (!href) continue;
    const rel = href.replace(/^[./\\]+/,'').replace(/\\/g,'/');
    const mappedOrig = mapLocalToOrig ? (mapLocalToOrig[rel] || mapLocalToOrig['/'+rel]) : null;
    const cssAbsUrl = mappedOrig || toAbs(href, pageOrigin);

    let cssText = '';
    const localFp = resolveLocalByHref(href, runDir);
    if (localFp) cssText = readText(localFp,'');
    if (!cssText && isHttp(cssAbsUrl)) cssText = await fetchRemoteText(cssAbsUrl);
    if (!cssText) continue;

    let rewritten = rewriteCssUrls(cssText, cssAbsUrl || pageOrigin || '');
    rewritten = await inlineCssImports(rewritten, cssAbsUrl || pageOrigin || '', runDir, mapLocalToOrig, 0, 3, maxBytes - Buffer.byteLength(combined,'utf8'));
    appendCss(rewritten, cssAbsUrl || href);
  }

  if (links.length) links.remove();

  $('head style, style').each((_, el)=>{
    const css = ($(el).html()||'').trim();
    if (css) {
      const rewritten = rewriteCssUrls(css, pageOrigin || '');
      appendCss(rewritten, '<style-inline>');
    }
    $(el).remove();
  });

  return combined.trim();
}

/* ---------- URL rewrite and script strip (global) ---------- */
function rewriteInlineHtmlUrlsToAbsolute($, pageOrigin, localToOriginalMap){
  const attrs=['src','href','poster','data-src'];
  $('img,source,video,audio,link,script,a').each((_,el)=>{
    for(const a of attrs){
      const v=$(el).attr(a); if(!v) continue; if(isHttp(v)) continue;
      const n=v.replace(/^[./\\]+/,'').replace(/\\/g,'/');
      const mapped=localToOriginalMap ? (localToOriginalMap[n]||localToOriginalMap['/'+n]) : null;
      $(el).attr(a, mapped || toAbs(v, pageOrigin));
    }
  });
  $('img[srcset], source[srcset]').each((_,el)=>{
    const v=$(el).attr('srcset'); if(!v) return;
    const out=v.split(',').map(s=>s.trim()).filter(Boolean).map(p=>{
      const seg=p.split(/\s+/);
      const u=seg[0];
      if(!isHttp(u)){
        const n=u.replace(/^[./\\]+/,'').replace(/\\/g,'/');
        const mapped=localToOriginalMap ? (localToOriginalMap[n]||localToOriginalMap['/'+n]) : null;
        seg[0]=mapped || toAbs(u, pageOrigin);
      }
      return seg.join(' ');
    });
    $(el).attr('srcset', out.join(', '));
  });
  $('script').remove();
}

/* ---------- body extraction helpers ---------- */
function extractBodyInnerHtmlSafe(html){
  try{
    const $ = cheerio.load(html, { decodeEntities:false });
    if ($('body').length) return $('body').html() || '';
  }catch{}
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return m ? m[1] : html;
}

/* ---------- CSS baking ---------- */
function bakeCssInHtml(html){
  if (!html || !juice) return html || '';
  try {
    return juice(html, {
      preserveImportant: true,
      inlinePseudoElements: true,
      removeStyleTags: true,
      applyWidthAttributes: true,
      applyHeightAttributes: true,
      preserveMediaQueries: true
    });
  } catch {
    return html;
  }
}

/* ---------- WXR build ---------- */
function escXml(s=''){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;'); }
function buildWxr(items, siteTitle='Imported Site'){
  const now=new Date();
  const head=`<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:wfw="http://wellformedweb.org/CommentAPI/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <title>${escXml(siteTitle)}</title>
    <link>https://example.com</link>
    <description>WXR export</description>
    <pubDate>${now.toUTCString()}</pubDate>
    <wp:wxr_version>1.2</wp:wxr_version>
`;
  const itemsXml = items.map((it,i)=>`
  <item>
    <title>${escXml(it.title || `Page ${i+1}`)}</title>
    <link>${escXml(it.url || '')}</link>
    <pubDate>${now.toUTCString()}</pubDate>
    <dc:creator><![CDATA[admin]]></dc:creator>
    <guid isPermaLink="false">${escXml('imported-'+(it.id || (i+1)))}</guid>
    <description></description>
    <content:encoded><![CDATA[${it.content || ''}]]></content:encoded>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <wp:post_id>${10000+i}</wp:post_id>
    <wp:post_date_gmt>${now.toISOString()}</wp:post_date_gmt>
    <wp:post_type>page</wp:post_type>
    <wp:status>publish</wp:status>
  </item>`).join('\n');
  return head + itemsXml + '\n  </channel>\n</rss>';
}

/* ---------- Manifest page path helper ---------- */
function pageHtmlPath(runDir, rec){
  const rel=rec.relPath && relPathNotIndex(rec.relPath) ? (rec.relPath||'') : 'index';
  return path.join(runDir, rel, 'desktop', 'index.html');
}
function relPathNotIndex(rel){ return (rel || '').trim() && (rel || '').trim() !== 'index'; }

/* ---------- Pages export (GLOBAL: inline + bake) ---------- */
async function exportWooPages({ runDir, outDir }){
  const mf=readJSON(path.join(runDir,'manifest.json'),[]);
  const pages=Array.isArray(mf)?mf.filter(r=>r&&r.profile==='desktop'):[];
  const outWoo=path.join(outDir,'woocommerce'); ensureDir(outWoo);

  const wxrItems=[]; let styledPages=0,totalCssBytes=0;
  for(const rec of pages){
    const file=pageHtmlPath(runDir, rec); if(!fs.existsSync(file)) continue;
    const html=readText(file,''); if(!html) continue;

    const pageUrl=rec.finalURL||rec.url||'';
    let pageOrigin=''; try{ pageOrigin=new URL(pageUrl).origin; }catch{}
    const mapOrigToLocal=parseAssetMapFromHTML(html);
    const mapLocalToOrig=invertMap(mapOrigToLocal);

    const $=cheerio.load(html,{decodeEntities:false});

    // Always inline CSS, fetching remote if needed
    let cssCombined = await collectAndInlineAllCssGlobal($, runDir, pageOrigin, mapLocalToOrig, { maxBytes: 350_000 });
    if(cssCombined){ styledPages++; totalCssBytes+=Buffer.byteLength(cssCombined,'utf8'); }

    // Absolute URLs and strip scripts
    rewriteInlineHtmlUrlsToAbsolute($, pageOrigin, mapLocalToOrig);

    // Robust body extraction
    let bodyHtml = $('body').length?$('body').html():extractBodyInnerHtmlSafe($.html());
    if (!bodyHtml) bodyHtml = extractBodyInnerHtmlSafe(html);

    // Inject <style> and then bake into elements (if juice is available)
    let content = (cssCombined?`<style>${cssCombined}</style>\n`:'') + (bodyHtml||'');
    content = bakeCssInHtml(content);

    const title=($('title').first().text()||'').trim() || slugify(rec.relPath||'index');
    wxrItems.push({ id:slugify(rec.relPath||'index'), title, url:pageUrl, content });
  }

  const siteTitle=(()=>{ try{ return new URL(pages[0]?.url||'').hostname; }catch{ return 'Imported Site'; }})();
  const wxr=buildWxr(wxrItems, siteTitle);
  const wxrPath=path.join(outWoo,'wordpress-pages-wxr.xml');
  writeText(wxrPath, wxr);
  return { outWoo, wxrPath, stats:{ pages:pages.length, styledPages, totalCssBytes } };
}

/* ---------- Products CSV (global-safe) ---------- */
function readProductsNdjson(runDir){
  const fp=path.join(runDir,'_data','products.ndjson');
  if(!fs.existsSync(fp)) return [];
  return readText(fp,'').split(/\r?\n/).filter(Boolean).map(ln=>{ try{ return JSON.parse(ln); }catch{ return null; } }).filter(Boolean);
}
function normalizePrice(v){
  if (v == null) return '';
  let s = String(v).trim();
  const m = s.match(/([0-9][0-9.,\s]*)/);
  s = m ? m[1] : s;
  s = s.replace(/\s+/g,'');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  const dec = Math.max(lastDot, lastComma);
  if (dec > 0){
    const intPart = s.slice(0, dec).replace(/[^\d]/g,'');
    const fracPart = s.slice(dec+1).replace(/[^\d]/g,'');
    return (intPart || '0') + (fracPart ? '.'+fracPart : '');
  }
  const digits = s.replace(/[^\d]/g,'');
  return digits ? digits : '';
}
function isAllowedImageUrl(u){
  try{
    const U=new URL(u);
    const p=(U.pathname||'').toLowerCase();
    if (p.includes('captcha')) return false;
    if (!/\.(jpg|jpeg|png|gif|webp)(?:$|\?)/i.test(p)) return false;
    return true;
  }catch{ return false; }
}
function absolutizeImages(images, origin){
  const set = new Set();
  const arr = Array.isArray(images) ? images : (images ? [images] : []);
  for (const img of arr){
    const s = String(img||'').trim().replace(/^["']|["']$/g,'');
    if (!s) continue;
    const abs = isHttp(s) ? s : (origin ? toAbs(s.startsWith('/')? s : '/'+s, origin) : s);
    if (abs && isAllowedImageUrl(abs)) set.add(abs);
  }
  return [...set];
}
function isLikelyJunkProduct(p, origin){
  const t=(p.title||'').trim();
  const tl=t.toLowerCase();
  if (/\b404\b/.test(tl)) return true;
  if (/not\s*found/.test(tl)) return true;
  if (/error\s*404/.test(tl)) return true;
  const price = normalizePrice(p.price||'');
  const imgs = absolutizeImages(p.images, origin);
  if (!price && imgs.length===0) return true;
  if (t.length < 2) return true;
  return false;
}
function cleanProducts(products, origin){
  const out=[]; const seenKey=new Set();
  for (const p of products){
    if (isLikelyJunkProduct(p, origin)) continue;
    const row = {
      title: (p.title || '').trim(),
      sku: p.sku || '',
      price: normalizePrice(p.price || ''),
      description: p.description || '',
      short: '',
      category: p.category || '',
      tags: Array.isArray(p.tags) ? p.tags.join(',') : (p.tags || ''),
      images: absolutizeImages(p.images, origin)
    };
    const key = (row.sku && row.sku.trim())
      ? `sku:${row.sku.trim().toLowerCase()}`
      : `u:${(p.url||'')}/${row.title.toLowerCase()}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    out.push(row);
  }
  return out;
}
function csvEscape(v){
  const s=v==null?'':String(v);
  if(/[",\n]/.test(s)) return `"${s.replace(/"/g,'""')}"`;
  return s;
}
function writeProductsCsvRows(rows, outWoo){
  if(!rows.length) return null;
  const fp=path.join(outWoo,'woocommerce-products.csv');
  const headers=['Name','Type','SKU','Regular price','Description','Short description','Categories','Tags','Images'];
  const lines=[ headers.join(',') ];
  for(const r of rows){
    lines.push([
      csvEscape(r.title),
      'simple',
      csvEscape(r.sku),
      csvEscape(r.price),
      csvEscape(r.description),
      csvEscape(r.short),
      csvEscape(r.category),
      csvEscape(r.tags),
      csvEscape((r.images||[]).join(','))
    ].join(','));
  }
  writeTextUtf8BOM(fp, lines.join('\n')+'\n');
  return fp;
}

/* ---------- Export entry points ---------- */
async function exportWoo({ runDir, outDir }){
  const { outWoo, wxrPath, stats } = await exportWooPages({ runDir, outDir });

  let products = readProductsNdjson(runDir);
  // If this was a full mirror run (not products-only), products.ndjson may be empty; that’s fine.
  const origin = getSiteOriginFromRun(runDir);
  const rows = cleanProducts(products, origin);
  const csvPath = rows.length ? writeProductsCsvRows(rows, outWoo) : null;

  return {
    platform:'woocommerce',
    outDir: outWoo,
    pagesWxr: wxrPath,
    productsCsv: csvPath || undefined,
    stats:{ ...(stats||{}), products_input: products.length, products_csv: rows.length }
  };
}
async function exportShopify({ runDir, outDir }){
  const out=path.join(outDir,'shopify'); ensureDir(out);
  return { platform:'shopify', outDir: out };
}
async function exportRun({ runDir, outDir, platform }){
  if(!runDir||!outDir||!platform) throw new Error('exportRun: runDir, outDir, platform required');
  if(platform==='woocommerce') return exportWoo({ runDir, outDir });
  if(platform==='shopify') return exportShopify({ runDir, outDir });
  throw new Error('Unknown platform: '+platform);
}

module.exports = { exportRun };