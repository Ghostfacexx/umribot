#!/usr/bin/env node
/**
 * WooCommerce WXR exporter (from mirrored HTML).
 *
 * Produces a WordPress WXR 1.2 XML with:
 * - <item> posts of type "product" (WooCommerce)
 * - Product postmeta: _sku, _regular_price, _sale_price, _price, _stock_status
 * - Taxonomy terms: product_cat, product_tag (declared as <wp:term> and attached to items)
 * - Image attachments: <item> with wp:post_type "attachment" and wp:attachment_url, assigned to each product
 * - _thumbnail_id wired to the first attachment per product
 *
 * Usage:
 *   node wc-export-wxr.cjs \
 *     --in downloaded_pages \
 *     --out out/products.wxr \
 *     --map wc-wxr-mapping.json \
 *     --base-url http://135.148.82.224:8083/ \
 *     --site-url https://your-wp-site.example \
 *     --author admin
 *
 * Notes:
 * - Install dependency: npm i cheerio
 * - This script targets SIMPLE products. Variations/attributes can be added later.
 * - The importer will fetch remote images from the attachment URLs during import.
 */

const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const cheerio = require('cheerio');

// --------------------- args ---------------------
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
const OUT = args.out || args.output || 'out/products.wxr';
const MAP_PATH = args.map || 'wc-wxr-mapping.json';
const BASE_URL = args['base-url'] || args.base || '';
const SITE_URL = (args['site-url'] || 'https://example.com').replace(/\/+$/, '');
const AUTHOR = args.author || 'admin';

if (!INPUT) {
  console.error('Error: --in <file-or-dir> is required');
  process.exit(1);
}
if (!fs.existsSync(MAP_PATH)) {
  console.error(`Error: mapping file not found at ${MAP_PATH}`);
  process.exit(1);
}

// --------------------- utils ---------------------
function walkHtmlFiles(root) {
  const out = [];
  function recur(p) {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p)) recur(path.join(p, name));
    } else if (st.isFile()) {
      const ext = path.extname(p).toLowerCase();
      if (ext === '.html' || ext === '.htm') out.push(p);
    }
  }
  const st = fs.statSync(root);
  if (st.isFile()) return [root];
  recur(root);
  return out;
}

