/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function toCsvRow(fields) {
  return fields.map(f => {
    if (f == null) return '';
    const s = String(f);
    if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }).join(',');
}

// WooCommerce product CSV columns (minimal)
const WC_HEADER = [
  'ID','Type','SKU','Name','Published','Visibility in catalog','Short description','Description',
  'Tax status','In stock?','Regular price','Sale price','Categories','Tags','Images'
];

function exportWooProductsCsv(entities, outDir) {
  const rows = [toCsvRow(WC_HEADER)];
  for (const e of entities.filter(x => x.type === 'product')) {
    const images = (e.images || []).map(x => x.src).join(','); // Woo supports comma-separated
    const row = [
      '', 'simple', e.sku || '', e.title || '', 1, 'visible', '',
      e.html || '', 'taxable', 1, e.price != null ? e.price : '', '',
      (e.categories || []).join(','),
      (e.metadata?.tags || []).join(','),
      images
    ];
    rows.push(toCsvRow(row));
  }
  const csvPath = path.join(outDir, 'woocommerce-products.csv');
  fs.writeFileSync(csvPath, rows.join('\n'), 'utf8');
  return csvPath;
}

// WXR for pages (WordPress eXtended RSS)
function exportWxrPages(entities, outDir, site = { title: 'Imported Site', url: 'https://example.com' }) {
  const pages = entities.filter(x => x.type === 'page');
  const now = new Date().toISOString();
  const items = pages.map((p, idx) => `
  <item>
    <title>${escapeXml(p.title || p.id)}</title>
    <link>${escapeXml(p.url || '')}</link>
    <pubDate>${new Date().toUTCString()}</pubDate>
    <dc:creator><![CDATA[admin]]></dc:creator>
    <guid isPermaLink="false">${escapeXml(`imported-${p.id}`)}</guid>
    <description></description>
    <content:encoded><![CDATA[${p.html}]]></content:encoded>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <wp:post_id>${10000 + idx}</wp:post_id>
    <wp:post_date_gmt>${now}</wp:post_date_gmt>
    <wp:post_type>page</wp:post_type>
    <wp:status>publish</wp:status>
  </item>`).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:wfw="http://wellformedweb.org/CommentAPI/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <title>${escapeXml(site.title)}</title>
    <link>${escapeXml(site.url)}</link>
    <description>WXR export</description>
    <pubDate>${new Date().toUTCString()}</pubDate>
    <wp:wxr_version>1.2</wp:wxr_version>
${items}
  </channel>
</rss>`;
  const wxrPath = path.join(outDir, 'wordpress-pages-wxr.xml');
  fs.writeFileSync(wxrPath, xml, 'utf8');
  return wxrPath;
}

function escapeXml(s='') {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

function exportWooCommerce(entities, outRoot) {
  const outDir = path.join(outRoot, 'woocommerce');
  ensureDir(outDir);
  const csv = exportWooProductsCsv(entities, outDir);
  const wxr = exportWxrPages(entities, outDir);
  return { outDir, productsCsv: csv, pagesWxr: wxr };
}

module.exports = { exportWooCommerce };
