#!/usr/bin/env node
/**
 * gui-server.cjs
 * Adds:
 *  - static /download for ./out
 *  - /api/export returns browser URLs to files/folder
 *  - /api/export-zip creates a zip or tar.gz and returns download link
 *  - keeps all existing endpoints and behavior
 *
 * Minimal reliability and speed fixes:
 *  - Prevent double starts via `startingJob` gate.
 *  - Guard currentJob in launchArchiver with ensureCurrentJob() to prevent null phase crash.
 *  - Preserve MAX_CAPTURE_MS=0 (unlimited) instead of defaulting to 15000.
 *  - Force pages-only discovery in auto-expand via DISABLE_AUTO_ALLOW env (crawler may use it to skip product auto-allow).
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { nanoid } = require('nanoid');
const { applyTransforms, resetTransforms, findRootIndex } = require('./transform.cjs');
const { prepareHosting } = require('./lib/hostingPrep.cjs');
const { deriveRunId } = require('./lib/run-id.cjs');
const { SETTINGS_CONFIG, getSetting, getAllSettings } = require('./lib/settings.cjs');

const PORT = parseInt(process.env.GUI_PORT || '8090', 10);
const BASE = path.join(__dirname,'downloaded_pages');
const ARCHIVER = path.join(__dirname,'archiver.cjs');
const CRAWLER = path.join(__dirname,'crawler.cjs');
const HOST_SERVER = path.join(__dirname,'server.cjs');
const HOSTING_OUT_BASE = path.join(__dirname,'hosting_packages');
const OUT_BASE = path.join(__dirname,'out'); // Exposed at /download

fs.mkdirSync(BASE,{recursive:true});
fs.mkdirSync(HOSTING_OUT_BASE,{recursive:true});
fs.mkdirSync(OUT_BASE,{recursive:true}); // ensure exists

const app = express();
app.use(express.json({limit:'35mb'}));
app.use('/static', express.static(path.join(__dirname,'public')));
app.use('/download', express.static(OUT_BASE, { dotfiles:'allow' })); // expose exports

let currentJob=null;
let currentChildProc=null;
let startingJob=false; // gate to prevent double start
let logBuf=[];
const MAX_LOG=6000;
let sseClients=[];
let runs=[];
const hosts = new Map();
let installingBrowsers = false;

// Infer a public URL for a given port depending on environment (Codespaces or local)
function inferPublicUrl(port){
  try{
    const p = String(port);
    if(process.env.CODESPACES === 'true'){
      const name = process.env.CODESPACE_NAME || '';
      const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev';
      if(name) return `https://${name}-${p}.${domain}/`;
    }
    const host = process.env.PUBLIC_HOST || process.env.HOST || 'localhost';
    const proto = process.env.PUBLIC_PROTOCOL || 'http';
    return `${proto}://${host}:${p}/`;
  }catch{
    return `http://localhost:${port}/`;
  }
}

/* ---------- Playwright Browser Installer ---------- */
app.post('/api/playwright/install', async (req,res)=>{
  try{
    if(installingBrowsers) return res.status(409).json({error:'install already in progress'});
    const { browsers=['chromium'], withDeps=false } = req.body||{};
    const args=['playwright','install', ...browsers];
    if(withDeps) args.push('--with-deps');
    installingBrowsers = true;
    push('[PW] install start args='+JSON.stringify(args));
    const child = spawn('npx', args, { env: process.env });
    child.stdout.on('data',d=>d.toString().split(/\r?\n/).filter(Boolean).forEach(l=>push('[PW] '+l)));
    child.stderr.on('data',d=>d.toString().split(/\r?\n/).filter(Boolean).forEach(l=>push('[PW:ERR] '+l)));
    child.on('exit',code=>{
      push('[PW] install exit code='+code);
      installingBrowsers=false;
    });
    // Respond immediately; logs will stream via SSE
    res.json({ ok:true, started:true, args, note:'Progress is streamed in Live Log' });
  }catch(e){ installingBrowsers=false; res.status(500).json({ error:e.message }); }
});

/* ---------------- Centralized Settings & Defaults ---------------- */
// Minimal UI help text registry (IDs correspond to inputs in public/index.html)
const UI_SETTINGS_HELP = {
  // Quick capture toggles
  optProfiles: 'Capture both desktop and mobile profiles if enabled (PROFILES=desktop,mobile).',
  optAggressive: 'Enable aggressive capture mode to click and expand more dynamic content.',
  optPreserve: 'Preserve original asset paths where possible instead of hashing.',
  optScroll: 'Perform extra scroll passes to trigger lazy-loaded content.',

  // Auto-expand discovery from provided seeds
  autoDepth: 'Auto-expand BFS depth. 0 disables auto-expand.',
  autoMaxPages: 'Maximum pages to fetch during auto-expand phase.',
  autoSameHost: 'Restrict auto-expand to the same host.',
  autoSubs: 'Include subdomains during auto-expand.',
  autoAllow: 'Optional allow regex. Only URLs matching this will be considered.',
  autoDeny: 'Optional deny regex. URLs matching this pattern will be excluded.',

  // Crawl-first section
  crawlSeeds: 'Seeds list for a preliminary crawl phase (one per line).',
  crawlDepth: 'Crawl BFS depth limit. 0 = only the seeds.',
  crawlMaxPages: 'Total pages to fetch during the crawl phase.',
  crawlWait: 'Wait (ms) after DOMContentLoaded before extracting links.',
  crawlSameHost: 'Restrict crawl to same host.',
  crawlSubs: 'Include subdomains during crawl.',
  crawlAllow: 'Crawl allow regex (optional).',
  crawlDeny: 'Crawl deny regex (optional).',

  // Advanced capture
  advEngine: 'Browser engine to use for capture (chromium recommended for speed).',
  advConcurrency: 'Concurrent pages to process. Increase carefully to avoid rate limits.',
  advHeadless: 'Run browser in headless mode. Disable for debugging or visual checks.',
  advWaitUntil: 'waitUntil for page navigation lifecycle (e.g., domcontentloaded, load).',
  advWaitExtra: 'Extra wait (ms) after waitUntil to stabilize dynamic pages.',
  advQuietMillis: 'Quiet period (ms) with no network to consider the page idle.',
  advNavTimeout: 'Navigation timeout (ms) per page.',
  advPageTimeout: 'Overall per-page timeout (ms).',
  advMaxCapMs: 'Global max capture time (ms). 0 = unlimited.',
  advScrollDelay: 'Delay (ms) between scroll steps during capture.',
  advInlineSmall: 'Inline small assets under this size (bytes). 0 disables.',
  advAssetMax: 'Skip assets larger than this size (bytes).',
  advRewriteInternal: 'Rewrite internal links to point to archived locations.',
  advMirrorSubs: 'Mirror subdomains inside the archive.',
  advMirrorCross: 'Mirror cross-origin assets and pages as allowed.',
  advIncludeCO: 'Allow including cross-origin requests where safe.',
  advRewriteHtmlAssets: 'Rewrite asset URLs found in HTML documents.',
  advFlattenRoot: 'Flatten root index to index.html (avoid nested index).',
  advInternalRegex: 'Regex to determine internal hosts/paths for rewriting.',
  advDomainFilter: 'Optional domain filter list to limit capture scope.',
  advClickSelectors: 'CSS selectors to click after load (one per line).',
  advRemoveSelectors: 'CSS selectors to remove from pages (one per line).',
  advSkipDownload: 'Skip downloading assets matching these patterns (one per line).',

  // Consent handling
  advConsentButtons: 'List of button texts that accept/close consent prompts.',
  advConsentExtraSel: 'Extra CSS selectors to trigger for consent banners.',
  advConsentForceRemove: 'Force removal selectors for stubborn consent overlays.',
  advConsentRetries: 'Number of retry attempts to handle consent.',
  advConsentInterval: 'Interval (ms) between consent retries.',
  advConsentWindow: 'Observe DOM mutations (ms) to catch late consent elements.',
  advConsentIframeScan: 'Scan iframes for consent prompts (slower).',
  advConsentDebug: 'Enable debug logs for consent automation.',
  advConsentScreenshot: 'Take debug screenshots during consent handling.',
  advForceConsentWait: 'Force an additional wait period for consent (ms in next field).',
  advForceConsentWaitMs: 'Milliseconds to wait when forced consent wait is enabled.',

  // Hosting prep
  hpMobile: 'Include a mobile variant in the prepared package.',
  hpStrip: 'Strip analytics scripts during hosting preparation.',
  hpSW: 'Generate and include a Service Worker for offline support.',
  hpCompress: 'Precompress files (gzip/brotli) during packaging.',
  hpSitemap: 'Include sitemap.xml for the prepared package.',
  hpZip: 'Create a downloadable ZIP for the package.',
  hpShopify: 'Enable Shopify embed mode tweaks.',
  hpPlatform: 'Target platform preset to tailor output for.',
  hpBaseUrl: 'Base URL used for sitemap and absolute link rewrites.',
  hpExtraRegex: 'Additional analytics regex to strip (optional).'
};

