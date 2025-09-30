#!/usr/bin/env node
/**
 * crawler.cjs  (Advanced / Seed-Limiter Version)
 *
 * Purpose:
 *   Lightweight breadth-first crawler used in two modes:
 *     1. Stand-alone ?Crawl Only? (GUI crawl form)
 *     2. Auto-Discover (Direct Run Depth) prior to archiving
 *
 * Key Fixes vs. Previous Version:
 *   - MAX_PAGES now controls TOTAL pages actually fetched (visitedOrder length),
 *     not the size of the discovered list.
 *   - urls.txt now contains ONLY the pages actually crawled (up to MAX_PAGES),
 *     in the chronological order they were fetched (not the entire discovered set).
 *   - Discovered-but-not-fetched URLs no longer force the archiver to expand unexpectedly.
 *   - Added seedsForArchive count in final log for clarity.
 *   - Added graceful early exit if external STOP flag file is dropped (optional).
 *
 * Environment Variables (defaults in parentheses):
 *   START_URLS (required)  newline or comma separated list
 *   OUTPUT_DIR (required)  destination directory (urls file placed in OUTPUT_DIR/_crawl)
 *   MAX_PAGES=200          total pages to FETCH (feeds archiver)
 *   MAX_DEPTH=3            BFS depth limit (0 = only the seeds)
 *   SAME_HOST_ONLY=true
 *   INCLUDE_SUBDOMAINS=true
 *   ALLOW_REGEX=           optional allow pattern
 *   DENY_REGEX=            optional deny pattern
 *   KEEP_QUERY_PARAMS=     comma list of query params to keep (others stripped)
 *   STRIP_ALL_QUERIES=false
 *   WAIT_AFTER_LOAD=500    ms wait after domcontentloaded
 *   NAV_TIMEOUT=15000      per navigation
 *   PAGE_TIMEOUT=45000     (not heavily used yet; placeholder for per-page budget)
 *   USER_AGENT= (chromium-like default)
 *
 *   PROXIES_FILE=          optional JSON array like:
 *                          [{ "server":"http://host:port","username":"user","password":"pass"}]
 *   STABLE_SESSION=true
 *   ROTATE_SESSION=false
 *   ROTATE_EVERY=0         rotate proxy/session every N pages (when not stable)
 *
 * Optional STOP MECHANISM (used by GUI stop-run escalation):
 *   If a file named STOP in OUTPUT_DIR/_crawl is created during crawl,
 *   crawler stops as soon as current page finishes.
 *
 * Outputs (in OUTPUT_DIR/_crawl):
 *   urls.txt               (ONLY fetched pages, in visit order; what archiver will use)
 *   discovered-debug.txt   (all normalized URLs ever seen; for diagnostics)
 *   graph.json             simple graph (nodes/edges) of discovered links
 *   report.json            metadata summary
 *
 * Exit Codes:
 *   0 success
 *   2 no pages found
 *   3 configuration error
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium, firefox, webkit } = require('playwright');
const { HttpsProxyAgent } = require('https-proxy-agent');
const https = require('https');

/* ---------------- Utility Helpers ---------------- */
function flag(name, def=false){
  const v = process.env[name];
  if (v == null) return def;
  return ['1','true','yes','on'].includes(v.toLowerCase());
}
function ensureDir(d){ fs.mkdirSync(d,{recursive:true}); }
function sha12(x){ return crypto.createHash('sha1').update(x).digest('hex').slice(0,12); }

const START_URLS_RAW = process.env.START_URLS || '';
const OUTPUT_DIR = process.env.OUTPUT_DIR;
if (!START_URLS_RAW || !OUTPUT_DIR){
  console.error('START_URLS and OUTPUT_DIR required');
  process.exit(3);
}
const START_URLS = [...new Set(START_URLS_RAW.split(/\r?\n|,/).map(s=>s.trim()).filter(Boolean))];
if (!START_URLS.length){
  console.error('No valid START_URLS');
  process.exit(3);
}

const MAX_PAGES         = parseInt(process.env.MAX_PAGES||'200',10);
const MAX_DEPTH         = parseInt(process.env.MAX_DEPTH||'3',10);
const SAME_HOST_ONLY    = flag('SAME_HOST_ONLY', true);
const INCLUDE_SUBDOMAINS= flag('INCLUDE_SUBDOMAINS', true);
const ALLOW_REGEX_STR   = process.env.ALLOW_REGEX || '';
const DENY_REGEX_STR    = process.env.DENY_REGEX || '';
const KEEP_QUERY_PARAMS = (process.env.KEEP_QUERY_PARAMS||'').split(',').map(s=>s.trim()).filter(Boolean);
const STRIP_ALL_QUERIES = flag('STRIP_ALL_QUERIES', false);
const WAIT_AFTER_LOAD   = parseInt(process.env.WAIT_AFTER_LOAD||'500',10);
const NAV_TIMEOUT       = parseInt(process.env.NAV_TIMEOUT||'15000',10);
const PAGE_TIMEOUT      = parseInt(process.env.PAGE_TIMEOUT||'45000',10); // (placeholder)
const USER_AGENT = process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Engine/headless for parity with archiver
const ENGINE = (process.env.ENGINE || 'chromium').toLowerCase();
const HEADLESS = flag('HEADLESS', true);

