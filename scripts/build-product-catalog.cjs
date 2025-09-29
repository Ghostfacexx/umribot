#!/usr/bin/env node
/**
 * Build a minimal product catalog from mirrored OpenCart HTML.
 * Output JSON keyed by product_id with title, slug, image, and price (if found).
 *
 * Usage:
 *   node scripts/build-product-catalog.cjs \
 *     --in downloaded_pages/teashop.bg-... \
 *     --out out/product-catalog.json \
 *     --prefer-profile desktop \
 *     --verbose
 *
 * Requires: npm i transliteration cheerio
 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { slugify: tslug } = require('transliteration');

function parseArgs(argv){const a={};for(let i=2;i<argv.length;i++){const k=argv[i];if(k.startsWith('--')){const n=k.slice(2);const v=argv[i+1]&&!argv[i+1].startsWith('--')?argv[++i]:true;a[n]=v;}}return a;}
const args=parseArgs(process.argv);
const INPUT=args.in||args.input;
const OUT=args.out||'out/product-catalog.json';
const VERBOSE=!!args.verbose;
const PREFER=(args['prefer-profile']||'').toLowerCase(); // desktop|mobile|''

if(!INPUT){console.error('Error: --in <dir> is required');process.exit(1);}

function walk(root){const out=[];function rec(p){const st=fs.statSync(p);if(st.isDirectory()){for(const n of fs.readdirSync(p))rec(path.join(p,n));}else if(st.isFile()&&/\.html?$/i.test(p)){out.push(p);}}rec(root);return out;}

function text(el){return (el.text()||'').replace(/\s+/g,' ').trim();}
function bestDetailTitle($){
  return text($('h1').first()) ||
         ($('meta[property="og:title"]').attr('content')||'').trim() ||
         ($('title').text()||'').trim() ||
         ($('img[alt]').attr('alt')||'').trim() ||
         ($('img[title]').attr('title')||'').trim();
}
function bestCardTitle($card){
  const a = $card.find('h4 a').first();
  const h4 = $card.find('h4').first();
  const t = (a.text()||h4.text()||'').replace(/\s+/g,' ').trim();
  if (t) return t;
  const img = $card.find('img[alt],img[title]').first();
  return (img.attr('alt')||img.attr('title')||'').trim();
}
function slugifyBG(s){
  return tslug(String(s||'').replace(/\u00A0/g,' ').trim(), { lowercase:true, separator:'-', trim:true }) || 'product';
}

const files=walk(INPUT);
const catalog={}; // { id: { id, title, slug, image, price } }

function ensure(pid, title, image, price, src){
  if(!pid || !title) return;
  if(!catalog[pid]){
    const slug = slugifyBG(title);
    catalog[pid] = { id: pid, title, slug, image: image||'', price: price||'' };
    if (VERBOSE) console.log(`CAT: ${pid} -> ${title} | ${slug} [${src}]`);
  } else {
    // Fill any missing fields
    if (!catalog[pid].image && image) catalog[pid].image = image;
    if (!catalog[pid].price && price) catalog[pid].price = price;
  }
}

for(const f of files){
  if(PREFER==='desktop' && /\/mobile\//i.test(f)) continue;
  if(PREFER==='mobile' && /\/desktop\//i.test(f)) continue;

  const html = fs.readFileSync(f,'utf8');
  const $ = cheerio.load(html,{ decodeEntities:false });

  // Detail page
  const pidDetail = ($('input[name="product_id"]').attr('value')||'').trim();
  if (pidDetail) {
    const title = bestDetailTitle($);
    // First image in thumbnails or main image
    let image = $('ul.thumbnails img').first().attr('src') || $('img').first().attr('src') || '';
    image = image.trim();
    ensure(pidDetail, title, image, '', path.relative(INPUT,f));
  }

  // Grids
  $('[class*="product-thumb"],[class*="product-layout"],[class*="product-grid"]').each((_,card)=>{
    const $card=$(card);
    let pid='';
    $card.find('[onclick]').each((__,el)=>{
      const on=String($(el).attr('onclick')||'');
      const m=on.match(/cart\.add\(['"](\d+)['"]/i);
      if (m){ pid=m[1]; return false; }
    });
    if(!pid){
      const d=$card.attr('data-product-id')||$card.find('[data-product-id]').attr('data-product-id')||'';
      if(d) pid=String(d).trim();
    }
    if (!pid) return;

    const title = bestCardTitle($card);
    const image = ($card.find('img').first().attr('src')||'').trim();
    // Price text inside .price
    const price = ($card.find('.price').first().text()||'').replace(/\s+/g,' ').trim();
    if (title) ensure(pid, title, image, price, path.relative(INPUT,f)+' [grid]');
  });
}

fs.mkdirSync(path.dirname(OUT), { recursive:true });
fs.writeFileSync(OUT, JSON.stringify(catalog, null, 2), 'utf8');
console.log(`Wrote ${Object.keys(catalog).length} products to ${OUT}`);