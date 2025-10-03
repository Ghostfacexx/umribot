#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * lib/deep-discover.cjs
 *
 * Category- and product-aware discovery that runs to "completion":
 *  - Exhaust categories (including pagination).
 *  - Visit all discovered product pages.
 *  - Respects same-site rules and optional allow/deny regexes.
 *  - Uses Playwright with stealth and light "humanization".
 *
 * Inputs:
 *   deepDiscover({
 *     startUrls: string[],               // initial seeds
 *     outDir: string,                    // run dir for _crawl outputs
 *     isSameSite: (url)=>boolean,        // same-site check supplied by archiver
 *     options: {
 *       engine: 'chromium'|'firefox'|'webkit',
 *       headless: boolean,
 *       stealth: boolean,
 *       pageWaitUntil: 'domcontentloaded'|'load'|'networkidle',
 *       navTimeout: number,
 *       waitAfterLoad: number,
 *       denyRegex?: string,
 *       allowRegex?: string,
 *       productLinkSelector?: string,    // override for product links on category pages
 *       categoryLinkSelector?: string,   // override for category links from home/menus
 *       nextPageSelectors?: string[],    // override for pagination "next"
 *       maxTotalPages?: number,          // 0 = unlimited
 *       stagnationRounds?: number,       // stop when no new URLs N rounds (default 3)
 *       stopFilePath?: string            // optional STOP file path to end early
 *     }
 *   })
 *
 * Output:
 *   {
 *     seeds: string[]  // final "complete" list: categories + products (+ some info pages)
 *   }
 */

const fs = require('fs');
const path = require('path');
const { chromium, firefox, webkit } = require('playwright');

function envB(v, def=false){ return v==null ? def : /^(1|true|yes|on)$/i.test(String(v)); }
function ensureDir(d){ fs.mkdirSync(d,{recursive:true}); }
function uniq(a){ return [...new Set(a)]; }
function normalizeUrl(u){ try{ const x=new URL(u); x.hash=''; return x.toString().replace(/(?<!:)\/$/,''); }catch{ return null; } }
function stopRequested(p){ if(!p) return false; try{ return fs.existsSync(p); }catch{ return false; } }

function pickBrowser(engine){
  return engine==='firefox' ? firefox : engine==='webkit' ? webkit : chromium;
}

async function applyStealth(context){
  try {
    await context.addInitScript(()=>{ try{ Object.defineProperty(navigator,'webdriver',{get:()=>undefined}); }catch{} });
    await context.addInitScript(()=>{ try{ Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']}); }catch{} });
    await context.addInitScript(()=>{ try{ Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5]}); }catch{} });
    await context.addInitScript(()=>{
      try{
        const gp = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(p){
          if(p===37445) return 'Intel Inc.'; if(p===37446) return 'Intel Iris OpenGL Engine';
          return gp.apply(this,[p]);
        };
      }catch{}
    });
  } catch {}
}

function rint(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }
async function humanize(page){
  try{
    const w=1366,h=900;
    const steps=rint(2,4);
    await page.mouse.move(rint(10,w-10), rint(10,h-10), { steps:rint(8,16) });
    for(let i=0;i<steps;i++){
      await page.waitForTimeout(rint(100,260));
      await page.mouse.move(rint(10,w-10), rint(10,h-10), { steps:rint(5,10) });
      if(Math.random()<0.5){ await page.mouse.wheel({deltaY:rint(250,750)}); }
    }
  }catch{}
}

async function gotoSmart(page, url, waitUntil, navTimeout, waitAfterLoad){
  page.setDefaultNavigationTimeout(navTimeout);
  try {
    await page.goto(url, { waitUntil, timeout: navTimeout });
  } catch (e) {
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: Math.min(12000, navTimeout) });
      try { await page.waitForLoadState('domcontentloaded', { timeout: Math.min(8000, navTimeout) }); } catch {}
    } catch(e2){ throw e; }
  }
  if (waitAfterLoad>0) await page.waitForTimeout(waitAfterLoad);
  await humanize(page);
}

function compileRx(s){ if(!s) return null; try{ return new RegExp(s,'i'); }catch{ return null; } }

// Heuristics
function defaultProductLinkSelector(){
  // Links to PDP inside category/grid items
  return 'a[href*="/product/"], a[href*="product_id="], a[href*="/p/"], .product a[href]:not([href*="/cart"]):not([href*="wishlist"])';
}
function defaultNextPageSelectors(){
  return [
    'a[rel="next"]',
    '.pagination a.next, .pagination a[aria-label="Next"]',
    '.page-numbers .next',
    'a[href*="page="], a[href*="/page/"]'
  ];
}
const INFO_HINTS = ['about','contact','information','delivery','shipping','returns','policy','terms','privacy'];

