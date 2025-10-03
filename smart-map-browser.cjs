#!/usr/bin/env node
/**
 * smart-map-browser.cjs
 * Build a curated seed list (plan-first) using a real browser (Playwright/Chromium).
 * Designed for JS-heavy/anti-bot sites where simple HTTP fetches fail.
 *
 * Env/options (via process.env):
 * - START_URLS: newline-separated start URLs (required)
 * - SAME_HOST_ONLY: 'true' | 'false' (default true)
 * - INCLUDE_SUBDOMAINS: 'true' | 'false' (default true)
 * - MAX_CATEGORIES: integer (default 50)
 * - MAX_CATEGORY_PAGES: integer (default 3)
 * - MAX_PRODUCTS_PER_CATEGORY: integer (default 200)
 * - ALLOW_REGEX: optional regex to include URLs
 * - DENY_REGEX: optional regex to exclude URLs
 * - PLATFORM_HINT: optional (opencart|woocommerce|shopify|magento|bigcommerce|auto)
 * - NEXT_PAGE_SELECTOR: optional CSS selector to find next-page link
 * - PAGE_PARAM: optional query param name for pagination (default 'page')
 * - PLAN_BROWSER_HEADLESS: 'true'|'false' (default 'false' for this script)
 * - PLAN_USER_AGENT: override UA
 * - PLAN_ACCEPT_LANGUAGE: e.g., 'en-US,en;q=0.9'
 * - PLAN_NAV_TIMEOUT_MS: per navigation timeout (default 25000)
 * - PLAN_WAIT_AFTER_MS: wait after navigation (default 1000)
 *
 * Usage: node tools/smart-map-browser.cjs <runDir>
 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { chromium } = require('playwright');

function die(msg){ console.error('[PLAN_ERR]', msg); process.exit(1); }
function log(...a){ console.log('[PLAN]', ...a); }
function exists(p){ try{ return fs.existsSync(p); }catch{ return false; } }
function ensureDir(p){ fs.mkdirSync(p,{ recursive:true }); }

function parseEnv(){
  const sameHostOnly = String(process.env.SAME_HOST_ONLY||'true').toLowerCase() !== 'false';
  const includeSubdomains = String(process.env.INCLUDE_SUBDOMAINS||'true').toLowerCase() !== 'false';
  const allowRx = (process.env.ALLOW_REGEX||'').trim();
  const denyRx = (process.env.DENY_REGEX||'').trim();
  const ua = (process.env.PLAN_USER_AGENT||'').trim();
  const lang = (process.env.PLAN_ACCEPT_LANGUAGE||'en-US,en;q=0.9').trim();
  const headlessStr = (process.env.PLAN_BROWSER_HEADLESS||'false').toLowerCase();
  const navTimeout = parseInt(process.env.PLAN_NAV_TIMEOUT_MS||'25000',10) || 25000;
  const waitAfter = parseInt(process.env.PLAN_WAIT_AFTER_MS||'1000',10) || 1000;
  const disableHttp2 = String(process.env.PLAN_DISABLE_HTTP2||'').toLowerCase()==='true';
  const proxyRaw = (process.env.PLAN_PROXY||'').trim();
  return {
    starts: String(process.env.START_URLS||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean),
    sameHostOnly,
    includeSubdomains,
    maxCategories: parseInt(process.env.MAX_CATEGORIES||'50',10) || 50,
    maxCategoryPages: parseInt(process.env.MAX_CATEGORY_PAGES||'3',10) || 3,
    maxProductsPerCategory: parseInt(process.env.MAX_PRODUCTS_PER_CATEGORY||'200',10) || 200,
    allowRegex: allowRx ? new RegExp(allowRx,'i') : null,
    denyRegex: denyRx ? new RegExp(denyRx,'i') : null,
    platformHint: (process.env.PLATFORM_HINT||'auto').toLowerCase(),
    nextPageSelector: (process.env.NEXT_PAGE_SELECTOR||'').trim(),
    pageParam: (process.env.PAGE_PARAM||'page').trim() || 'page',
    headless: (headlessStr!=='false'),
    userAgent: ua,
    acceptLanguage: lang,
    navTimeout,
    waitAfter,
    disableHttp2,
    proxyRaw
  };
}

function normalize(url){
  try{
    const u = new URL(url);
    u.hash='';
    if(u.pathname!=="/" && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/,'');
    return u.toString();
  }catch{ return url; }
}

function sameSiteCheck(url, base, sameHostOnly, includeSubdomains){
  try{
    const u = new URL(url, base);
    const b = new URL(base);
    if(u.protocol!==b.protocol) return false;
    if(u.hostname===b.hostname) return true;
    if(!sameHostOnly){ return u.origin===u.origin; }
    if(includeSubdomains){
      const strip = h=>h.replace(/^www\./i,'');
      const uh=strip(u.hostname), bh=strip(b.hostname);
      return uh===bh || uh.endsWith('.'+bh);
    }
    return false;
  }catch{ return false; }
}

function classifyHref(href, base, platform){
  try{
    const u = new URL(href, base);
    const qs = u.search || '';
    const route = (qs.match(/(?:^|[?&])route=([^&]+)/) || [,''])[1].toLowerCase();
    const isProductId = /(?:^|[?&])product_id=\d+/.test(qs);
    const p = u.pathname.toLowerCase();
    const host = u.hostname.toLowerCase();

    // OpenCart
    if(platform==='opencart' || platform==='auto'){
      if(route==='product/product' || isProductId) return 'product';
      if(route==='product/category') return 'category';
      if(route==='information/contact' || route==='information/information') return 'information';
    }
    // WooCommerce
    if(platform==='woocommerce' || platform==='auto'){
      if(/\/product\//.test(p)) return 'product';
      if(/\/(category|product-category)\//.test(p)) return 'category';
      if(/\/(about|contact|shipping|returns|privacy|terms)(?:\/|$)/.test(p)) return 'information';
    }
    // YNAP-style
    if(platform==='auto' || /theoutnet\.com$/.test(host) || /net-a-porter\.com$/.test(host) || /mrporter\.com$/.test(host)){
      if(/\/shop\/product\//.test(p)) return 'product';
      if(/\/shop(\/|$)/.test(p)) return 'category';
      if(/\/(help|contact|about|privacy|terms)(?:\/|$)/.test(p)) return 'information';
    }
    // Shopify
    if(platform==='shopify' || platform==='auto'){
      if(/\/products\//.test(p)) return 'product';
      if(/\/(collections|collections\/all|collections\/[^/]+)(?:\/|$)/.test(p)) return 'category';
      if(/\/(pages|policies)\//.test(p)) return 'information';
    }
    // Magento
    if(platform==='magento' || platform==='auto'){
      if(/\/product\//.test(p) || /\/(catalog\/product|\?product=)/.test(p)) return 'product';
      if(/\/(category|catalog\/category)\//.test(p)) return 'category';
      if(/\/(customer|checkout|cart|wishlist|account)(?:\/|$)/.test(p)) return 'other';
    }
    // BigCommerce
    if(platform==='bigcommerce' || platform==='auto'){
      if(/\/products\//.test(p)) return 'product';
      if(/\/(categories|category)\//.test(p)) return 'category';
      if(/\/(about|contact|shipping|returns|privacy|terms)(?:\/|$)/.test(p)) return 'information';
    }
    if(u.origin===new URL(base).origin && (u.pathname==='/' || /route=common\/home/.test(qs))) return 'home';
    return 'other';
  }catch{ return 'other'; }
}

function pickPlatform(html){
  const low = (html||'').toLowerCase();
  if(/opencart/i.test(low) || /route=product\//i.test(low)) return 'opencart';
  if(/woocommerce/i.test(low) || /wp-content\/plugins\/woocommerce/i.test(low)) return 'woocommerce';
  if(/shopify/i.test(low) || /cdn\.shopify\.com/i.test(low)) return 'shopify';
  if(/magento/i.test(low) || /mage-init|magento-init|static\/frontend/i.test(low)) return 'magento';
  if(/bigcommerce/i.test(low) || /cdn\.bcapp\.dev|stencil-utils/i.test(low)) return 'bigcommerce';
  return 'auto';
}

async function extractLinks(page, baseUrl, cfg){
  try{
    await page.waitForSelector('a[href]', { timeout: Math.min(5000, cfg.navTimeout) }).catch(()=>{});
  }catch{}
  const hrefs = await page.$$eval('a[href]', as => as.map(a => a.getAttribute('href')).filter(Boolean)).catch(()=>[]);
  const links = new Set();
  for(const href of hrefs){
    try{
      const abs = new URL(href, baseUrl).toString();
      if(!sameSiteCheck(abs, baseUrl, cfg.sameHostOnly, cfg.includeSubdomains)) continue;
      const norm = normalize(abs);
      if(cfg.denyRegex && cfg.denyRegex.test(norm)) continue;
      if(cfg.allowRegex && !cfg.allowRegex.test(norm)) continue;
      links.add(norm);
    }catch{}
  }
  return [...links];
}

function parseProxy(proxyRaw){
  if(!proxyRaw) return null;
  try{
    let s = proxyRaw.trim();
    if(!/^\w+:\/\//.test(s)) s = 'http://'+s;
    const u = new URL(s);
    const server = `${u.protocol}//${u.hostname}${u.port?(':'+u.port):''}`;
    const out = { server };
    if(u.username || u.password){ out.username = decodeURIComponent(u.username||''); out.password = decodeURIComponent(u.password||''); }
    return out;
  }catch{ return null; }
}

async function buildPlanBrowser(starts, cfg, runDir){
  if(!starts.length) die('No START_URLS provided');
  const args = ['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'];
  if(cfg.disableHttp2){ args.push('--disable-http2','--disable-quic'); }
  const proxy = parseProxy(cfg.proxyRaw);
  const launchOpts = { headless: cfg.headless, args };
  if(proxy) launchOpts.proxy = proxy;
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    userAgent: cfg.userAgent || undefined,
    locale: cfg.acceptLanguage.split(',')[0] || 'en-US'
  });
  // Light stealth
  try {
    await context.addInitScript(() => { try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {} });
    await context.addInitScript(() => { try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] }); } catch {} });
  } catch {}

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(cfg.navTimeout);

  let homeHtml='';
  try {
    await page.goto(starts[0], { waitUntil: 'domcontentloaded' });
    if(cfg.waitAfter>0) await page.waitForTimeout(cfg.waitAfter);
    homeHtml = await page.content();
  } catch(e){
    log('home fetch failed:', e.message || String(e));
  }
  const platform = (cfg.platformHint && cfg.platformHint!=='auto') ? cfg.platformHint : pickPlatform(homeHtml);
  log('platform=', platform);

  const buckets = { home:new Set(), categories:new Set(), products:new Set(), information:new Set(), others:new Set() };
  for(const s of starts){
    try{
      await page.goto(s, { waitUntil: 'domcontentloaded' });
      if(cfg.waitAfter>0) await page.waitForTimeout(cfg.waitAfter);
      buckets.home.add(normalize(s));
      const links = await extractLinks(page, s, cfg);
      for(const l of links){
        const cls = classifyHref(l, s, platform);
        if(cls==='category') buckets.categories.add(l);
        else if(cls==='product') buckets.products.add(l);
        else if(cls==='information') buckets.information.add(l);
        else buckets.others.add(l);
      }
    }catch(e){ log('seed error', s, e.message); }
  }

  // paginate categories, collect products
  const catList = [...buckets.categories].slice(0, cfg.maxCategories);
  for(const cat of catList){
    let pageUrl = cat;
    for(let i=0;i<cfg.maxCategoryPages;i++){
      try{
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
        if(cfg.waitAfter>0) await page.waitForTimeout(cfg.waitAfter);
        const links = await extractLinks(page, pageUrl, cfg);
        for(const l of links){ if(classifyHref(l, cat, platform)==='product') buckets.products.add(l); }
        // next page via selector or rel=next or page param
        let nextHref = '';
        if(cfg.nextPageSelector){
          try { nextHref = await page.$eval(cfg.nextPageSelector, a=>a && a.getAttribute('href')); } catch {}
        }
        if(!nextHref){
          try{ nextHref = await page.$eval('a[rel="next"]', a=>a && a.getAttribute('href')); }catch{}
        }
        if(!nextHref){
          try{
            const rx = new RegExp(`([?&])${cfg.pageParam}=(\\d+)`);
            const m = pageUrl.match(rx);
            if(m){
              const cur = parseInt(m[2],10)||1;
              const nu = new URL(pageUrl); nu.searchParams.set(cfg.pageParam, String(cur+1)); nextHref = nu.toString();
            } else {
              const cand = await page.$$eval(`a[href*="${cfg.pageParam}="]`, as=>as.map(a=>a.getAttribute('href')).filter(Boolean)[0]);
              nextHref = cand || '';
            }
          }catch{}
        }
        if(nextHref){
          try{
            const abs = new URL(nextHref, pageUrl).toString();
            if(!sameSiteCheck(abs, pageUrl, cfg.sameHostOnly, cfg.includeSubdomains)) break;
            pageUrl = normalize(abs);
          }catch{ break; }
        } else break;
      }catch(e){ log('cat page error', e.message); break; }
    }
  }

  if(cfg.maxProductsPerCategory>0 && buckets.products.size>cfg.maxProductsPerCategory*catList.length){
    const trimmed = new Set(); let count=0, limit = cfg.maxProductsPerCategory*catList.length;
    for(const p of buckets.products){ trimmed.add(p); if(++count>=limit) break; }
    buckets.products = trimmed;
  }

  const uniq = (arr)=>[...new Set(arr)];
  const seeds = uniq([
    ...buckets.home,
    ...buckets.categories,
    ...buckets.information,
    ...buckets.products
  ]);

  await context.close(); await browser.close();
  return { platform, buckets, seeds };
}

async function main(){
  const runDir = process.argv[2];
  if(!runDir) die('Usage: node tools/smart-map-browser.cjs <runDir>');
  if(!exists(runDir)) die('runDir not found: '+runDir);

  const cfg = parseEnv();
  if(!cfg.starts.length) die('START_URLS env required');

  const plan = await buildPlanBrowser(cfg.starts, cfg, runDir);
  const outDir = path.join(runDir, '_plan');
  ensureDir(outDir);
  const mapJson = {
    platform: plan.platform,
    counts: {
      home: plan.buckets.home.size,
      categories: plan.buckets.categories.size,
      information: plan.buckets.information.size,
      products: plan.buckets.products.size,
      seeds: plan.seeds.length
    },
    lists: {
      home: [...plan.buckets.home],
      categories: [...plan.buckets.categories],
      information: [...plan.buckets.information],
      products: [...plan.buckets.products],
      others: [...plan.buckets.others]
    },
    samples: {
      home: [...plan.buckets.home].slice(0,5),
      categories: [...plan.buckets.categories].slice(0,5),
      products: [...plan.buckets.products].slice(0,5)
    }
  };
  fs.writeFileSync(path.join(outDir,'map.json'), JSON.stringify(mapJson,null,2));
  fs.writeFileSync(path.join(outDir,'plan.json'), JSON.stringify(mapJson,null,2));
  fs.writeFileSync(path.join(outDir,'seeds.txt'), plan.seeds.join('\n')+'\n');
  console.log('[PLAN_OK]', JSON.stringify(mapJson.counts));
}

if(require.main===module){
  main().catch(e=>{ console.error('[PLAN_FATAL]', e.message||String(e)); process.exit(1); });
}
