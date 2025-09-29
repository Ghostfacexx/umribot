/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
let cheerio;
try { cheerio = require('cheerio'); } catch { console.warn('[platform/parse-html] Install cheerio: npm i cheerio'); }

const { page, product } = require('./schema.cjs');

function safeSlug(s='') {
  return String(s).toLowerCase().replace(/https?:\/\//,'').replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'').slice(0, 80);
}

function extractJsonLd($) {
  const blocks = $('script[type="application/ld+json"]').map((_, el) => $(el).contents().text()).get();
  const items = [];
  for (const txt of blocks) {
    try {
      const obj = JSON.parse(txt);
      if (Array.isArray(obj)) items.push(...obj);
      else items.push(obj);
    } catch {}
  }
  return items;
}

function parseHtmlFile(filePath, urlHint) {
  const html = fs.readFileSync(filePath, 'utf8');
  const $ = cheerio ? cheerio.load(html) : null;

  const title = $ ? ($('title').first().text().trim() || $('h1').first().text().trim() || path.basename(filePath)) : path.basename(filePath);
  const metaDesc = $ ? $('meta[name="description"]').attr('content') || '' : '';
  const canonical = $ ? $('link[rel="canonical"]').attr('href') || '' : '';
  const text = $ ? $('body').text().replace(/\s+/g, ' ').trim() : '';
  const images = $ ? $('img').map((_, el) => ({
    src: $(el).attr('src') || '',
    alt: ($(el).attr('alt') || '').trim()
  })).get() : [];

  const url = urlHint || canonical || '';
  const id = safeSlug(url || title || path.basename(filePath));

  // Detect product via JSON-LD first
  let isProduct = false, price = null, currency = 'USD', sku = '', brand = '', categories = [], variants = [];
  if ($) {
    const ld = extractJsonLd($);
    const prod = ld.find(x => {
      const t = Array.isArray(x['@type']) ? x['@type'] : [x['@type']];
      return t && t.some(y => String(y).toLowerCase() === 'product');
    });
    if (prod) {
      isProduct = true;
      sku = prod.sku || '';
      brand = typeof prod.brand === 'string' ? prod.brand : (prod.brand && prod.brand.name) || '';
      categories = Array.isArray(prod.category) ? prod.category : (prod.category ? [prod.category] : []);
      const offers = Array.isArray(prod.offers) ? prod.offers[0] : prod.offers;
      if (offers) {
        price = Number(offers.price) || null;
        currency = offers.priceCurrency || currency;
      }
      // variants placeholder (requires site-specific parsing; left empty here)
    }
  }

  if (isProduct) {
    return product(id, url, title, html, text, images, price, currency, sku, brand, categories, variants, { description: metaDesc, canonical });
  }
  return page(id, url, title, html, text, images, { description: metaDesc, canonical });
}

function parseRunDirectory(runDir) {
  // naive: collect top-level or nested index.html files
  const items = [];
  function walk(dir) {
    const list = fs.readdirSync(dir, { withFileTypes: true });
    for (const d of list) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        walk(p);
      } else if (d.isFile() && /\.(html?|xhtml)$/i.test(d.name)) {
        const urlHint = undefined; // could derive from a manifest you keep per page
        try {
          items.push(parseHtmlFile(p, urlHint));
        } catch (e) {
          console.warn('[parse-html] Failed', p, e.message);
        }
      }
    }
  }
  walk(runDir);
  return items;
}

module.exports = { parseRunDirectory, parseHtmlFile };