function looksInfoUrl(url){ const u=String(url).toLowerCase(); return INFO_HINTS.some(h=>u.includes(h)); }
function looksProductUrl(url){
  const u=String(url).toLowerCase();
  return /product|\/p\/|product_id=|add-to-cart=/.test(u);
}
function looksCategoryUrl(url){
  const u=String(url).toLowerCase();
  return /(category|collections|shop|catalog|route=product\/category|\/c\/|\/collections\/)/.test(u) && !looksProductUrl(u);
}

async function extractAnchors(page){
  try {
    return await page.$$eval('a[href]', as => as.map(a=>a.href).filter(Boolean));
  } catch { return []; }
}

async function isProductPage(page){
  // Heuristics: JSON-LD Product, add-to-cart button, obvious PDP markers
  try{
    const hasJsonLd = await page.$$eval('script[type="application/ld+json"]', ns=>{
      return ns.some(n=>{
        try{ const j=JSON.parse(n.textContent||'{}'); const t=Array.isArray(j)? j.map(x=>x['@type']).join(','):j['@type']; return /Product/i.test(String(t||'')); }catch{ return false; }
      });
    }).catch(()=>false);
    if (hasJsonLd) return true;
  }catch{}
  const selectors = [
    '#button-cart', '.single_add_to_cart_button', 'button[name="button-add-to-cart"]',
    'form.cart', '.product-form__cart-submit', 'button.add-to-cart'
  ];
  for (const sel of selectors){
    try{ if (await page.locator(sel).first().count() > 0) return true; }catch{}
  }
  return false;
}

async function findProductLinksOnCategory(page, overrideSelector){
  let urls = [];
  const selector = overrideSelector || defaultProductLinkSelector();
  try {
    const anchors = await page.$$eval(selector, as => as.map(a=>a.href).filter(Boolean));
    urls.push(...anchors);
  } catch {}
  // Fallback: scan anchors and keep those with “product-like” path
  const all = await extractAnchors(page);
  urls.push(...all.filter(looksProductUrl));
  return uniq(urls);
}

async function findNextPageLinks(page, overrideSelectors){
  const sels = overrideSelectors && overrideSelectors.length ? overrideSelectors : defaultNextPageSelectors();
  let outs = [];
  for (const sel of sels){
    try {
      const links = await page.$$eval(sel, as => as.map(a=>a.href).filter(Boolean));
      outs.push(...links);
    } catch {}
  }
  // De-duplicate, normalize
  return uniq(outs.map(normalizeUrl).filter(Boolean));
}

async function findCategoryLinks(page, overrideSelector){
  let out = [];
  if (overrideSelector) {
    try{ out = await page.$$eval(overrideSelector, as=>as.map(a=>a.href).filter(Boolean)); }catch{}
  } else {
    // Heuristic: menu/nav, obvious category paths; avoid account/cart/etc
    const all = await extractAnchors(page);
    out = all.filter(looksCategoryUrl);
  }
  return uniq(out);
}

function withinLimits(count, maxTotal){ return maxTotal<=0 ? true : count < maxTotal; }

