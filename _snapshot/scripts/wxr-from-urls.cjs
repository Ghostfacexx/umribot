#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs-extra');
const path = require('path');
const cheerio = require('cheerio');
const fetch = require('node-fetch');
const he = require('he');
const slugify = require('slugify');
const { v4: uuidv4 } = require('uuid');

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : def; }

(async () => {
  const cfgPath = arg('config', 'scripts/wxr.config.json');
  const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));

  // Output dirs
  const pagesDir = path.resolve(cfg.output.pagesDir || 'dist/pages');
  await fs.ensureDir(pagesDir);

  const themeSlug = cfg.site.themeSlug || 'teashop-mirror';
  const themeOutDir = path.resolve('dist/theme', themeSlug);
  const assetsBaseRel = path.posix.join('assets', 'mirror');
  const assetsBaseAbs = path.join(themeOutDir, assetsBaseRel);
  await fs.ensureDir(assetsBaseAbs);

  const cssManifest = [];
  const cssSeen = new Set();

  // Build a rich link map: many aliases -> local /slug/
  const linkMap = new Map();
  const origin = cfg.site.origin.replace(/\/+$/, '');
  let aliasesAdded = 0;

  for (const p of cfg.pages) {
    const slug = p.slug || makeSlugFromUrlOrTitle(p.url, p.title);
    const target = p.isFrontPage ? '/' : `/${slug}/`;

    for (const alias of makeAliasesForUrl(origin, p.url)) {
      const key = normalizeUrl(alias);
      if (!linkMap.has(key)) {
        linkMap.set(key, target);
        aliasesAdded++;
      }
    }
  }

  // Optional manual overrides (array of {from: "...", toSlug: "desktops"})
  if (Array.isArray(cfg.linkOverrides)) {
    for (const ov of cfg.linkOverrides) {
      const to = ov.toSlug === '/' ? '/' : `/${ov.toSlug.replace(/^\/|\/$/g, '')}/`;
      for (const a of makeAliasesForUrl(origin, ov.from)) {
        const key = normalizeUrl(a);
        if (!linkMap.has(key)) { linkMap.set(key, to); aliasesAdded++; }
      }
    }
  }

  console.log(`[map] link aliases registered: ${aliasesAdded}`);

  const items = [];
  for (let i = 0; i < cfg.pages.length; i++) {
    const p = cfg.pages[i];
    const mode = (p.mode || cfg.defaults?.mode || 'capture').toLowerCase();
    const selector = p.selector || (p.isFrontPage ? 'body' : (cfg.defaults?.selector || 'body'));
    const removeExternalLibs = cfg.defaults?.removeExternalLibs ?? false;

    console.log(`[${mode}] ${i + 1}/${cfg.pages.length} ${p.url}`);

    if (mode !== 'capture') {
      items.push({
        title: p.title || p.url,
        slug: p.slug || makeSlugFromUrlOrTitle(p.url, p.title),
        content: linkBody(p.url)
      });
      continue;
    }

    // Fetch page HTML
    const res = await fetch(p.url, {
      timeout: 60000,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml;q=0.9'
      }
    });
    if (!res.ok) {
      console.warn('[warn] HTTP', res.status, p.url);
      items.push({
        title: p.title || p.url,
        slug: p.slug || makeSlugFromUrlOrTitle(p.url, p.title),
        content: linkBody(p.url)
      });
      continue;
    }

    const html = await res.text();
    const $ = cheerio.load(html, { decodeEntities: false });

    // Mirror site CSS on this page (collect <link rel="stylesheet">)
    if (cfg.assets?.includeSiteCSS) {
      const links = $('link[rel="stylesheet"]');
      await Promise.all(links.toArray().map(async el => {
        const href = $(el).attr('href');
        if (!href) return;
        const abs = safeAbs(href, p.url);
        if (!abs) return;
        const savedRel = await mirrorAsset(abs, assetsBaseAbs, assetsBaseRel);
        if (savedRel && !cssSeen.has(savedRel)) {
          cssSeen.add(savedRel);
          cssManifest.push(savedRel);
        }
      }));
    }

    // Extract content region
    let node = $('body');
    if (selector && $(selector).length) node = $(selector).first();
    let content = node.html() || '';

    // Optional: strip styles/scripts left inside fragment
    if (removeExternalLibs) {
      const $frag = cheerio.load(content, { decodeEntities: false });
      $frag('link[rel=stylesheet], script[src]').remove();
      content = $frag.root().html() || content;
    }

    // Mirror images in fragment and rewrite src/srcset to theme paths
    if (cfg.assets?.downloadImages) {
      content = await rewriteImages(content, p.url, assetsBaseAbs, assetsBaseRel, themeSlug);
    }

    // Rewrite anchors:
    // - normalize exact URLs
    // - decode SingleFile q/route (index.php/q/route/...) back to route form and map
    content = rewriteAnchors(content, origin, linkMap);

    // Clean stray FA tokens baked as <i><span>f0d7</span></i>
    const $clean = cheerio.load(content, { decodeEntities: false });
    $clean('i.fa > span, i.glyphicon > span').remove();
    content = $clean.root().html() || content;

    items.push({
      title: p.title || p.url,
      slug: p.slug || makeSlugFromUrlOrTitle(p.url, p.title),
      content
    });
  }

  // Write manifest + loader for CSS
  await fs.ensureDir(themeOutDir);
  await fs.writeJson(path.join(themeOutDir, 'assets-mirror-manifest.json'), { css: cssManifest }, { spaces: 2 });
  await fs.writeFile(path.join(themeOutDir, 'mirror-styles.php'), mirrorStylesPhp(), 'utf8');

  // Write WXR
  const wxrPath = path.join(pagesDir, 'pages.wxr');
  await fs.writeFile(wxrPath, buildWXR(cfg, items), 'utf8');

  console.log(`\n[ok] wrote ${wxrPath}`);
  console.log(`[ok] theme mirror assets at ${themeOutDir}`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

/* ---------- helpers ---------- */

function safeAbs(urlOrPath, base) { try { return new URL(urlOrPath, base).toString(); } catch { return ''; } }

/**
 * Given origin and a "known" page URL, create many aliases that might appear in captured HTML:
 * - the URL itself (normalized)
 * - route form (index.php?route=...)
 * - SingleFile q/route form (index.php/q/route/<enc(route)>/k/v/)
 * - trailing slash variants where applicable
 */
function makeAliasesForUrl(origin, url) {
  const out = new Set();
  try {
    const u = new URL(url, origin);
    u.hash = '';
    out.add(u.toString());
    // trailing-slash variants
    const u2 = new URL(u.toString());
    if (!/index\.php/.test(u2.pathname)) {
      if (!u2.pathname.endsWith('/')) { u2.pathname += '/'; out.add(u2.toString()); }
    }

    // If it's route form, add q/route alias
    const route = u.searchParams.get('route');
    if (route) {
      // canonical route URL
      const canon = new URL(origin + '/index.php');
      canon.searchParams.set('route', route);
      for (const [k, v] of u.searchParams.entries()) {
        if (k !== 'route') canon.searchParams.set(k, v);
      }
      out.add(canon.toString());

      // q/route alias as SingleFile emits inside HTML
      const qr = new URL(origin + '/index.php');
      let qp = '/q/route/' + encodeURIComponent(route) + '/';
      for (const [k, v] of u.searchParams.entries()) {
        if (k === 'route') continue;
        qp += `${encodeURIComponent(k)}/${encodeURIComponent(v)}/`;
      }
      qr.pathname += qp;
      out.add(qr.toString());
      // with/without trailing slash already covered
    }
  } catch { /* ignore */ }
  return Array.from(out);
}

async function mirrorAsset(absUrl, assetsBaseAbs, assetsBaseRel) {
  try {
    const u = new URL(absUrl);
    const cleanPath = u.pathname.replace(/^\/+/, '');
    const rel = path.posix.join(assetsBaseRel, u.hostname, cleanPath);
    const out = path.join(assetsBaseAbs, u.hostname, cleanPath);
    await fs.ensureDir(path.dirname(out));
    if (!(await fs.pathExists(out))) {
      const r = await fetch(absUrl, { timeout: 60000 });
      if (!r.ok) return '';
      const buf = await r.buffer();
      await fs.writeFile(out, buf);
    }
    return rel;
  } catch { return ''; }
}

async function rewriteImages(html, pageUrl, assetsBaseAbs, assetsBaseRel, themeSlug) {
  const $ = cheerio.load(html, { decodeEntities: false });

  const rewriteSrc = async (el, attr) => {
    const src = $(el).attr(attr); if (!src) return;
    const abs = safeAbs(src, pageUrl); if (!abs) return;
    const rel = await mirrorAsset(abs, assetsBaseAbs, assetsBaseRel);
    if (rel) $(el).attr(attr, `/${path.posix.join('wp-content/themes', themeSlug, rel)}`);
  };

  for (const el of $('img[src]').toArray()) { await rewriteSrc(el, 'src'); }

  // srcset
  for (const el of $('img[srcset], source[srcset]').toArray()) {
    const val = $(el).attr('srcset'); if (!val) continue;
    const parts = val.split(',').map(s => s.trim());
    const out = [];
    for (const part of parts) {
      const m = part.match(/^(\S+)(\s+\S+)?$/); if (!m) continue;
      const abs = safeAbs(m[1], pageUrl);
      const rel = abs ? await mirrorAsset(abs, assetsBaseAbs, assetsBaseRel) : '';
      if (rel) out.push(`/${path.posix.join('wp-content/themes', themeSlug, rel)}${m[2] || ''}`);
    }
    if (out.length) $(el).attr('srcset', out.join(', '));
  }

  return $.root().html() || html;
}

/**
 * Rewrite anchors to local slugs when possible.
 * - Check raw normalized URL key
 * - If path is /index.php/q/route/... decode to canonical route URL and check again
 */
function rewriteAnchors(html, origin, linkMap) {
  try {
    const $ = cheerio.load(html, { decodeEntities: false });

    $('a[href]').each((_, el) => {
      const href = ($(el).attr('href') || '').trim();
      if (!href) return;

      // absolutize against origin
      let abs;
      try { abs = new URL(href, origin).toString(); } catch { return; }

      // try direct lookup
      let key = normalizeUrl(abs);
      if (linkMap.has(key)) {
        $(el).attr('href', linkMap.get(key));
        return;
      }

      // try q/route decode ? canonical route form
      const decoded = decodeQRoute(abs, origin);
      if (decoded) {
        key = normalizeUrl(decoded);
        if (linkMap.has(key)) {
          $(el).attr('href', linkMap.get(key));
          return;
        }
      }
      // leave untouched if we don't know it
    });

    return $.root().html() || html;
  } catch {
    return html;
  }
}

/**
 * Convert SingleFile path like:
 *   https://site/index.php/q/route/product%2Fcategory/path/59/
 * back into:
 *   https://site/index.php?route=product/category&path=59
 */
function decodeQRoute(urlStr, origin) {
  try {
    const u = new URL(urlStr, origin);
    const m = u.pathname.match(/\/index\.php\/q\/route\/([^/]+)\/(.*)$/);
    if (!m) return '';
    const route = decodeURIComponent(m[1]);
    const rest = m[2] || '';
    const parts = rest.split('/').filter(Boolean);
    const canon = new URL(origin + '/index.php');
    canon.searchParams.set('route', route);
    for (let i = 0; i < parts.length; i += 2) {
      const k = decodeURIComponent(parts[i] || '');
      const v = decodeURIComponent(parts[i + 1] || '');
      if (k) canon.searchParams.set(k, v);
    }
    return canon.toString();
  } catch {
    return '';
  }
}

function linkBody(url) { return `<p><a href="${he.encode(url)}" rel="noopener" target="_blank">${he.encode(url)}</a></p>`; }

function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','fbclid'].forEach(k => x.searchParams.delete(k));
    // unify trailing slash for non-file paths
    if (!x.pathname.match(/\.[a-z0-9]+$/i) && !x.pathname.endsWith('/')) x.pathname += '/';
    return x.toString().replace(/\/+$/, '');
  } catch { return u; }
}