const PROXIES_FILE  = process.env.PROXIES_FILE || '';
const STABLE_SESSION= flag('STABLE_SESSION', true);
const ROTATE_SESSION= flag('ROTATE_SESSION', false);
const ROTATE_EVERY  = parseInt(process.env.ROTATE_EVERY||'0',10);

/* Regex compile */
let allowRx=null, denyRx=null;
if (ALLOW_REGEX_STR){
  try { allowRx = new RegExp(ALLOW_REGEX_STR,'i'); } catch(e){ console.error('Invalid ALLOW_REGEX', e.message); }
}
if (DENY_REGEX_STR){
  try { denyRx = new RegExp(DENY_REGEX_STR,'i'); } catch(e){ console.error('Invalid DENY_REGEX', e.message); }
}

/* Proxy rotation */
let proxies=[];
if (PROXIES_FILE){
  try {
    proxies = JSON.parse(fs.readFileSync(PROXIES_FILE,'utf8'));
    if(!Array.isArray(proxies)) proxies=[];
  } catch { proxies=[]; }
}
let proxyIndex=0;
function randSession(){ return crypto.randomBytes(4).toString('hex'); }
function nextProxy(pagesDone){
  if(!proxies.length) return null;
  if(!STABLE_SESSION && ROTATE_EVERY>0 && pagesDone>0 && pagesDone % ROTATE_EVERY===0){
    proxyIndex++;
  }
  const base=proxies[proxyIndex % proxies.length];
  let username=base.username||'';
  if(!STABLE_SESSION && ROTATE_SESSION){
    username=username.replace(/(session-)[A-Za-z0-9_-]+/,(_,p)=>p+randSession());
  }
  return { server:base.server, username, password:base.password };
}

/* Normalization */
function normalizeURL(raw, rootHost){
  let u;
  try {
    u = new URL(raw);
  } catch { return null; }
  if (!/^https?:$/i.test(u.protocol)) return null;

  if (SAME_HOST_ONLY){
    const rootLower = rootHost.toLowerCase();
    const hostLower = u.hostname.toLowerCase();
    const same = hostLower === rootLower;
    const sub = INCLUDE_SUBDOMAINS && hostLower.endsWith('.'+rootLower);
    if (!same && !sub) return null;
  }

  u.hash='';
  if (STRIP_ALL_QUERIES){
    u.search='';
  } else if (KEEP_QUERY_PARAMS.length){
    const params=new URLSearchParams(u.search);
    [...params.keys()].forEach(k=>{
      if(!KEEP_QUERY_PARAMS.includes(k)) params.delete(k);
    });
    u.search = params.toString()?('?'+params.toString()):'';
  }

  let final=u.toString();
  try {
    if (u.pathname !== '/' && final.endsWith('/')) final=final.slice(0,-1);
  } catch {}
  if (allowRx && !allowRx.test(final)) return null;
  if (denyRx && denyRx.test(final)) return null;
  return final;
}

/* Browser creation (chromium only for speed; can be extended) */
async function createBrowser(proxyObj){
  const args=['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'];
  const launch={ headless:HEADLESS };
  if(proxyObj){
    launch.proxy={ server:proxyObj.server, username:proxyObj.username, password:proxyObj.password };
  }
  launch.args=args;
  const bt = ENGINE==='firefox' ? firefox : ENGINE==='webkit' ? webkit : chromium;
  return bt.launch(launch);
}

/* Optional STOP flag file */
function stopFlagPath(outDir){
  return path.join(outDir,'_crawl','STOP');
}
function stopRequested(outDir){
  try { return fs.existsSync(stopFlagPath(outDir)); } catch { return false; }
}

