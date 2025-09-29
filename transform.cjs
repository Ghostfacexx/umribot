/**
 * transform.cjs (improved logo detection & replacement)
 *
 * Enhancements:
 *  - detectPrimaryLogo() scores candidates (id/class/alt/src containing "logo", brand hints,
 *    biggest width/height attributes).
 *  - replaceLogo() now replaces ALL <img> elements with the same original src (so header + sticky variants).
 *  - Returns replacedCount and candidate list length.
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

function findRootIndex(runDir){
  const flat = path.join(runDir,'index.html');
  if (fs.existsSync(flat)) {
    return { indexPath: flat, variant:'flat', assetsDir: path.join(runDir,'assets') };
  }
  const nested = path.join(runDir,'index','index.html');
  if (fs.existsSync(nested)) {
    return { indexPath: nested, variant:'nested', assetsDir: path.join(runDir,'index','assets') };
  }
  throw new Error('No index.html (flat or nested) in run: '+runDir);
}

function ensureOriginalBackup(indexPath){
  const d = path.dirname(indexPath);
  const backup = path.join(d,'index.original.html');
  if (!fs.existsSync(backup)){
    fs.copyFileSync(indexPath, backup);
  }
  return backup;
}

function loadBaseHTML(runDir){
  const { indexPath } = findRootIndex(runDir);
  const original = ensureOriginalBackup(indexPath);
  return fs.readFileSync(original,'utf8');
}

/* ---------- Improved Logo Detection ---------- */
function detectPrimaryLogo($){
  const brandHints = extractBrandHints($);
  const imgs = $('img[src]');
  const candidates = [];

  imgs.each((i,el)=>{
    const $el = $(el);
    const src = $el.attr('src') || '';
    if(!src) return;
    const id = ($el.attr('id')||'').toLowerCase();
    const cls = ($el.attr('class')||'').toLowerCase();
    const alt = ($el.attr('alt')||'').toLowerCase();
    const w = parseInt($el.attr('width')||'0',10);
    const h = parseInt($el.attr('height')||'0',10);

    let score = 0;

    // explicit logo keywords
    if(/logo/.test(id)) score += 40;
    if(/logo/.test(cls)) score += 40;
    if(/logo/.test(alt)) score += 30;
    if(/logo/.test(src)) score += 25;

    // brand name hints (from title / meta)
    for(const hint of brandHints){
      if(hint && alt.includes(hint)) score += 25;
      if(hint && src.toLowerCase().includes(hint)) score += 10;
    }

    // size - prefer something not tiny
    const area = (w||0)*(h||0);
    if (area > 0){
      if (area >= 5000) score += 15;
      else if (area >= 1000) score += 8;
    }

    // penalize data URIs or svg (if inline) (we still can replace, but less sure)
    if(/^data:/.test(src)) score -= 10;

    // store
    candidates.push({
      el:$el,
      src,
      score,
      width:w,
      height:h
    });
  });

  if(!candidates.length) return { primary:null, candidates:0 };

  candidates.sort((a,b)=> b.score - a.score);
  const primary = candidates[0];
  return { primary, candidates: candidates.length };
}

function extractBrandHints($){
  const hints = new Set();
  const title = $('title').first().text().trim();
  if(title){
    // take leading word(s) before dash or pipe
    const m = title.split(/[-|]/)[0].trim().toLowerCase();
    if(m && m.length<=30) hints.add(m.split(/\s+/)[0]);
  }
  // meta og:site_name
  const siteName = $('meta[property="og:site_name"]').attr('content');
  if(siteName) hints.add(siteName.trim().toLowerCase().split(/\s+/)[0]);
  return [...hints].filter(Boolean);
}

function replaceLogo($, newLogoRelPath){
  const det = detectPrimaryLogo($);
  if(!det.primary){
    return { replaced:false, oldSrc:null, candidates:0, replacedCount:0 };
  }
  const oldSrc = det.primary.src;
  let replacedCount=0;
  $('img[src]').each((i,el)=>{
    const $el=$(el);
    if(($el.attr('src')||'') === oldSrc){
      $el.attr('src', newLogoRelPath);
      $el.attr('data-tx','1');
      replacedCount++;
    }
  });
  return {
    replaced: replacedCount>0,
    oldSrc,
    candidates: det.candidates,
    replacedCount
  };
}

