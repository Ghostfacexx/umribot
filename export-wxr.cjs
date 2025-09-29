#!/usr/bin/env node
/**
 * export-wxr.cjs
 *
 * Converts either:
 *  - a folder of HTML files (SingleFile output), or
 *  - archiver.cjs output (has manifest.json)
 * into a WordPress WXR file with <content:encoded>.
 *
 * Key features for "make it look like the original":
 *  - WXR_INLINE_CSS=1: inline all <head> CSS (link rel=stylesheet + <style>) into content
 *  - WXR_INLINE_REMOTE_CSS=1: fetch remote CSS and inline it, fixing url() / @import to absolute URLs
 *  - WXR_INLINE_JS=1: inline <head> <script> tags (remote and inline) into content (optional)
 *  - WXR_BODY_ONLY=0 (default): export full page body (you can still target just a section via WXR_KEEP_SELECTOR)
 *  - WXR_KEEP_SELECTOR: only export a specific section (e.g., "#content") instead of the whole body
 *  - WXR_STRIP_SELECTORS: remove selectors from the exported fragment (comma-separated)
 *  - WXR_ALLOW_SCRIPT=1: keep <script> in the final content fragment (default is to allow since we inline JS only if asked)
 *
 * Usage:
 *   node export-wxr.cjs <input_dir> [outFile=wordpress-pages-wxr.xml]
 *
 * Env:
 *   WXR_PROFILE=desktop           // for archiver outputs; desktop|mobile
 *   WXR_SITE_TITLE="teashop.bg"
 *   WXR_SITE_LINK="https://teashop.bg"
 *   WXR_AUTHOR="admin"
 *   WXR_STATUS="publish"
 *   WXR_BODY_ONLY=0|1
 *   WXR_KEEP_SELECTOR="#content"  // optional: export only this section
 *   WXR_STRIP_SELECTORS="header,footer,nav" // optional: remove these before export
 *   WXR_ALLOW_SCRIPT=1            // allow scripts in content (admins with unfiltered_html required)
 *   WXR_LINK_PREFIX="https://teashop.bg" // fallback when original URL cannot be detected
 *   WXR_INLINE_CSS=1              // inline CSS from <head>
 *   WXR_INLINE_REMOTE_CSS=1       // fetch and inline remote CSS referenced by <link>
 *   WXR_INLINE_JS=0|1             // inline scripts from <head> (off by default)
 *   WXR_REMOTE_TIMEOUT_MS=15000
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const cheerio = require('cheerio');

function sha1hex(s){ return crypto.createHash('sha1').update(String(s)).digest('hex'); }
function cdataWrap(s){ return `<![CDATA[${String(s).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`; }
function nowRfc822(){ return new Date().toUTCString(); }
function escapeXml(s){
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
function safeRead(p){ try{ return fs.readFileSync(p,'utf8'); }catch{ return ''; } }
function fileExists(p){ try{ fs.accessSync(p); return true; } catch{ return false; } }

function stripOfflineShim(html){
  return String(html).replace(/<script>\s*\(\(\)=>\{try\{[^]*?__OFFLINE_FALLBACK__[^]*?\}\)\(\);\s*<\/script>/i, '');
}

function detectOriginalURLFromHTML(html){
  const src = String(html);
  let m = src.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)/i);
  if (m && m[1]) return m[1];
  m = src.match(/<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']+)/i);
  if (m && m[1]) return m[1];
  m = src.match(/<base[^>]+href=["']([^"']+)/i);
  if (m && m[1]) return m[1];
  m = src.match(/saved from url=\(?\d*\)?\s*(https?:\/\/[^\s"'<>]+)/i);
  if (m && m[1]) return m[1];
  m = src.match(/Saved from:\s*(https?:\/\/[^\s"'<>]+)/i);
  if (m && m[1]) return m[1];
  return '';
}

function extractTitle(html, fallback){
  const m = String(html).match(/<title[^>]*>([^<]*)<\/title>/i);
  if (m && m[1]) return m[1].trim();
  return fallback || 'Untitled';
}

function isLikelyHostname(s){
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s || '');
}
function guessOriginFromDirName(dir){
  const base = path.basename(dir);
  const host = base.split('-')[0];
  if (isLikelyHostname(host)) return `https://${host}`;
  return '';
}

function walkHtmlFiles(root){
  const out = [];
  (function rec(d){
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const ent of entries){
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) rec(p);
      else if (ent.isFile() && /\.(html?|xhtml)$/i.test(ent.name)) out.push(p);
    }
  })(root);
  return out.sort();
}

/* ------------ HTTP fetch helpers ------------ */
const REMOTE_TIMEOUT_MS = parseInt(process.env.WXR_REMOTE_TIMEOUT_MS||'15000',10);
function fetchText(url){
  return new Promise((resolve,reject)=>{
    try{
      const mod = url.startsWith('https:') ? https : http;
      const req = mod.get(url, { headers: { 'User-Agent':'Mozilla/5.0' }, timeout:REMOTE_TIMEOUT_MS }, (res)=>{
        if(res.statusCode>=300 && res.statusCode<400 && res.headers.location){
          // follow one redirect
          return resolve(fetchText(new URL(res.headers.location, url).toString()));
        }
        const chunks=[];
        res.on('data',c=>chunks.push(c));
        res.on('end',()=> resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error',reject);
      req.setTimeout(REMOTE_TIMEOUT_MS, ()=>{ try{req.destroy(new Error('timeout'));}catch{} });
    }catch(e){ reject(e); }
  });
}

/* ------------ CSS rewriting ------------ */
function fixCssUrls(css, cssUrl){
  const base = (()=>{ try{ return new URL(cssUrl); }catch{ return null; } })();
  if(!base) return css;

  // url(...)
  css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_,q,u)=>{
    const trimmed = u.trim();
    if (/^(data:|https?:|\/\/)/i.test(trimmed)) return `url(${trimmed})`;
    try{
      const abs = new URL(trimmed, base).toString();
      return `url(${abs})`;
    }catch{ return `url(${trimmed})`; }
  });

  // @import '...'
  css = css.replace(/@import\s+(url\()?['"]?([^'")]+)['"]?\)?/gi, (_,isUrl,u)=>{
    const trimmed = u.trim();
    if (/^(https?:|\/\/)/i.test(trimmed)) return `@import url(${trimmed})`;
    try{
      const abs = new URL(trimmed, base).toString();
      return `@import url(${abs})`;
    }catch{ return `@import url(${trimmed})`; }
  });

  return css;
}

/* ------------ Head extraction & inlining ------------ */
async function extractHeadAssets(html, baseUrl, opts){
  const { inlineCss, inlineRemoteCss, inlineJs } = opts;
  if (!inlineCss && !inlineJs) return { cssText:'', jsText:'' };

  const $ = cheerio.load(html, { decodeEntities:false });
  let cssParts = [];
  let jsParts  = [];

  if (inlineCss){
    // Inline <style> from head
    $('head style').each((_,el)=>{
      const t = $(el).html() || '';
      if (t.trim()) cssParts.push(t);
    });

    // Fetch and inline <link rel=stylesheet>
    if (inlineRemoteCss){
      const links = $('head link[rel~="stylesheet"][href]');
      for (let i=0;i<links.length;i++){
        const el = links[i];
        const href = $(el).attr('href');
        if (!href) continue;
        try{
          const abs = new URL(href, baseUrl).toString();
          const text = await fetchText(abs).catch(()=> '');
          if (text){
            cssParts.push(fixCssUrls(text, abs));
          }
        }catch{ /* skip */ }
      }
    }
  }

  if (inlineJs){
    // Inline <script> from head (src and inline)
    const scripts = $('head script');
    for (let i=0;i<scripts.length;i++){
      const el = scripts[i];
      const src = $(el).attr('src');
      if (src){
        try{
          const abs = new URL(src, baseUrl).toString();
          const text = await fetchText(abs).catch(()=> '');
          if (text) jsParts.push(text);
        }catch{ /* skip */ }
      } else {
        const t = $(el).html() || '';
        if (t.trim()) jsParts.push(t);
      }
    }
  }

  const cssText = cssParts.length ? `<style>\n${cssParts.join('\n')}\n</style>\n` : '';
  const jsText  = jsParts.length  ? `<script>\n${jsParts.join('\n')}\n</script>\n` : '';
  return { cssText, jsText };
}

/* ------------ Content processing ------------ */
function buildFragment(html, opts){
  // Start from full document so selectors resolve
  const $ = cheerio.load(html, { decodeEntities:false });

  let fragmentHtml;
  if (opts.keepSelector){
    const node = $(opts.keepSelector).first();
    fragmentHtml = node.length ? $(node).html() || '' : $('body').html() || $.html();
  } else if (opts.bodyOnly){
    fragmentHtml = $('body').html() || $.html();
  } else {
    fragmentHtml = $('body').html() || $.html();
  }

  // Load fragment to safely strip
  const WRAP_ID='__wxr_root__';
  const $frag = cheerio.load(`<div id="${WRAP_ID}">${fragmentHtml}</div>`, { decodeEntities:false });

  // Optional stripping
  if (opts.stripSelectors && opts.stripSelectors.length){
    try { $frag(opts.stripSelectors.join(',')).remove(); } catch {}
  }

  // If scripts are not allowed, remove them (we will inject our inlined head JS later if requested)
  if (!opts.allowScript){
    $frag('script').remove();
  }

  return $frag(`#${WRAP_ID}`).html() || fragmentHtml;
}

function buildHeader(siteTitle, siteLink, pubDate){
  return [
    '<?xml version="1.0" encoding="UTF-8" ?>',
    '<rss version="2.0"',
    '  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"',
    '  xmlns:content="http://purl.org/rss/1.0/modules/content/"',
    '  xmlns:wfw="http://wellformedweb.org/CommentAPI/"',
    '  xmlns:dc="http://purl.org/dc/elements/1.1/"',
    '  xmlns:wp="http://wordpress.org/export/1.2/">',
    '  <channel>',
    `    <title>${escapeXml(siteTitle)}</title>`,
    `    <link>${escapeXml(siteLink)}</link>`,
    '    <description>WXR export</description>',
    `    <pubDate>${pubDate}</pubDate>`,
    '    <wp:wxr_version>1.2</wp:wxr_version>',
    ''
  ].join('\n');
}
function buildFooter(){ return '  </channel>\n</rss>\n'; }

function makeItemXML({ title, link, pubDate, author, guid, content, status }){
  return [
    '  <item>',
    `    <title>${escapeXml(title)}</title>`,
    `    <link>${escapeXml(link || '')}</link>`,
    `    <pubDate>${pubDate}</pubDate>`,
    `    <dc:creator>${cdataWrap(author)}</dc:creator>`,
    `    <guid isPermaLink="false">${escapeXml(guid)}</guid>`,
    '    <description></description>',
    `    <content:encoded>${cdataWrap(content)}</content:encoded>`,
    '    <wp:post_type>page</wp:post_type>',
    `    <wp:status>${escapeXml(status)}</wp:status>`,
    '  </item>',
    ''
  ].join('\n');
}

async function processOneDoc(htmlRaw, sourcePathOrUrl, opts){
  const html = stripOfflineShim(htmlRaw);
  const baseUrl = (()=>{ try{
    const fromHtml = detectOriginalURLFromHTML(htmlRaw);
    if (fromHtml) return new URL(fromHtml).origin + '/';
    if (/^https?:\/\//i.test(sourcePathOrUrl)) return new URL(sourcePathOrUrl).origin + '/';
    return '';
  }catch{ return ''; } })();

  // Build the main fragment first (body or a section)
  let fragment = buildFragment(html, opts);

  // Collect and inline head assets, then prepend them to fragment
  const head = await extractHeadAssets(html, baseUrl||sourcePathOrUrl, {
    inlineCss: !!opts.inlineCss,
    inlineRemoteCss: !!opts.inlineRemoteCss,
    inlineJs: !!opts.inlineJs
  });

  // Order: CSS first, then fragment, then JS (so DOM exists)
  let final = '';
  if (head.cssText) final += head.cssText;
  final += fragment;
  if (opts.allowScript && head.jsText) final += '\n' + head.jsText;

  return final;
}

/* ------------ Main ------------ */
async function main(){
  const inputDir = process.argv[2];
  const outFile  = process.argv[3] || 'wordpress-pages-wxr.xml';
  if (!inputDir){
    console.error('Usage: node export-wxr.cjs <input_dir> [outFile=wordpress-pages-wxr.xml]');
    process.exit(1);
  }

  const WXR_PROFILE = (process.env.WXR_PROFILE || 'desktop').trim();
  const BODY_ONLY   = !!(process.env.WXR_BODY_ONLY && !/^0|false|no$/i.test(process.env.WXR_BODY_ONLY));
  const KEEP_SEL    = (process.env.WXR_KEEP_SELECTOR || '').trim();
  const STRIP_SEL   = (process.env.WXR_STRIP_SELECTORS || '').split(',').map(s=>s.trim()).filter(Boolean);
  const ALLOW_SCRIPT= !!(process.env.WXR_ALLOW_SCRIPT && !/^0|false|no$/i.test(process.env.WXR_ALLOW_SCRIPT));
  const INLINE_CSS  = !!(process.env.WXR_INLINE_CSS && !/^0|false|no$/i.test(process.env.WXR_INLINE_CSS));
  const INLINE_REMOTE_CSS = !!(process.env.WXR_INLINE_REMOTE_CSS && !/^0|false|no$/i.test(process.env.WXR_INLINE_REMOTE_CSS));
  const INLINE_JS   = !!(process.env.WXR_INLINE_JS && !/^0|false|no$/i.test(process.env.WXR_INLINE_JS));

  const AUTHOR      = process.env.WXR_AUTHOR || 'admin';
  const STATUS      = process.env.WXR_STATUS || 'publish';
  const LINK_PREFIX = process.env.WXR_LINK_PREFIX || '';
  let SITE_TITLE    = process.env.WXR_SITE_TITLE || '';
  let SITE_LINK     = process.env.WXR_SITE_LINK  || '';

  const pubDate = nowRfc822();
  const manifestPath = path.join(inputDir, 'manifest.json');
  const items = [];

  const opts = {
    bodyOnly: BODY_ONLY,
    keepSelector: KEEP_SEL,
    stripSelectors: STRIP_SEL,
    allowScript: ALLOW_SCRIPT || INLINE_JS, // if we inline JS, allow scripts
    inlineCss: INLINE_CSS,
    inlineRemoteCss: INLINE_REMOTE_CSS,
    inlineJs: INLINE_JS
  };

  if (fileExists(manifestPath)){
    const manifest = JSON.parse(fs.readFileSync(manifestPath,'utf8'));
    const recs = manifest.filter(r => r && r.profile === WXR_PROFILE && /^ok/.test(String(r.status||'')));
    if (!recs.length) { console.error('No successful records for profile:', WXR_PROFILE); process.exit(3); }

    if (!SITE_LINK || !SITE_TITLE){
      try { const u = new URL(recs[0].url); SITE_LINK = SITE_LINK || u.origin; SITE_TITLE = SITE_TITLE || u.hostname; } catch {}
    }

    for (const r of recs){
      const rel = (r.relPath || '').replace(/^\/+/, '');
      const htmlPath = path.join(inputDir, rel ? rel : '', r.profile, 'index.html');
      const htmlRaw = safeRead(htmlPath);
      if (!htmlRaw) continue;

      const content = await processOneDoc(htmlRaw, r.url || r.finalURL || LINK_PREFIX, opts);
      const title = extractTitle(htmlRaw, r.url);
      let link = detectOriginalURLFromHTML(htmlRaw) || r.url || r.finalURL || '';
      if (!link && LINK_PREFIX) link = LINK_PREFIX;

      const guid = 'imported-' + sha1hex(link || (rel || title || htmlPath));
      items.push(makeItemXML({ title, link, pubDate, author:AUTHOR, guid, content, status:STATUS }));
    }
  } else {
    const files = walkHtmlFiles(inputDir);
    if (!files.length){ console.error('No HTML files found in', inputDir); process.exit(4); }

    if (!SITE_LINK){ SITE_LINK = guessOriginFromDirName(inputDir) || LINK_PREFIX || 'https://example.com'; }
    if (!SITE_TITLE){ try { SITE_TITLE = new URL(SITE_LINK).hostname; } catch { SITE_TITLE = 'WXR export'; } }

    for (const p of files){
      const htmlRaw = safeRead(p);
      if (!htmlRaw) continue;

      const sourceUrl = detectOriginalURLFromHTML(htmlRaw) || LINK_PREFIX || SITE_LINK;
      const content = await processOneDoc(htmlRaw, sourceUrl, opts);
      const title = extractTitle(htmlRaw, path.basename(p));
      let link = detectOriginalURLFromHTML(htmlRaw) || '';
      if (!link){
        const rel = path.relative(inputDir, p).replace(/\\/g,'/').replace(/index\.html?$/i,'');
        if (LINK_PREFIX) link = LINK_PREFIX.replace(/\/+$/,'') + '/' + rel;
        else if (SITE_LINK) link = SITE_LINK.replace(/\/+$/,'') + '/' + rel;
      }

      const guid = 'imported-' + sha1hex(link || p);
      items.push(makeItemXML({ title, link, pubDate, author:AUTHOR, guid, content, status:STATUS }));
    }
  }

  const xml = [ buildHeader(SITE_TITLE, SITE_LINK, pubDate), ...items, buildFooter() ].join('\n');
  fs.writeFileSync(path.resolve(process.cwd(), outFile), xml, 'utf8');
  console.log('[WXR_WRITE]', outFile, 'items=', items.length);
}

main();