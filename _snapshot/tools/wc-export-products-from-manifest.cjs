#!/usr/bin/env node
/**
 * Build WooCommerce CSV products directly from manifest.json URLs (teashop.bg / OpenCart).
 * - De-duplicates desktop/mobile by product_id + path (prefers --prefer-profile=desktop).
 * - Absolutizes image URLs using the page <base> or the page URL.
 *
 * Usage:
 *   node tools/wc-export-products-from-manifest.cjs \
 *     --manifest "/root/SingleFile/single-file-cli/downloaded_pages/teashop.bg-2025-09-28-1827-6eia/manifest.json" \
 *     --out out/teashop-products.csv \
 *     --map wc-products-mapping.json \
 *     --prefer-profile desktop
 *
 * Requires: Node 18+ and: npm i cheerio
 */
const fs = require('fs');
const path = require('path');
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
const MANIFEST = args.manifest;
const OUT = args.out || 'out/products.csv';
const MAP_PATH = args.map || 'wc-products-mapping.json';
const PREFER_PROFILE = (args['prefer-profile'] || 'desktop').toLowerCase(); // desktop|mobile

if (!MANIFEST) {
  console.error('Error: --manifest <path/to/manifest.json> is required');
  process.exit(1);
}
if (!fs.existsSync(MAP_PATH)) {
  console.error(`Error: mapping file not found at ${MAP_PATH}`);
  process.exit(1);
}

function loadMapping(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function normalizeSpaces(s){ return s ? s.replace(/\s+/g,' ').trim() : ''; }
function cleanPrice(raw){
  if (!raw) return '';
  const s = String(raw).replace(/[\s\u00A0]/g,'')
    .replace(/[,](?=\d{3}\b)/g,'')
    .replace(/[^\d.,-]/g,'');
  if (s.includes('.') && s.includes(',')) return s.replace(/,/g,'');
  if (!s.includes('.') && s.includes(',')) return s.replace(/,/g,'.');
  return s;
}
function xmlBaseFrom($, fallbackUrl) {
  const base = $('base').attr('href') ||
               $('link[rel="canonical"]').attr('href') ||
               $('meta[property="og:url"]').attr('content') ||
               fallbackUrl || '';
  try { return new URL(base).toString(); } catch { return fallbackUrl || ''; }
}
function absolutize(u, baseUrl) {
  if (!u) return '';
  try { return new URL(u).toString(); }
  catch { try { return new URL(u, baseUrl).toString(); } catch { return u; } }
}
function selectOne($, selector) {
  if (!selector) return '';
  for (const part of selector.split('||').map(s=>s.trim()).filter(Boolean)) {
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
  const seen = new Set();
  return results.filter(v => (seen.has(v) ? false : (seen.add(v), true)));
}
function stringifyCsv(rows) {
  const esc = v => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  };
  const header = Object.keys(rows[0] || {});
  return [ header.map(esc).join(','), ...rows.map(r => header.map(h => esc(r[h])).join(',')) ].join('\n');
}
function pickTeashopMap(mapping) {
  // Favor teashop.bg domain-specific mapping if present
  const base = mapping.default?.product || {};
  const t = mapping.byDomain?.['teashop.bg']?.product || {};
  return {...base, ...t};
}
function productKeyFromUrl(uStr) {
  try {
    const u = new URL(uStr);
    const pid = u.searchParams.get('product_id') || '';
    // Use host+path to separate sites; include pid if present; otherwise fallback to full URL.
    if (pid) return `${u.host}${u.pathname}?pid=${pid}`;
    return u.toString();
  } catch {
    return uStr;
  }
}
async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      'accept-language': 'bg-BG,bg;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

(async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const raw = manifest.filter(e => /route=product\/product/i.test(e.finalURL));

  if (!raw.length) {
    console.error('No product/product URLs found in manifest.');
    process.exit(2);
  }

  // De-duplicate by key; prefer desktop over mobile for each key
  const buckets = new Map(); // key -> {entry}
  for (const e of raw) {
    const key = productKeyFromUrl(e.finalURL);
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, e);
    } else {
      const preferNew = (PREFER_PROFILE === 'desktop')
        ? (e.profile === 'desktop' && existing.profile !== 'desktop')
        : (e.profile === 'mobile' && existing.profile !== 'mobile');
      if (preferNew) buckets.set(key, e);
    }
  }
  const entries = Array.from(buckets.values());
  console.log(`Found ${raw.length} product URLs in manifest; ${entries.length} after ${PREFER_PROFILE}-preferred de-duplication.`);

  const mapping = loadMapping(MAP_PATH);
  const m = pickTeashopMap(mapping);

  const rows = [];
  let i = 0;
  for (const entry of entries) {
    i++;
    const url = entry.finalURL;
    try {
      const html = await fetchHtml(url);
      const $ = cheerio.load(html, { decodeEntities: false });

      const baseForAbs = xmlBaseFrom($, url);

      const name = normalizeSpaces(selectOne($, m.name));
      if (!name) { console.warn(`SKIP (no name): ${url}`); continue; }

      const sku = selectOne($, m.sku) || '';
      const priceReg = cleanPrice(selectOne($, m.price_regular));
      const priceSale = cleanPrice(selectOne($, m.price_sale));
      const descHtml = selectOne($, m.description_html) || '';
      const shortDescHtml = selectOne($, m.short_description_html) || '';
      const cats = selectAll($, m.categories, normalizeSpaces);
      const tags = selectAll($, m.tags, normalizeSpaces);
      const images = selectAll($, m.images, v => absolutize(v, baseForAbs)).filter(u => /^https?:\/\//i.test(u));

      const inStockSel = m.in_stock;
      const inStock = inStockSel ? Boolean(selectOne($, inStockSel)) : undefined;

      rows.push({
        'Name': name,
        'Type': 'simple',
        'SKU': sku || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48),
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
      });

      console.log(`OK [${i}/${entries.length}]: ${name}`);
    } catch (err) {
      console.warn(`ERR: ${url} -> ${err.message}`);
    }
  }

  if (!rows.length) {
    console.error('No products extracted from URLs. Check mapping selectors.');
    process.exit(3);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const csv = stringifyCsv(rows);
  fs.writeFileSync(OUT, csv, 'utf8');
  console.log(`\nWrote ${rows.length} products to ${OUT}`);
})();