#!/usr/bin/env node
/**
 * Build product-id -> slug map from mirrored OpenCart HTML.
 * Sources:
 *  - Product detail: input[name="product_id"], h1/og:title/title, image alt/title
 *  - Category grids: cart.add('ID', ...) + <h4> or image alt/title inside the card
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
const OUT=args.out||'out/product-map.json';
const VERBOSE=!!args.verbose;
const PREFER=(args['prefer-profile']||'').toLowerCase(); // desktop|mobile|''

if(!INPUT){console.error('Error: --in <dir> is required');process.exit(1);}

function walk(root){const out=[];function rec(p){const st=fs.statSync(p);if(st.isDirectory()){for(const n of fs.readdirSync(p))rec(path.join(p,n));}else if(st.isFile()&&/\.html?$/i.test(p)){out.push(p);}}rec(root);return out;}

function safeText($,sel){const el=$(sel).first();return (el.text()||'').replace(/\s+/g,' ').trim();}
function bestTitle($){
  return safeText($,'h1') ||
         $('meta[property="og:title"]').attr('content') ||
         ($('title').text()||'').trim() ||
         $('img[alt]').attr('alt') ||
         $('img[title]').attr('title') || '';
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
  // transliteration’s slugify handles Cyrillic cleanly
  return tslug(String(s||'').replace(/\u00A0/g,' ').trim(), { lowercase:true, separator:'-', trim:true }) || 'product';
}

const files=walk(INPUT);
const map={};
function setMap(pid,title,src){
  if(!pid) return;
  const slug=slugifyBG(title);
  if(!map[pid]){
    map[pid]=slug;
    if(VERBOSE) console.log(`MAP: product_id=${pid} -> slug=${slug} [${src}]`);
  }
}

for(const f of files){
  if(PREFER==='desktop' && /\/mobile\//i.test(f)) continue;
  if(PREFER==='mobile' && /\/desktop\//i.test(f)) continue;

  const html=fs.readFileSync(f,'utf8');
  const $=cheerio.load(html,{decodeEntities:false});

  // 1) Product detail page
  const pidDetail=($('input[name="product_id"]').attr('value')||'').trim();
  if(pidDetail){
    const title = bestTitle($);
    if(title) setMap(pidDetail,title,path.relative(INPUT,f));
  }

  // 2) Product/category grids
  $('[class*="product-thumb"],[class*="product-layout"],[class*="product-grid"]').each((_,card)=>{
    const $card=$(card);
    // product_id from cart.add('ID',...)
    let pid='';
    $card.find('[onclick]').each((__,el)=>{
      const on=String($(el).attr('onclick')||'');
      const m=on.match(/cart\.add\(['"](\d+)['"]/i);
      if(m){pid=m[1];return false;}
    });
    if(!pid){
      const d=$card.attr('data-product-id')||$card.find('[data-product-id]').attr('data-product-id')||'';
      if(d) pid=String(d).trim();
    }
    if(!pid) return;

    const title = bestCardTitle($card);
    if(title) setMap(pid,title,path.relative(INPUT,f)+' [grid]');
  });
}

fs.mkdirSync(path.dirname(OUT),{recursive:true});
fs.writeFileSync(OUT,JSON.stringify(map,null,2),'utf8');
console.log(`Wrote ${Object.keys(map).length} product mappings to ${OUT}`);