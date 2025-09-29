#!/usr/bin/env node
/**
 * Export PAGES (non-product content) to WXR from mirrored HTML using folder paths.
 *
 * Path-hierarchy mode:
 * - Each index.html is treated as a distinct page keyed by its relative folder.
 * - The WordPress page hierarchy mirrors the folder hierarchy.
 * - Root, "index", and "index.html" are unified to a single "home" page.
 *
 * Example:
 *   node wc-export-pages-wxr.cjs \
 *     --in downloaded_pages/teashop.bg-... \
 *     --out out/pages.wxr \
 *     --map wc-pages-mapping.json \
 *     --base-url https://teashop.bg/ \
 *     --site-url https://your-wordpress-site.example \
 *     --author admin \
 *     --prefer-profile desktop \
 *     --dedupe rel \
 *     --path-hierarchy \
 *     --slug-source key \
 *     --home-title "??????" \
 *     --allow-title-only \
 *     --verbose
 *
 * Flags:
 *   --path-hierarchy        Build parent/child from folder segments (recommended)
 *   --prefer-profile        desktop|mobile (default: none)
 *   --dedupe                rel|canonical|both|none (default: rel)
 *   --include-path-regex    Only include keys matching this JS RegExp (e.g. "^(about_us|delivery|privacy|terms|smartphone|desktops|home)$")
 *   --exclude-path-regex    Exclude keys matching this JS RegExp
 *   --slug-source           title|key (default: title). key uses folder key for slugs.
 *   --home-title            Override title for the home page
 *   --allow-title-only      Keep pages with title even if content is empty
 *   --include-products      Do not skip product pages
 *   --verbose               Log details
 *
 * Requirements: npm i cheerio
 */
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const cheerio = require('cheerio');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[k] = v;
    }
  }
  return args;
}
const args = parseArgs(process.argv);
const INPUT = args.in || args.input;
const OUT = args.out || args.output || 'out/pages.wxr';
const MAP_PATH = args.map || 'wc-pages-mapping.json';
const BASE_URL = args['base-url'] || args.base || '';
const SITE_URL = (args['site-url'] || 'https://example.com').replace(/\/+$/, '');
const AUTHOR = args.author || 'admin';
const INCLUDE_PRODUCTS = Boolean(args['include-products']);
const VERBOSE = Boolean(args.verbose);
const PREFER_PROFILE = (args['prefer-profile'] || '').toLowerCase(); // '', 'desktop', 'mobile'
const DEDUPE = (args['dedupe'] || 'rel').toLowerCase(); // rel|canonical|both|none
const ALLOW_TITLE_ONLY = Boolean(args['allow-title-only']);
const PATH_HIERARCHY = Boolean(args['path-hierarchy']);
const SLUG_SOURCE = (args['slug-source'] || 'title').toLowerCase(); // 'title' | 'key'
const HOME_TITLE = args['home-title'] || '';

const includeRe = args['include-path-regex'] ? new RegExp(args['include-path-regex']) : null;
const excludeRe = args['exclude-path-regex'] ? new RegExp(args['exclude-path-regex']) : null;

if (!INPUT) {
  console.error('Error: --in <file-or-dir> is required');
  process.exit(1);
}
if (!fs.existsSync(MAP_PATH)) {
  console.error(`Error: mapping file not found at ${MAP_PATH}`);
  process.exit(1);
}

