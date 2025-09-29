/* Extract products from captured HTML:
   - schema.org JSON-LD
   - Open Graph product tags
   - OpenCart product pages (index.php?route=product/product&product_id=...)
   - OpenCart category listings (index.php?route=product/category&path=...)  <-- listing cards
*/
const cheerio = require('cheerio');

function asArray(x){ return Array.isArray(x) ? x : (x!=null ? [x] : []); }
function unwrap(x){
  if (x==null) return '';
  if (typeof x==='string' || typeof x==='number') return String(x);
  if (Array.isArray(x)) return x.map(unwrap).filter(Boolean).join(', ');
  if (typeof x==='object') return unwrap(x.text || x['@value'] || x.name || '');
  return '';
}

/* JSON-LD */
function readJSONLD($){
  const out=[];
  $('script[type="application/ld+json"]').each((_,el)=>{
    const t=$(el).contents().text();
    if(!t) return;
    try{ out.push(JSON.parse(t)); }catch{}
  });
  return out;
}
function walkProducts(node, acc){
  if (!node || typeof node !== 'object') return;
  const t=node['@type']; const arr=t ? (Array.isArray(t)?t:[t]) : [];
  if (arr.map(x=>String(x).toLowerCase()).includes('product')) acc.push(node);
  for (const k of Object.keys(node)){
    const v=node[k];
    if (Array.isArray(v)) v.forEach(ch=>walkProducts(ch,acc));
    else if (v && typeof v==='object') walkProducts(v,acc);
  }
}
function pickPrice(n){
  const offers = asArray(n.offers || n.offer || n.Offers);
  let price='', currency='';
  for (const ofr of offers){
    if (!ofr) continue;
    if (ofr.price != null) price = String(ofr.price);
    if (ofr.priceCurrency) currency = String(ofr.priceCurrency);
    const ps = ofr.priceSpecification || ofr.priceSpecs;
    if (ps){
      const a = asArray(ps);
      for (const p of a){
        if (p && p.price != null) price = String(p.price);
        if (p && p.priceCurrency) currency = String(p.priceCurrency);
      }
    }
    if (price) break;
  }
  if (!price && n.offers && n.offers.lowPrice) price = String(n.offers.lowPrice);
  if (!currency && n.offers && n.offers.priceCurrency) currency = String(n.offers.priceCurrency);
  return { price, currency };
}
function fromJSONLD($, pageUrl){
  const nodes=[];
  for (const d of readJSONLD($)){
    if(!d) continue;
    if (Array.isArray(d)) d.forEach(x=>walkProducts(x,nodes));
    else if (d['@graph']) walkProducts(d['@graph'], nodes);
    else walkProducts(d,nodes);
  }
  const out=[];
  for (const n of nodes){
    const images = asArray(n.image || n.images || (n.photo && n.photo.contentUrl)).map(String);
    const { price, currency } = pickPrice(n);
    out.push({ url:pageUrl, source:'jsonld', title: unwrap(n.name)||'', description: unwrap(n.description)||'', sku: unwrap(n.sku)||'', brand: unwrap(n.brand && (n.brand.name||n.brand))||'', category: unwrap(n.category)||'', price, currency, images });
  }
  return out;
}

/* Open Graph */
function fromOG($, pageUrl){
  const og = p => $(`meta[property="${p}"]`).attr('content') || '';
  if (!/product/i.test(og('og:type')||'')) return [];
  const title = og('og:title') || $('title').first().text() || '';
  const description = og('og:description') || '';
  const image = og('og:image') || '';
  const price = $(`meta[property="product:price:amount"]`).attr('content') || '';
  const currency = $(`meta[property="product:price:currency"]`).attr('content') || '';
  const sku = $(`meta[property="product:retailer_item_id"]`).attr('content') || '';
  return [{ url:pageUrl, source:'og', title, description, sku, price, currency, images: image ? [image] : [] }];
}

