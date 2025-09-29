#!/usr/bin/env node
/**
 * archiver-lib.cjs
 * Snapshot with:
 *  - Network quiet waiting
 *  - Asset capture + rewriting
 *  - Internal link & JSON-LD rewriting (with www normalization & dual-origin handling)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium, firefox, webkit } = require('playwright');
const { HttpsProxyAgent } = require('https-proxy-agent');
const https = require('https');
const cheerio = require('cheerio');

function logDefault(m){ process.stdout.write(m + '\n'); }
function ensureDir(d){ fs.mkdirSync(d,{recursive:true}); }
function shortHash(s){ return crypto.createHash('sha1').update(s).digest('hex').slice(0,16); }
function escapeRegExp(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

function localPathFromURL(u){
  const x = new URL(u);
  let p = x.pathname;
  if (!p || p === '/') return '';
  p = p.replace(/\/+$/,'').replace(/^\/+/,'');
  return p;
}

function guessExt(url, ct){
  let m; try{ m=(new URL(url).pathname.match(/(\.[a-z0-9]{2,6})(?:$|[?#])/i)||[])[1]; }catch{}
  if (m) return m.toLowerCase();
  ct=(ct||'').toLowerCase();
  if (/png/.test(ct)) return '.png';
  if (/jpe?g/.test(ct)) return '.jpg';
  if (/webp/.test(ct)) return '.webp';
  if (/gif/.test(ct)) return '.gif';
  if (/css/.test(ct)) return '.css';
  if (/javascript|ecmascript/.test(ct)) return '.js';
  if (/woff2/.test(ct)) return '.woff2';
  if (/woff/.test(ct)) return '.woff';
  if (/ttf/.test(ct)) return '.ttf';
  if (/svg/.test(ct)) return '.svg';
  if (/ico/.test(ct)) return '.ico';
  return '.bin';
}

function likelyAsset(url, ct){
  if (/\.(png|jpe?g|webp|gif|svg|css|js|mjs|cjs|woff2?|ttf|otf|ico)$/i.test(url)) return true;
  if (/^(image|font)\//.test(ct)) return true;
  if (/css/.test(ct) || /javascript/.test(ct)) return true;
  return false;
}

async function createBrowser(engineName, headless, proxy, disableHTTP2){
  const engines={ chromium, firefox, webkit };
  const engine=engines[engineName]||chromium;
  const args=['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'];
  if (disableHTTP2 && engineName==='chromium') args.push('--disable-http2');
  const launchOpts={ headless };
  if (proxy){
    launchOpts.proxy = { server: proxy.server, username: proxy.username, password: proxy.password };
  }
  if (engineName==='chromium') launchOpts.args=args;
  return engine.launch(launchOpts);
}

function buildProxyRotator(proxies,{stableSession=true,rotateSession=false}){
  let idx=0;
  return function(pageNum){
    if (!proxies || !proxies.length) return null;
    const base = proxies[idx % proxies.length];
    if (!stableSession && pageNum>1) idx++;
    let user=base.username;
    if (rotateSession && !stableSession){
      user=user.replace(/(session-)[A-Za-z0-9_-]+/,(_,p)=> p+crypto.randomBytes(4).toString('hex'));
    }
    return { server:base.server, username:user, password:base.password };
  };
}

function rawFetchProxy(url, proxy, ua){
  return new Promise((resolve,reject)=>{
    const proxyUrl = `http://${proxy.username}:${proxy.password}@${proxy.server.replace(/^https?:\/\//,'')}`;
    const agent = new HttpsProxyAgent(proxyUrl);
    const u = new URL(url);
    const opts={
      hostname:u.hostname,
      path:u.pathname + (u.search||''),
      method:'GET',
      headers:{
        'User-Agent': ua || 'Mozilla/5.0',
        'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      agent,
      timeout:25000
    };
    const req = https.request(opts, res=>{
      let chunks=[]; res.on('data',c=>chunks.push(c));
      res.on('end',()=> resolve({ status:res.statusCode, body:Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error',reject);
    req.setTimeout(25000,()=>{ req.destroy(new Error('raw timeout')); });
    req.end();
  });
}

/* -------- Asset rewriting (HTML + CSS) -------- */
function rewriteHTMLAssets(html, assetRecords, { stripTracking=true, inlineSmall=0, assetsDirName='assets' }){
  const $ = cheerio.load(html,{ decodeEntities:false });
  const map = {};
  for (const r of assetRecords){
    const target = r.inlineDataUri ? r.inlineDataUri : `${assetsDirName}/${r.fileName}`;
    map[r.url] = target;
    try {
      const u=new URL(r.url);
      map['//'+u.host+u.pathname] = target;
    }catch{}
  }
  function rewriteAttr(el, attr){
    const val = $(el).attr(attr);
    if (!val) return;
    if (attr==='srcset'){
      const parts=val.split(',').map(p=>p.trim()).map(p=>{
        const seg=p.split(/\s+/);
        const urlPart=seg[0];
        const mapped=map[urlPart] || map[urlPart.replace(/^https?:/,'')] || map[urlPart.replace(/^https?:\/\//,'//')];
        if (mapped) seg[0]=mapped;
        return seg.join(' ');
      });
      $(el).attr(attr, parts.join(', '));
      return;
    }
    const mapped=map[val] || map[val.replace(/^https?:/,'')] || map[val.replace(/^https?:\/\//,'//')];
    if (mapped) $(el).attr(attr, mapped);
  }
  $('img,script,link,source,video,audio,iframe').each((_,el)=>{
    ['src','href','data-src','poster','srcset'].forEach(a=> rewriteAttr(el,a));
  });
  if (stripTracking){
    const tracking=[
      /googletagmanager\.com/i,
      /google-analytics\.com/i,
      /gtag\/js/i,
      /facebook\.net/i,
      /connect\.facebook\.net/i,
      /doubleclick\.net/i,
      /mailchimp/i,
      /chimpstatic\.com/i
    ];
    $('script[src],script').each((_,el)=>{
      const s=$(el).attr('src') || $(el).html();
      if (tracking.some(rx=>rx.test(s))) $(el).remove();
    });
  }
  let out = $.html();
  for (const r of assetRecords){
    if (r.inlineDataUri){
      const rx=new RegExp(escapeRegExp(r.url),'g');
      out=out.replace(rx,r.inlineDataUri);
      try{
        const u=new URL(r.url);
        const rx2=new RegExp(escapeRegExp('//'+u.host+u.pathname),'g');
        out=out.replace(rx2,r.inlineDataUri);
      }catch{}
    } else {
      const local=`${assetsDirName}/${r.fileName}`;
      const rx=new RegExp(escapeRegExp(r.url),'g');
      out=out.replace(rx,local);
      try{
        const u=new URL(r.url);
        const rx2=new RegExp(escapeRegExp('//'+u.host+u.pathname),'g');
        out=out.replace(rx2,local);
      }catch{}
    }
  }
  return out;
}

function rewriteCSSFiles(assetRecords, assetsDir){
  const urlToLocal={};
  for (const r of assetRecords){
    if (r.inlineDataUri) continue;
    urlToLocal[r.url]=r.fileName;
    try{
      const u=new URL(r.url);
      urlToLocal['//'+u.host+u.pathname]=r.fileName;
    }catch{}
  }
  for (const r of assetRecords){
    if (!/\.css$/i.test(r.fileName)) continue;
    const full=path.join(assetsDir,r.fileName);
    if (!fs.existsSync(full)) continue;
    try {
      let css=fs.readFileSync(full,'utf8');
      css=css.replace(/url\(([^)]+)\)/g,(m,g1)=>{
        let ref=g1.trim().replace(/^["']|["']$/g,'');
        if (!ref) return m;
        const local=urlToLocal[ref] || urlToLocal[ref.replace(/^https?:/,'')] || urlToLocal[ref.replace(/^https?:\/\//,'//')];
        if (local) return `url(${JSON.stringify(local)})`;
        return m;
      });
      fs.writeFileSync(full,css,'utf8');
    }catch{}
  }
}

/* -------- Pre-asset transform (name/price/link) -------- */
function transformHTML(html,{ nameRules, priceRules, linkRewrite, baseURL }){
  if (!nameRules && !priceRules && !linkRewrite) return html;
  const $=cheerio.load(html,{ decodeEntities:false });
  if (nameRules){
    const sels=['h1','h1.product-name','[data-test-id="product-name"]','.product__title'];
    const { prefix='', suffix='', regexFind='', regexFlags='g', regexReplace='' }=nameRules;
    const rx=regexFind ? new RegExp(regexFind, regexFlags):null;
    sels.forEach(sel=>{
      $(sel).each((_,el)=>{
        let t=$(el).text().trim();
        if(!t) return;
        if (rx) t=t.replace(rx,regexReplace);
        t=prefix+t+suffix;
        $(el).text(t);
      });
    });
  }
  if (priceRules){
    const {
      currencySymbol='$', multiplier=1, addAmount=0,
      floor=false, ceil=false, roundCents=true,
      currencyFind='', currencyReplace='',
      postRegexFind='', postRegexReplace=''
    }=priceRules;
    const findRx=currencyFind ? new RegExp(currencyFind,'g'):null;
    $('[class*="price"],.price,span,div').each((_,el)=>{
      const txt=$(el).text();
      if(!/\d/.test(txt)) return;
      if(!/[\d][\d,]*(?:\.\d{1,2})?/.test(txt)) return;
      let rep=txt;
      if (findRx) rep=rep.replace(findRx,currencyReplace);
      const m=rep.replace(/,/g,'').match(/(\d+(?:\.\d+)?)/);
      if(!m) return;
      let val=parseFloat(m[1]);
      if (isNaN(val)) return;
      val=val*multiplier+addAmount;
      if (floor) val=Math.floor(val);
      if (ceil) val=Math.ceil(val);
      if (roundCents) val=parseFloat(val.toFixed(2));
      const out=currencySymbol+val.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,',');
      $(el).text(out);
    });
    if (postRegexFind){
      const prx=new RegExp(postRegexFind,'g');
      $('body *').each((_,el)=>{
        const n=$(el); const t=n.text();
        if (prx.test(t)) n.text(t.replace(prx, postRegexReplace));
      });
    }
  }
  if (linkRewrite){
    const domains=linkRewrite.stripDomains||[];
    if (domains.length){
      $('a[href]').each((_,a)=>{
        let href=$(a).attr('href'); if(!href) return;
        try{
          const u=new URL(href,baseURL);
          if (domains.some(d=>u.hostname.endsWith(d))){
            let p=u.pathname.replace(/\/+$/,'');
            if(!p) p='/';
            $(a).attr('href', p==='/'?'/':p+'/');
          }
        }catch{}
      });
    }
  }
  return $.html();
}

/* -------- Internal links + JSON-LD (with www normalization) -------- */
function rewriteInternalLinksAndJSONLD(html, baseURL, opts){
  const {
    rewriteInternalLinks,
    rewriteJSONLD,
    keepCanonicalAbsolute,
    keepMetaAbsolute,
    replaceAllBaseOrigins,
    debugInternalLinks
  } = opts;

  if (!rewriteInternalLinks && !rewriteJSONLD) return html;

  const uBase = new URL(baseURL);
  const baseHost = uBase.hostname;
  const normBase = baseHost.replace(/^www\./,'');
  const originWithWWW = uBase.protocol + '//' + (baseHost.startsWith('www.') ? baseHost : 'www.'+baseHost);
  const originNoWWW = uBase.protocol + '//' + normBase;
  const origins = new Set([originNoWWW, originWithWWW]);

  const $ = cheerio.load(html,{ decodeEntities:false });
  let linkCount=0, jsonCount=0, globalReplaceCount=0;

  if (rewriteInternalLinks){
    const ATTRS = ['href','src','data-src','poster'];
    $('*[href], *[src], *[data-src], *[poster]').each((_,el)=>{
      ATTRS.forEach(attr=>{
        const val=$(el).attr(attr);
        if(!val) return;
        if (/^(data:|mailto:|tel:|javascript:)/i.test(val)) return;
        let abs;
        try { abs = new URL(val, originNoWWW); }
        catch { return; }
        const hostNorm = abs.hostname.replace(/^www\./,'');
        if (hostNorm !== normBase) return;

        const isCanonical = $(el).is('link[rel=canonical]');
        const isMeta = $(el).is('meta[property="og:url"],meta[property="og:image"],meta[property="og:image:url"],meta[property="og:image:secure_url"]');

        if (isCanonical && keepCanonicalAbsolute) return;
        if (isMeta && keepMetaAbsolute) return;

        let p = abs.pathname || '/';
        if (!/\.[a-z0-9]{2,6}$/i.test(p) && !p.endsWith('/')) p+='/';
        if (!p.startsWith('/')) p='/'+p;
        $(el).attr(attr,p);
        linkCount++;
      });
    });
  }

  if (rewriteJSONLD){
    $('script[type="application/ld+json"]').each((_,el)=>{
      let txt=$(el).html();
      if (!txt) return;
      let changed=false;
      for (const o of origins){
        const rx = new RegExp(escapeRegExp(o)+'/', 'g');
        if (rx.test(txt)){
          txt = txt.replace(rx,'/');
          changed=true;
        }
      }
      if (changed){
        $(el).text(txt);
        jsonCount++;
      }
    });
  }

  // Optional global pass to replace both origins in any remaining text (meta tags etc.)
  if (replaceAllBaseOrigins){
    let out = $.html();
    for (const o of origins){
      const rx=new RegExp(escapeRegExp(o)+'/', 'g');
      if (rx.test(out)){
        out = out.replace(rx,'/');
        globalReplaceCount++;
      }
    }
    if (debugInternalLinks) {
      console.log(`[INTERNAL_REWRITE] links=${linkCount} jsonld=${jsonCount} globalOriginPass=${globalReplaceCount}`);
    }
    return out;
  } else {
    if (debugInternalLinks) {
      console.log(`[INTERNAL_REWRITE] links=${linkCount} jsonld=${jsonCount}`);
    }
    return $.html();
  }
}

/* ---------------- Single Page Capture ---------------- */
async function capture(url, cfg){
  const start=Date.now();
  const relPath=localPathFromURL(url);
  const pageDir = relPath ? path.join(cfg.outputRoot, relPath) : cfg.outputRoot;
  const assetsDir = path.join(pageDir,'assets');
  ensureDir(pageDir); ensureDir(assetsDir);

  const rec={
    url, relPath,
    status:'ok',
    mainStatus:null,
    finalURL:null,
    assets:0,
    rawUsed:false,
    reasons:[],
    durationMs:0,
    assetFiles:[]
  };

  const proxy = cfg.proxyNext ? cfg.proxyNext(cfg.pageNum++) : null;
  let browser;
  let lastActivity=Date.now();
  let inflight=0;
  const assetRecords=[];
  const savedUrlSet=new Set();
  function activity(){ lastActivity=Date.now(); }
  function allowAsset(rUrl, ct){
    if (cfg.includeCross) return true;
    try{
      const baseHost=(new URL(url)).hostname.replace(/^www\./,'');
      const h=(new URL(rUrl)).hostname.replace(/^www\./,'');
      return h===baseHost || h.endsWith('.'+baseHost);
    }catch{return false;}
  }

  try{
    browser=await createBrowser(cfg.engine, cfg.headless, proxy, cfg.disableHTTP2);
    const context=await browser.newContext({
      userAgent: cfg.userAgent,
      viewport:{width:1366,height:900},
      locale:'en-US'
    });
    const page=await context.newPage();

    page.on('request', req=>{
      inflight++; activity();
      if (cfg.debugNet) cfg.log('[REQ] '+req.method()+' '+req.url());
    });
    page.on('requestfinished', req=>{ inflight=Math.max(0,inflight-1); activity(); });
    page.on('requestfailed', req=>{
      inflight=Math.max(0,inflight-1); activity();
      rec.reasons.push('REQ_FAIL '+req.url());
    });
    page.on('response', resp=>{
      activity();
      const req=resp.request();
      const rUrl=req.url();
      const ct=(resp.headers()['content-type']||'').toLowerCase();
      if (!likelyAsset(rUrl,ct)) return;
      if (!allowAsset(rUrl,ct)) return;
      if (savedUrlSet.has(rUrl)) return;
      resp.body().then(buf=>{
        if (buf.length>12*1024*1024) return;
        const fileName=shortHash(rUrl)+guessExt(rUrl,ct);
        if (cfg.inlineSmallAssets>0 && buf.length<=cfg.inlineSmallAssets && /^image\//.test(ct)){
          const b64=buf.toString('base64');
          assetRecords.push({ url:rUrl, fileName, contentType:ct, size:buf.length, inlineDataUri:`data:${ct};base64,${b64}` });
          savedUrlSet.add(rUrl);
          if (cfg.debugAssets) cfg.log('[ASSET_INLINE] '+rUrl);
          return;
        }
        fs.writeFileSync(path.join(assetsDir,fileName),buf);
        assetRecords.push({ url:rUrl, fileName, contentType:ct, size:buf.length });
        savedUrlSet.add(rUrl);
        if (cfg.debugAssets) cfg.log('[ASSET_SAVE] '+rUrl+' -> '+fileName);
      }).catch(()=>{});
    });

    const resp=await page.goto(url,{ waitUntil:cfg.navWaitUntil, timeout:cfg.navTimeout });
    rec.mainStatus=resp?.status();
    rec.finalURL=resp?.url()||page.url();

    if (cfg.waitForSelector){
      try { await page.waitForSelector(cfg.waitForSelector,{timeout:cfg.selectorTimeout}); }
      catch { rec.reasons.push('selectorTimeout'); }
    } else {
      try { await page.waitForSelector('body',{timeout:8000}); }catch{}
    }

    for (let i=0;i<cfg.scrollPasses;i++){
      await page.evaluate(()=> window.scrollBy(0, document.body.scrollHeight||2000));
      await page.waitForTimeout(cfg.scrollDelay);
    }

    if (cfg.runPageScript){
      try { await page.evaluate(cfg.runPageScript); activity(); }
      catch(e){ rec.reasons.push('scriptErr:'+e.message); }
    }

    if (cfg.waitExtra>0) await page.waitForTimeout(cfg.waitExtra);

    const quiet=()=>(Date.now()-lastActivity)>=cfg.quietMillis && inflight===0;
    const hardStop=Date.now()+cfg.maxCaptureTime;
    while (Date.now()<hardStop){
      if (quiet()) break;
      await page.waitForTimeout(300);
    }

    if (cfg.screenshot){
      try { await page.screenshot({ path:path.join(pageDir,'screenshot.png'), fullPage:true }); }catch{}
    }

    let html=await page.content();

    html=transformHTML(html,{
      nameRules:cfg.nameRules,
      priceRules:cfg.priceRules,
      linkRewrite:cfg.linkRewrite,
      baseURL:url
    });

    if (cfg.rewriteAssets){
      rewriteCSSFiles(assetRecords, assetsDir);
      html = rewriteHTMLAssets(html, assetRecords, {
        stripTracking: cfg.stripTracking,
        inlineSmall: cfg.inlineSmallAssets,
        assetsDirName:'assets'
      });
    }

    html = rewriteInternalLinksAndJSONLD(html, url, {
      rewriteInternalLinks: cfg.rewriteInternalLinks,
      rewriteJSONLD: cfg.rewriteJSONLD,
      keepCanonicalAbsolute: cfg.keepCanonicalAbsolute,
      keepMetaAbsolute: cfg.keepMetaAbsolute,
      replaceAllBaseOrigins: cfg.replaceAllBaseOrigins,
      debugInternalLinks: cfg.debugInternalLinks
    });

    fs.writeFileSync(path.join(pageDir,'index.html'), html,'utf8');
    await browser.close();
  }catch(e){
    rec.status='error:nav '+e.message;
    rec.reasons.push('navErr:'+e.message);
    try { if (browser) await browser.close(); }catch{}
    if (proxy){
      try{
        const raw=await rawFetchProxy(url,proxy,cfg.userAgent);
        rec.rawUsed=true;
        rec.mainStatus=rec.mainStatus||raw.status;
        let html=transformHTML(raw.body,{
          nameRules:cfg.nameRules,
          priceRules:cfg.priceRules,
          linkRewrite:cfg.linkRewrite,
          baseURL:url
        });
        html = rewriteInternalLinksAndJSONLD(html, url, {
          rewriteInternalLinks: cfg.rewriteInternalLinks,
          rewriteJSONLD: cfg.rewriteJSONLD,
          keepCanonicalAbsolute: cfg.keepCanonicalAbsolute,
          keepMetaAbsolute: cfg.keepMetaAbsolute,
          replaceAllBaseOrigins: cfg.replaceAllBaseOrigins,
          debugInternalLinks: cfg.debugInternalLinks
        });
        fs.writeFileSync(path.join(pageDir,'index.html'), html,'utf8');
      }catch(er){ rec.reasons.push('rawFail:'+er.message); }
    }
  }

  rec.assets=assetRecords.length;
  rec.assetFiles=assetRecords.map(r=>({
    url:r.url, file:r.inlineDataUri?'(inlined)':r.fileName, size:r.size, inline:!!r.inlineDataUri
  }));
  rec.durationMs=Date.now()-start;
  cfg.log(`[RESULT] ${rec.status} ${url} assets=${rec.assets} ms=${rec.durationMs} saved=${relPath||'(root)'}`);
  return rec;
}

/* ---------------- Run Archive ---------------- */
async function runArchive({
  urls,
  outputRoot,
  options={},
  nameRules,
  priceRules,
  linkRewrite,
  log=logDefault
}){
  ensureDir(outputRoot);
  const {
    engine='chromium',
    concurrency=2,
    headless=true,
    waitExtra=1500,
    navTimeout=30000,
    navWaitUntil='domcontentloaded',
    scrollPasses=1,
    scrollDelay=600,
    includeCrossOrigin=true,
    disableHTTP2=false,
    proxiesFile=null,
    stableSession=true,
    rotateSession=false,
    screenshot=false,
    debugAssets=false,
    debugNet=false,
    waitForSelector='',
    selectorTimeout=12000,
    quietMillis=1500,
    maxCaptureTime=15000,
    runPageScript='',
    rewriteAssets=true,
    stripTracking=true,
    inlineSmallAssets=0,
    rewriteInternalLinks=true,
    rewriteJSONLD=true,
    keepCanonicalAbsolute=false,
    keepMetaAbsolute=false,
    replaceAllBaseOrigins=true,          // NEW default true
    debugInternalLinks=false,
    userAgent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
  } = options;

  let proxies=null;
  if (proxiesFile){
    try { proxies=JSON.parse(fs.readFileSync(proxiesFile,'utf8')); }
    catch { log('[WARN] proxies file unreadable'); }
  }
  const proxyNext = proxies ? buildProxyRotator(proxies,{stableSession,rotateSession}) : null;

  log(`[ARCHIVE_START] urls=${urls.length} engine=${engine} concurrency=${concurrency} root=${outputRoot}`);

  const manifest=[];
  const partial=path.join(outputRoot,'manifest.partial.jsonl');
  let idx=0;
  let pageNum=1;
  const ctxBase={
    outputRoot,
    engine,
    headless,
    waitExtra,
    navTimeout,
    navWaitUntil,
    scrollPasses,
    scrollDelay,
    includeCross: includeCrossOrigin,
    disableHTTP2,
    proxyNext,
    userAgent,
    nameRules,
    priceRules,
    linkRewrite,
    log,
    pageNum,
    screenshot,
    debugAssets,
    debugNet,
    waitForSelector,
    selectorTimeout,
    quietMillis,
    maxCaptureTime,
    runPageScript,
    rewriteAssets,
    stripTracking,
    inlineSmallAssets,
    rewriteInternalLinks,
    rewriteJSONLD,
    keepCanonicalAbsolute,
    keepMetaAbsolute,
    replaceAllBaseOrigins,
    debugInternalLinks
  };

  async function worker(wid){
    while(true){
      if (idx>=urls.length) break;
      const u=urls[idx++];
      ctxBase.pageNum=pageNum++;
      log(`[W${wid}] ${idx}/${urls.length} ${u}`);
      const rec=await capture(u, ctxBase);
      manifest.push(rec);
      fs.appendFileSync(partial, JSON.stringify(rec)+'\n');
    }
  }

  await Promise.all(Array.from({length:concurrency},(_,i)=>worker(i+1)));

  manifest.sort((a,b)=>a.url.localeCompare(b.url));
  fs.writeFileSync(path.join(outputRoot,'manifest.json'), JSON.stringify(manifest,null,2));

  const stats={
    total:manifest.length,
    failures:manifest.filter(m=>!m.status.startsWith('ok')).length,
    assetsTotal:manifest.reduce((s,m)=>s+m.assets,0)
  };
  log(`[ARCHIVE_DONE] total=${stats.total} failures=${stats.failures} assetsTotal=${stats.assetsTotal}`);
  return { manifest, stats };
}

module.exports = { runArchive };