// ---------- utils ----------
function walkHtmlFiles(root) {
  const list = [];
  function recur(p) {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const c of fs.readdirSync(p)) recur(path.join(p, c));
    } else if (st.isFile()) {
      const ext = path.extname(p).toLowerCase();
      if (ext === '.html' || ext === '.htm') list.push(p);
    }
  }
  const st = fs.statSync(root);
  if (st.isFile()) return [root];
  recur(root);
  return list;
}
function xmlEscape(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function cdata(s) {
  if (s == null) return '<![CDATA[]]>';
  return `<![CDATA[${String(s).replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}
function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 200) || 'page';
}
function absolutize(urlStr, baseUrl) {
  if (!urlStr) return '';
  try { return new URL(urlStr).toString(); }
  catch { try { return new URL(urlStr, baseUrl).toString(); } catch { return urlStr; } }
}
function normalizeSpaces(s) { return s ? s.replace(/\s+/g, ' ').trim() : ''; }
function loadMapping(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

// Select first element text
function selectText($, selector) {
  if (!selector) return '';
  for (const part of selector.split('||').map(s => s.trim()).filter(Boolean)) {
    const at = part.lastIndexOf('@');
    if (at > 0) {
      const sel = part.slice(0, at).trim();
      const attr = part.slice(at + 1).trim();
      const el = $(sel).first();
      if (el && el.length) {
        const v = attr === 'text' ? el.text() : el.attr(attr);
        if (v != null && String(v).trim()) return String(v).trim();
      }
    } else {
      const el = $(part).first();
      if (el && el.length) {
        const v = el.text();
        if (v != null && String(v).trim()) return String(v).trim();
      }
    }
  }
  return '';
}
// Select first element inner HTML
function selectHtml($, selector) {
  if (!selector) return '';
  for (const part of selector.split('||').map(s => s.trim()).filter(Boolean)) {
    const at = part.lastIndexOf('@');
    if (at > 0) {
      const sel = part.slice(0, at).trim();
      const attr = part.slice(at + 1).trim();
      const el = $(sel).first();
      if (el && el.length) {
        const v = attr === 'html' ? el.html() : (attr === 'text' ? el.text() : el.attr(attr));
        if (v != null && String(v).trim()) return String(v).trim();
      }
    } else {
      const el = $(part).first();
      if (el && el.length) {
        const v = el.html();
        if (v != null && String(v).trim()) return v;
      }
    }
  }
  return '';
}

// Product detection (Woo + OpenCart)
function isLikelyProduct($) {
  const wc = (
    $('.single-product').length ||
    $('.woocommerce div.product').length ||
    $('meta[property="product:price:amount"]').length
  );
  const oc = (
    $('form#product').length ||
    $('#button-cart').length ||
    $('div#product').length ||
    $('meta[property="og:type"][content*="product"]').length ||
    $('[itemtype*="Product"]').length ||
    /"@type"\s*:\s*"Product"/i.test(
      $('script[type="application/ld+json"]').map((_,el)=>$(el).text()).get().join('\n')
    )
  );
  return Boolean(wc || oc);
}

// Path-based key helpers
function relKeyForFile(absFile) {
  // Normalize a file path to a key like "about_us" or "category/sub"
  let rel = path.relative(INPUT, absFile).replace(/\\/g, '/');

  // Strip desktop/mobile index.html
  rel = rel.replace(/\/(desktop|mobile)\/index\.html$/i, '');

  // Strip trailing /index.html anywhere
  rel = rel.replace(/\/index\.html$/i, '');

  // Handle root index.html (no leading slash)
  if (rel === 'index.html') rel = '';

  // Trim trailing slashes
  rel = rel.replace(/\/+$/, '');

  // Normalize root-ish keys to "home"
  if (rel === '' || rel === '.' || /^index$/i.test(rel)) return 'home';

  return rel;
}
function parentKeyOf(key) {
  if (key === 'home') return '';
  const p = key.split('/').slice(0, -1).join('/');
  return p || '';
}
function depthOfKey(key) {
  if (key === 'home' || key === '') return 0;
  return key.split('/').length;
}

// ---------- page build ----------
function buildPage($, map, baseUrl, keyForFallback) {
  const m = map.page || {};
  const base =
    $('base').attr('href') ||
    $('meta[property="og:url"]').attr('content') ||
    $('link[rel="canonical"]').attr('href') ||
    baseUrl || '';

  // Title with fallbacks (breadcrumb last item; folder name if needed)
  let title = normalizeSpaces(
    selectText($,
      m.title ||
      "meta[property='og:title']@content || #content h1 || h1.page-title || .breadcrumb li:last-child a@text || .breadcrumb li:last-child@text || h1"
    )
  );
  if (!title) {
    const last = keyForFallback.split('/').pop() || 'Page';
    title = last.replace(/[-_]+/g, ' ').trim();
    title = title.charAt(0).toUpperCase() + title.slice(1);
  }
  if (keyForFallback === 'home' && HOME_TITLE) title = HOME_TITLE;

  // HTML content
  const contentHtml = selectHtml(
    $,
    m.content_html ||
      "#content || #content .row || .container #content || main .entry-content || article .entry-content || .post-content || .content || body"
  );

  const excerptHtml = selectHtml($, m.excerpt_html || ".intro, .lead, .summary");

  // Images: og:image + main content imgs
  const resolvedBase =
    $('base').attr('href') ||
    $('link[rel=\"canonical\"]').attr('href') ||
    base;

  const imgs = [];
  if (m.images) {
    const selectors = m.images.split('||').map(s => s.trim()).filter(Boolean);
    for (const part of selectors) {
      const at = part.lastIndexOf('@');
      let sel = part, attr = 'src';
      if (at > 0) {
        sel = part.slice(0, at).trim();
        attr = part.slice(at + 1).trim();
      }
      $(sel).each((_, el) => {
        const val = attr === 'text' ? $(el).text() : $(el).attr(attr);
        if (val && String(val).trim()) imgs.push(String(val).trim());
      });
      if (imgs.length) break;
    }
  } else {
    const metaImgs = $("meta[property='og:image']").map((_, el) => $(el).attr('content') || '').get();
    const contentImgs = $("#content img, .entry-content img, .content img").map((_, el) => $(el).attr('src') || '').get();
    imgs.push(...metaImgs, ...contentImgs);
  }
  const seen = new Set();
  const finalImgs = imgs
    .map(u => absolutize(u, resolvedBase))
    .filter(u => /^https?:\/\//i.test(u))
    .filter(u => (seen.has(u) ? false : (seen.add(u), true)));

  const slug = SLUG_SOURCE === 'key' ? slugify(keyForFallback === 'home' ? 'home' : keyForFallback) : slugify(title);

  return {
    title,
    slug,
    contentHtml,
    excerptHtml,
    images: finalImgs
  };
}

function postmetaXml(key, val) {
  return [
    '<wp:postmeta>',
    `<wp:meta_key>${key}</wp:meta_key>`,
    `<wp:meta_value><![CDATA[${val || ''}]]></wp:meta_value>`,
    '</wp:postmeta>'
  ].join('');
}
function pageItemXml(p, ids, thumbId, author, dates) {
  const link = `${SITE_URL}/?page_id=${ids.post}`;
  const parts = [
    `<title>${cdata(p.title)}</title>`,
    `<link>${xmlEscape(link)}</link>`,
    `<pubDate>${xmlEscape(dates.rfc2822)}</pubDate>`,
    `<dc:creator>${cdata(author)}</dc:creator>`,
    `<guid isPermaLink="false">${xmlEscape(`page-${ids.post}`)}</guid>`,
    `<description></description>`,
    `<content:encoded>${cdata(p.contentHtml)}</content:encoded>`,
    `<excerpt:encoded>${cdata(p.excerptHtml)}</excerpt:encoded>`,
    `<wp:post_id>${ids.post}</wp:post_id>`,
    `<wp:post_date>${xmlEscape(dates.local)}</wp:post_date>`,
    `<wp:post_date_gmt>${xmlEscape(dates.gmt)}</wp:post_date_gmt>`,
    `<wp:comment_status>closed</wp:comment_status>`,
    `<wp:ping_status>closed</wp:ping_status>`,
    `<wp:post_name>${xmlEscape(p.slug)}</wp:post_name>`,
    `<wp:status>publish</wp:status>`,
    `<wp:post_parent>${ids.parent}</wp:post_parent>`,
    `<wp:menu_order>${ids.menuOrder || 0}</wp:menu_order>`,
    `<wp:post_type>page</wp:post_type>`,
    `<wp:post_password></wp:post_password>`,
    `<wp:is_sticky>0</wp:is_sticky>`,
    thumbId ? postmetaXml('_thumbnail_id', String(thumbId)) : ''
  ];
  return `<item>${parts.join('')}</item>`;
}
function attachmentItemXml(url, attId, parentId, author, dates) {
  const fileName = (url.split('/').pop() || 'image').split('?')[0];
  const title = fileName.replace(/\.[a-z0-9]+$/i, '');
  const link = `${SITE_URL}/?attachment_id=${attId}`;
  const parts = [
    `<title>${cdata(title)}</title>`,
    `<link>${xmlEscape(link)}</link>`,
    `<pubDate>${xmlEscape(dates.rfc2822)}</pubDate>`,
    `<dc:creator>${cdata(author)}</dc:creator>`,
    `<guid isPermaLink="false">${xmlEscape(`attachment-${attId}`)}</guid>`,
    `<description></description>`,
    `<content:encoded><![CDATA[]]></content:encoded>`,
    `<excerpt:encoded><![CDATA[]]></excerpt:encoded>`,
    `<wp:post_id>${attId}</wp:post_id>`,
    `<wp:post_date>${xmlEscape(dates.local)}</wp:post_date>`,
    `<wp:post_date_gmt>${xmlEscape(dates.gmt)}</wp:post_date_gmt>`,
    `<wp:comment_status>closed</wp:comment_status>`,
    `<wp:ping_status>closed</wp:ping_status>`,
    `<wp:post_name>${xmlEscape(slugify(title))}</wp:post_name>`,
    `<wp:status>inherit</wp:status>`,
    `<wp:post_parent>${parentId}</wp:post_parent>`,
    `<wp:menu_order>0</wp:menu_order>`,
    `<wp:post_type>attachment</wp:post_type>`,
    `<wp:post_password></wp:post_password>`,
    `<wp:is_sticky>0</wp:is_sticky>`,
    `<wp:attachment_url>${xmlEscape(url)}</wp:attachment_url>`
  ];
  return `<item>${parts.join('')}</item>`;
}
function nowDates() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const local = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const g = new Date(d.getTime() - d.getTimezoneOffset()*60000);
  const gLocal = `${g.getFullYear()}-${pad(g.getMonth()+1)}-${pad(g.getDate())} ${pad(g.getHours())}:${pad(g.getMinutes())}:${pad(g.getSeconds())}`;
  return { local, gmt: gLocal, rfc2822: d.toUTCString() };
}

// ---------- main ----------
(function main() {
  const files = walkHtmlFiles(INPUT);
  if (!files.length) {
    console.error('No HTML files found under:', INPUT);
    process.exit(1);
  }
  const mapping = loadMapping(MAP_PATH);

  // Phase 1: collect candidates keyed by rel path (prefer desktop/mobile)
  const buckets = new Map(); // key -> {file, profile}
  for (const f of files) {
    if (PREFER_PROFILE === 'desktop' && /\/mobile\//i.test(f)) {
      if (VERBOSE) console.log(`SKIP profile (prefer desktop): ${path.relative(process.cwd(), f)}`);
      continue;
    }
    if (PREFER_PROFILE === 'mobile' && /\/desktop\//i.test(f)) {
      if (VERBOSE) console.log(`SKIP profile (prefer mobile): ${path.relative(process.cwd(), f)}`);
      continue;
    }
    const key = relKeyForFile(f);
    if (!key) continue;

    // Include/exclude by regex
    if (includeRe && !includeRe.test(key)) {
      if (VERBOSE) console.log(`SKIP include-path-regex: ${key}`);
      continue;
    }
    if (excludeRe && excludeRe.test(key)) {
      if (VERBOSE) console.log(`SKIP exclude-path-regex: ${key}`);
      continue;
    }

    // Dedupe by rel path
    const existing = buckets.get(key);
    const isDesktop = /\/desktop\//i.test(f);
    if (!existing) {
      buckets.set(key, { file: f, profile: isDesktop ? 'desktop' : (/\/mobile\//i.test(f) ? 'mobile' : '') });
    } else if (PREFER_PROFILE === 'desktop' && isDesktop) {
      buckets.set(key, { file: f, profile: 'desktop' });
    } else if (PREFER_PROFILE === 'mobile' && /\/mobile\//i.test(f) && existing.profile !== 'mobile') {
      buckets.set(key, { file: f, profile: 'mobile' });
    }
  }

  // Phase 2: build pages for each bucket
  const nodes = new Map(); // key -> {key, page, images, parentKey, depth}
  for (const [key, { file }] of buckets.entries()) {
    const html = fs.readFileSync(file, 'utf8');
    const $ = cheerio.load(html, { decodeEntities: false });

    if (!INCLUDE_PRODUCTS && isLikelyProduct($)) {
      if (VERBOSE) console.log(`SKIP product: ${path.relative(process.cwd(), file)} key=${key}`);
      continue;
    }

    // Mapping pick uses BASE_URL host (we're path-driven)
    const baseHost = (() => { try { return new URL(BASE_URL).host.toLowerCase(); } catch { return ''; } })();
    const mapHost = baseHost || '';
    const map = (function pick(mapping, h) {
      if (mapping.byDomain) {
        if (h && mapping.byDomain[h]) return { page: { ...(mapping.default?.page || {}), ...(mapping.byDomain[h].page || {}) } };
        const noPort = h.split(':')[0];
        if (mapping.byDomain[noPort]) return { page: { ...(mapping.default?.page || {}), ...(mapping.byDomain[noPort].page || {}) } };
      }
      return { page: mapping.default?.page || {} };
    })(mapping, mapHost);

    const page = buildPage($, map, BASE_URL, key);
    if (!page.title || (!page.contentHtml && !ALLOW_TITLE_ONLY)) {
      if (VERBOSE) console.log(`SKIP (no title/content): ${path.relative(process.cwd(), file)} key=${key}`);
      continue;
    }

    nodes.set(key, {
      key,
      page,
      images: page.images || [],
      parentKey: PATH_HIERARCHY ? parentKeyOf(key) : '',
      depth: PATH_HIERARCHY ? depthOfKey(key) : 0,
      file
    });

    if (VERBOSE) console.log(`PAGE: ${path.relative(process.cwd(), file)} -> key=${key} title=${page.title}`);
  }

  if (!nodes.size) {
    console.error('No pages exported. Try --include-products or adjust wc-pages-mapping.json.');
    process.exit(2);
  }

  // Phase 3: assign IDs and build hierarchy (parents before children)
  let nextId = 50000;
  const idByKey = new Map();
  const items = [];
  const dates = nowDates();

  const sortedKeys = Array.from(nodes.keys()).sort((a, b) => (nodes.get(a).depth - nodes.get(b).depth));

  for (const key of sortedKeys) {
    const node = nodes.get(key);
    if (!node) continue;

    // Ensure parent exists (if not, create a stub from key name)
    let parentId = 0;
    if (PATH_HIERARCHY && node.parentKey) {
      if (!idByKey.has(node.parentKey)) {
        const parentTitleRaw = node.parentKey.split('/').pop() || 'Page';
        const parentTitle = parentTitleRaw.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const parentSlug = SLUG_SOURCE === 'key' ? slugify(node.parentKey) : slugify(parentTitle);
        const pId = nextId++;
        idByKey.set(node.parentKey, pId);

        const stub = {
          title: parentTitle,
          slug: parentSlug,
          contentHtml: '',
          excerptHtml: '',
          images: []
        };

        const stubXml = pageItemXml(stub, { post: pId, parent: 0, menuOrder: nodes.get(node.parentKey)?.depth || 0 }, null, AUTHOR, dates);
        items.push(stubXml);
        if (VERBOSE) console.log(`STUB: parent created for key=${node.parentKey} (id=${pId})`);
      }
      parentId = idByKey.get(node.parentKey);
    }

    const postId = nextId++;
    idByKey.set(key, postId);

    // Attachments
    let thumb = null;
    const seenImg = new Set();
    node.images.forEach((u, idx) => {
      if (!u || !/^https?:\/\//i.test(u) || seenImg.has(u)) return;
      seenImg.add(u);
      const attId = nextId++;
      if (idx === 0) thumb = attId;
      items.push(attachmentItemXml(u, attId, postId, AUTHOR, dates));
    });

    const menuOrder = node.depth;
    const itemXml = pageItemXml(node.page, { post: postId, parent: parentId, menuOrder }, thumb, AUTHOR, dates);
    items.push(itemXml);
  }

  // Finalize feed
  const header = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:wfw="http://wellformedweb.org/CommentAPI/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/"
>
<channel>
  <title><![CDATA[Pages Import]]></title>
  <link>${xmlEscape(SITE_URL)}</link>
  <description><![CDATA[Generated from mirrored HTML (path hierarchy)]]></description>
  <pubDate>${xmlEscape(dates.rfc2822)}</pubDate>
  <language>bg</language>
  <wp:wxr_version>1.2</wp:wxr_version>
  <wp:base_site_url>${xmlEscape(SITE_URL)}</wp:base_site_url>
  <wp:base_blog_url>${xmlEscape(SITE_URL)}</wp:base_blog_url>
`;
  const footer = `
</channel>
</rss>`;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, header + items.join('\n') + footer, 'utf8');
  const pageCount = items.filter(x => x.includes('<wp:post_type>page</wp:post_type>')).length;
  console.log(`\nWrote ${pageCount} pages (plus attachments) to ${OUT}`);
})();