function xmlEscape(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdata(s) {
  if (s == null) return '<![CDATA[]]>';
  // Avoid closing CDATA in content
  return `<![CDATA[${String(s).replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200) || 'item';
}

function absolutize(urlStr, baseUrl) {
  if (!urlStr) return '';
  try {
    const u = new URL(urlStr);
    return u.toString();
  } catch {
    try {
      return new URL(urlStr, baseUrl).toString();
    } catch {
      return urlStr;
    }
  }
}

function normalizeSpaces(s) {
  return s ? s.replace(/\s+/g, ' ').trim() : '';
}

function nowDates() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const local = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const g = new Date(d.getTime() - d.getTimezoneOffset()*60000);
  const gLocal = `${g.getFullYear()}-${pad(g.getMonth()+1)}-${pad(g.getDate())} ${pad(g.getHours())}:${pad(g.getMinutes())}:${pad(g.getSeconds())}`;
  return { local, gmt: gLocal, rfc2822: d.toUTCString() };
}

// --------------------- mapping helpers ---------------------
function loadMapping(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function findHostname($) {
  const cand =
    $('link[rel="canonical"]').attr('href') ||
    $('meta[property="og:url"]').attr('content') ||
    $('meta[name="og:url"]').attr('content') ||
    $('meta[property="twitter:url"]').attr('content') ||
    $('meta[name="twitter:url"]').attr('content') ||
    '';
  try { return cand ? new URL(cand).hostname : ''; } catch { return ''; }
}
function pickMappingForHost(mapping, host) {
  if (mapping.byDomain) {
    if (mapping.byDomain[host]) {
      return { product: { ...(mapping.default?.product || {}), ...(mapping.byDomain[host].product || {}) } };
    }
    // Try host without port
    const noPort = host.split(':')[0];
    if (mapping.byDomain[noPort]) {
      return { product: { ...(mapping.default?.product || {}), ...(mapping.byDomain[noPort].product || {}) } };
    }
  }
  return { product: mapping.default?.product || {} };
}
function selectOne($, selector) {
  if (!selector) return '';
  for (const part of selector.split('||').map(s => s.trim()).filter(Boolean)) {
    const atIdx = part.lastIndexOf('@');
    if (atIdx > 0) {
      const sel = part.slice(0, atIdx).trim();
      const attr = part.slice(atIdx + 1).trim();
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
function selectAll($, selector, mapFn = v => v) {
  if (!selector) return [];
  const parts = selector.split('||').map(s => s.trim()).filter(Boolean);
  const results = [];
  for (const part of parts) {
    const atIdx = part.lastIndexOf('@');
    if (atIdx > 0) {
      const sel = part.slice(0, atIdx).trim();
      const attr = part.slice(atIdx + 1).trim();
      $(sel).each((_, el) => {
        const v = attr === 'text' ? $(el).text() : $(el).attr(attr);
        if (v != null && String(v).trim()) results.push(mapFn(String(v).trim()));
      });
    } else {
      $(part).each((_, el) => {
        const v = $(el).text();
        if (v != null && String(v).trim()) results.push(mapFn(String(v).trim()));
      });
    }
    if (results.length) break;
  }
  // de-dup
  const seen = new Set();
  return results.filter(v => (seen.has(v) ? false : (seen.add(v), true)));
}
function cleanPrice(raw) {
  if (!raw) return '';
  const s = String(raw)
    .replace(/[\s\u00A0]/g, '')
    .replace(/[,](?=\d{3}\b)/g, '')
    .replace(/[^\d.,-]/g, '');
  if (s.includes('.') && s.includes(',')) return s.replace(/,/g, '');
  if (!s.includes('.') && s.includes(',')) return s.replace(/,/g, '.');
  return s;
}

// --------------------- extraction ---------------------
function extractProduct($, map, baseUrl) {
  const m = map.product || {};
  const base =
    $('base').attr('href') ||
    $('meta[property="og:url"]').attr('content') ||
    $('link[rel="canonical"]').attr('href') ||
    baseUrl ||
    '';

  const name = normalizeSpaces(selectOne($, m.name));
  const sku = selectOne($, m.sku) || '';
  const priceReg = cleanPrice(selectOne($, m.price_regular));
  const priceSale = cleanPrice(selectOne($, m.price_sale));
  const descHtml = selectOne($, m.description_html) || '';
  const shortDescHtml = selectOne($, m.short_description_html) || '';
  const cats = selectAll($, m.categories, normalizeSpaces);
  const tags = selectAll($, m.tags, normalizeSpaces);
  const images = selectAll($, m.images, v => absolutize(v, base));

  const inStockSel = m.in_stock;
  const inStock = inStockSel ? Boolean(selectOne($, inStockSel)) : undefined;

  return {
    name,
    slug: slugify(name),
    sku,
    price_regular: priceReg || '',
    price_sale: priceSale || '',
    description_html: descHtml,
    short_description_html: shortDescHtml,
    categories: cats,
    tags: tags,
    images: images,
    in_stock: inStock
  };
}

// --------------------- WXR build ---------------------
function termObject(domain, name) {
  const nicename = slugify(name);
  return { domain, name, nicename, parent: '' };
}

function termXml(t) {
  return [
    '<wp:term>',
    `<wp:term_taxonomy>${xmlEscape(t.domain)}</wp:term_taxonomy>`,
    `<wp:term_slug>${xmlEscape(t.nicename)}</wp:term_slug>`,
    `<wp:term_parent>${xmlEscape(t.parent || '')}</wp:term_parent>`,
    `<wp:term_name>${cdata(t.name)}</wp:term_name>`,
    '</wp:term>'
  ].join('');
}

function categoryTagItemsXml(dom, items) {
  return items.map(name =>
    `<category domain="${xmlEscape(dom)}" nicename="${xmlEscape(slugify(name))}">${cdata(name)}</category>`
  ).join('');
}

function postmetaXml(key, value) {
  return [
    '<wp:postmeta>',
    `<wp:meta_key>${xmlEscape(key)}</wp:meta_key>`,
    `<wp:meta_value>${cdata(value)}</wp:meta_value>`,
    '</wp:postmeta>'
  ].join('');
}

function productItemXml(p, ids, thumbId, author, dates) {
  const link = `${SITE_URL}/?post_type=product&p=${ids.post}`;
  const body = [
    `<title>${cdata(p.name)}</title>`,
    `<link>${xmlEscape(link)}</link>`,
    `<pubDate>${xmlEscape(dates.rfc2822)}</pubDate>`,
    `<dc:creator>${cdata(author)}</dc:creator>`,
    `<guid isPermaLink="false">${xmlEscape(`product-${ids.post}`)}</guid>`,
    `<description></description>`,
    `<content:encoded>${cdata(p.description_html)}</content:encoded>`,
    `<excerpt:encoded>${cdata(p.short_description_html)}</excerpt:encoded>`,
    `<wp:post_id>${ids.post}</wp:post_id>`,
    `<wp:post_date>${xmlEscape(dates.local)}</wp:post_date>`,
    `<wp:post_date_gmt>${xmlEscape(dates.gmt)}</wp:post_date_gmt>`,
    `<wp:comment_status>closed</wp:comment_status>`,
    `<wp:ping_status>closed</wp:ping_status>`,
    `<wp:post_name>${xmlEscape(p.slug)}</wp:post_name>`,
    `<wp:status>publish</wp:status>`,
    `<wp:post_parent>0</wp:post_parent>`,
    `<wp:menu_order>0</wp:menu_order>`,
    `<wp:post_type>product</wp:post_type>`,
    `<wp:post_password></wp:post_password>`,
    `<wp:is_sticky>0</wp:is_sticky>`,
    categoryTagItemsXml('product_cat', p.categories),
    categoryTagItemsXml('product_tag', p.tags),
    postmetaXml('_sku', p.sku),
    postmetaXml('_regular_price', p.price_regular),
    postmetaXml('_sale_price', p.price_sale),
    postmetaXml('_price', p.price_sale || p.price_regular),
    postmetaXml('_stock_status', p.in_stock === undefined ? 'instock' : (p.in_stock ? 'instock' : 'outofstock')),
    thumbId ? postmetaXml('_thumbnail_id', String(thumbId)) : ''
  ].join('');
  return `<item>${body}</item>`;
}

function attachmentItemXml(img, ids, parentId, author, dates) {
  const fileName = img.url.split('/').pop() || 'image';
  const title = fileName.replace(/\.[a-z0-9]+$/i, '');
  const link = `${SITE_URL}/?attachment_id=${ids.attachment}`;
  const body = [
    `<title>${cdata(title)}</title>`,
    `<link>${xmlEscape(link)}</link>`,
    `<pubDate>${xmlEscape(dates.rfc2822)}</pubDate>`,
    `<dc:creator>${cdata(author)}</dc:creator>`,
    `<guid isPermaLink="false">${xmlEscape(`attachment-${ids.attachment}`)}</guid>`,
    `<description></description>`,
    `<content:encoded><![CDATA[]]></content:encoded>`,
    `<excerpt:encoded><![CDATA[]]></excerpt:encoded>`,
    `<wp:post_id>${ids.attachment}</wp:post_id>`,
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
    `<wp:attachment_url>${xmlEscape(img.url)}</wp:attachment_url>`
  ].join('');
  return `<item>${body}</item>`;
}

// --------------------- main ---------------------
(function main() {
  const files = walkHtmlFiles(INPUT);
  if (!files.length) {
    console.error('No HTML files found under:', INPUT);
    process.exit(1);
  }

  const mapping = loadMapping(MAP_PATH);

  // Collections
  const products = [];
  const terms = {
    product_cat: new Map(), // slug -> name
    product_tag: new Map()
  };

  for (const file of files) {
    const html = fs.readFileSync(file, 'utf8');
    const $ = cheerio.load(html, { decodeEntities: false });

    const host = findHostname($);
    const map = pickMappingForHost(mapping, host);
    const p = extractProduct($, map, BASE_URL);
    if (!p.name) {
      // eslint-disable-next-line no-console
      console.warn(`SKIP (no Name): ${file}`);
      continue;
    }

    // Register terms
    p.categories.forEach(name => {
      const slug = slugify(name);
      if (!terms.product_cat.has(slug)) terms.product_cat.set(slug, name);
    });
    p.tags.forEach(name => {
      const slug = slugify(name);
      if (!terms.product_tag.has(slug)) terms.product_tag.set(slug, name);
    });

    // Filter image URLs and de-dup
    const seen = new Set();
    p.images = p.images.filter(u => {
      const ok = !!u && /^https?:\/\//i.test(u);
      if (!ok) return false;
      if (seen.has(u)) return false;
      seen.add(u);
      return true;
    });

    products.push(p);
    // eslint-disable-next-line no-console
    console.log(`OK: ${path.basename(file)} -> ${p.name}`);
  }

  if (!products.length) {
    console.error('No products extracted. Check your mapping selectors.');
    process.exit(2);
  }

  // Assign IDs
  let nextId = 10000;
  const itemsXml = [];
  const dates = nowDates();

  // Emit top-level terms
  const allTermObjs = [
    ...Array.from(terms.product_cat.values()).map(name => termObject('product_cat', name)),
    ...Array.from(terms.product_tag.values()).map(name => termObject('product_tag', name))
  ];

  // Emit products + attachments
  for (const p of products) {
    const postId = nextId++;
    let thumbnailId = null;

    // Attachments
    const attachmentIds = [];
    for (const [i, url] of p.images.entries()) {
      const attId = nextId++;
      attachmentIds.push(attId);
      const imgXml = attachmentItemXml({ url }, { attachment: attId }, postId, AUTHOR, dates);
      itemsXml.push(imgXml);
      if (i === 0) thumbnailId = attId;
    }

    const prodXml = productItemXml(p, { post: postId }, thumbnailId, AUTHOR, dates);
    // Place product before its attachments? WP importer handles any order, but we’ll keep product first for readability.
    itemsXml.unshift(prodXml);
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
  <title>${cdata('WooCommerce Import')}</title>
  <link>${xmlEscape(SITE_URL)}</link>
  <description>${cdata('Generated from mirrored HTML')}</description>
  <pubDate>${xmlEscape(dates.rfc2822)}</pubDate>
  <language>en</language>
  <wp:wxr_version>1.2</wp:wxr_version>
  <wp:base_site_url>${xmlEscape(SITE_URL)}</wp:base_site_url>
  <wp:base_blog_url>${xmlEscape(SITE_URL)}</wp:base_blog_url>
  ${allTermObjs.map(termXml).join('\n  ')}
`;

  const footer = `
</channel>
</rss>
`;

  const xml = header + '\n' + itemsXml.join('\n') + footer;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, xml, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`\nWrote ${products.length} products (+ attachments) to ${OUT}`);
})();