function getCrawlerDefaults(){
  return {
    maxPages: 200,
    maxDepth: 3,
    sameHostOnly: true,
    includeSubdomains: true,
    allowRegex: '',
    denyRegex: '',
    waitAfterLoad: 500,
    navTimeout: 15000,
    pageTimeout: 45000,
    engine: 'chromium',
    headless: true
  };
}

function buildCrawlEnv(options, dir, startUrls) {
  const o = options || {};
  return {
    ...process.env,
    START_URLS: (startUrls||[]).join('\n'),
    OUTPUT_DIR: dir,
    MAX_PAGES: String(o.maxPages ?? getCrawlerDefaults().maxPages),
    MAX_DEPTH: String(o.maxDepth ?? getCrawlerDefaults().maxDepth),
    SAME_HOST_ONLY: (o.sameHostOnly === false ? 'false' : 'true'),
    INCLUDE_SUBDOMAINS: (o.includeSubdomains === false ? 'false' : 'true'),
    ALLOW_REGEX: o.allowRegex || '',
    DENY_REGEX: o.denyRegex || '',
    WAIT_AFTER_LOAD: String(o.waitAfterLoad ?? getCrawlerDefaults().waitAfterLoad),
    NAV_TIMEOUT: String(o.navTimeout ?? getCrawlerDefaults().navTimeout),
    PAGE_TIMEOUT: String(o.pageTimeout ?? getCrawlerDefaults().pageTimeout),
    ENGINE: (o.engine || getCrawlerDefaults().engine),
    HEADLESS: (o.headless===false?'false':'true'),
    DISABLE_HTTP2: (o.disableHttp2?'true':'false')
  };
}

function getArchiverDefaults(){
  return {
    engine: 'chromium',
    concurrency: 2,
    headless: true,
    includeCrossOrigin: false,
    waitExtra: 700,
    navTimeout: 20000,
    pageTimeout: 40000,
    mirrorProducts: false,
    scrollPasses: 0,
    scrollDelay: 250,
    assetMaxBytes: 3*1024*1024,
    rewriteInternal: true,
    internalRewriteRegex: '',
    domainFilter: '',
    preserveAssetPaths: false,
    rewriteHtmlAssets: true,
    mirrorSubdomains: true,
    mirrorCrossOrigin: false,
    inlineSmallAssets: 0,
    pageWaitUntil: 'domcontentloaded',
    quietMillis: 1500,
    maxCaptureMs: 0,
    clickSelectors: '',
    consentButtonTexts: '',
    consentExtraSelectors: '',
    consentForceRemoveSelectors: '',
    consentRetryAttempts: 12,
    consentRetryInterval: 700,
    consentMutationWindow: 8000,
    consentIframeScan: false,
    consentDebug: false,
    consentDebugScreenshot: false,
    forceConsentWaitMs: 0,
    removeSelectors: '',
    skipDownloadPatterns: '',
    flattenRoot: false,
    aggressiveCapture: false,
    profiles: (process.env.PROFILES || 'desktop,mobile'),
    sameSiteMode: (process.env.SAME_SITE_MODE || 'etld'),
    internalHostsRegex: (process.env.INTERNAL_HOSTS_REGEX || ''),
    targetPlatform: (process.env.TARGET_PLATFORM || 'generic').toLowerCase()
  };
}