async function deepDiscover({ startUrls, outDir, isSameSite, options={} }){
  const {
    engine='chromium',
    headless=true,
    stealth=true,
    pageWaitUntil='domcontentloaded',
    navTimeout=15000,
    waitAfterLoad=500,
    denyRegex='',
    allowRegex='',
    productLinkSelector='',
    categoryLinkSelector='',
    nextPageSelectors=[],
    maxTotalPages=0,             // 0 = unlimited
    stagnationRounds=3,
    stopFilePath=''
  } = options;

  const allowRx = compileRx(allowRegex);
  const denyRx  = compileRx(denyRegex);

  function urlAllowed(u){
    if (!u) return false;
    try {
      if (!isSameSite(u)) return false;
      const n = normalizeUrl(u); if(!n) return false;
      if (allowRx && !allowRx.test(n)) return false;
      if (denyRx && denyRx.test(n)) return false;
      return true;
    } catch { return false; }
  }

  const browserType = pickBrowser(engine);
  const browser = await browserType.launch({ headless, args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({ viewport:{width:1366,height:900}, locale:'en-US' });
  if (stealth) await applyStealth(context);

  const allSeen = new Set();              // all normalized URLs seen
  const categoriesVisited = new Set();    // categories we processed
  const productsVisited = new Set();      // product PDPs processed
  const infoKept = new Set();             // a few info pages
  const queue = [];                       // { url, type: 'home'|'category'|'product', depth }

  // Seed normalization and classification
  for (const raw of uniq(startUrls||[])){
    const n = normalizeUrl(raw); if(!n) continue;
    if (!urlAllowed(n)) continue;
    allSeen.add(n);
    const type = looksProductUrl(n) ? 'product' : looksCategoryUrl(n) ? 'category' : 'home';
    queue.push({ url: n, type, depth: 0 });
  }

  let processedCount = 0;
  let roundsWithoutNew = 0;
  let discoveredNewInRound = false;

  async function processHomeOrCategory(item){
    if (categoriesVisited.has(item.url)) return;
    const page = await context.newPage();
    try{
      await gotoSmart(page, item.url, pageWaitUntil, navTimeout, waitAfterLoad);

      // If home, try to find top-level categories
      if (item.type === 'home'){
        const cats = (await findCategoryLinks(page, categoryLinkSelector)).filter(urlAllowed);
        for (const c of cats){
          if(!allSeen.has(c)){
            allSeen.add(c);
            queue.push({ url:c, type:'category', depth: item.depth+1 });
            discoveredNewInRound = true;
          }
        }
      }

      // Treat the page as a category (home may also be a category)
      const productLinks = (await findProductLinksOnCategory(page, productLinkSelector)).filter(urlAllowed);
      for (const p of productLinks){
        if(!allSeen.has(p)){
          allSeen.add(p);
          queue.push({ url: p, type:'product', depth: item.depth+1 });
          discoveredNewInRound = true;
        }
      }
      const nexts = (await findNextPageLinks(page, nextPageSelectors)).filter(urlAllowed);
      for (const nx of nexts){
        if(!allSeen.has(nx)){
          allSeen.add(nx);
          queue.push({ url: nx, type:'category', depth: item.depth+1 });
          discoveredNewInRound = true;
        }
      }

      // Keep a few info pages encountered
      const anchors = await extractAnchors(page);
      for (const a of anchors){
        const n = normalizeUrl(a);
        if (!n) continue;
        if (!urlAllowed(n)) continue;
        if (looksInfoUrl(n) && !infoKept.has(n)){
          infoKept.add(n);
          discoveredNewInRound = true;
        }
      }
    } finally {
      try { await page.close(); } catch {}
    }
    categoriesVisited.add(item.url);
    processedCount++;
  }

  async function processProduct(item){
    if (productsVisited.has(item.url)) return;
    const page = await context.newPage();
    try{
      await gotoSmart(page, item.url, pageWaitUntil, navTimeout, waitAfterLoad);
      // Sanity check PDP; If it’s actually a grid, it will be picked up by category logic elsewhere.
      const pdp = await isProductPage(page);
      if (!pdp){
        const anchors = await extractAnchors(page);
        for (const a of anchors){
          const n = normalizeUrl(a); if(!n) continue;
          if (!urlAllowed(n)) continue;
          if (looksProductUrl(n) && !allSeen.has(n)){
            allSeen.add(n);
            queue.push({ url:n, type:'product', depth:item.depth+1 });
            discoveredNewInRound = true;
          }
        }
      } else {
        try{
          const rel = await page.$$eval('a[href*="product"], a[href*="/p/"], a[href*="product_id="]', as=>as.map(a=>a.href).filter(Boolean).slice(0,40));
          for (const r of rel){
            const n = normalizeUrl(r); if(!n) continue;
            if (!urlAllowed(n)) continue;
            if (looksProductUrl(n) && !allSeen.has(n)){
              allSeen.add(n);
              queue.push({ url:n, type:'product', depth:item.depth+1 });
              discoveredNewInRound = true;
            }
          }
        }catch{}
      }
    } finally {
      try { await page.close(); } catch {}
    }
    productsVisited.add(item.url);
    processedCount++;
  }

  while (queue.length){
    if (stopRequested(stopFilePath)) break;
    if (!withinLimits(processedCount, maxTotalPages)) break;

    discoveredNewInRound = false;
    const item = queue.shift();
    if (!urlAllowed(item.url)) continue;

    if (item.type==='product' && productsVisited.has(item.url)) continue;
    if ((item.type==='category' || item.type==='home') && categoriesVisited.has(item.url)) continue;

    try {
      if (item.type === 'product') await processProduct(item);
      else await processHomeOrCategory(item);
    } catch (e) {
      console.log('[DEEP_DISCOVER_ERR]', item.url, e.message);
    }

    if (queue.length === 0){
      if (!discoveredNewInRound) roundsWithoutNew++;
      else roundsWithoutNew = 0;
      if (roundsWithoutNew >= stagnationRounds) break;
    }
  }

  try { await context.close(); } catch {}
  try { await browser.close(); } catch {}

  const seeds = uniq([
    ...categoriesVisited,
    ...productsVisited,
    ...Array.from(infoKept).slice(0, 50)
  ]);

  const crawlDir = path.join(outDir, '_crawl'); ensureDir(crawlDir);
  fs.writeFileSync(path.join(crawlDir, 'urls.txt'), seeds.join('\n')+'\n', 'utf8');
  fs.writeFileSync(path.join(crawlDir, 'report.json'), JSON.stringify({
    pagesProcessed: processedCount,
    categories: categoriesVisited.size,
    products: productsVisited.size,
    infoKept: infoKept.size,
    seeds: seeds.length,
    stoppedEarly: stopRequested(stopFilePath),
    ts: new Date().toISOString()
  }, null, 2), 'utf8');

  console.log('[DEEP_DISCOVER_DONE]', { processedCount, categories: categoriesVisited.size, products: productsVisited.size, seeds: seeds.length });
  return { seeds };
}

module.exports = { deepDiscover };
