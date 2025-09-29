#!/usr/bin/env node
/**
 * Export PRODUCTS to WooCommerce CSV from mirrored HTML.
 *
 * Usage:
 *   node wc-export-products-csv.cjs \
 *     --in downloaded_pages \
 *     --out out/products.csv \
 *     --map wc-products-mapping.json \
 *     --base-url https://teashop.bg/
 *
 * Requirements: npm i cheerio
 *
 * Notes:
 * - Detects product pages and skips non-products by default.
 *   Use --include-non-products to force extraction from every HTML file.
 * - CSV columns match WooCommerce CSV importer for simple products.
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
const OUT = args.out || args.output || 'out/products.csv';
const MAP_PATH = args.map || 'wc-products-mapping.json';
const BASE_URL = args['base-url'] || args.base || '';
const INCLUDE_NON_PRODUCTS = Boolean(args['include-non-products']);

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
function absolutize(urlStr, baseUrl) {
  if (!urlStr) return '';
  try { return new URL(urlStr).toString(); }
  catch { try { return new URL(urlStr, baseUrl).toString(); } catch { return urlStr; } }
}
function normalizeSpaces(s) { return s ? s.replace(/\s+/g, ' ').trim() : ''; }
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
function stringifyCsv(rows) {
  const esc = v => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = Object.keys(rows[0] || {});
  return [
    header.map(esc).join(','),
    ...rows.map(r => header.map(h => esc(r[h])).join(','))
  ].join('\n');
}

// --------------------- mapping helpers ---------------------
function loadMapping(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function findHostname($) {
  const cand =
    $('link[rel="canonical"]').attr('href') ||
    $('meta[property="og:url"]').attr('content') ||
    $('meta[name="og:url"]').attr('content') || '';
  try { return cand ? new URL(cand).hostname : ''; } catch { return ''; }
}
function pickMappingForHost(mapping, host) {
  if (mapping.byDomain) {
    if (mapping.byDomain[host]) {
      return { product: { ...(mapping.default?.product || {}), ...(mapping.byDomain[host].product || {}) } };
    }
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
function selectAll($, selector, mapFn = v => v) {
  if (!selector) return [];
  const parts = selector.split('||').map(s => s.trim()).filter(Boolean);
  const results = [];
  for (const part of parts) {
    const at = part.lastIndexOf('@');
    if (at > 0) {
      const sel = part.slice(0, at).trim();
      const attr = part.slice(at + 1).trim();
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
function isLikelyProduct($, m) {
  // Map-specific flag
  if (m?.is_product) {
    const sel = Array.isArray(m.is_product) ? m.is_product : [m.is_product];
    for (const s of sel) {
      if (s && $(s).length) return true;
    }
  }
  // Heuristics for Woo product templates
  return Boolean(
    $('.single-product').length ||
    $('.product').length && ($('.price').length || $('.woocommerce-product-gallery').length) ||
    $('meta[property="product:price:amount"]').length ||
    $('[itemtype*="Product"]').length
  );
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
  const images = selectAll($, m.images, v => absolutize(v, base))
    .filter(u => /^https?:\/\//i.test(u));

  const inStockSel = m.in_stock;
  const inStock = inStockSel ? Boolean(selectOne($, inStockSel)) : undefined;

  // Build Woo CSV row
  const row = {
    'Name': name,
    'Type': 'simple',
    'SKU': sku || (name ? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48) : ''),
    'Published': 1,
    'Visibility in catalog': 'visible',
    'Short description': shortDescHtml,
    'Description': descHtml,
    'Regular price': priceReg,
    'Sale price': priceSale,
    'In stock?': inStock === undefined ? '' : (inStock ? 1 : 0),
    'Stock': '',
    'Categories': cats.join(', '),
    'Tags': tags.join(', '),
    'Images': images.join(', ')
  };
  return row;
}

// --------------------- main ---------------------
(function main() {
  const mapping = loadMapping(MAP_PATH);
  const files = walkHtmlFiles(INPUT);
  if (!files.length) {
    console.error('No HTML files found under:', INPUT);
    process.exit(1);
  }
  const rows = [];
  for (const f of files) {
    const html = fs.readFileSync(f, 'utf8');
    const $ = cheerio.load(html, { decodeEntities: false });
    const host = findHostname($);
    const map = pickMappingForHost(mapping, host);
    if (!INCLUDE_NON_PRODUCTS && !isLikelyProduct($, map.product)) {
      continue;
    }
    const row = extractProduct($, map, BASE_URL);
    if (row['Name']) {
      rows.push(row);
      console.log(`PRODUCT: ${path.basename(f)} -> ${row['Name']}`);
    }
  }
  if (!rows.length) {
    console.error('No products extracted. Try --include-non-products or adjust selectors in wc-products-mapping.json.');
    process.exit(2);
  }
  // Normalize columns
  const headers = new Set();
  rows.forEach(r => Object.keys(r).forEach(k => headers.add(k)));
  const headerList = Array.from(headers);
  const normalized = rows.map(r => {
    const o = {};
    headerList.forEach(h => { o[h] = r[h] ?? ''; });
    return o;
  });
  const csv = stringifyCsv(normalized);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, csv, 'utf8');
  console.log(`\nWrote ${rows.length} products to ${OUT}`);
})();