function buildArchiverEnv(options){
  const d = getArchiverDefaults();
  const o = options || {};
  const maxCap = (Object.prototype.hasOwnProperty.call(o,'maxCaptureMs'))
    ? Number(o.maxCaptureMs || 0)
    : d.maxCaptureMs;
  return {
    ...process.env,
    ENGINE: o.engine || d.engine,
    CONCURRENCY: String(o.concurrency ?? d.concurrency),
    HEADLESS: (o.headless===false?'false':'true'),
    INCLUDE_CROSS_ORIGIN: (o.includeCrossOrigin?'true':'false'),
    WAIT_EXTRA: String(o.waitExtra ?? d.waitExtra),
    NAV_TIMEOUT_MS: String(o.navTimeout ?? d.navTimeout),
    PAGE_TIMEOUT_MS: String(o.pageTimeout ?? d.pageTimeout),
    PRODUCT_MIRROR_ENABLE: (o.mirrorProducts ? 'true' : 'false'),
    SCROLL_PASSES: String(o.scrollPasses ?? d.scrollPasses),
    SCROLL_DELAY: String(o.scrollDelay ?? d.scrollDelay),
    ASSET_MAX_BYTES: String(o.assetMaxBytes ?? d.assetMaxBytes),
    REWRITE_INTERNAL: (o.rewriteInternal===false?'false':'true'),
    INTERNAL_REWRITE_REGEX: o.internalRewriteRegex || d.internalRewriteRegex,
    DOMAIN_FILTER: o.domainFilter || d.domainFilter,
    PRESERVE_ASSET_PATHS: (o.preserveAssetPaths?'true':'false'),
    REWRITE_HTML_ASSETS: (o.rewriteHtmlAssets===false?'false':'true'),
    MIRROR_SUBDOMAINS: (o.mirrorSubdomains===false?'false':'true'),
    MIRROR_CROSS_ORIGIN: (o.mirrorCrossOrigin?'true':'false'),
    INLINE_SMALL_ASSETS: String(o.inlineSmallAssets ?? d.inlineSmallAssets),
    PAGE_WAIT_UNTIL: o.pageWaitUntil || d.pageWaitUntil,
    QUIET_MILLIS: String(o.quietMillis ?? d.quietMillis),
    MAX_CAPTURE_MS: String(maxCap),
    CLICK_SELECTORS: (o.clickSelectors || d.clickSelectors).trim(),
    CONSENT_BUTTON_TEXTS: (o.consentButtonTexts || d.consentButtonTexts).trim(),
    CONSENT_EXTRA_SELECTORS: (o.consentExtraSelectors || d.consentExtraSelectors).trim(),
    CONSENT_FORCE_REMOVE_SELECTORS: (o.consentForceRemoveSelectors || d.consentForceRemoveSelectors).trim(),
    CONSENT_RETRY_ATTEMPTS: String(o.consentRetryAttempts ?? d.consentRetryAttempts),
    CONSENT_RETRY_INTERVAL_MS: String(o.consentRetryInterval ?? d.consentRetryInterval),
    CONSENT_MUTATION_WINDOW_MS: String(o.consentMutationWindow ?? d.consentMutationWindow),
    CONSENT_IFRAME_SCAN: (o.consentIframeScan?'true':'false'),
    CONSENT_DEBUG: (o.consentDebug?'true':'false'),
    CONSENT_DEBUG_SCREENSHOT: (o.consentDebugScreenshot?'true':'false'),
    FORCE_CONSENT_WAIT_MS: String(o.forceConsentWaitMs ?? d.forceConsentWaitMs),
    REMOVE_SELECTORS: (o.removeSelectors || d.removeSelectors).trim(),
    SKIP_DOWNLOAD_PATTERNS: (o.skipDownloadPatterns || d.skipDownloadPatterns).trim(),
    FLATTEN_ROOT_INDEX: (o.flattenRoot?'1':'0'),
    AGGRESSIVE_CAPTURE: (o.aggressiveCapture?'true':'false'),
    PROFILES: o.profiles || d.profiles,
    SAME_SITE_MODE: o.sameSiteMode || d.sameSiteMode,
    INTERNAL_HOSTS_REGEX: o.internalHostsRegex || d.internalHostsRegex,
    TARGET_PLATFORM: (o.targetPlatform || d.targetPlatform),
    // network hardening
    DISABLE_HTTP2: (o.disableHttp2 ? 'true' : 'false')
  };
}

// API: settings help and defaults for UI tooltips/hints
app.get('/api/settings',(req,res)=>{
  res.json({
    help: UI_SETTINGS_HELP,
    defaults: { archiver: getArchiverDefaults(), crawler: getCrawlerDefaults() }
  });
});

function push(line){
  const l='['+new Date().toISOString()+'] '+line;
  logBuf.push(l);
  if(logBuf.length>MAX_LOG) logBuf.splice(0, logBuf.length-MAX_LOG);
  sseClients.forEach(r=>r.write(`data: ${l}\n\n`));
  process.stdout.write(l+'\n');
}
function findRun(id){ return runs.find(r=>r.id===id); }

function safeStat(p){ try { return fs.statSync(p); } catch { return null; } }

/* ---------- Child Process Utilities ---------- */
function attachChildProcessLoggers(child, logPrefix) {
  child.stdout.on('data', d => d.toString().split(/\r?\n/).filter(Boolean).forEach(l => push(`[${logPrefix}] ${l}`)));
  child.stderr.on('data', d => d.toString().split(/\r?\n/).filter(Boolean).forEach(l => push(`[${logPrefix}:ERR] ${l}`)));
}

function createJobExitHandler(jobId, jobType, onExit) {
  return (code) => {
    push(`[${jobType}_EXIT] id=${jobId} code=${code}`);
    if (onExit) onExit(code);
  };
}

function buildRunFromDir(dirName){
  const runDir=path.join(BASE,dirName);
  const mfPath=path.join(runDir,'manifest.json');
  let stats=null, finishedAt=null;
  if(fs.existsSync(mfPath)){
    try{
      const mf=JSON.parse(fs.readFileSync(mfPath,'utf8'));
      const failures=mf.filter(m=>!m.status || !String(m.status).startsWith('ok')).length;
      const totalAssets=mf.reduce((s,m)=>s+(m.assets||0),0);
      stats={ pages:mf.length, failures, assets:totalAssets };
      const st=safeStat(mfPath);
      finishedAt=st?st.mtimeMs:Date.now();
    }catch{}
  }
  const stDir=safeStat(runDir);
  const startedAt=stDir?stDir.ctimeMs:Date.now();
  return {
    id:dirName,
    dir:runDir,
    seedsFile:fs.existsSync(path.join(runDir,'seeds.txt'))?path.join(runDir,'seeds.txt'):undefined,
    startedAt,
    finishedAt:stats?finishedAt:undefined,
    stats,
    stopped:false,
    reconstructed:true
  };
}
function scanExistingRuns(){
  const names = fs.readdirSync(BASE,{withFileTypes:true})
    .filter(d=>d.isDirectory())
    .map(d=>d.name)
    .filter(n=>/^[A-Za-z0-9_.-]+$/.test(n));
  for(const name of names){
    if(!findRun(name)){
      const rec=buildRunFromDir(name);
      runs.push(rec);
    }
  }
}

/* Ensure job exists before phase transitions (prevents null crash) */
function ensureCurrentJob(id, dir, startedAt, phase){
  if(!currentJob || currentJob.id !== id){
    currentJob = {
      id,
      dir,
      startedAt: startedAt || Date.now(),
      phase: phase || 'archive',
      totalUrls: (currentJob && currentJob.totalUrls) || 0,
      stopRequested: false
    };
  } else {
    currentJob.phase = phase || currentJob.phase || 'archive';
  }
}

/* ---------- Serve UI (auto-inject helper scripts) ---------- */
app.get('/',(req,res)=>{
  try{
    const fp = path.join(__dirname,'public','index.html');
    let html = fs.readFileSync(fp,'utf8');
    const tags = [
      '<script src="/static/js/target-platform.js"></script>',
      '<script src="/static/js/export-ui.js"></script>'
    ];
    for (const tag of tags) {
      if (!html.includes(tag)) {
        html = /<\/body>/i.test(html)
          ? html.replace(/<\/body>/i, `  ${tag}\n</body>`)
          : html + '\n' + tag + '\n';
      }
    }
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.status(500).send('UI load error: ' + e.message);
  }
});