/* OpenCart product page */
function fromOpenCartProduct($, pageUrl){
  const url = new URL(pageUrl);
  const route = url.searchParams.get('route') || '';
  if (!/product\/product/i.test(route)) return [];
  const title = $('#content h1').first().text().trim() || $('h1').first().text().trim() || '';
  let price = $('#content .price .price-new').first().text().trim()
           || $('#content .price').first().text().trim()
           || $('.list-unstyled h2').first().text().trim()
           || $('#price').first().text().trim()
           || '';
  let currency=''; const m=price.match(/([€$£]|BGN|USD|EUR)/i); if (m) currency=m[1].toUpperCase().replace(/[^A-Z]/g,'');
  let description = $('#tab-description').html() || $('#description').html() || $('#content .tab-content').first().html() || ''; description = description ? description.trim() : '';
  let sku=''; $('#content .list-unstyled li').each((_,li)=>{ const t=$(li).text().trim(); if(/model/i.test(t)||/sku/i.test(t)){ sku=t.replace(/^\s*(model|sku)\s*[:\-]?\s*/i,'').trim(); } });
  let category=''; const crumbs=$('.breadcrumb li a').map((_,a)=>$(a).text().trim()).get().filter(Boolean); if(crumbs.length>=2) category=crumbs.slice(1).slice(0,-1).join(' > ') || crumbs.slice(-2,-1)[0] || '';
  const imagesSet=new Set();
  $('#content .thumbnail a, #content .thumbnails a, a.thumbnail, .image a').each((_,a)=>{ const href=$(a).attr('href'); if(href) imagesSet.add(href); });
  $('#content img, .product-images img, .image img').each((_,img)=>{ const src=$(img).attr('src'); if(src) imagesSet.add(src); const d=$(img).attr('data-zoom-image')||$(img).attr('data-large-src'); if(d) imagesSet.add(d); });
  const images=Array.from(imagesSet);
  if (!title) return [];
  return [{ url:pageUrl, source:'opencart', title, description, sku, category, price, currency, images }];
}

/* OpenCart category listing (listing cards on category pages) */
function fromOpenCartCategory($, pageUrl){
  const url = new URL(pageUrl);
  const route = url.searchParams.get('route') || '';
  if (!/product\/category/i.test(route)) return [];
  const out = [];
  const cards = $('.product-layout, .product-thumb, .product-grid .product, .product-list .product');
  cards.each((_, el) => {
    const $el = $(el);
    const link = $el.find('a').filter((_,x)=>/route=product\/product/i.test($(x).attr('href')||'')).first();
    const title = ($el.find('h4 a').text().trim()
                || $el.find('.caption a').first().text().trim()
                || $el.find('a').first().text().trim());
    const href = link.attr('href') || '';
    const price = ($el.find('.price .price-new').first().text().trim()
                || $el.find('.price').first().text().trim()
                || '').replace(/\s+/g,' ').trim();
    const img = ($el.find('img').attr('data-src') || $el.find('img').attr('src') || '').trim();
    if (!title) return;

    let currency=''; const m=price.match(/([€$£]|BGN|USD|EUR)/i); if (m) currency=m[1].toUpperCase().replace(/[^A-Z]/g,'');

    out.push({
      url: href || pageUrl,
      source: 'opencart-category',
      title,
      description: '',
      sku: '',
      brand: '',
      category: '',
      price,
      currency,
      images: img ? [img] : []
    });
  });
  return out;
}

function extractProductsFromHTML(html, pageUrl){
  const $ = cheerio.load(html, { decodeEntities:false });

  // Best ? fallback chain
  let products = fromJSONLD($, pageUrl);
  if (!products.length) products = fromOG($, pageUrl);
  if (!products.length) products = fromOpenCartProduct($, pageUrl);
  if (!products.length) products = fromOpenCartCategory($, pageUrl);

  const seen=new Set(); const out=[];
  for (const p of products){
    const key = (p.sku && p.sku.trim())
      ? `sku:${p.sku.trim().toLowerCase()}`
      : `u:${(p.url||pageUrl)}/${(p.title||'').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

module.exports = { extractProductsFromHTML };