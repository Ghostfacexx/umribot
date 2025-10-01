#!/usr/bin/env node
/**
 * Any HTML → WordPress WXR (pages) with:
 * - CSS/JS capture into post meta (_anypage_*), for pixel-accurate rendering (with MU plugin).
 * - Internal link rewrite for pages AND products (OpenCart → Woo).
 * - Product-card grid rewrite using cart.add('ID') hints.
 *
 * New flags:
 *   --product-map out/product-map.json   JSON: { "120": "yoga-chai-ayurveda", ... }
 *   --product-base /product              Base path for Woo products (default /product)
 *   --debug-rewrites                    Log link rewrites
 *
 * Requires: Node 18+, npm i cheerio
 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { URL } = require('url');

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
const OUT = args.out || 'out/pages-any.wxr';
const SITE_URL = (args['site-url'] || 'https://example.com').replace(/\/+$/, '');
const AUTHOR = args.author || 'admin';
const BASE_URL = args['base-url'] || '';
const VERBOSE = Boolean(args.verbose);

const PREFER_PROFILE = (args['prefer-profile'] || '').toLowerCase(); // desktop|mobile|''
const MODE = (args.mode || 'folder').toLowerCase(); // 'folder' or 'file'
const PATH_HIERARCHY = Boolean(args['path-hierarchy']);
const SLUG_SOURCE = (args['slug-source'] || 'title').toLowerCase(); // 'title' | 'key'
const HOME_TITLE = args['home-title'] || '';
const ALLOW_TITLE_ONLY = Boolean(args['allow-title-only']);
const MAX_ATTACH = Math.max(0, Number(args['max-attachments'] || 6));
const MIN_CONTENT_CHARS = Number(args['min-content-chars'] || 40);

const REWRITE_INTERNAL_LINKS = Boolean(args['rewrite-internal-links']);
const PRODUCT_BASE = (args['product-base'] || '/product').replace(/\/+$/, '');
const PRODUCT_MAP_PATH = args['product-map'] || '';
const DEBUG_REWRITES = Boolean(args['debug-rewrites']);

const includeRe = args['include-path-regex'] ? new RegExp(args['include-path-regex']) : null;
const excludeRe = args['exclude-path-regex'] ? new RegExp(args['exclude-path-regex']) : null;

if (!INPUT) { console.error('Error: --in <file-or-dir> is required'); process.exit(1); }

// Transliteration for Bulgarian (same as in product-map)
function transliterateCyrillicToLatin(str) {
  const map = {
    'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Е':'E','Ж':'Zh','З':'Z','И':'I','Й':'Y',
    'К':'K','Л':'L','М':'M','Н':'N','О':'O','П':'P','Р':'R','С':'S','Т':'T','У':'U',
    'Ф':'F','Х':'H','Ц':'Ts','Ч':'Ch','Ш':'Sh','Щ':'Sht','Ъ':'A','Ь':'','Ю':'Yu','Я':'Ya',
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ж':'zh','з':'z','и':'i','й':'y',
    'к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u',
    'ф':'f','х':'h','ц':'ts','ч':'ch','ш':'sh','щ':'sht','ъ':'a','ь':'','ю':'yu','я':'ya'
  };
  return str.split('').map(ch => map[ch] ?? ch).join('');
}
function slugify(s) {
  const t = transliterateCyrillicToLatin(String(s || ''));
  const lower = t.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const slug = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 200);
  return slug || 'page';
}

// ---------- utilities ----------
function walkHtmlFiles(root) {
  const list = [];
  function rec(p) {
    const st = fs.statSync(p);
    if (st.isDirectory()) for (const n of fs.readdirSync(p)) rec(path.join(p, n));
    else if (st.isFile() && /\.(html?|htm)$/i.test(p)) list.push(p);
  }
  rec(root);
  return list;
}
function normalizeSpaces(s) { return s ? s.replace(/\s+/g, ' ').trim() : ''; }
function xmlEscape(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}
function cdata(s) {
  if (s == null) return '<![CDATA[]]>';
  return `<![CDATA[${String(s).replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}
function absolutize(u, base) {
  if (!u) return '';
  try { return new URL(u).toString(); }
  catch { try { return new URL(u, base).toString(); } catch { return u; } }
}
function hostOf(u) { try { return new URL(u).host.toLowerCase(); } catch { return ''; } }

function baseFor($, fallback) {
  const b = $('base').attr('href') ||
            $('link[rel="canonical"]').attr('href') ||
            $('meta[property="og:url"]').attr('content') ||
            fallback || '';
  try { return b ? new URL(b).toString() : ''; } catch { return fallback || ''; }
}
function collapseProfilesInPath(rel) {
  return rel.replace(/\/(desktop|mobile)(?=\/|$)/ig, '');
}
function pathKeyForFile(absFile) {
  let rel = path.relative(INPUT, absFile).replace(/\\/g, '/');
  rel = rel.replace(/\/index\.html?$/i, '');
  rel = collapseProfilesInPath(rel);
  rel = rel.replace(/\.html?$/i, '');
  rel = rel.replace(/\/+$/, '').replace(/^\/+/, '');
  if (rel === '' || rel === '.' || /^index$/i.test(rel)) return 'home';
  return rel;
}
function parentKeyOf(key) {
  if (!PATH_HIERARCHY || key === 'home') return '';
  const p = key.split('/').slice(0, -1).join('/');
  return p || '';
}
function depthOf(key) {
  if (!PATH_HIERARCHY) return 0;
  if (key === 'home') return 0;
  return key.split('/').length;
}
function preferProfile(oldPath, newPath) {
  const isOldDesktop = /\/desktop(\/|$)/i.test(oldPath);
  const isNewDesktop = /\/desktop(\/|$)/i.test(newPath);
  const isOldMobile = /\/mobile(\/|$)/i.test(oldPath);
  const isNewMobile = /\/mobile(\/|$)/i.test(newPath);
  if (PREFER_PROFILE === 'desktop') return isNewDesktop && !isOldDesktop;
  if (PREFER_PROFILE === 'mobile') return isNewMobile && !isOldMobile;
  return false;
}

// Content selection and cleanup
const CONTENT_SELECTOR = args['content-selector'] ||
  "#content, main .entry-content, article .entry-content, main, article, .post-content, .entry-content, .content, .container #content, .container, body";
const STRIP_SELECTORS = (args['strip-selectors'] ||
  "script, noscript, iframe[title='Google analytics'], .cookie, .cookies, .cookie-notice, .gdpr, .newsletter, .popup, .modal, .offcanvas, .ads, .advert, .ad, #comments, .comments, nav.breadcrumbs .pagination"
).split(',').map(s => s.trim()).filter(Boolean);

function pickContainerSelector($) {
  const candidates = CONTENT_SELECTOR.split(',').map(s => s.trim()).filter(Boolean);
  for (const sel of candidates) if ($(sel).length) return sel;
  return 'body';
}
function cleanAndFixContent($, container, base) {
  const c = $(container).first().clone();

  c.find('img').each((_, img) => {
    const $img = $(img);
    if (!$img.attr('src')) {
      const lazy = $img.attr('data-src') || $img.attr('data-lazy') || $img.attr('data-original') || $img.attr('data-srcset');
      if (lazy) $img.attr('src', lazy);
    }
    const src = $img.attr('src');
    if (src) $img.attr('src', absolutize(src, base));
    const ss = $img.attr('srcset');
    if (ss) {
      const fixed = ss.split(',').map(s => {
        const [u, d] = s.trim().split(/\s+/);
        return [absolutize(u, base), d].filter(Boolean).join(' ');
      }).join(', ');
      $img.attr('srcset', fixed);
    }
  });

  c.find('a[href]').each((_, a) => {
    const $a = $(a);
    const href = $a.attr('href');
    if (href) $a.attr('href', absolutize(href, base));
  });

  STRIP_SELECTORS.forEach(sel => c.find(sel).remove());

  return c.html() || '';
}

function pageFromFile(absPath) {
  const html = fs.readFileSync(absPath, 'utf8');
  const $ = cheerio.load(html, { decodeEntities: false });

  const base = baseFor($, BASE_URL);
  const containerSel = pickContainerSelector($);
  const contentHtml = cleanAndFixContent($, containerSel, base);

  let title =
    normalizeSpaces($('meta[property="og:title"]').attr('content')) ||
    normalizeSpaces($('title').text()) ||
    normalizeSpaces($('h1').first().text()) ||
    '';

  // Capture head assets
  const headStyles = [];
  $('link[rel="stylesheet"][href]').each((_, el) => {
    const u = $(el).attr('href');
    if (!u) return;
    const abs = absolutize(u, base);
    headStyles.push(abs);
  });

  let inlineCss = '';
  $('style').each((_, el) => {
    const css = $(el).html();
    if (css && String(css).trim()) inlineCss += css + "\n";
  });

  const deny = /(google-analytics|googletagmanager|gtag\/js|fb(|-)|connect\.facebook|hotjar|clarity|recaptcha|gstatic|intercom|livereload)/i;
  const headScripts = [];
  $('script[src]').each((_, el) => {
    const u = $(el).attr('src');
    if (!u) return;
    const abs = absolutize(u, base);
    if (!deny.test(abs)) headScripts.push(abs);
  });

  return { $, base, title, contentHtml, headStyles, inlineCss, headScripts };
}

// ---------- XML helpers ----------
function postmetaXml(key, val) {
  return [
    '<wp:postmeta>',
    `<wp:meta_key>${key}</wp:meta_key>`,
    `<wp:meta_value><![CDATA[${val || ''}]]></wp:meta_value>`,
    '</wp:postmeta>'
  ].join('');
}
function pageItemXml(p, ids, thumbId, dates, siteUrl, author) {
  const link = `${siteUrl}/?page_id=${ids.post}`;
  const parts = [
    `<title>${cdata(p.title)}</title>`,
    `<link>${xmlEscape(link)}</link>`,
    `<pubDate>${xmlEscape(dates.rfc2822)}</pubDate>`,
    `<dc:creator>${cdata(author)}</dc:creator>`,
    `<guid isPermaLink="false">${xmlEscape(`page-${ids.post}`)}</guid>`,
    `<description></description>`,
    `<content:encoded>${cdata(p.contentHtml)}</content:encoded>`,
    `<excerpt:encoded>${cdata(p.excerptHtml || '')}</excerpt:encoded>`,
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
    thumbId ? postmetaXml('_thumbnail_id', String(thumbId)) : '',
    postmetaXml('_anypage_layout_reset', '1'),
    postmetaXml('_anypage_styles', JSON.stringify(p._anypage_styles || [])),
    postmetaXml('_anypage_inline_css', p._anypage_inline_css || ''),
    postmetaXml('_anypage_scripts', JSON.stringify(p._anypage_scripts || []))
  ];
  return `<item>${parts.join('')}</item>`;
}
function attachmentItemXml(url, attId, parentId, dates, siteUrl, author) {
  const fileName = (url.split('/').pop() || 'image').split('?')[0];
  const title = fileName.replace(/\.[a-z0-9]+$/i, '');
  const link = `${siteUrl}/?attachment_id=${attId}`;
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

// ---------- product + page link rewriting ----------
function loadProductMap(pth) {
  if (!pth) return {};
  if (!fs.existsSync(pth)) {
    console.warn(`Warning: --product-map file not found: ${pth}`);
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(pth, 'utf8'));
  } catch (e) {
    console.warn(`Warning: failed to parse product map ${pth}: ${e.message}`);
    return {};
  }
}
const productMap = loadProductMap(PRODUCT_MAP_PATH);

function productSlugFromUrl(href) {
  // Detect OpenCart product URLs like index.php?route=product/product&product_id=120
  try {
    const u = new URL(href, BASE_URL || 'http://local/');
    const route = u.searchParams.get('route') || '';
    const pid = u.searchParams.get('product_id') || u.searchParams.get('productId') || '';
    if (/product\/product/i.test(route) && pid && productMap[pid]) {
      return productMap[pid];
    }
  } catch {}
  return null;
}

function keyFromUrlLike(uStr) {
  try {
    const u = new URL(uStr, BASE_URL || 'http://local/');
    const baseHost = BASE_URL ? new URL(BASE_URL).host.toLowerCase() : '';
    const sameHost = !/^https?:/i.test(uStr) || (baseHost && u.host.toLowerCase() === baseHost);

    if (!sameHost) return null;

    let p = u.pathname || '/';
    if (p === '/' || p === '' || /^\/index(\.html?)?$/i.test(p)) return 'home';

    p = p.replace(/^\/+/, '').replace(/\/+$/, '');
    p = collapseProfilesInPath('/' + p).replace(/^\/+/, '').replace(/\/index$/i, '');

    return p || 'home';
  } catch { return null; }
}

function rewriteProductCards($c) {
  // For each product card: if we can detect product_id from cart.add, rewrite anchors to product URL
  $c('[class*="product-thumb"], [class*="product-layout"], [class*="product-grid"]').each((_, card) => {
    const $card = $c(card);
    let pid = '';
    $card.find('[onclick]').each((__, el) => {
      const on = String($c(el).attr('onclick') || '');
      const m = on.match(/cart\.add\(['"](\d+)['"]/i);
      if (m) { pid = m[1]; return false; }
    });
    if (!pid) {
      const cand = $card.attr('data-product-id') || $card.find('[data-product-id]').attr('data-product-id') || '';
      if (cand) pid = String(cand).trim();
    }
    if (!pid) return;
    const slug = productMap[pid];
    if (!slug) return;

    // Rewrite obvious product anchors (image link + title link)
    $card.find('a[href]').each((__, a) => {
      const $a = $c(a);
      const href = $a.attr('href') || '';
      // Only rewrite same-site links that are not already pointing to /product/
      const isExternal = /^https?:\/\//i.test(href) && hostOf(href) && BASE_URL && hostOf(href) !== hostOf(BASE_URL);
      if (isExternal) return;
      if (new RegExp(`^${PRODUCT_BASE.replace(/\//g, '\\/')}/`, 'i').test(href)) return;
      const newHref = `${PRODUCT_BASE}/${slug}/`;
      if (DEBUG_REWRITES) console.log(`REWRITE card: ${href} -> ${newHref}`);
      $a.attr('href', newHref);
    });
  });
}

// ---------- main ----------
(function main() {
  const files = walkHtmlFiles(INPUT);

  const buckets = new Map(); // key -> absPath
  for (const f of files) {
    if (PREFER_PROFILE === 'desktop' && /\/mobile\//i.test(f)) { if (VERBOSE) console.log(`SKIP profile mobile: ${f}`); continue; }
    if (PREFER_PROFILE === 'mobile' && /\/desktop\//i.test(f)) { if (VERBOSE) console.log(`SKIP profile desktop: ${f}`); continue; }
    if (MODE === 'folder' && !/\/index\.html?$/i.test(f)) continue;

    const key = pathKeyForFile(f);
    if (includeRe && !includeRe.test(key)) { if (VERBOSE) console.log(`SKIP include filter: ${key}`); continue; }
    if (excludeRe && excludeRe.test(key)) { if (VERBOSE) console.log(`SKIP exclude filter: ${key}`); continue; }

    const existing = buckets.get(key);
    if (!existing) buckets.set(key, f);
    else if (preferProfile(existing, f)) buckets.set(key, f);
  }

  if (!buckets.size) { console.error('No candidate pages found.'); process.exit(2); }

  // First pass: parse titles, slugs, content and head assets
  const nodes = new Map(); // key -> node
  const slugByKey = new Map();

  for (const [key, file] of buckets.entries()) {
    const { $, base, title: t0, contentHtml, headStyles, inlineCss, headScripts } = pageFromFile(file);

    let title = t0;
    if (!title) {
      const last = key.split('/').pop() || 'Page';
      title = last.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
    if (key === 'home' && HOME_TITLE) title = HOME_TITLE;

    const slug = (SLUG_SOURCE === 'key') ? slugify(key === 'home' ? 'home' : key) : slugify(title);
    slugByKey.set(key, slug);

    nodes.set(key, {
      key, file, depth: depthOf(key), parentKey: parentKeyOf(key),
      base, title, contentHtml, headStyles, inlineCss, headScripts
    });

    if (VERBOSE) console.log(`PAGE: ${file} -> key=${key} title=${title}`);
  }

  // Rewrite internal links to local pages and products
  if (REWRITE_INTERNAL_LINKS) {
    for (const node of nodes.values()) {
      const $c = cheerio.load(`<div id="__c">${node.contentHtml}</div>`, { decodeEntities: false });

      // Product cards (grid)
      rewriteProductCards($c);

      // Anchor-by-anchor
      $c('#__c a[href]').each((_, a) => {
        const $a = $c(a);
        const href = $a.attr('href'); if (!href) return;

        // Product URL with product_id
        const prodSlug = productSlugFromUrl(href);
        if (prodSlug) {
          const newHref = `${PRODUCT_BASE}/${prodSlug}/`;
          if (DEBUG_REWRITES) console.log(`REWRITE product: ${href} -> ${newHref}`);
          $a.attr('href', newHref);
          return;
        }

        // Page rewrite by key
        const k = keyFromUrlLike(href);
        if (k && slugByKey.has(k)) {
          const newHref = `/${slugByKey.get(k)}/`;
          if (DEBUG_REWRITES) console.log(`REWRITE page: ${href} -> ${newHref}`);
          $a.attr('href', newHref);
        }
      });

      node.contentHtml = $c('#__c').html() || node.contentHtml;
    }
  }

  // Emit WXR
  let nextId = 80000;
  const idByKey = new Map();
  const items = [];
  const dates = nowDates();

  if (PATH_HIERARCHY) {
    const sortedKeys = Array.from(nodes.keys()).sort((a,b) => nodes.get(a).depth - nodes.get(b).depth);
    for (const key of sortedKeys) {
      const parent = parentKeyOf(key);
      if (!parent) continue;
      if (!idByKey.has(parent) && !nodes.has(parent)) {
        const titleRaw = parent.split('/').pop() || 'Page';
        const stubTitle = titleRaw.replace(/[-_]+/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
        const stubSlug = SLUG_SOURCE === 'key' ? slugify(parent) : slugify(stubTitle);
        const pid = nextId++; idByKey.set(parent, pid);
        const stub = { title: stubTitle, slug: stubSlug, contentHtml: '', excerptHtml: '', images: [], _anypage_styles: [], _anypage_inline_css: '', _anypage_scripts: [] };
        items.push(pageItemXml(stub, { post: pid, parent: 0, menuOrder: key.split('/').length - 1 }, null, dates, SITE_URL, AUTHOR));
        if (VERBOSE) console.log(`STUB: created for ${parent} id=${pid}`);
      }
    }
  }

  for (const node of Array.from(nodes.values()).sort((a,b) => a.depth - b.depth)) {
    const postId = nextId++;
    idByKey.set(node.key, postId);

    let parent = 0;
    if (PATH_HIERARCHY) {
      const pKey = parentKeyOf(node.key);
      if (pKey) parent = idByKey.get(pKey) || 0;
    }

    // Attachments (from content)
    const imgs = new Set();
    const $imgDoc = cheerio.load(`<div id="__c">${node.contentHtml}</div>`, { decodeEntities: false });
    $imgDoc('#__c img[src]').each((_, img) => {
      const u = $imgDoc(img).attr('src');
      if (u) imgs.add(u);
    });
    const images = Array.from(imgs).filter(u => /^https?:\/\//i.test(u)).slice(0, MAX_ATTACH);

    if (!ALLOW_TITLE_ONLY) {
      const textLen = normalizeSpaces($imgDoc('#__c').text()).length;
      if (!node.contentHtml || textLen < MIN_CONTENT_CHARS) {
        if (VERBOSE) console.log(`SKIP (too little content): key=${node.key} file=${node.file}`);
        continue;
      }
    }

    // Attachments
    let thumb = null;
    images.forEach((u, idx) => {
      const attId = nextId++;
      if (idx === 0) thumb = attId;
      items.push(attachmentItemXml(u, attId, postId, dates, SITE_URL, AUTHOR));
    });

    const page = {
      title: node.title,
      slug: (SLUG_SOURCE === 'key') ? slugify(node.key === 'home' ? 'home' : node.key) : slugify(node.title),
      contentHtml: node.contentHtml,
      excerptHtml: '',
      _anypage_styles: node.headStyles || [],
      _anypage_inline_css: node.inlineCss || '',
      _anypage_scripts: node.headScripts || []
    };

    items.push(pageItemXml(page, { post: postId, parent, menuOrder: node.depth }, thumb, dates, SITE_URL, AUTHOR));
  }

  const header = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:wfw="http://wellformedweb.org/CommentAPI/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/"
>
<channel>
  <title><![CDATA[Pages Import (AnyPage)]]></title>
  <link>${xmlEscape(SITE_URL)}</link>
  <description><![CDATA[Generated from mirrored HTML]]></description>
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

  const pageCount = items.filter(s => s.includes('<wp:post_type>page</wp:post_type>')).length;
  console.log(`\nWrote ${pageCount} pages (plus attachments) to ${OUT}`);
})();