/* ---------- Logs (SSE) ---------- */
app.get('/api/logs',(req,res)=>{
  res.writeHead(200,{
    'Content-Type':'text/event-stream',
    'Cache-Control':'no-cache',
    Connection:'keep-alive'
  });
  logBuf.slice(-500).forEach(l=>res.write(`data: ${l}\n\n`));
  sseClients.push(res);
  req.on('close',()=>{ sseClients=sseClients.filter(c=>c!==res); });
});

/* ---------- Debug ---------- */
app.get('/api/debug/runs',(req,res)=> res.json({count:runs.length,runs}));
app.get('/api/debug/job',(req,res)=> res.json({currentJob}));

/* ---------- Settings Configuration ---------- */
app.get('/api/settings', (req,res) => {
  res.json({ settings: getAllSettings() });
});

/* ---------- finalizePartialManifest ---------- */
function finalizePartialManifest(dir){
  const partial = path.join(dir,'manifest.partial.jsonl');
  const final = path.join(dir,'manifest.json');
  if (!fs.existsSync(partial)){
    fs.writeFileSync(final,'[]','utf8');
    return { pages:0, failures:0, assets:0 };
  }
  const lines = fs.readFileSync(partial,'utf8').split(/\r?\n/).filter(Boolean);
  const map = new Map();
  for(const line of lines){
    try{
      const rec=JSON.parse(line);
      map.set(rec.url, rec);
    }catch{}
  }
  const manifest=[...map.values()].sort((a,b)=>a.url.localeCompare(b.url));
  fs.writeFileSync(final, JSON.stringify(manifest,null,2));
  const failures=manifest.filter(m=>!m.status.startsWith('ok')).length;
  const assets=manifest.reduce((s,m)=>s+m.assets,0);
  return { pages:manifest.length, failures, assets };
}

// Mount products-only API
const attachProductsOnlyApi = require('./server/products-only-api.cjs');
attachProductsOnlyApi(app, {
  rootDir: __dirname,           // project root (where archiver.cjs, crawler.cjs live)
  downloadBaseUrl: '/download'  // already served by your static mount
});

/* ---------- Runs & Status ---------- */
app.get('/api/runs',(req,res)=>{
  scanExistingRuns();
  res.json({ runs: runs
    .slice()
    .sort((a,b)=> (a.startedAt>b.startedAt? -1:1))
    .map(r=>({
      id:r.id, dir:r.dir, startedAt:r.startedAt, finishedAt:r.finishedAt,
      stats:r.stats, stopped: !!r.stopped, pending: !!r.pending
    }))
  });
});
app.get('/api/status',(req,res)=>{
  res.json({ running: !!currentJob, currentJob, lastRun: runs.slice(-1)[0] || null, hosts: [...hosts.keys()] });
});
app.get('/api/manifest',(req,res)=>{
  const id=req.query.id;
  scanExistingRuns();
  const run=id? findRun(id) : runs.slice(-1)[0];
  if(!run) return res.status(404).json({error:'run not found'});
  const mf=path.join(run.dir,'manifest.json');
  if(!fs.existsSync(mf)) return res.status(404).json({error:'manifest missing'});
  res.sendFile(mf);
});

/* ---------- Stop Run ---------- */
app.post('/api/stop-run',(req,res)=>{
  if(!currentJob || !currentChildProc){
    return res.status(400).json({error:'no run in progress'});
  }
  const jobId=currentJob.id;
  push(`[STOP_REQUEST] id=${jobId} phase=${currentJob.phase}`);
  currentJob.stopRequested=true;
  // If currently in a crawling phase, drop a STOP flag file to encourage graceful exit
  try {
    if(/crawl/i.test(String(currentJob.phase||''))){
      const flagDir = path.join(currentJob.dir,'_crawl');
      fs.mkdirSync(flagDir,{recursive:true});
      fs.writeFileSync(path.join(flagDir,'STOP'),'1');
      push('[STOP_FLAG] wrote _crawl/STOP');
    }
  } catch(e){ push('[STOP_FLAG_ERR] '+e.message); }
  try { currentChildProc.kill('SIGTERM'); } catch(e){ push('[STOP_ERR] '+e.message); }
  const pid=currentChildProc.pid;
  setTimeout(()=>{
    try{
      process.kill(pid,0);
      push(`[STOP_FORCE] SIGKILL pid=${pid}`);
      process.kill(pid,'SIGKILL');
    }catch{}
  },1500);

  try {
    const runRec=findRun(jobId);
    if(currentJob.phase==='archive'){
      const stats=finalizePartialManifest(currentJob.dir);
      if(runRec){
        runRec.stats=stats;
        runRec.finishedAt=Date.now();
        runRec.stopped=true;
        runRec.pending=false;
      } else {
        runs.push({ id:jobId, dir:currentJob.dir, startedAt:currentJob.startedAt,
          finishedAt:Date.now(), stats, stopped:true, pending:false });
      }
      push(`[JOB_EXIT] id=${jobId} code=137 (stopped early)`);
    } else {
      const crawlDir=path.join(currentJob.dir,'_crawl');
      let seedsFile=path.join(crawlDir,'urls.txt');
      let stats=null;
      if(fs.existsSync(seedsFile)){
        const lines=fs.readFileSync(seedsFile,'utf8').trim().split(/\r?\n/).filter(Boolean);
        stats={ pagesCrawled: lines.length };
      } else seedsFile=null;
      if(runRec){
        runRec.stats=stats;
        runRec.finishedAt=Date.now();
        runRec.pending=false;
        runRec.stopped=true;
      } else {
        runs.push({
          id:jobId, dir:currentJob.dir, seedsFile,
          startedAt:currentJob.startedAt, finishedAt:Date.now(),
          stats, stopped:true, pending:false
        });
      }
      push(`[CRAWL_EXIT] id=${jobId} code=137 (stopped early)`);
    }
  } catch(e){
    push('[STOP_FINALIZE_ERR] '+e.message);
  }
  currentChildProc=null;
  currentJob=null;
  startingJob=false; // release gate
  res.json({ ok:true, message:'Run stopped & finalized.' });
});

/* ---------- Stop Crawler ---------- */
app.post('/api/stop-crawler',(req,res)=>{
  if(!currentJob || !currentChildProc){
    return res.status(400).json({error:'no crawler running'});
  }
  
  // Create STOP file for crawler if it's a crawl-only or crawl phase
  if(currentJob.phase === 'crawl-only' || currentJob.phase === 'crawl'){
    const stopFile = path.join(currentJob.dir,'_crawl','STOP');
    try {
      fs.mkdirSync(path.dirname(stopFile), {recursive: true});
      fs.writeFileSync(stopFile, 'STOP', 'utf8');
      push(`[STOP_CRAWLER] Stop file created: ${stopFile}`);
    } catch(e) {
      push(`[STOP_CRAWLER_ERR] Failed to create stop file: ${e.message}`);
    }
  }
  
  // Also send SIGTERM as backup
  try { 
    currentChildProc.kill('SIGTERM'); 
  } catch(e){ 
    push('[STOP_CRAWLER_ERR] '+e.message); 
  }
  
  res.json({ ok:true, message:'Crawler stop requested.' });
});

