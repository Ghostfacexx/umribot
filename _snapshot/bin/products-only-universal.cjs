#!/usr/bin/env node
/**
 * Universal products-only → Woo runner (no page mirroring)
 * - Discovers product URLs via API → Sitemaps → Pattern learning → Safe ID enumeration
 * - Fetches product pages HTTP-first; Playwright fallback only when needed (assets blocked)
 * - Extracts products with lib/product-extract.cjs
 * - Writes _data/products.ndjson
 *
 * Usage:
 *   node bin/products-only-universal.cjs <seed_url> <run_dir> [max_products]
 */
const fs = require('fs');
const path = require('path');
const { fetchHTML, looksLikeHTML } = require('../lib/http-fetch.cjs');
const { discoverFromSitemaps } = require('../lib/discovery/sitemap.cjs');
const { learnProductPatterns, htmlDecodeEntities } = require('../lib/discovery/patterns.cjs');
const { extractIds, deriveRangeFrom, buildUrls } = require('../lib/discovery/id-enum.cjs');
const { chromium } = require('playwright');

const seedRaw = process.argv[2];
const runDir  = process.argv[3];
const MAX_PRODUCTS = parseInt(process.argv[4] || process.env.MAX_PRODUCTS || '2000',10);
if (!seedRaw || !runDir){ console.error('Usage: node bin/products-only-universal.cjs <seed_url> <run_dir> [max_products]'); process.exit(2); }

