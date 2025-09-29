#!/usr/bin/env node
/**
 * WooCommerce CSV exporter for mirrored product pages.
 *
 * Usage:
 *   node wc-export.cjs --in downloaded_pages --out out/products.csv --map wc-mapping.json [--base-url https://mirror.example.com]
 *
 * Notes:
 * - Requires: cheerio (npm i cheerio)
 * - No other runtime deps. CSV writer implemented below.
 * - CSV headers match WooCommerce importer expectations for simple products.
 * - Mapping is domain-aware. If canonical URL or og:url exists, hostname drives selection.
 * - If images are relative, provide --base-url to absolutize; otherwise ensure mirrored HTML has absolute URLs.
 *
 * Output columns (subset, extensible):
 *   Name, Type, SKU, Published, Visibility in catalog, Short description, Description,
 *   Regular price, Sale price, In stock?, Stock, Categories, Tags, Images,
 *   Attribute 1 name, Attribute 1 value(s), Attribute 1 visible, Attribute 1 global,
 *   Attribute 2 name, Attribute 2 value(s), Attribute 2 visible, Attribute 2 global
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

function walkHtmlFiles(root) {
  const out = [];
  function recur(p) {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p)) {
        recur(path.join(p, name));
      }
    } else if (st.isFile()) {
      const ext = path.extname(p).toLowerCase();
      if (ext === '.html' || ext === '.htm') out.push(p);
    }
  }
  const exists = fs.existsSync(root);
  if (!exists) return out;
  const st = exists ? fs.statSync(root) : null;
  if (st && st.isFile()) {
    const ext = path.extname(root).toLowerCase();
    if (ext === '.html' || ext === '.htm') return [root];
  }
  recur(root);
  return out;
}

function loadMapping(mapPath) {
  const raw = fs.readFileSync(mapPath, 'utf8');
  const cfg = JSON.parse(raw);
  return cfg;
}

function findHostname($) {
  const cand =
    $('link[rel="canonical"]').attr('href') ||
    $('meta[property="og:url"]').attr('content') ||
    $('meta[name="og:url"]').attr('content') ||
    $('meta[property="twitter:url"]').attr('content') ||
    $('meta[name="twitter:url"]').attr('content') ||
    '';
  try {
    if (!cand) return '';
    const u = new URL(cand);
    return u.hostname || '';
  } catch {
    return '';
  }
}

function absolutize(urlStr, baseUrl) {
  if (!urlStr) return '';
  try {
    // Already absolute
    const u = new URL(urlStr);
    return u.toString();
  } catch {
    // Relative
    if (!baseUrl) return urlStr;
    try {
      return new URL(urlStr, baseUrl).toString();
    } catch {
      return urlStr;
    }
  }
}

function selectOne($, selector) {
  if (!selector) return '';
  // Support OR selectors with "||"
  for (const part of selector.split('||').map(s => s.trim()).filter(Boolean)) {
    // Support "sel@attr" notation
    const atIdx = part.lastIndexOf('@');
    if (atIdx > 0) {
      const sel = part.slice(0, atIdx).trim();
      const attr = part.slice(atIdx + 1).trim();
      const el = $(sel).first();
      if (el && el.length) {
        if (attr === 'text') {
          const v = el.text().trim();
          if (v) return v;
        } else {
          const v = el.attr(attr);
          if (v) return String(v).trim();
        }
      }
    } else {
      const el = $(part).first();
      if (el && el.length) {
        const v = el.text().trim();
        if (v) return v;
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
        const $el = $(el);
        let v = attr === 'text' ? $el.text() : $el.attr(attr);
        if (v != null) {
          v = String(v).trim();
          if (v) results.push(mapFn(v));
        }
      });
    } else {
      $(part).each((_, el) => {
        const v = $(el).text().trim();
        if (v) results.push(mapFn(v));
      });
    }
    if (results.length) break; // stop at first part producing results
  }
  // De-dup while preserving order
  const seen = new Set();
  const unique = [];
  for (const r of results) {
    if (!seen.has(r)) {
      seen.add(r);
      unique.push(r);
    }
  }
  return unique;
}

function cleanPrice(raw) {
  if (!raw) return '';
  // Remove currency symbols and thousands separators, normalize decimal
  const s = String(raw)
    .replace(/[\s\u00A0]/g, '')
    .replace(/[,](?=\d{3}\b)/g, '') // 1,234 -> 1234
    .replace(/[^\d.,-]/g, '');
  // If both , and . exist, assume . is decimal (US/Intl) and remove ,
  if (s.includes('.') && s.includes(',')) {
    return s.replace(/,/g, '');
  }
  // If only , exists, assume it is decimal separator
  if (!s.includes('.') && s.includes(',')) {
    return s.replace(/,/g, '.');
  }
  return s;
}

function boolToWoo(val) {
  return val ? 1 : 0;
}

function stringifyCsv(rows) {
  // Simple CSV stringifier that handles quotes and newlines.
  const escape = v => {
    if (v == null) return '';
    const s = String(v);
    if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const header = Object.keys(rows[0] || {});
  const lines = [];
  lines.push(header.map(escape).join(','));
  for (const r of rows) {
    lines.push(header.map(h => escape(r[h])).join(','));
  }
  return lines.join('\n');
}

function normalizeSpaces(s) {
  return s ? s.replace(/\s+/g, ' ').trim() : '';
}

function toCategories(list) {
  // Convert breadcrumb-style arrays to Woo format: "Parent > Child, Another"
  // Accept already formatted strings too.
  if (!list || list.length === 0) return '';
  if (typeof list === 'string') return list;
  // Assume deepest item is actual category; optionally join full chain
  // Here we join full chain per item if list looks like multiple paths
  // For simple breadcrumb, just use the last item:
  const last = list[list.length - 1];
  return normalizeSpaces(last);
}

function buildAttributes(attrDefs, $, baseUrl, cfgAttrs = []) {
  // cfgAttrs: [{ name, selector, attr(optional), delimiter(optional) }]
  // Returns array of attribute objects ready to be mapped to columns
  const out = [];
  for (const def of cfgAttrs) {
    const values = selectAll($, `${def.selector}${def.attr ? '@' + def.attr : '@text'}`)
      .map(v => v.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (values.length) {
      out.push({
        name: def.name,
        values: Array.from(new Set(values)).join(', '),
        visible: 1,
        global: 0
      });
    }
  }
  return out;
}

function pickMappingForHost(mapping, host) {
  if (mapping.byDomain && mapping.byDomain[host]) {
    // Deep merge default -> domain
    return {
      product: {
        ...(mapping.default?.product || {}),
        ...(mapping.byDomain[host].product || {})
      }
    };
  }
  return { product: mapping.default?.product || {} };
}

function extractProduct($, map, baseUrl) {
  const prod = {};
  const m = map.product || {};
  const name = selectOne($, m.name);
  const skuRaw = selectOne($, m.sku);
  const sku = skuRaw || '';
  const priceReg = cleanPrice(selectOne($, m.price_regular));
  const priceSale = cleanPrice(selectOne($, m.price_sale));
  const descHtml = selectOne($, m.description_html);
  const shortDescHtml = selectOne($, m.short_description_html);
  const cats = selectAll($, m.categories, normalizeSpaces);
  const tags = selectAll($, m.tags, normalizeSpaces);
  let images = selectAll($, m.images, v => v);
  // Absolutize images if a base URL is provided or meta URL found:
  const base =
    $('base').attr('href') ||
    $('meta[property="og:url"]').attr('content') ||
    $('link[rel="canonical"]').attr('href') ||
    baseUrl ||
    '';
  images = images
    .map(src => absolutize(src, base))
    .filter((v, i, a) => v && a.indexOf(v) === i);

  const inStockSel = m.in_stock;
  const inStock =
    inStockSel ? Boolean(selectOne($, inStockSel)) : '';

  const attrs = buildAttributes(m, $, baseUrl, m.attributes || []);

  // Build CSV row
  const row = {
    'Name': normalizeSpaces(name),
    'Type': 'simple',
    'SKU': sku,
    'Published': 1,
    'Visibility in catalog': 'visible',
    'Short description': shortDescHtml || '',
    'Description': descHtml || '',
    'Regular price': priceReg || '',
    'Sale price': priceSale || '',
    'In stock?': inStock === '' ? '' : boolToWoo(inStock),
    'Stock': '', // optional; leave blank if unknown
    'Categories': toCategories(cats),
    'Tags': tags.join(', '),
    'Images': images.join(', ')
  };

  // Attributes -> Attribute N columns
  attrs.forEach((a, idx) => {
    const n = idx + 1;
    row[`Attribute ${n} name`] = a.name;
    row[`Attribute ${n} value(s)`] = a.values;
    row[`Attribute ${n} visible`] = a.visible;
    row[`Attribute ${n} global`] = a.global;
  });

  // If no SKU, optionally generate a deterministic one from name
  if (!row['SKU'] && row['Name']) {
    row['SKU'] = row['Name'].toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48);
  }

  return row;
}

async function main() {
  const args = parseArgs(process.argv);
  const inputPath = args.in || args.input;
  const outPath = args.out || args.output || 'products.csv';
  const mapPath = args.map || 'wc-mapping.json';
  const baseUrl = args['base-url'] || args.base || '';

  if (!inputPath) {
    console.error('Error: --in <file-or-dir> is required');
    process.exit(1);
  }
  if (!fs.existsSync(mapPath)) {
    console.error(`Error: mapping file not found at ${mapPath}`);
    process.exit(1);
  }

  const mapping = loadMapping(mapPath);
  const files = walkHtmlFiles(inputPath);
  if (!files.length) {
    console.error('No HTML files found under:', inputPath);
    process.exit(1);
  }

  const rows = [];
  for (const f of files) {
    const html = fs.readFileSync(f, 'utf8');
    const $ = cheerio.load(html, { decodeEntities: false });
    const host = findHostname($);
    const map = pickMappingForHost(mapping, host);

    const row = extractProduct($, map, baseUrl);
    if (row['Name']) {
      rows.push(row);
      // eslint-disable-next-line no-console
      console.log(`OK: ${path.basename(f)} -> ${row['Name']}`);
    } else {
      // eslint-disable-next-line no-console
      console.warn(`SKIP (no Name): ${f}`);
    }
  }

  if (!rows.length) {
    console.error('No products extracted. Check your mapping selectors.');
    process.exit(2);
  }

  // Ensure consistent headers across rows
  const headers = new Set();
  for (const r of rows) Object.keys(r).forEach(k => headers.add(k));
  const headerList = Array.from(headers);

  // Normalize rows to have same keys
  const normalized = rows.map(r => {
    const o = {};
    headerList.forEach(h => { o[h] = r[h] ?? ''; });
    return o;
  });

  const csv = stringifyCsv(normalized);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, csv, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`\nWrote ${rows.length} products to ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});