/* ---------- Crawl Only ---------- */
app.post('/api/crawl',(req,res)=>{
  if (currentJob || startingJob) return res.status(400).json({error:'job running'});
  const { startUrlsText, crawlOptions={} } = req.body||{};
  if(!startUrlsText) return res.status(400).json({error:'startUrlsText required'});
  const startUrls=startUrlsText.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  if(!startUrls.length) return res.status(400).json({error:'no start urls'});

  const id = deriveRunId(startUrlsText, {
    format: process.env.RUN_ID_FORMAT || 'domain-date-rand',
    baseDir: BASE,
    stripWWW: String(process.env.RUN_ID_STRIP_WWW || 'true').toLowerCase() !== 'false'
  });
  const dir=path.join(BASE,id);
  fs.mkdirSync(dir,{recursive:true});

  const env = buildCrawlEnv(crawlOptions, dir, startUrls);
  startingJob = true;
  currentJob={ id, dir, startedAt:Date.now(), phase:'crawl-only', totalUrls:startUrls.length };
  startingJob = false;
  runs.push({ id, dir, startedAt:currentJob.startedAt, stats:null, stopped:false, pending:true });
  push(`[CRAWL_START] id=${id} seeds=${startUrls.length}`);
  const child=spawn('node',[CRAWLER],{ env });
  currentChildProc=child;
  child.stdout.on('data',d=>d.toString().split(/\r?\n/).filter(Boolean).forEach(l=>push('[C] '+l)));
  child.stderr.on('data',d=>d.toString().split(/\r?\n/).filter(Boolean).forEach(l=>push('[C:ERR] '+l)));
  child.on('exit',code=>{
    push(`[CRAWL_EXIT] id=${id} code=${code}`);
    let seedsFile = path.join(dir,'_crawl','urls.txt');
    let stats=null;
    if(fs.existsSync(seedsFile)){
      stats={ pagesCrawled: fs.readFileSync(seedsFile,'utf8').trim().split(/\r?\n/).filter(Boolean).length };
    }
    const rec=findRun(id);
    if(rec){
      rec.stats=stats;
      rec.finishedAt=Date.now();
      rec.pending=false;
      rec.stopped= !!currentJob?.stopRequested;
    }
    currentJob=null; currentChildProc=null;
    startingJob=false;
  });
  res.json({ ok:true, crawlId:id, dir });
});

/* ---------- Launch Archiver ---------- */
function launchArchiver(id, dir, seedsFile, options, startedAt){
  // Ensure job state exists (prevents null crash)
  ensureCurrentJob(id, dir, startedAt, 'archive');

  const env = buildArchiverEnv(options);
  push(`[JOB_PHASE] archive start id=${id} target=${env.TARGET_PLATFORM}`);
  const child=spawn('node',[ARCHIVER,seedsFile,dir],{ env });
  currentChildProc=child;
  
  attachChildProcessLoggers(child, 'A');
  
  child.on('exit', createJobExitHandler(id, 'JOB', (code) => {
    let stats=null;
    const manifestPath=path.join(dir,'manifest.json');
    if(!fs.existsSync(manifestPath)){
      try{
        const partial = path.join(dir,'manifest.partial.jsonl');
        if(fs.existsSync(partial)){
          const lines = fs.readFileSync(partial,'utf8').split(/\r?\n/).filter(Boolean);
          const map = new Map();
          for(const line of lines){ try{ const rec=JSON.parse(line); map.set(rec.url+':'+rec.profile, rec); }catch{} }
          const manifest=[...map.values()];
          fs.writeFileSync(manifestPath, JSON.stringify(manifest,null,2));
          const failures=manifest.filter(m=>!String(m.status||'').startsWith('ok')).length;
          const totalAssets=manifest.reduce((s,m)=>s+(m.assets||0),0);
          stats={ pages:manifest.length, failures, assets:totalAssets };
        }
      }catch{}
    } else {
      try{
        const mf=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
        const failures=mf.filter(m=>!String(m.status||'').startsWith('ok')).length;
        const totalAssets=mf.reduce((s,m)=>s+(m.assets||0),0);
        stats={ pages:mf.length, failures, assets:totalAssets };
      }catch{}
    }
    const rec=findRun(id);
    if(rec){
      rec.stats=stats;
      rec.finishedAt=Date.now();
      rec.pending=false;
      rec.stopped= !!currentJob?.stopRequested;
    } else {
      runs.push({
        id, dir, seedsFile, startedAt,
        finishedAt:Date.now(), stats,
        stopped: !!currentJob?.stopRequested, pending:false
      });
    }
    currentJob=null; currentChildProc=null;
    startingJob=false;
  }));
}

