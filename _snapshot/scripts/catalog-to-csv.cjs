#!/usr/bin/env node
/**
 * Convert product-catalog.json -> WooCommerce CSV
 * Columns: Name, Slug, SKU, Type, Status, Regular price, Images (optional)
 *
 * Usage:
 *   node scripts/catalog-to-csv.cjs out/product-catalog.json out/woo-products.csv [--no-images]
 *
 * Input JSON (from build-product-catalog.cjs):
 * {
 *   "120": { "id":"120", "title":"ЙОГА ЧАЙ /АЮРВЕДА/", "slug":"yoga-chay-ayurveda", "image":"https://...", "price":"5.40 лв. (2.76€)" },
 *   ...
 * }
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const inPath  = args[0] || 'out/product-catalog.json';
const outPath = args[1] || 'out/woo-products.csv';
const NO_IMAGES = args.includes('--no-images');

if (!fs.existsSync(inPath)) {
  console.error('Input JSON not found:', inPath);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));

function priceBGNToNumber(s) {
  if (typeof s !== 'string') return '';
  const m = s.match(/(\d+(?:[.,]\d+)?)/); // first number like 5.40 or 5,40
  return m ? m[1].replace(',', '.') : '';
}

const headers = ['Name','Slug','SKU','Type','Status','Regular price'];
if (!NO_IMAGES) headers.push('Images');

const rows = [headers];

for (const [id, p] of Object.entries(data)) {
  const name  = p.title || p.slug || id;
  const slug  = p.slug || '';
  const sku   = id;                    // keep original OpenCart product_id as SKU
  const type  = 'simple';
  const status = 'publish';
  const price = priceBGNToNumber(p.price || '');

  const row = [name, slug, sku, type, status, price];
  if (!NO_IMAGES) row.push(p.image || '');
  rows.push(row);
}

const csv = rows.map(r => r.map(v => {
  const s = String(v ?? '');
  return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g,'""')}"` : s;
}).join(',')).join('\n');

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, csv, 'utf8');
console.log(`Wrote ${outPath} with ${rows.length - 1} rows. Images included: ${!NO_IMAGES}`);