/* Main Crawl */
async function crawl(){
  const crawlDir = path.join(OUTPUT_DIR,'_crawl');
  ensureDir(crawlDir);

  const rootURL=START_URLS[0];
  const rootHost=(()=>{ try { return new URL(rootURL).hostname; } catch { return ''; }})();

  const queue=[];               // BFS queue: {url, depth}
  const seen=new Set();         // all normalized URLs ever seen (discovered)
  const visitedOrder=[];        // order of ACTUAL FETCHES (pages we opened) -> seeds for archiver
  const depths=new Map();       // url -> depth (for graph)
  const edges=[];               // {from,to}

  START_URLS.forEach(u=>{
    const n=normalizeURL(u, rootHost);
    if(n && !seen.has(n)){
      seen.add(n);
      depths.set(n,0);
      queue.push({url:n, depth:0});
    }
  });

  let pagesCrawled=0;
  let browser=await createBrowser(nextProxy(0));
  const context=await browser.newContext({
    userAgent:USER_AGENT,
    viewport:{width:1366,height:900},
    locale:'en-US'
  });

  async function processItem(item){
    if (pagesCrawled >= MAX_PAGES) return;
    if (item.depth > MAX_DEPTH) return;
    if (stopRequested(OUTPUT_DIR)) return;

    let page;
    let ok=false;
    let linkCount=0;
    try {
      page=await context.newPage();
      page.setDefaultNavigationTimeout(NAV_TIMEOUT);
      await page.goto(item.url,{ waitUntil:'domcontentloaded' });
      if (WAIT_AFTER_LOAD>0) await page.waitForTimeout(WAIT_AFTER_LOAD);
      // Mark visited
      visitedOrder.push(item.url);
      pagesCrawled++;

      // Extract links only if we can still expand
      if (pagesCrawled < MAX_PAGES && item.depth < MAX_DEPTH){
        const hrefs=await page.$$eval('a[href]', as=>as.map(a=>a.getAttribute('href')));
        for(const raw of hrefs){
          if(!raw) continue;
          let resolved;
            try { resolved=new URL(raw, item.url).toString(); } catch { continue; }
          const norm=normalizeURL(resolved, rootHost);
          if(!norm) continue;
          edges.push({ from:item.url, to:norm });
          if(!seen.has(norm)){
            seen.add(norm);
            const d=item.depth+1;
            depths.set(norm,d);
            // Enqueue only if we still can fetch more pages and depth within limit
            if (d <= MAX_DEPTH && visitedOrder.length < MAX_PAGES){
              queue.push({ url:norm, depth:d });
            }
          }
        }
        linkCount=hrefs.length;
      }
      ok=true;
      console.log(`[CRAWL] d=${item.depth} ok url=${item.url} links=${linkCount}`);
    } catch(e){
      console.log(`[CRAWL_ERR] ${item.url} ${e.message}`);
    } finally {
      try { if(page) await page.close(); } catch {}
    }
  }

  while(queue.length && pagesCrawled < MAX_PAGES){
    if (stopRequested(OUTPUT_DIR)) break;
    const item=queue.shift();
    await processItem(item);
  }

  try { await browser.close(); } catch {}

  // seedsForArchive: exactly the visited pages (limit enforced)
  const seedsForArchive = visitedOrder.slice(0, MAX_PAGES);
  // For debugging: full discovered set
  fs.writeFileSync(path.join(crawlDir,'discovered-debug.txt'), Array.from(seen).join('\n')+'\n','utf8');
  // Output only fetched pages to urls.txt
  fs.writeFileSync(path.join(crawlDir,'urls.txt'), seedsForArchive.join('\n')+'\n','utf8');

  // Graph & report use all discovered but highlight actual crawled subset
  fs.writeFileSync(path.join(crawlDir,'graph.json'), JSON.stringify({
    nodes: Array.from(seen).map(u=>({
      url:u,
      depth: depths.get(u) ?? null,
      crawled: visitedOrder.includes(u)
    })),
    edges
  }, null, 2),'utf8');

  fs.writeFileSync(path.join(crawlDir,'report.json'), JSON.stringify({
    startURLs: START_URLS,
    pagesCrawled: visitedOrder.length,
    seedsForArchive: seedsForArchive.length,
    totalDiscovered: seen.size,
    maxDepth: MAX_DEPTH,
    maxPages: MAX_PAGES,
    sameHostOnly: SAME_HOST_ONLY,
    includeSubdomains: INCLUDE_SUBDOMAINS,
    allowRegex: ALLOW_REGEX_STR || null,
    denyRegex: DENY_REGEX_STR || null,
    keepQueryParams: KEEP_QUERY_PARAMS,
    stripAllQueries: STRIP_ALL_QUERIES,
    stoppedEarly: stopRequested(OUTPUT_DIR),
    timestamp: new Date().toISOString()
  }, null, 2),'utf8');

  console.log(`[CRAWL_DONE] discovered=${seen.size} crawled=${visitedOrder.length} seedsForArchive=${seedsForArchive.length}${stopRequested(OUTPUT_DIR)?' (STOP)':''}`);

  if (!seedsForArchive.length){
    process.exit(2);
  }
}

crawl().catch(e=>{
  console.error('CRAWL_FATAL', e);
  process.exit(1);
});