/* ---------- RUN Endpoint ---------- */
app.post('/api/run',(req,res)=>{
  push('[DEBUG] /api/run incoming body=' + JSON.stringify(req.body||{}));

  // Prevent duplicate starts (double click, double submit)
  if(currentJob || startingJob) return res.status(400).json({error:'job running'});
  startingJob = true;

  const { urlsText, options={}, crawlOptions={}, crawlFirst=false } = req.body||{};
  const directURLs = urlsText ? urlsText.split(/\r?\n/).map(x=>x.trim()).filter(Boolean) : [];
  if(!directURLs.length && !crawlFirst && !(options.autoExpandDepth>0)){
    startingJob = false;
    return res.status(400).json({error:'No direct URLs and no crawl/auto-expand requested'});
  }

  const primaryForId =
    (directURLs[0] || '') ||
    (crawlFirst ? (crawlOptions.startUrlsText || '').split(/\r?\n/).map(s=>s.trim()).filter(Boolean)[0] || '' : '') ||
    (urlsText || '');

  const id = deriveRunId(primaryForId, {
    format: process.env.RUN_ID_FORMAT || 'domain-date-rand',
    baseDir: BASE,
    stripWWW: String(process.env.RUN_ID_STRIP_WWW || 'true').toLowerCase() !== 'false'
  });

  const dir=path.join(BASE,id);
  fs.mkdirSync(dir,{recursive:true});

  const autoDepth = parseInt(options.autoExpandDepth || 0,10);
  const autoMax = parseInt(options.autoExpandMaxPages || 0,10) || 200;

  runs.push({ id, dir, seedsFile:null, startedAt:Date.now(), stats:null, stopped:false, pending:true });

  if(!crawlFirst && autoDepth>0){
    currentJob={ id, dir, startedAt:Date.now(), phase:'auto-expand', totalUrls:directURLs.length };
    startingJob = false; // gate released
    push(`[JOB_START] id=${id} autoExpandDepth=${autoDepth} seeds=${directURLs.length}`);
    const env = {
      ...buildCrawlEnv({
        maxPages: autoMax,
        maxDepth: autoDepth,
        sameHostOnly: options.autoExpandSameHostOnly,
        includeSubdomains: options.autoExpandSubdomains,
        allowRegex: options.autoExpandAllowRegex,
        denyRegex: options.autoExpandDenyRegex,
        waitAfterLoad: crawlOptions.waitAfterLoad,
        navTimeout: crawlOptions.navTimeout,
        pageTimeout: crawlOptions.pageTimeout,
        disableHttp2: (options.disableHttp2 || crawlOptions.disableHttp2)
      }, dir, directURLs),
      DISABLE_AUTO_ALLOW: 'true'
    };
    const crawlChild=spawn('node',[CRAWLER],{ env });
    currentChildProc=crawlChild;
    crawlChild.stdout.on('data',d=>d.toString().split(/\r?\n/).filter(Boolean).forEach(l=>push('[C] '+l)));
    crawlChild.stderr.on('data',d=>d.toString().split(/\r?\n/).filter(Boolean).forEach(l=>push('[C:ERR] '+l)));
    crawlChild.on('exit', code=>{
      push(`[AUTO_EXPAND_EXIT] id=${id} code=${code}`);
      const seedsFile=path.join(dir,'_crawl','urls.txt');
      if(code!==0 || !fs.existsSync(seedsFile)){
        push('[JOB_ABORT] auto expand produced no seeds');
        const rec=findRun(id);
        if(rec){ rec.pending=false; rec.finishedAt=Date.now(); rec.stats=null; }
        startingJob = false;
        try{ if(currentChildProc){ currentChildProc.kill('SIGTERM'); } }catch{}
        currentChildProc=null;
        currentJob=null;
        return;
      }
      const rec=findRun(id);
      if(rec){ rec.seedsFile=seedsFile; }

      // Ensure job exists before moving to archiver (prevents null crash)
      ensureCurrentJob(id, dir, rec ? rec.startedAt : Date.now(), 'archive');

      launchArchiver(id, dir, seedsFile, options, rec?rec.startedAt:Date.now());
    });
    return res.json({ ok:true, runId:id, dir, crawling:true, autoExpand:true });
  }

  if(crawlFirst){
    const startUrls = (crawlOptions.startUrlsText||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
    if(!startUrls.length){
      startingJob = false;
      return res.status(400).json({error:'crawlFirst set but no startUrls'});
    }
    currentJob={ id, dir, startedAt:Date.now(), phase:'crawl', totalUrls:0 };
    startingJob = false;
    push(`[JOB_START] id=${id} crawlFirst=true startSeeds=${startUrls.length}`);
  const env = buildCrawlEnv(crawlOptions, dir, startUrls);
    const crawlChild=spawn('node',[CRAWLER],{ env });
    currentChildProc=crawlChild;
    crawlChild.stdout.on('data',d=>d.toString().split(/\r?\n/).filter(Boolean).forEach(l=>push('[C] '+l)));
    crawlChild.stderr.on('data',d=>d.toString().split(/\r?\n/).filter(Boolean).forEach(l=>push('[C:ERR] '+l)));
    crawlChild.on('exit',code=>{
      push(`[CRAWL_PHASE_EXIT] id=${id} code=${code}`);
      const seedsFile=path.join(dir,'_crawl','urls.txt');
      if(code!==0 || !fs.existsSync(seedsFile)){
        push('[JOB_ABORT] crawl produced no seeds');
        const rec=findRun(id);
        if(rec){ rec.pending=false; rec.finishedAt=Date.now(); }
        startingJob = false;
        try{ if(currentChildProc){ currentChildProc.kill('SIGTERM'); } }catch{}
        currentChildProc=null;
        currentJob=null;
        return;
      }
      const rec=findRun(id);
      if(rec){ rec.seedsFile=seedsFile; }

      // Ensure job exists before archiver
      ensureCurrentJob(id, dir, rec ? rec.startedAt : Date.now(), 'archive');

      launchArchiver(id, dir, seedsFile, options, rec?rec.startedAt:Date.now());
    });
    return res.json({ ok:true, runId:id, dir, crawling:true });
  }

  if(!directURLs.length){
    startingJob = false;
    return res.status(400).json({error:'no direct URLs'});
  }
  const seedsFile=path.join(dir,'seeds.txt');
  fs.writeFileSync(seedsFile, directURLs.join('\n')+'\n','utf8');
  const rec=findRun(id);
  if(rec){ rec.seedsFile=seedsFile; }
  currentJob={ id, dir, startedAt:Date.now(), phase:'archive', totalUrls:directURLs.length };
  startingJob = false;
  push(`[JOB_START] id=${id} direct urls=${directURLs.length}`);
  launchArchiver(id, dir, seedsFile, options, rec?rec.startedAt:Date.now());
  res.json({ ok:true, runId:id, dir, crawling:false });
});

/* ---------- Delete Run ---------- */
app.post('/api/delete-run',(req,res)=>{
  const { runId } = req.body||{};
  if(!runId) return res.status(400).json({error:'runId required'});
  const idx=runs.findIndex(r=>r.id===runId);
  if(idx===-1) return res.status(404).json({error:'not found'});
  if(currentJob && currentJob.id===runId) return res.status(400).json({error:'job running'});
  try{
    fs.rmSync(runs[idx].dir,{recursive:true, force:true});
  }catch(e){
    return res.status(500).json({error:'delete failed '+e.message});
  }
  runs.splice(idx,1);
  push('[DELETE_RUN] '+runId);
  res.json({ ok:true });
});

/* ---------- Host controls ---------- */
app.post('/api/host-run',(req,res)=>{
  const { runId, port=8081, startPath='' } = req.body||{};
  scanExistingRuns();
  const run = runId? findRun(runId) : runs.slice(-1)[0];
  if(!run) return res.status(404).json({error:'run not found'});
  if(!fs.existsSync(HOST_SERVER)) return res.status(500).json({error:'server.cjs missing'});

  const p = parseInt(port, 10);
  if(!p || p<1 || p>65535) return res.status(400).json({error:'invalid port'});
  if(hosts.has(p)) return res.status(409).json({error:`port ${p} already in use by runId=${hosts.get(p).runId}`});

  const env={ ...process.env, ARCHIVE_ROOT: run.dir, PORT:String(p), START_PATH:startPath };
  const child=spawn('node',[HOST_SERVER],{ env });
  
  attachChildProcessLoggers(child, 'HOST');
  
  child.on('exit', createJobExitHandler(p, 'HOST', (code) => {
    hosts.delete(p);
  }));
  const publicUrl = inferPublicUrl(p) + (startPath || '').replace(/^\//,'');
  hosts.set(p, { child, runId: run.id, startedAt: Date.now(), root: run.dir, url: publicUrl });
  push(`[HOST_START] pid=${child.pid} port=${p} public=${publicUrl} root=${run.dir} runId=${run.id}`);
  res.json({ ok:true, url: publicUrl, runId:run.id, pid:child.pid, port:p });
});
app.post('/api/host-run/auto',(req,res)=>{
  const { runId, startPath='' } = req.body||{};
  const range = Array.from({length:9}, (_,i)=>8081+i);
  const free = range.find(p=>!hosts.has(p));
  if(!free) return res.status(409).json({error:'no free port in 8081..8089'});
  req.body.port = free;
  app._router.handle(req, res, 'POST');
});
app.post('/api/host-stop',(req,res)=>{
  const { port, runId } = req.body||{};
  let entryPort = null;
  if(port && hosts.has(parseInt(port,10))) {
    entryPort = parseInt(port,10);
  } else if(runId) {
    for(const [p, h] of hosts.entries()) {
      if(h.runId === runId) { entryPort = p; break; }
    }
  }
  if(entryPort==null) return res.status(404).json({error:'host not found'});
  const entry = hosts.get(entryPort);
  try { entry.child.kill('SIGTERM'); } catch(e) { push('[HOST_STOP_ERR] '+e.message); }
  res.json({ ok:true, stoppedPort: entryPort, runId: entry.runId });
});
app.get('/api/hosts',(req,res)=>{
  const list = [...hosts.entries()].map(([port, h]) => ({
    port, runId: h.runId, root: h.root, startedAt: h.startedAt, url: h.url || inferPublicUrl(port)
  }));
  res.json({ hosts: list });
});

/* ---------- Transforms & Hosting Prep ---------- */
app.post('/api/transform-preview',(req,res)=>{
  try{
    const { runId, actions } = req.body||{};
    if(!runId) return res.status(400).json({error:'runId required'});
    const run=findRun(runId);
    if(!run) return res.status(404).json({error:'run not found'});
    const result=applyTransforms(run.dir, actions||{}, { preview:true });
    res.json({ ok:true, result });
  }catch(e){ res.status(500).send(JSON.stringify({ error:e.message })); }
});
app.post('/api/transform-apply',(req,res)=>{
  try{
    const { runId, actions } = req.body||{};
    if(!runId) return res.status(400).json({error:'runId required'});
    const run=findRun(runId);
    if(!run) return res.status(404).json({error:'run not found'});
    const result=applyTransforms(run.dir, actions||{}, { preview:false });
    push('[TRANSFORM_APPLY] run='+runId);
    res.json({ ok:true, result });
  }catch(e){ res.status(500).json({ error:e.message }); }
});
app.post('/api/transform-reset',(req,res)=>{
  try{
    const { runId } = req.body||{};
    if(!runId) return res.status(400).json({error:'runId required'});
    const run=findRun(runId);
    if(!run) return res.status(404).json({error:'run not found'});
    const info=resetTransforms(run.dir);
    push('[TRANSFORM_RESET] run='+runId);
    res.json({ ok:true, info });
  }catch(e){ res.status(500).json({ error:e.message }); }
});
app.post('/api/upload-logo',(req,res)=>{
  try{
    const { runId, fileName, dataBase64 } = req.body||{};
    if(!runId || !fileName || !dataBase64) return res.status(400).json({error:'runId,fileName,dataBase64 required'});
    const run=findRun(runId);
    if(!run) return res.status(404).json({error:'run not found'});
    const { assetsDir } = findRootIndex(run.dir);
    if(!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir,{recursive:true});
    const safe=fileName.replace(/[^a-zA-Z0-9._-]+/g,'_');
    const buf=Buffer.from(dataBase64,'base64');
    fs.writeFileSync(path.join(assetsDir,safe), buf);
    push('[LOGO_UPLOAD] run='+runId+' file='+safe+' bytes='+buf.length);
    res.json({ ok:true, storedFile:safe });
  }catch(e){ res.status(500).json({ error:e.message }); }
});

/* ---------- Hosting presets & suggestions ---------- */
const PLATFORM_PRESETS = [
  { id:'generic', precompress:true,  label:'Generic' },
  { id:'netlify', precompress:true,  label:'Netlify' },
  { id:'cloudflare', precompress:false, label:'Cloudflare Pages' },
  { id:'s3', precompress:true, label:'S3+CloudFront' },
  { id:'shopify', precompress:true, label:'Shopify' }
];
function loadManifest(runId){
  const run=findRun(runId);
  if(!run) return null;
  const fp=path.join(run.dir,'manifest.json');
  if(!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp,'utf8')); } catch { return null; }
}
function analyzeRunSmart(run){
  const manifest = loadManifest(run.id) || [];
  const pagesSet=new Set();
  let hasMobile=false;
  let totalAssets=0;
  let largestInline=0;
  let analyticsHits=0;
  for(const rec of manifest){
    if(rec.profile==='desktop'){
      pagesSet.add(rec.relPath||'index');
      totalAssets += (rec.assets||0);
    }
    if(rec.profile==='mobile') hasMobile=true;
  }
  manifest.filter(r=>r.profile==='desktop').slice(0,5).forEach(rec=>{
    let file;
    if(!rec.relPath || rec.relPath==='index') file=path.join(run.dir,'index','desktop','index.html');
    else file=path.join(run.dir,rec.relPath,'desktop','index.html');
    if(fs.existsSync(file)){
      const html=fs.readFileSync(file,'utf8');
      const m=html.match(/(googletagmanager|gtag|analytics|hotjar|clarity|segment|fullstory|facebook\.net)/gi);
      if(m) analyticsHits+=m.length;
      const parts=html.split('<script');
      for(let i=1;i<parts.length;i++){
        const seg=parts[i];
        const end=seg.indexOf('</script>');
        if(end>0){
          const script = seg.slice(seg.indexOf('>')+1,end);
          if(script.length>largestInline) largestInline=script.length;
        }
      }
    }
  });
  let baseUrl='';
  if(manifest[0] && manifest[0].url){
    try{ baseUrl=new URL(manifest[0].url).origin; }catch{}
  }
  return {
    runId: run.id,
    pages: pagesSet.size || manifest.length || 1,
    hasMobile,
    totalAssetsApprox: totalAssets,
    largestInlineScriptBytes: largestInline,
    analyticsMatches: analyticsHits,
    recommendations: {
      mode: hasMobile ? 'switch' : 'desktop',
      stripAnalytics: analyticsHits>0,
      precompress: (largestInline>200000 || totalAssets>400),
      noServiceWorker: (pagesSet.size||1) < 2,
      baseUrl
    }
  };
}
app.get('/api/hosting/platform-presets',(req,res)=>{
  res.json({ platforms: PLATFORM_PRESETS.map(p=>({ id:p.id,label:p.label,recommends:{precompress:p.precompress} })) });
});
app.get('/api/hosting/:runId/suggestions',(req,res)=>{
  const run=findRun(req.params.runId);
  if(!run) return res.status(404).json({error:'run not found'});
  try { res.json(analyzeRunSmart(run)); }
  catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/api/hosting-presets',(req,res)=>{
  res.json({ platforms: PLATFORM_PRESETS.map(p=>({ id:p.id,label:p.label,recommends:{precompress:p.precompress} })) });
});
app.get('/api/runs/:id/prepare-suggestions',(req,res)=>{
  const run=findRun(req.params.id);
  if(!run) return res.status(404).json({error:'run not found'});
  try { res.json(analyzeRunSmart(run)); }
  catch(e){ res.status(500).json({error:e.message}); }
});

