#!/usr/bin/env node
/**
 * smart-map.cjs
 * Build an explicit, curated seed list ("plan-first") for archiving.
 * - Fetches start URL(s) and classifies links as home, category, product, info, other
 * - For category pages, follows pagination (limited) and collects product links
 * - Writes _plan/map.json, _plan/plan.json (full lists) and _plan/seeds.txt under the provided run directory
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
 * - PLATFORM_HINT: optional (e.g., 'opencart'|'woocommerce'|'shopify'|'magento'|'bigcommerce'|'auto')
 * - NEXT_PAGE_SELECTOR: optional CSS selector to find next-page link (overrides heuristics)
 * - PAGE_PARAM: optional query param name for pagination (default 'page')
 *
 * Usage:
 *   node tools/smart-map.cjs <runDir>
 */
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

function die(msg){ console.error('[PLAN_ERR]', msg); process.exit(1); }
function log(...a){ console.log('[PLAN]', ...a); }
function exists(p){ try{ return fs.existsSync(p); }catch{ return false; } }
function ensureDir(p){ fs.mkdirSync(p,{ recursive:true }); }
function sleep(ms){ return new Promise(res=>setTimeout(res,ms)); }

function parseEnv(){
  const sameHostOnly = String(process.env.SAME_HOST_ONLY||'true').toLowerCase() !== 'false';
  const includeSubdomains = String(process.env.INCLUDE_SUBDOMAINS||'true').toLowerCase() !== 'false';
  const allowRx = (process.env.ALLOW_REGEX||'').trim();
  const denyRx = (process.env.DENY_REGEX||'').trim();
  const cfg = {
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
    pageParam: (process.env.PAGE_PARAM||'page').trim() || 'page'
  };
  return cfg;
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

function normalize(url){
  try{
    const u = new URL(url);
    // Remove hash fragments; keep query
    u.hash = '';
    // Normalize redundant trailing slashes (except root)
    if(u.pathname!=="/" && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/,'');
    return u.toString();
  }catch{ return url; }
}

async function get(url, opts={}){
  const timeoutEnv = parseInt(process.env.PLAN_TIMEOUT_MS||'',10);
  const retryEnv = parseInt(process.env.PLAN_RETRIES||'',10);
  const { timeoutMs=(Number.isFinite(timeoutEnv)?timeoutEnv:25000), retries=(Number.isFinite(retryEnv)?retryEnv:3) } = opts;
  let lastErr;
  for(let i=0;i<=retries;i++){
    try{
      const ctl = new AbortController();
      const t = setTimeout(()=>ctl.abort(), timeoutMs);
      const ua = process.env.PLAN_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
      const u = new URL(url);
      const headers = {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': process.env.PLAN_ACCEPT_LANGUAGE || 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Upgrade-Insecure-Requests': '1',
        // Additional realistic browser headers to reduce bot challenges
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-User': '?1',
        'Sec-Fetch-Dest': 'document',
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Referer': u.origin + '/',
        'Connection': 'keep-alive',
        'DNT': '1'
      };
      const r = await fetch(url, { redirect:'follow', signal: ctl.signal, headers });
      clearTimeout(t);
      if(!r.ok) throw new Error('HTTP '+r.status);
      const html = await r.text();
      return html;
    }catch(e){
      // Normalize abort/timeout error message so it doesn't read like the user did it
      const isAbort = (e && (e.name==='AbortError' || /aborted/i.test(String(e && e.message))));
      if(isAbort){
        lastErr = new Error(`Timeout after ${timeoutMs} ms`);
      } else {
        lastErr = e instanceof Error ? e : new Error(String(e));
      }
      if(i<retries){
        console.log('[PLAN]', `retry ${i+1}/${retries} ${url} due to: ${lastErr.message}`);
        await sleep(300);
      }
    }
  }
  throw lastErr;
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
    // YNAP-style (The Outnet / Net-A-Porter)
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

function pickPlatform(html, base){
  const low = (html||'').toLowerCase();
  if(/opencart/i.test(low) || /route=product\//i.test(low)) return 'opencart';
  if(/woocommerce/i.test(low) || /wp-content\/plugins\/woocommerce/i.test(low)) return 'woocommerce';
  if(/shopify/i.test(low) || /cdn\.shopify\.com/i.test(low)) return 'shopify';
  if(/magento/i.test(low) || /mage-init|magento-init|static\/frontend/i.test(low)) return 'magento';
  if(/bigcommerce/i.test(low) || /cdn\.bcapp\.dev|stencil-utils/i.test(low)) return 'bigcommerce';
  // default
  return 'auto';
}

async function collectFromPage(url, cfg, platform){
  const html = await get(url);
  const $ = cheerio.load(html);
  const base = url;
  const links = new Set();
  $('a[href]').each((_,a)=>{
    const href = $(a).attr('href');
    if(!href) return;
    try{
      const abs = new URL(href, base).toString();
      if(!sameSiteCheck(abs, base, cfg.sameHostOnly, cfg.includeSubdomains)) return;
      const norm = normalize(abs);
      if(cfg.denyRegex && cfg.denyRegex.test(norm)) return;
      if(cfg.allowRegex && !cfg.allowRegex.test(norm)) return;
      links.add(norm);
    }catch{}
  });
  return { html, links:[...links] };
}

async function buildPlan(starts, cfg){
  if(!starts.length) die('No START_URLS provided');
  const primary = starts[0];
  let homeHtml = '';
  try { homeHtml = await get(primary); } catch(e) {
    log('home fetch failed:', (e && e.message) || String(e));
    // Proceed with auto platform; downstream will still attempt to collect links
    homeHtml = '';
  }
  const platform = (cfg.platformHint && cfg.platformHint!=='auto') ? cfg.platformHint : pickPlatform(homeHtml, primary);
  log('platform=', platform);

  // Initial scan from home(s)
  const buckets = { home:new Set(), categories:new Set(), products:new Set(), information:new Set(), others:new Set() };
  for(const s of starts){
    buckets.home.add(normalize(s));
    const { links } = await collectFromPage(s, cfg, platform);
    for(const l of links){
      const cls = classifyHref(l, s, platform);
      if(cls==='category') buckets.categories.add(l);
      else if(cls==='product') buckets.products.add(l);
      else if(cls==='information') buckets.information.add(l);
      else buckets.others.add(l);
    }
  }

  // For category pages: paginate limited, collect products
  const catList = [...buckets.categories].slice(0, cfg.maxCategories);
  for(const cat of catList){
    let pageUrl = cat;
    for(let i=0;i<cfg.maxCategoryPages;i++){
      try{
        const { html, links } = await collectFromPage(pageUrl, cfg, platform);
        // product links
        for(const l of links){ if(classifyHref(l, cat, platform)==='product') buckets.products.add(l); }
        // attempt to find next page via rel=next or ?page=
        const $ = cheerio.load(html);
        let nextHref = '';
        if(cfg.nextPageSelector){
          nextHref = $(cfg.nextPageSelector).attr('href') || '';
        }
        if(!nextHref){
          nextHref = $('a[rel="next"]').attr('href') || '';
        }
        if(!nextHref){
          const rx = new RegExp(`([?&])${cfg.pageParam}=(\\d+)`);
          const m = pageUrl.match(rx);
          if(m){
            const cur = parseInt(m[2],10)||1;
            const nu = new URL(pageUrl); nu.searchParams.set(cfg.pageParam, String(cur+1)); nextHref = nu.toString();
          } else {
            // look for explicit page number links
            const cand = $(`a[href*="${cfg.pageParam}="]`).map((_,a)=>$(a).attr('href')).get().filter(Boolean)[0];
            nextHref = cand || '';
          }
        }
        if(nextHref){
          try {
            const abs = new URL(nextHref, pageUrl).toString();
            if(!sameSiteCheck(abs, pageUrl, cfg.sameHostOnly, cfg.includeSubdomains)) break;
            pageUrl = normalize(abs);
          } catch { break; }
        } else break;
      }catch(e){ log('cat page error', e.message); break; }
    }
  }

  // Limit products per category overall if very large
  if(cfg.maxProductsPerCategory>0 && buckets.products.size>cfg.maxProductsPerCategory*catList.length){
    const trimmed = new Set();
    let count=0, limit = cfg.maxProductsPerCategory*catList.length;
    for(const p of buckets.products){ trimmed.add(p); if(++count>=limit) break; }
    buckets.products = trimmed;
  }

  // Build final seeds: home + categories + information + products
  const uniq = (arr)=>[...new Set(arr)];
  const seeds = uniq([
    ...buckets.home,
    ...buckets.categories,
    ...buckets.information,
    ...buckets.products
  ]);

  return { platform, buckets, seeds };
}

async function main(){
  const runDir = process.argv[2];
  if(!runDir) die('Usage: node tools/smart-map.cjs <runDir>');
  if(!exists(runDir)) die('runDir not found: '+runDir);

  const cfg = parseEnv();
  if(!cfg.starts.length) die('START_URLS env required');

  const plan = await buildPlan(cfg.starts, cfg);
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