function makeSlugFromUrlOrTitle(url, title) {
  if (title) return slugify(title, { lower: true, strict: true });
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean);
    const raw = segs[segs.length - 1] || 'page';
    return slugify(decodeURIComponent(raw), { lower: true, strict: true }) || 'page';
  } catch { return slugify(url, { lower: true, strict: true }).slice(0, 40) || 'page'; }
}

function buildWXR(cfg, items) {
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
  const itemsXML = items.map((p, i) => {
    const id = 1000 + i;
    const title = he.encode(p.title || '');
    const slug = p.slug || `page-${id}`;
    const content = `<![CDATA[${p.content}]]>`;
    return `
  <item>
    <title>${title}</title>
    <link>${cfg.site.origin}/${encodeURI(slug)}/</link>
    <pubDate>${new Date().toUTCString()}</pubDate>
    <dc:creator><![CDATA[admin]]></dc:creator>
    <guid isPermaLink="false">${uuidv4()}</guid>
    <description></description>
    <content:encoded>${content}</content:encoded>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <wp:post_id>${id}</wp:post_id>
    <wp:post_date>${now}</wp:post_date>
    <wp:post_date_gmt>${now}</wp:post_date_gmt>
    <wp:comment_status>closed</wp:comment_status>
    <wp:ping_status>closed</wp:ping_status>
    <wp:post_name>${slug}</wp:post_name>
    <wp:status>publish</wp:status>
    <wp:post_parent>0</wp:post_parent>
    <wp:menu_order>${i}</wp:menu_order>
    <wp:post_type>page</wp:post_type>
    <wp:is_sticky>0</wp:is_sticky>
  </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0"
 xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
 xmlns:content="http://purl.org/rss/1.0/modules/content/"
 xmlns:wfw="http://wellformedweb.org/CommentAPI/"
 xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:wp="http://wordpress.org/export/1.2/"
>
<channel>
  <title>${he.encode(cfg.site.brand || 'Mirror')}</title>
  <link>${cfg.site.origin}</link>
  <description>Exported by WXR generator (asset-aware, explicit OpenCart link mapping)</description>
  <pubDate>${new Date().toUTCString()}</pubDate>
  <language>bg</language>
  <wp:wxr_version>1.2</wp:wxr_version>
  <wp:base_site_url>${cfg.site.origin}</wp:base_site_url>
  <wp:base_blog_url>${cfg.site.origin}</wp:base_blog_url>
${itemsXML}
</channel>
</rss>`;
}

function mirrorStylesPhp() {
  return `<?php
if (!defined('ABSPATH')) exit;
/**
 * Enqueue mirrored site CSS in the order they were discovered.
 * Expects assets-mirror-manifest.json and assets/mirror/... inside this theme.
 */
add_action('wp_enqueue_scripts', function () {
  $theme_dir = get_stylesheet_directory();
  $theme_uri = get_stylesheet_directory_uri();
  $manifest  = $theme_dir . '/assets-mirror-manifest.json';
  if (!file_exists($manifest)) return;
  $data = json_decode(file_get_contents($manifest), true);
  if (!is_array($data) || empty($data['css'])) return;
  $i = 0;
  foreach ($data['css'] as $rel) {
    $rel = ltrim($rel, '/');
    $handle = 'mirror-css-' . (++$i);
    wp_enqueue_style($handle, $theme_uri . '/' . $rel, [], null);
  }
}, 35);
`;
}