/* ---------- Platform Export (Shopify / WooCommerce) ---------- */
function toWeb(absPath){
  const rel = path.relative(OUT_BASE, absPath);
  if (rel.startsWith('..')) return null; // outside OUT_BASE
  return '/download/' + rel.split(path.sep).join('/');
}

app.get('/api/page-map', (req, res) => {
  try{
    const runId = String(req.query.runId || '').trim();
    if (!runId) return res.status(400).json({ error: 'runId required' });
    const run = runs.find(r=>r.id===runId);
    if(!run) return res.status(404).json({ error:'run not found' });

    const tool = path.join(__dirname, 'tools', 'page-map.cjs');
    if (!fs.existsSync(tool)) return res.status(500).json({ error:'tools/page-map.cjs missing' });

    // Generate (idempotent) and return the JSON
    const { spawnSync } = require('child_process');
    const out = spawnSync(process.execPath, [tool, run.dir], { encoding:'utf8' });
    if (out.status !== 0) return res.status(500).json({ error: out.stderr || out.stdout || 'page-map failed' });

    const reportPath = path.join(run.dir, '_reports', 'page-map.json');
    if (!fs.existsSync(reportPath)) return res.status(500).json({ error:'page-map.json not found' });
    const json = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    res.json({ ok:true, map: json, seedsFile: '/download/' + path.relative(path.join(__dirname,'out'), reportPath).split(path.sep).join('/') });
  } catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/export', async (req,res)=>{
  try{
    const { runId, platform, out, inlineCss } = req.body || {};
    if(!runId) return res.status(400).json({ error:'runId required' });
    if(!platform) return res.status(400).json({ error:'platform required (shopify|woocommerce)' });

    const run = runs.find(r=>r.id===runId);
    if(!run) return res.status(404).json({ error:'run not found' });

    const exporterPath = path.join(__dirname, 'platform', 'exporter.cjs');
    if(!fs.existsSync(exporterPath)) return res.status(500).json({ error:'exporter missing (platform/exporter.cjs)' });
    const { exportRun } = require(exporterPath);

    const OUT_DIR_BASE = path.join(__dirname, 'out'); // ensure this exists and is exposed via /download
    fs.mkdirSync(OUT_DIR_BASE, { recursive: true });

    const outDir = out ? path.resolve(out) : path.join(OUT_DIR_BASE, platform, `${runId}-${Date.now().toString(36)}`);
    fs.mkdirSync(outDir, { recursive: true });

    const result = await exportRun({ runDir: run.dir, outDir, platform, options: { inlineCss } });

    const toWebLocal = (abs) => {
      const rel = path.relative(OUT_DIR_BASE, abs);
      return rel.startsWith('..') ? null : ('/download/' + rel.split(path.sep).join('/'));
    };

    const folderUrl = toWebLocal(result.outDir || outDir);
    const productsCsvUrl = result.productsCsv ? toWebLocal(result.productsCsv) : null;
    const pagesWxrUrl = result.pagesWxr ? toWebLocal(result.pagesWxr) : null;

    const payload = { ok:true, outDir: result.outDir || outDir, result, folderUrl, productsCsvUrl, pagesWxrUrl };
    try { console.log('[EXPORT]', payload); } catch {}
    res.json(payload);
  }catch(e){
    res.status(500).json({ error:e.message });
  }
});

