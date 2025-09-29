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

function push(line){
  const l='['+new Date().toISOString()+'] '+line;
  logBuf.push(l);
  if(logBuf.length>MAX_LOG) logBuf.splice(0, logBuf.length-MAX_LOG);
  sseClients.forEach(r=>r.write(`data: ${l}\n\n`));
  process.stdout.write(l+'\n');
}
function findRun(id){ return runs.find(r=>r.id===id); }

function safeStat(p){ try { return fs.statSync(p); } catch { return null; } }
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

  const env={
    ...process.env,
    START_URLS:startUrls.join('\n'),
    OUTPUT_DIR:dir,
    MAX_PAGES:String(crawlOptions.maxPages||200),
    MAX_DEPTH:String(crawlOptions.maxDepth||3),
    SAME_HOST_ONLY:crawlOptions.sameHostOnly===false?'false':'true',
    INCLUDE_SUBDOMAINS:crawlOptions.includeSubdomains===false?'false':'true',
    ALLOW_REGEX:crawlOptions.allowRegex||'',
    DENY_REGEX:crawlOptions.denyRegex||'',
    WAIT_AFTER_LOAD:String(crawlOptions.waitAfterLoad||500),
    NAV_TIMEOUT:String(crawlOptions.navTimeout || 15000),
    PAGE_TIMEOUT:String(crawlOptions.pageTimeout || 45000)
  };
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

  // Preserve 0 (unlimited) if provided; default to 0 (unlimited)
  const maxCap = (options && Object.prototype.hasOwnProperty.call(options,'maxCaptureMs'))
    ? Number(options.maxCaptureMs || 0)
    : 0;

  const env={
    ...process.env,
    ENGINE: options.engine || 'chromium',
    CONCURRENCY: String(options.concurrency || 2),
    HEADLESS: options.headless===false?'false':'true',
    INCLUDE_CROSS_ORIGIN: options.includeCrossOrigin?'true':'false',
    WAIT_EXTRA: String(options.waitExtra || 700),
    NAV_TIMEOUT_MS: String(options.navTimeout || 20000),
    PAGE_TIMEOUT_MS: String(options.pageTimeout || 40000),
    PRODUCT_MIRROR_ENABLE: options.mirrorProducts ? 'true' : 'false',
    SCROLL_PASSES: String(options.scrollPasses || 0),
    SCROLL_DELAY: String(options.scrollDelay || 250),
    ASSET_MAX_BYTES: String(options.assetMaxBytes || (3*1024*1024)),
    REWRITE_INTERNAL: options.rewriteInternal===false?'false':'true',
    INTERNAL_REWRITE_REGEX: options.internalRewriteRegex || '',
    DOMAIN_FILTER: options.domainFilter || '',
    PRESERVE_ASSET_PATHS: options.preserveAssetPaths?'true':'false',
    REWRITE_HTML_ASSETS: options.rewriteHtmlAssets===false?'false':'true',
    MIRROR_SUBDOMAINS: options.mirrorSubdomains===false?'false':'true',
    MIRROR_CROSS_ORIGIN: options.mirrorCrossOrigin?'true':'false',
    INLINE_SMALL_ASSETS: String(options.inlineSmallAssets || 0),
    PAGE_WAIT_UNTIL: options.pageWaitUntil || 'domcontentloaded',
    QUIET_MILLIS: String(options.quietMillis || 1500),
    MAX_CAPTURE_MS: String(maxCap), // respect 0 (unlimited)
    CLICK_SELECTORS: (options.clickSelectors || '').trim(),
    CONSENT_BUTTON_TEXTS: (options.consentButtonTexts || '').trim(),
    CONSENT_EXTRA_SELECTORS: (options.consentExtraSelectors || '').trim(),
    CONSENT_FORCE_REMOVE_SELECTORS: (options.consentForceRemoveSelectors || '').trim(),
    CONSENT_RETRY_ATTEMPTS: String(options.consentRetryAttempts || 12),
    CONSENT_RETRY_INTERVAL_MS: String(options.consentRetryInterval || 700),
    CONSENT_MUTATION_WINDOW_MS: String(options.consentMutationWindow || 8000),
    CONSENT_IFRAME_SCAN: options.consentIframeScan?'true':'false',
    CONSENT_DEBUG: options.consentDebug?'true':'false',
    CONSENT_DEBUG_SCREENSHOT: options.consentDebugScreenshot?'true':'false',
    FORCE_CONSENT_WAIT_MS: String(options.forceConsentWaitMs || 0),
    REMOVE_SELECTORS: (options.removeSelectors || '').trim(),
    SKIP_DOWNLOAD_PATTERNS: (options.skipDownloadPatterns || '').trim(),
    FLATTEN_ROOT_INDEX: options.flattenRoot?'1':'0',
    AGGRESSIVE_CAPTURE: options.aggressiveCapture?'true':'false',
    PROFILES: options.profiles || process.env.PROFILES || 'desktop,mobile',
    SAME_SITE_MODE: options.sameSiteMode || process.env.SAME_SITE_MODE || 'etld',
    INTERNAL_HOSTS_REGEX: options.internalHostsRegex || process.env.INTERNAL_HOSTS_REGEX || '',
    TARGET_PLATFORM: (options.targetPlatform || process.env.TARGET_PLATFORM || 'generic').toLowerCase()
  };
  push(`[JOB_PHASE] archive start id=${id} target=${env.TARGET_PLATFORM}`);
  const child=spawn('node',[ARCHIVER,seedsFile,dir],{ env });
  currentChildProc=child;
  child.stdout.on('data',d=>d.toString().split(/\r?\n/).filter(Boolean).forEach(l=>push('[A] '+l)));
  child.stderr.on('data',d=>d.toString().split(/\r?\n/).filter(Boolean).forEach(l=>push('[A:ERR] '+l)));
  child.on('exit',code=>{
    push(`[JOB_EXIT] id=${id} code=${code}`);
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
  });
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
    const env={
      ...process.env,
      START_URLS: directURLs.join('\n'),
      OUTPUT_DIR: dir,
      MAX_PAGES: String(autoMax),
      MAX_DEPTH: String(autoDepth),
      SAME_HOST_ONLY: options.autoExpandSameHostOnly===false?'false':'true',
      INCLUDE_SUBDOMAINS: options.autoExpandSubdomains===false?'false':'true',
      ALLOW_REGEX: options.autoExpandAllowRegex || '',
      DENY_REGEX: options.autoExpandDenyRegex || '',
      WAIT_AFTER_LOAD: String(crawlOptions.waitAfterLoad || 500),
      NAV_TIMEOUT: String(crawlOptions.navTimeout || 15000),
      PAGE_TIMEOUT: String(crawlOptions.pageTimeout || 45000),
      // Force pages-only discovery; suppress product auto-allow in crawler (if supported)
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
        currentJob=null; currentChildProc=null;
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
    const env={
      ...process.env,
      START_URLS:startUrls.join('\n'),
      OUTPUT_DIR:dir,
      MAX_PAGES:String(crawlOptions.maxPages || 200),
      MAX_DEPTH:String(crawlOptions.maxDepth || 3),
      SAME_HOST_ONLY:crawlOptions.sameHostOnly===false?'false':'true',
      INCLUDE_SUBDOMAINS:crawlOptions.includeSubdomains===false?'false':'true',
      ALLOW_REGEX:crawlOptions.allowRegex || '',
      DENY_REGEX:crawlOptions.denyRegex || '',
      WAIT_AFTER_LOAD:String(crawlOptions.waitAfterLoad || 500),
      NAV_TIMEOUT:String(crawlOptions.navTimeout || 15000),
      PAGE_TIMEOUT:String(crawlOptions.pageTimeout || 45000)
    };
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
        currentJob=null; currentChildProc=null;
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
  child.stdout.on('data',d=>d.toString().split(/\r?\n/).filter(Boolean).forEach(l=>push('[HOST] '+l)));
  child.stderr.on('data',d=>d.toString().split(/\r?\n/).filter(Boolean).forEach(l=>push('[HOST:ERR] '+l)));
  child.on('exit',code=>{
    push('[HOST_EXIT] port='+p+' code='+code);
    hosts.delete(p);
  });
  hosts.set(p, { child, runId: run.id, startedAt: Date.now(), root: run.dir });
  push(`[HOST_START] pid=${child.pid} port=${p} root=${run.dir} runId=${run.id}`);
  res.json({ ok:true, url:`http://YOUR_SERVER_IP:${p}/`, runId:run.id, pid:child.pid, port:p });
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
    port, runId: h.runId, root: h.root, startedAt: h.startedAt
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

/* ---------- Start Server ---------- */
app.listen(PORT,'0.0.0.0',()=>{
  console.log('GUI server on http://0.0.0.0:'+PORT);
  console.log('Download base:', BASE);
  console.log('Exports are downloadable at /download/* from', OUT_BASE);
});