let SEED = seedRaw; try { SEED = new URL(seedRaw).toString(); } catch { SEED = 'https://' + seedRaw.replace(/^https?:\/\//,''); }
const ORIGIN = (()=>{ try{ return new URL(SEED).origin; }catch{return ''; }})();
const CONC = parseInt(process.env.CONCURRENCY || '12', 10);
const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT_MS || '9000', 10);
const WAIT_EXTRA = parseInt(process.env.WAIT_EXTRA || '30', 10);

const extractor = require(path.join(process.cwd(), 'lib', 'product-extract.cjs'));
const outDataDir = path.join(runDir, '_data');
const outNdjson = path.join(outDataDir, 'products.ndjson');

function ensureDir(d){ fs.mkdirSync(d,{recursive:true}); }
function writeVisited(list){
  ensureDir(path.join(runDir,'_crawl'));
  fs.writeFileSync(path.join(runDir,'_crawl','urls.txt'), list.join('\n')+'\n','utf8');
}

async function fetchJSON(u){
  try{
    const r = await fetchHTML(u, 7000, 'Mozilla/5.0 (UniversalProducts)');
    if (!r.ok) return null;
    const body = r.body.trim();
    return JSON.parse(body);
  }catch{return null;}
}

/* 1) API discoverer (Woo Store API) */
async function apiDiscoverWoo(origin, cap=MAX_PRODUCTS){
  const urls=[];
  try{
    // Try Woo store API (WC Blocks): /wp-json/wc/store/products?per_page=100&page=N
    for (let page=1; page<=20 && urls.length<cap; page++){
      const u = new URL('/wp-json/wc/store/products', origin);
      u.searchParams.set('per_page','100'); u.searchParams.set('page', String(page));
      const js = await fetchJSON(u.toString());
      if (!Array.isArray(js) || !js.length) break;
      for (const it of js){
        const link = it?.permalink || it?.permalink_url || it?.url;
        if (link) urls.push(link);
      }
    }
  }catch{}
  return Array.from(new Set(urls));
}

/* 2) Sitemap discoverer */
async function sitemapDiscover(origin){
  const urls = await discoverFromSitemaps(origin, 10000);
  // Keep only likely product URLs (simple heuristic: have at least 2 path segments or 'product' in path)
  return urls.filter(u=>{
    try{ const U=new URL(u); return /product|shop|catalog|collections/i.test(U.pathname) || U.pathname.split('/').filter(Boolean).length>=2; }catch{return false;}
  });
}

/* 3) Pattern learner */
async function patternDiscover(seed){
  const urls = await learnProductPatterns(seed, 40);
  return urls;
}

/* 4) Safe ID enumeration (only when product_id/id patterns exist in samples) */
function maybeBuildEnumUrls(sampleHtml, origin){
  const ids = extractIds(sampleHtml || '');
  if (!ids.length) return [];
  const range = deriveRangeFrom(ids) || { min:1, max:500 };
  const paramName = /(?:\?|&|&amp;)id=/.test(sampleHtml) ? 'id' : 'product_id';
  return buildUrls(origin, paramName, range);
}

/* Fetch + extract */
const visited=new Set(), visitOrder=[], seenKeys=new Set();
function addProductRows(items, pageUrl){
  if (!Array.isArray(items) || !items.length) return 0;
  ensureDir(outDataDir);
  let added=0;
  for (const p of items){
    const key = (p.sku && String(p.sku).trim())
      ? `sku:${String(p.sku).trim().toLowerCase()}`
      : `u:${(p.url || pageUrl)}/${(p.title||'').toLowerCase()}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    fs.appendFileSync(outNdjson, JSON.stringify(p)+'\n','utf8');
    added++;
  }
  return added;
}

async function newContext(){
  const browser = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ userAgent:'Mozilla/5.0 (UniversalProducts)' });
  await ctx.route('**/*', route => {
    const t=route.request().resourceType();
    if (t==='image'||t==='font'||t==='stylesheet'||t==='media') return route.abort();
    route.continue();
  });
  return { browser, ctx };
}

async function fetchHTMLFast(u){
  const r=await fetchHTML(u, 7000);
  if (looksLikeHTML(r)) return r.body;
  return '';
}

async function processUrls(urls){
  const queue = urls.slice(0, MAX_PRODUCTS*3);
  let pw = null;

  async function fetchHTMLWithFallback(u){
    const body = await fetchHTMLFast(u);
    if (body) return body;
    if (!pw) pw=await newContext();
    const page = await pw.ctx.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);
    try{ await page.goto(u,{waitUntil:'domcontentloaded'}); if (WAIT_EXTRA>0) await page.waitForTimeout(WAIT_EXTRA); return await page.content(); }catch{ return ''; }
    finally{ try{ await page.close(); }catch{} }
  }

  const workers=[];
  for(let i=0;i<Math.max(1,CONC);i++){
    workers.push((async()=>{
      while(queue.length && seenKeys.size < MAX_PRODUCTS){
        const u = queue.shift();
        if (!u || visited.has(u)) continue;
        visited.add(u); visitOrder.push(u);
        try{
          const html = await fetchHTMLWithFallback(u);
          if (!html) { console.log('[U_PROD][err] empty', u); continue; }

          // opportunistic product_id scan to build more product detail URLs
          const ids = extractIds(html);
          if (ids.length){
            const more = buildUrls(ORIGIN, /(?:\?|&)id=/.test(u)?'id':'product_id', { min:Math.min(...ids.map(x=>+x)), max:Math.max(...ids.map(x=>+x)) });
            for (const m of more){ if (!visited.has(m)) queue.push(m); }
          }

          const items = extractor.extractProductsFromHTML(html, u);
          const added = addProductRows(items, u);
          if (added) console.log(`[U_PROD][+${added}] ${u}`);
        }catch(e){ console.log('[U_PROD][err]', u, e.message); }
      }
    })());
  }
  await Promise.all(workers);
  if (pw){ try{ await pw.ctx.close(); }catch{} try{ await pw.browser.close(); }catch{} }
  writeVisited(visitOrder);
}

(async ()=>{
  // Stage A: get candidate product URLs with multiple discoverers
  const candidates = new Set();

  // API (Woo store) — best quality if present
  try{
    const apiUrls = await apiDiscoverWoo(ORIGIN, MAX_PRODUCTS*2);
    apiUrls.forEach(u=>candidates.add(u));
    if (candidates.size >= MAX_PRODUCTS) {
      await processUrls(Array.from(candidates).slice(0, MAX_PRODUCTS*2));
      console.log('[U_PROD_DONE] products=', seenKeys.size, 'out=', outNdjson);
      return;
    }
  }catch{}

  // Sitemaps
  try{
    const siteUrls = await sitemapDiscover(ORIGIN);
    siteUrls.forEach(u=>candidates.add(u));
  }catch{}

  // Pattern learning from pages
  try{
    const patUrls = await patternDiscover(SEED);
    patUrls.forEach(u=>candidates.add(u));
  }catch{}

  // If we still have too few, try safe ID enumeration derived from a sample page
  let enumUrls=[];
  if (candidates.size < Math.max(50, Math.floor(MAX_PRODUCTS/3))){
    try{
      const r = await fetchHTML(SEED, 7000);
      const enumFromSeed = r && r.ok ? maybeEnumFromHTML(r.body) : [];
      enumUrls = enumFromSeed;
    }catch{}
  }

  function maybeEnumFromHTML(html){
    const ids = extractIds(html||'');
    if (!ids.length) return [];
    const range = deriveRangeFrom(ids) || { min:1, max:500 };
    // pick param by evidence in html
    const param = /(?:\?|&|&amp;)id=/.test(html) ? 'id' : 'product_id';
    return buildUrls(ORIGIN, param, range);
  }

  const initialList = Array.from(new Set([...candidates, ...enumUrls])).slice(0, MAX_PRODUCTS*3);
  console.log('[U_PROD_DISCOVERED]', { candidates:candidates.size, enum:enumUrls.length, queued:initialList.length });

  // Stage B: fetch + extract
  await processUrls(initialList);

  console.log('[U_PROD_DONE] products=', seenKeys.size, 'out=', outNdjson);
})();
