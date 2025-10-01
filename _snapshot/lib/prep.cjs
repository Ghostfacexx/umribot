/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function slugify(s = '') {
  return String(s).toLowerCase().replace(/https?:\/\//, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 80);
}

function slugFromUrl(url, relPath) {
  if (relPath && relPath !== 'index') return slugify(relPath);
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/\/+$/, '') || 'index';
    return slugify(p === '/' ? 'index' : p);
  } catch {
    return slugify(relPath || 'index');
  }
}

/* ---------- Shopify: write Liquid section per page (desktop only recommended) ---------- */
function prepWriteShopify(html, url, outRoot, relPath) {
  const slug = slugFromUrl(url, relPath);
  const themeDir = path.join(outRoot, '_prep', 'shopify-theme');
  const sectionsDir = path.join(themeDir, 'sections');
  ensureDir(sectionsDir);
  const file = path.join(sectionsDir, `captured-page-${slug}.liquid`);
  const content = `{% comment %} Auto-generated from ${url} {% endcomment %}
<section class="captured-page">
  <div class="container">
${html}
  </div>
</section>`;
  fs.writeFileSync(file, content, 'utf8');
}

/* ---------- WooCommerce: collect pages into a WXR ---------- */
function escapeXml(s = '') {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

function collectWooPage(buffer, { title, url, id }, html) {
  buffer.items.push({ title, url, id, html });
}

function finalizeWoo(outRoot, buffer) {
  if (!buffer || !buffer.items || buffer.items.length === 0) return null;
  const outDir = path.join(outRoot, '_prep', 'woocommerce');
  ensureDir(outDir);
  const nowIso = new Date().toISOString();

  const itemsXml = buffer.items.map((p, idx) => `
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
    <wp:post_date_gmt>${nowIso}</wp:post_date_gmt>
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
    <title>Imported Site</title>
    <link>https://example.com</link>
    <description>WXR export</description>
    <pubDate>${new Date().toUTCString()}</pubDate>
    <wp:wxr_version>1.2</wp:wxr_version>
${itemsXml}
  </channel>
</rss>`;
  const wxrPath = path.join(outDir, 'wordpress-pages-wxr.xml');
  fs.writeFileSync(wxrPath, xml, 'utf8');
  return wxrPath;
}

module.exports = {
  prepWriteShopify,
  collectWooPage,
  finalizeWoo,
  slugFromUrl
};
