/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

// Shopify expects:
// - Theme Liquid files (sections/snippets/templates) for theme integration
// - OR CSV for product import (Admin > Products > Import)
// Here we generate both: basic Liquid sections/snippets for pages and a products.csv

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function toCsvRow(fields) {
  return fields.map(f => {
    if (f == null) return '';
    const s = String(f);
    if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }).join(',');
}

function exportProductsCsv(entities, outDir) {
  const rows = [];
  const header = [
    'Handle','Title','Body (HTML)','Vendor','Type','Tags',
    'Published','Option1 Name','Option1 Value','Variant SKU','Variant Price','Variant Currency',
    'Image Src','Image Alt Text'
  ];
  rows.push(toCsvRow(header));
  for (const e of entities.filter(x => x.type === 'product')) {
    const handle = e.id;
    const vendor = e.brand || '';
    const type = e.categories?.[0] || '';
    const tags = (e.categories || []).join(';');
    const published = 'TRUE';
    const mainImg = e.images?.[0]?.src || '';
    const alt = e.images?.[0]?.alt || '';
    const sku = e.sku || '';
    const price = e.price != null ? e.price : '';
    const currency = e.currency || '';

    // minimal single-variant line
    const row = [
      handle, e.title, e.html, vendor, type, tags,
      published, 'Title', 'Default', sku, price, currency,
      mainImg, alt
    ];
    rows.push(toCsvRow(row));

    // optional: emit variant rows if provided
    for (const v of e.variants || []) {
      const vRow = [
        handle, '', '', '', '', '',
        '', 'Title', v.option1 || 'Default', v.sku || '', v.price ?? '', currency,
        (v.image || ''), ''
      ];
      rows.push(toCsvRow(vRow));
    }
  }
  const csvPath = path.join(outDir, 'products.csv');
  fs.writeFileSync(csvPath, rows.join('\n'), 'utf8');
  return csvPath;
}

function exportPagesAsLiquidSections(entities, themeDir) {
  // Output: sections/captured-page-<slug>.liquid that renders the captured HTML
  const sectionsDir = path.join(themeDir, 'sections');
  const snippetsDir = path.join(themeDir, 'snippets');
  ensureDir(sectionsDir);
  ensureDir(snippetsDir);

  const made = [];
  for (const e of entities.filter(x => x.type === 'page')) {
    const file = path.join(sectionsDir, `captured-page-${e.id}.liquid`);
    const liquid = `{% comment %} Auto-generated from capture: ${e.url || ''} {% endcomment %}
<section class="captured-page">
  <div class="container">
    ${e.html}
  </div>
</section>`;
    fs.writeFileSync(file, liquid, 'utf8');
    made.push(file);
  }
  // simple product snippet
  const productSnippet = `{% comment %} Auto-generated product card {% endcomment %}
<div class="product-card">
  <a href="{{ product.url | default: '#' }}">
    {% if product.featured_image %}
      <img src="{{ product.featured_image | img_url: '600x' }}" alt="{{ product.title | escape }}">
    {% endif %}
    <h3>{{ product.title }}</h3>
    {% if product.price %}<p>{{ product.price | money }}</p>{% endif %}
  </a>
</div>`;
  fs.writeFileSync(path.join(snippetsDir, 'captured-product-card.liquid'), productSnippet, 'utf8');

  return made;
}

function exportShopify(entities, outRoot) {
  const themeDir = path.join(outRoot, 'shopify-theme');
  ensureDir(themeDir);
  const createdSections = exportPagesAsLiquidSections(entities, themeDir);
  const csv = exportProductsCsv(entities, outRoot);
  return { themeDir, createdSections, productsCsv: csv };
}

module.exports = { exportShopify };