/* ---------- Names ---------- */
function transformNames($, nameOptions){
  if (!nameOptions) return { changed:0 };
  const {
    selectors = 'h1,.product-name,.product__title',
    prefix = '',
    suffix = '',
    regexFind = '',
    regexFlags = 'g',
    regexReplace = ''
  } = nameOptions;

  let changed=0;
  let rx=null;
  if (regexFind){
    try { rx=new RegExp(regexFind, regexFlags); } catch {}
  }

  selectors.split(',').map(s=>s.trim()).filter(Boolean).forEach(sel=>{
    $(sel).each((_,el)=>{
      let txt=$(el).text();
      if (!txt.trim()) return;
      if (rx) txt=txt.replace(rx, regexReplace);
      txt=prefix+txt+suffix;
      $(el).text(txt);
      $(el).attr('data-tx','1');
      changed++;
    });
  });
  return { changed };
}

/* ---------- Prices ---------- */
function parsePriceToken(tok){
  const normalized = tok.replace(/[^0-9.,]/g,'').replace(/,/g,'');
  if (!normalized) return null;
  const v = parseFloat(normalized);
  if (isNaN(v)) return null;
  return v;
}
function formatPrice(originalToken, newVal, currencySymbolOverride){
  const symMatch = originalToken.match(/^[\s]*([€$£]|USD|EUR|GBP)/i);
  const currency = currencySymbolOverride || (symMatch ? symMatch[1] : '');
  let s = newVal.toFixed(2);
  s = s.replace(/\B(?=(\d{3})+(?!\d))/g,',');
  return currency ? currency + s : s;
}
function transformPrices($, priceOptions){
  if (!priceOptions) return { changed:0 };
  const {
    percent=0,
    add=0,
    round=true,
    floor=false,
    ceil=false,
    currencySymbol=''
  } = priceOptions;
  if (percent===0 && add===0) return { changed:0 };

  const PRICE_REGEX=/(?:[€$£]|USD|EUR|GBP)?\s*\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?/g;
  let changed=0;

  $('body *').each((_,el)=>{
    const tag=(el.tagName||el.name||'').toLowerCase();
    if (['script','style','noscript'].includes(tag)) return;
    const node=$(el);
    let html=node.html();
    if (!html) return;
    let replaced=false;
    html=html.replace(PRICE_REGEX,(m)=>{
      const val=parsePriceToken(m);
      if (val==null) return m;
      let newVal = val * (1+percent/100) + add;
      if (floor) newVal=Math.floor(newVal);
      if (ceil) newVal=Math.ceil(newVal);
      if (round && !floor && !ceil) newVal=parseFloat(newVal.toFixed(2));
      replaced=true; changed++;
      return formatPrice(m,newVal,currencySymbol||'');
    });
    if (replaced){
      node.html(html);
      node.attr('data-tx','1');
    }
  });

  return { changed };
}

/* ---------- Main Transform ---------- */
function applyTransforms(runDir, actions, options={}){
  const { indexPath } = findRootIndex(runDir);
  const baseHTML = loadBaseHTML(runDir);
  const $ = cheerio.load(baseHTML, { decodeEntities:false });

  let priceResult={changed:0};
  let nameResult={changed:0};
  let logoResult={replaced:false};

  if (actions.price) priceResult=transformPrices($, actions.price);
  if (actions.name)  nameResult=transformNames($, actions.name);
  if (actions.logo && actions.logo.newFileName){
    const relLogo = path.join('assets', actions.logo.newFileName).replace(/\\/g,'/');
    logoResult=replaceLogo($, relLogo);
  }

  const transformed=$.html();
  if (!options.preview){
    const dir=path.dirname(indexPath);
    fs.writeFileSync(path.join(dir,'index.transformed.html'), transformed,'utf8');
    fs.writeFileSync(indexPath, transformed,'utf8');
  }

  return {
    preview: !!options.preview,
    price: priceResult,
    name: nameResult,
    logo: logoResult,
    indexPath
  };
}

/* ---------- Reset ---------- */
function resetTransforms(runDir){
  const { indexPath } = findRootIndex(runDir);
  const dir=path.dirname(indexPath);
  const original=path.join(dir,'index.original.html');
  if (!fs.existsSync(original)) throw new Error('No index.original.html backup found.');
  fs.copyFileSync(original, indexPath);
  return { restored:true, indexPath };
}

module.exports = {
  applyTransforms,
  resetTransforms,
  findRootIndex
};