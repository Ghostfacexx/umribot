#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs-extra');
const path = require('path');
const cheerio = require('cheerio');
const { XMLParser } = require('fast-xml-parser');

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : def; }

(async () => {
  const inPath  = path.resolve(arg('in', 'dist/pages/pages.wxr'));
  const outPath = path.resolve(arg('out', 'scripts/pages.json'));
  const theme   = arg('theme', 'teashop-mirror');
  const origin  = (arg('origin', 'https://teashop.bg')).replace(/\/+$/, '');

  if (!(await fs.pathExists(inPath))) {
    console.error('WXR not found at', inPath);
    process.exit(1);
  }

  const xml = await fs.readFile(inPath, 'utf8');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' , textNodeName: 'text'});
  const doc = parser.parse(xml);

  const channel = doc?.rss?.channel;
  if (!channel) { console.error('Invalid WXR: missing channel'); process.exit(1); }
  const items = Array.isArray(channel.item) ? channel.item : [channel.item].filter(Boolean);

  const out = [];
  for (const it of items) {
    const title = it.title ?? '';
    const slug  = it['wp:post_name'] ?? safeSlug(title);
    const isFrontPage = (slug === 'teashop-bg') || /магазин за чай/i.test(String(title));

    // content:encoded is namespaced; depending on parser it may be under 'content:encoded' or 'content'
    const rawContent = it['content:encoded'] ?? it.content ?? '';

    // Fix HTML: rewrite images to mirrored theme path, decode q/route links
    const contentHtml = await fixHtml(String(rawContent), {
      origin,
      theme,
      localThemePrefix: `/wp-content/themes/${theme}/assets/mirror/teashop.bg/`
    });

    out.push({
      title: String(title || slug),
      slug: String(slug || safeSlug(title)),
      isFrontPage,
      menuOrder: 0,
      originUrl: it.link || '',
      contentHtml
    });
  }

  await fs.ensureDir(path.dirname(outPath));
  await fs.writeJson(outPath, out, { spaces: 2 });
  console.log('[ok] wrote', outPath, 'pages:', out.length);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

function safeSlug(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[^\w\s-]/g, '')
    .trim().replace(/\s+/g, '-')
    || 'page';
}

async function fixHtml(html, ctx) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // img[src] → theme mirror
  $('img[src]').each((_, el) => {
    const src = $(el).attr('src') || '';
    const fixed = mapImg(src, ctx);
    if (fixed) $(el).attr('src', fixed);
  });
  // srcset
  $('img[srcset], source[srcset]').each((_, el) => {
    const val = $(el).attr('srcset') || '';
    const parts = val.split(',').map(s => s.trim()).filter(Boolean);
    const out = [];
    for (const part of parts) {
      const m = part.match(/^(\S+)(\s+\S+)?$/);
      if (!m) continue;
      const fixed = mapImg(m[1], ctx);
      out.push(`${fixed || m[1]}${m[2] || ''}`);
    }
    if (out.length) $(el).attr('srcset', out.join(', '));
  });

  // anchors: decode SingleFile q/route and normalize teashop links (best-effort)
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    const fixed = mapHref(href, ctx);
    if (fixed) $(el).attr('href', fixed);
  });

  // Remove stray <i><span>f0d7</span></i> tokens (SingleFile leftovers)
  $('i.fa > span, i.glyphicon > span').remove();

  return $.root().html() || html;
}

function mapImg(url, { origin, localThemePrefix }) {
  try {
    // Absolute teashop.bg/image/... → local theme mirror
    if (/^https?:\/\/[^/]*teashop\.bg\/image\//i.test(url)) {
      return url.replace(/^https?:\/\/[^/]*teashop\.bg\/image\//i, `${localThemePrefix}image/`);
    }
    // Root-relative /image/... → local theme mirror
    if (/^\/image\//i.test(url)) {
      return url.replace(/^\/image\//i, `${localThemePrefix}image/`);
    }
    // Absolute teashop.bg/catalog/... (flags, logo)
    if (/^https?:\/\/[^/]*teashop\.bg\/catalog\//i.test(url)) {
      return url.replace(/^https?:\/\/[^/]*teashop\.bg\/catalog\//i, `${localThemePrefix}catalog/`);
    }
    return '';
  } catch { return ''; }
}

function mapHref(href, { origin }) {
  try {
    // Already local or hash/mailto/tel – leave
    if (/^(\/|#|mailto:|tel:)/i.test(href)) return '';

    // Decode SingleFile q/route → canonical route
    const decoded = decodeQRoute(href, origin);
    if (decoded) return normalizeLocal(decoded, origin);

    // teashop absolute → try to normalize to a local relative
    if (/^https?:\/\/[^/]*teashop\.bg/i.test(href)) {
      return normalizeLocal(href, origin);
    }

    return '';
  } catch { return ''; }
}

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
  } catch { return ''; }
}

// Convert known teashop routes to local slugs (best-effort)
function normalizeLocal(absUrl, origin) {
  try {
    const u = new URL(absUrl, origin);
    // Known categories map: path=59 → /category-59/
    if (u.searchParams.get('route') === 'product/category' && u.searchParams.get('path')) {
      return `/category-${u.searchParams.get('path')}/`;
    }
    // Home
    if (u.pathname === '/' || (u.pathname.endsWith('/index.php') && u.searchParams.get('route') === 'common/home')) {
      return '/';
    }
    // Raw path passthrough like /desktops
    if (!u.search) return u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
    return ''; // leave unknowns as-is
  } catch { return ''; }
}