/* ---------- Zip exported folder (optional) ---------- */
function execShell(cmd){
  return new Promise((resolve,reject)=>{
    const child = spawn('bash',['-lc',cmd],{ stdio:['ignore','pipe','pipe'] });
    let out='', err='';
    child.stdout.on('data',d=> out+=d.toString());
    child.stderr.on('data',d=> err+=d.toString());
    child.on('exit',code=> code===0 ? resolve({out,err}) : reject(new Error(err||('exit '+code))));
  });
}
app.post('/api/export-zip', async (req,res)=>{
  try{
    const { dir } = req.body || {};
    if(!dir) return res.status(400).json({ error:'dir required (absolute or contained under ./out)' });
    const targetDir = path.isAbsolute(dir) ? dir : path.join(OUT_BASE, dir);
    if(!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()){
      return res.status(404).json({ error:'dir not found' });
    }
    const rel = path.relative(OUT_BASE, targetDir);
    if(rel.startsWith('..')) return res.status(400).json({ error:'dir must be under ./out' });

    const baseName = path.basename(targetDir).replace(/[^A-Za-z0-9._-]+/g,'_');
    const zipPath = path.join(path.dirname(targetDir), baseName + '.zip');
    // Try zip, fallback to tar.gz
    try {
      await execShell(`command -v zip >/dev/null 2>&1 && (cd "${targetDir}" && zip -r "${zipPath}" .)`);
    } catch {
      const tgz = zipPath.replace(/\.zip$/,'.tar.gz');
      await execShell(`tar -czf "${tgz}" -C "${path.dirname(targetDir)}" "${path.basename(targetDir)}"`);
      return res.json({ ok:true, archive: tgz, url: toWeb(tgz) });
    }
    res.json({ ok:true, archive: zipPath, url: toWeb(zipPath) });
  } catch(e){
    res.status(500).json({ error:e.message });
  }
});

/* ---------- Startup ---------- */
scanExistingRuns();
    // Back-compat alias; accept empty body and mirror /api/host-stop behavior
    app.post('/api/stop-host',(req,res)=>{
      const body = req.body || {};
      let { port, runId } = body;
      let entryPort = null;
      if(port && hosts.has(parseInt(port,10))) {
        entryPort = parseInt(port,10);
      } else if(runId) {
        for(const [p, h] of hosts.entries()) {
          if(h.runId === runId) { entryPort = p; break; }
        }
      } else {
        // If nothing provided, try to stop the first host
        const first = [...hosts.keys()][0];
        if(first!=null) entryPort = first;
      }
      if(entryPort==null) return res.status(404).json({error:'host not found'});
      const entry = hosts.get(entryPort);
      try { entry.child.kill('SIGTERM'); } catch(e) { push('[HOST_STOP_ERR] '+e.message); }
      res.json({ ok:true, stoppedPort: entryPort, runId: entry.runId });
    });

/* ---------- Start Server ---------- */
app.listen(PORT,'0.0.0.0',()=>{
  console.log('GUI server on http://0.0.0.0:'+PORT);
  console.log('Download base:', BASE);
  console.log('Exports are downloadable at /download/* from', OUT_BASE);
});