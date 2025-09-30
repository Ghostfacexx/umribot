/* MARKER: APP_JS_MINIMAL_V2_ADV */
(function(){
  const captureLog = id('captureLog');
  const liveLog    = id('liveLog');
  const hostLog    = id('hostLog');
  const hpLog      = id('hpLog');
  const runsBody   = document.querySelector('#runsTable tbody');
  const jobsBody   = document.querySelector('#jobsTable tbody');
  let selectedRun  = null;
  let platforms    = [];
  // Plan state
  let planAvailable = []; // all URLs from plan (union of lists)
  let planSelected = [];  // curated selected list (ordered)
  let planRunId = null;   // runId where plan files are stored
  logCap('App bootstrap (advanced)');

  // ---------- Utilities
  function id(x){return document.getElementById(x);}
  function asBool(el){ return !!(el && (el.checked || el.value==='true')); }
  function asNum(el, def){ const n = parseInt(el?.value||'',10); return Number.isFinite(n)?n:def; }
  function asStr(el){ return (el?.value||'').trim(); }
  function lines(el){ return asStr(el).split(/\r?\n/).map(s=>s.trim()).filter(Boolean).join('\n'); }
  function append(el,msg){ if(!el) return; el.textContent += msg+'\n'; if(el.textContent.length>30000) el.textContent=el.textContent.slice(-25000); el.scrollTop=el.scrollHeight; console.log('[UI]',msg); }
  function logCap(m){ append(captureLog,m); }
  function logLive(m){ append(liveLog,m); }
  function logHost(m){ append(hostLog,m); }
  function logHP(m){ append(hpLog,m); }
  async function syncButtons(){
    try{
      const j = await fetchJSON('/api/status');
      const running = !!(j && j.running);
      id('btnStart').disabled = running;
      id('btnStop').disabled = !running;
    }catch(e){ /* ignore */ }
  }
  async function fetchJSON(url, opts){
    // Robust JSON fetch: tolerates empty bodies and logs non-JSON responses gracefully
    logCap('fetch '+url);
    const r = await fetch(url, opts);
    logCap('fetch '+url+' status='+r.status);
    const text = await r.text();
    if (!r.ok) {
      // Prefer server-provided text for diagnostics
      const msg = text ? ('HTTP '+r.status+' '+text.slice(0,300)) : ('HTTP '+r.status);
      throw new Error(msg);
    }
    if (!text) return {}; // tolerate empty JSON body
    try { return JSON.parse(text); }
    catch(e){
      // Some endpoints may legitimately return empty or plain text; surface a compact message
      logCap('non-JSON response from '+url+': '+text.slice(0,200));
      // Best effort: return a minimal object so callers can proceed without crashing
      return { ok: true, raw: text };
    }
  }
  // ---------- Recent seeds (persist last 5 in localStorage)
  const RECENT_KEY = 'archiver_recent_seeds_v1';
  function getRecentSeeds(){
    try{ const arr=JSON.parse(localStorage.getItem(RECENT_KEY)||'[]'); return Array.isArray(arr)?arr:[]; }catch{ return []; }
  }
  function pushRecentSeed(url){
    if(!url) return; const now=url.trim(); if(!now) return;
    const arr=getRecentSeeds().filter(x=>x!==now);
    arr.unshift(now);
    while(arr.length>5) arr.pop();
    try{ localStorage.setItem(RECENT_KEY, JSON.stringify(arr)); }catch{}
    renderRecentSeeds();
  }
  function renderRecentSeeds(){
    const wrap=document.getElementById('recentSeedsWrap'); if(!wrap) return;
    const arr=getRecentSeeds();
    if(!arr.length){ wrap.innerHTML=''; return; }
    wrap.innerHTML = 'Recent: ' + arr.map(u=>`<a href="#" data-seed="${encodeURIComponent(u)}" class="zipLink">${u}</a>`).join(' | ');
    wrap.querySelectorAll('a[data-seed]').forEach(a=>{
      a.onclick=(e)=>{ e.preventDefault(); const val=decodeURIComponent(a.getAttribute('data-seed')||''); const t=id('seedInput'); if(t){ t.value=val; t.focus(); }};
    });
  }


  async function jsonMaybe(r){
    // Safe parser for places still using fetch(...).then(jsonMaybe)
    const text = await r.text();
    if (!r.ok) throw new Error('HTTP '+r.status+ (text?(' '+text.slice(0,200)) : ''));
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { ok:true, raw: text }; }
  }
  function fmtTime(t){ if(!t) return '-'; try{ return new Date(t).toLocaleTimeString(); }catch{return '-';} }

  window.onerror=(m,src,l,c,e)=>logCap('ERROR '+m+' @'+l+':'+c);
  window.onunhandledrejection=e=>logCap('PROMISE_REJECTION '+(e.reason?.message||e.reason));

  // ---------- SSE
  try{
    const es=new EventSource('/api/logs');
    es.onmessage=e=>{
      logLive(e.data);
      if(/JOB_START|JOB_EXIT|CRAWL_EXIT|AUTO_EXPAND_EXIT|JOB_ABORT/.test(e.data)){
        setTimeout(loadRuns,600);
        setTimeout(syncButtons,650);
      }
    };
  }catch(e){ logLive('SSE error '+e.message); }

  // ---------- Runs
  function renderRuns(list){
    runsBody.innerHTML = (list||[]).map(r=>{
      const pages = r.stats?.pages ?? r.stats?.pagesCrawled ?? (r.pending?'�':'-');
      const fails = r.stats?.failures ?? 0;
      const assets = r.stats?.assets ?? '-';
      return `<tr data-run="${r.id}" class="${r.pending?'pending':''}">
        <td>${r.id}</td>
        <td>${fmtTime(r.startedAt)}</td>
        <td>${pages}</td>
        <td>${fails}</td>
        <td>${assets}</td>
        <td><button data-act="sel" data-run="${r.id}" style="font-size:.55rem">Select</button></td>
      </tr>`;
    }).join('');
  }
  function loadRuns(){ return fetchJSON('/api/runs').then(j=>renderRuns(j.runs||[])).catch(e=>logCap('loadRuns err '+e.message)); }

  runsBody.addEventListener('click',e=>{
    const act=e.target.getAttribute('data-act');
    if(act==='sel'){
      selectedRun = e.target.getAttribute('data-run');
      id('hostRun').value = selectedRun;
      logCap('Selected run '+selectedRun);
      id('hpNotice').textContent = 'Selected run: '+selectedRun;
      // Try to load existing plan for this run
      fetchJSON('/api/plan/'+selectedRun).then(j=>{
        if(j && j.ok && j.map){ renderPlanFromMap(j.map, selectedRun); }
      }).catch(()=>{});
    }
  });

  // ---------- Build capture options
  function buildOptions(){
    const opts={};
    if(id('optProfiles').checked) opts.profiles='desktop,mobile';
    if(id('optAggressive').checked) opts.aggressiveCapture=true;
    if(id('optPreserve').checked) opts.preserveAssetPaths=true;
  // Block trackers (analytics/ads/pixels)
  if(id('optBlockTrackers')?.checked) opts.blockTrackers = true;
    if(id('optScroll').checked) { opts.scrollPasses=2; }

    // Auto-expand
    const adepth = asNum(id('autoDepth'),0);
    if(adepth>0){
      opts.autoExpandDepth = adepth;
      opts.autoExpandMaxPages = asNum(id('autoMaxPages'),120);
      opts.autoExpandSameHostOnly = asBool(id('autoSameHost'));
      opts.autoExpandSubdomains = asBool(id('autoSubs'));
      const allow = asStr(id('autoAllow')); if(allow) opts.autoExpandAllowRegex = allow;
      const deny = asStr(id('autoDeny'));   if(deny)  opts.autoExpandDenyRegex  = deny;
    }

    // Advanced capture
    opts.engine = asStr(id('advEngine')) || 'chromium';
    opts.concurrency = asNum(id('advConcurrency'),2);
    opts.headless = (id('advHeadless')?.value!=='false');
  opts.stealth = !!(document.getElementById('advStealth')?.checked);
  const proxyStr = asStr(id('advProxy')); if(proxyStr) opts.proxy = proxyStr;

    opts.pageWaitUntil = asStr(id('advWaitUntil')) || 'domcontentloaded';
    opts.waitExtra     = asNum(id('advWaitExtra'),700);
    opts.quietMillis   = asNum(id('advQuietMillis'),1500);
    opts.navTimeout    = asNum(id('advNavTimeout'),20000);
    opts.pageTimeout   = asNum(id('advPageTimeout'),40000);
    opts.maxCaptureMs  = asNum(id('advMaxCapMs'),15000);
    opts.scrollDelay   = asNum(id('advScrollDelay'),250);

    const inlineSmall = asNum(id('advInlineSmall'),0); if(inlineSmall>0) opts.inlineSmallAssets = inlineSmall;
    const assetMax    = asNum(id('advAssetMax'),0);    if(assetMax>0)    opts.assetMaxBytes    = assetMax;

    opts.rewriteInternal     = asBool(id('advRewriteInternal'));
    opts.mirrorSubdomains    = asBool(id('advMirrorSubs'));
    opts.mirrorCrossOrigin   = asBool(id('advMirrorCross'));
    opts.includeCrossOrigin  = asBool(id('advIncludeCO'));
    opts.rewriteHtmlAssets   = asBool(id('advRewriteHtmlAssets'));
    opts.flattenRoot         = asBool(id('advFlattenRoot'));
  // Crawl-only/auto-expand helper flag for tricky HTTP/2 sites
  opts.disableHttp2        = asBool(id('advDisableHttp2'));
    // Let archiver perform internal discovery when crawler struggles
    opts.discoverInArchiver = asBool(id('advDiscoverInArchiver'));
    // Plan-first mapper: build explicit seed list before archiving
    opts.planFirst          = asBool(id('advPlanFirst'));

    const internalRx = asStr(id('advInternalRegex')); if(internalRx) opts.internalRewriteRegex = internalRx;
    const domainFilter = asStr(id('advDomainFilter')); if(domainFilter) opts.domainFilter = domainFilter;

    const clickSel = lines(id('advClickSelectors')); if(clickSel) opts.clickSelectors = clickSel;
    const remSel   = lines(id('advRemoveSelectors')); if(remSel) opts.removeSelectors = remSel;
    const skipPat  = lines(id('advSkipDownload')); if(skipPat) opts.skipDownloadPatterns = skipPat;

    // Consent
    const btns = lines(id('advConsentButtons')); if(btns) opts.consentButtonTexts = btns;
    const extra= lines(id('advConsentExtraSel')); if(extra) opts.consentExtraSelectors = extra;
    const force= lines(id('advConsentForceRemove')); if(force) opts.consentForceRemoveSelectors = force;
    opts.consentRetryAttempts = asNum(id('advConsentRetries'),12);
    opts.consentRetryInterval = asNum(id('advConsentInterval'),700);
    opts.consentMutationWindow= asNum(id('advConsentWindow'),8000);
    opts.consentIframeScan    = asBool(id('advConsentIframeScan'));
    opts.consentDebug         = asBool(id('advConsentDebug'));
    opts.consentDebugScreenshot = asBool(id('advConsentScreenshot'));
    if(asBool(id('advForceConsentWait'))){
      opts.forceConsentWaitMs = asNum(id('advForceConsentWaitMs'),0);
    }
    return opts;
  }

  // ---------- Plan Builder UI ----------
  function renderPlanFromMap(map, runId){
    planRunId = runId || planRunId;
    const counts = map.counts||{};
    id('planMetrics').textContent = `home=${counts.home||0}, categories=${counts.categories||0}, info=${counts.information||0}, products=${counts.products||0}, seeds=${counts.seeds||0}`;
    const lists = map.lists || {};
    const all = [ ...(lists.home||[]), ...(lists.categories||[]), ...(lists.information||[]), ...(lists.products||[]) ];
    planAvailable = [...new Set(all)];
    renderPlanLists();
  }
  function renderPlanLists(){
    const mk = (arr, idName)=>{
      const el = id(idName); if(!el) return;
      el.innerHTML = arr.map(u=>`<div class="rowItem"><label class="opt"><input type="checkbox" data-url="${encodeURIComponent(u)}"> ${u}</label></div>`).join('');
    };
    mk(planAvailable, 'planAvailable');
    mk(planSelected, 'planSelected');
  }
  function getChecked(containerId){
    const el = id(containerId); if(!el) return [];
    return Array.from(el.querySelectorAll('input[type="checkbox"]:checked')).map(x=>decodeURIComponent(x.getAttribute('data-url')||''));
  }
  id('btnPlanBuild').onclick = ()=>{
    const startText = (id('planStartUrls').value||'').trim();
    if(!startText){ alert('Enter start URL(s)'); return; }
    const options = buildOptions();
    fetch('/api/plan/build',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ startUrlsText: startText, options }) })
      .then(jsonMaybe).then(j=>{
        if(j && j.ok && j.map){ renderPlanFromMap(j.map, j.runId); logCap('Plan built: '+JSON.stringify(j.map.counts)); selectedRun = j.runId; id('hostRun').value=j.runId; }
        else logCap('Plan build response '+JSON.stringify(j||{}));
      }).catch(e=>logCap('Plan build error '+e.message));
  };
  id('btnPlanSelect').onclick=()=>{
    const sel = getChecked('planAvailable');
    const setSel = new Set(planSelected);
    sel.forEach(u=>{ if(!setSel.has(u)) planSelected.push(u); });
    renderPlanLists();
  };
  id('btnPlanRemove').onclick=()=>{
    const sel = getChecked('planSelected');
    const rm = new Set(sel);
    planSelected = planSelected.filter(u=>!rm.has(u));
    renderPlanLists();
  };
  function move(delta){
    const sel = getChecked('planSelected'); if(sel.length!==1) return;
    const u = sel[0];
    const idx = planSelected.indexOf(u); if(idx<0) return;
    const nidx = idx+delta; if(nidx<0 || nidx>=planSelected.length) return;
    const tmp = planSelected[nidx]; planSelected[nidx]=planSelected[idx]; planSelected[idx]=tmp;
    renderPlanLists();
  }
  id('btnPlanUp').onclick=()=>move(-1);
  id('btnPlanDown').onclick=()=>move(1);
  id('btnPlanSave').onclick=()=>{
    if(!selectedRun){ alert('Select or build a run first'); return; }
    fetch('/api/plan/'+selectedRun, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ selected: planSelected, order: planSelected }) })
      .then(jsonMaybe).then(j=>{ logCap('Plan saved '+JSON.stringify(j)); })
      .catch(e=>logCap('Plan save error '+e.message));
  };
  id('btnPlanExport').onclick=()=>{
    const data = { selected: planSelected, available: planAvailable };
    const blob = new Blob([JSON.stringify(data,null,2)], { type:'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download='plan.json'; a.click(); URL.revokeObjectURL(url);
  };
  id('btnPlanImport').onclick=()=> id('planImportFile').click();
  id('planImportFile').addEventListener('change', async (e)=>{
    const f = e.target.files && e.target.files[0]; if(!f) return;
    try{
      const text = await f.text();
      const j = JSON.parse(text);
      planAvailable = Array.isArray(j.available)? j.available : planAvailable;
      planSelected = Array.isArray(j.selected)? j.selected : planSelected;
      renderPlanLists();
    }catch(err){ alert('Import parse error: '+err.message); }
  });

  // ---------- Start Run
  id('btnStart').onclick = ()=>{
    const urls = asStr(id('seedInput')).split(/\n+/).filter(Boolean);
    if(!urls.length){ alert('Enter at least one URL'); return; }
    // store first url in recent
    pushRecentSeed(urls[0]);
  const options = buildOptions();
    // If planSelected has entries, send as planSeeds to use explicitly
    if(planSelected.length){ options.planSeeds = planSelected.slice(); }
    id('btnStart').disabled=true; id('btnStop').disabled=false;
    logCap('POST /api/run start');
    fetch('/api/run',{ method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ urlsText: urls.join('\n'), options }) })
    .then(jsonMaybe).then(j=>{
      logCap('Run response '+JSON.stringify(j));
      if(j.runId){ setTimeout(loadRuns,900); }
      else { setTimeout(syncButtons,300); }
    }).catch(e=>{
      logCap('Run start error '+e.message);
      setTimeout(syncButtons,300);
    });
  };

  // ---------- Crawl First
  id('btnStartCrawlFirst').onclick = ()=>{
    const startUrls = asStr(id('crawlSeeds')).split(/\n+/).filter(Boolean).join('\n');
    if(!startUrls){ alert('Enter crawl seeds'); return; }
    // store first seed
    pushRecentSeed(startUrls.split(/\n/)[0]);
  const options = buildOptions();
    const crawlOptions = {
      maxDepth:   asNum(id('crawlDepth'),3),
      maxPages:   asNum(id('crawlMaxPages'),200),
      waitAfterLoad: asNum(id('crawlWait'),500),
      sameHostOnly:  asBool(id('crawlSameHost')),
      includeSubdomains: asBool(id('crawlSubs')),
      allowRegex: asStr(id('crawlAllow')),
      denyRegex:  asStr(id('crawlDeny')),
      disableHttp2: asBool(id('advDisableHttp2'))
    };
    id('btnStart').disabled=true; id('btnStop').disabled=false;
    logCap('POST /api/run (crawlFirst)');
    fetch('/api/run',{ method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ urlsText:'', options, crawlFirst:true, crawlOptions:{...crawlOptions,startUrlsText:startUrls} }) })
    .then(jsonMaybe).then(j=>{
      logCap('Run response '+JSON.stringify(j));
      if(j.runId){ setTimeout(loadRuns,1200); }
      else { id('btnStart').disabled=false; id('btnStop').disabled=true; }
    }).catch(e=>{
      logCap('Run start error '+e.message);
      id('btnStart').disabled=false; id('btnStop').disabled=true;
    });
  };

  // ---------- Stop Run / Refresh
  id('btnStop').onclick=()=>{
    fetch('/api/stop-run',{method:'POST'})
      .then(jsonMaybe)
      .then(j=>{
        logCap('Stop run '+JSON.stringify(j));
      })
      .catch(e=>{
        logCap('Stop error '+e.message);
      })
      .finally(()=>{
        id('btnStop').disabled=true; id('btnStart').disabled=false; setTimeout(syncButtons,500); setTimeout(loadRuns,800);
      });
  };
  id('btnForceRefresh').onclick=()=>loadRuns();
  // ---------- Install Playwright Browsers
  const ib = document.getElementById('btnInstallBrowsers');
  if(ib){
    ib.onclick=()=>{
      fetch('/api/playwright/install',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({browsers:['chromium']})})
        .then(jsonMaybe).then(j=>logCap('Playwright install: '+JSON.stringify(j)))
        .catch(e=>logCap('Playwright install error '+e.message));
    };
  }

  // ---------- Hosting
  id('btnHost').onclick=()=>{
    if(!selectedRun) return alert('Select a run');
    const port=+id('hostPort').value||8081;
    fetch('/api/host-run',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({runId:selectedRun,port})})
      .then(jsonMaybe).then(j=>{
        if(!j.ok){ logHost('Host error '+JSON.stringify(j)); return; }
        logHost('Hosting '+j.runId+' @ '+j.url);
        id('btnStopHost').disabled=false;
        const openBtn = id('btnOpenHost');
  if(openBtn){ openBtn.disabled=false; openBtn.dataset.url = j.url; }
  // Auto-open in a new tab/window (Codespaces will open a forwarded URL)
        try { if(j.url) window.open(j.url, '_blank', 'noopener'); } catch {}
      }).catch(e=>logHost('Host exception '+e.message));
  };
  const openBtn = id('btnOpenHost');
  if(openBtn){
    openBtn.onclick = ()=>{
      const url = openBtn.dataset.url || '';
      if(!url){ logHost('No hosted URL available'); return; }
      try { window.open(url, '_blank', 'noopener'); } catch(e){ logHost('Open error '+e.message); }
    };
  }
  id('btnStopHost').onclick=()=>{
    const port=+id('hostPort').value||8081;
    fetch('/api/stop-host',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({port})})
    .then(jsonMaybe).then(j=>{
      logHost('Stop host '+JSON.stringify(j)); id('btnStopHost').disabled=true;
    }).catch(e=>logHost('Stop host error '+e.message));
  };

  // ---------- Hosting Prep
  function loadPlatforms(){
    fetchJSON('/api/hosting-presets').then(j=>{
      platforms = j.platforms||[];
      id('hpPlatform').innerHTML = platforms.map(p=>`<option value="${p.id}">${p.label||p.id}</option>`).join('');
    }).catch(e=>logHP('platforms err '+e.message));
  }
  id('btnSuggest').onclick=()=>{
    if(!selectedRun) return logHP('No run selected');
    fetchJSON('/api/runs/'+selectedRun+'/prepare-suggestions').then(s=>{
      logHP('Suggest: pages='+s.pages+' mobile='+s.hasMobile+' assets�'+s.totalAssetsApprox+' analytics='+s.analyticsMatches);
      id('hpMobile').checked=s.hasMobile;
      if(s.recommendations.stripAnalytics) id('hpStrip').checked=true;
      if(s.recommendations.precompress) id('hpCompress').checked=true;
      if(!s.recommendations.noServiceWorker) id('hpSW').checked=true;
      if(s.recommendations.baseUrl && !id('hpBaseUrl').value) id('hpBaseUrl').value=s.recommendations.baseUrl;
      const mode=s.recommendations.mode||'desktop';
      const r=document.querySelector(`input[name="hpMode"][value="${mode}"]`); if(r) r.checked=true;
    }).catch(e=>logHP('Suggest error '+e.message));
  };
  id('btnPreparePkg').onclick=()=>{
    if(!selectedRun) return logHP('No run selected');
    const mode=(document.querySelector('input[name="hpMode"]:checked')||{}).value || 'switch';
    const payload={
      runId:selectedRun,
      options:{
        mode,
        includeMobile:id('hpMobile').checked,
        stripAnalytics:id('hpStrip').checked,
        serviceWorker:id('hpSW').checked,
        precompress:id('hpCompress').checked,
        sitemap:id('hpSitemap').checked,
        baseUrl:id('hpBaseUrl').value.trim(),
        extraAnalyticsRegex:id('hpExtraRegex').value.trim(),
        platform:id('hpPlatform').value,
        shopifyEmbed:id('hpShopify').checked,
        createZip:id('hpZip').checked
      }
    };
    logHP('POST prepare '+JSON.stringify(payload));
    fetch('/api/hosting/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
      .then(jsonMaybe).then(j=>{ logHP('Prepare response '+JSON.stringify(j)); refreshJobs(); })
      .catch(e=>logHP('Prepare error '+e.message));
  };
  id('btnRefreshJobs').onclick=refreshJobs;
  function refreshJobs(){
    fetchJSON('/api/hosting/jobs').then(j=>{
      jobsBody.innerHTML = j.map(job=>`<tr>
        <td>${job.id}</td><td>${job.status}</td>
        <td>${job.zip?`<a class="zipLink" href="/api/hosting/jobs/${job.id}/download">zip</a>`:''}</td>
        <td>${job.runId}</td>
        <td><button data-j="${job.id}" style="font-size:.55rem">Log</button></td>
      </tr>`).join('');
    }).catch(e=>logHP('jobs err '+e.message));
  }
  jobsBody.addEventListener('click',e=>{
    const idAttr=e.target.getAttribute('data-j');
    if(!idAttr) return;
    fetchJSON('/api/hosting/jobs/'+idAttr).then(job=>{
      logHP('Job '+idAttr+' status='+job.status);
      if(job.log) logHP(job.log.slice(-40).join('\n'));
    }).catch(e2=>logHP('job view err '+e2.message));
  });

  // ---------- Init
  function wireRegexPresets(){
    const pairs = [
      ['autoAllowPreset','autoAllow'],
      ['autoDenyPreset','autoDeny'],
      ['crawlAllowPreset','crawlAllow'],
      ['crawlDenyPreset','crawlDeny'],
    ];
    pairs.forEach(([selId,inputId])=>{
      const sel = document.getElementById(selId);
      const inp = document.getElementById(inputId);
      if(!sel || !inp) return;
      sel.addEventListener('change',()=>{
        const v = sel.value || '';
        if(v){ inp.value = v; inp.dispatchEvent(new Event('input')); }
      });
    });
  }
  // Load help settings for tooltips
  fetch('/api/settings').then(jsonMaybe).then(j=>{
    try{
      const help=j.help||{};
      Object.keys(help).forEach(idKey=>{
        const el=document.getElementById(idKey);
        if(el && !el.title) el.title = help[idKey];
      });
    }catch(e){ logCap('help load err '+e.message); }
  }).catch(e=>logCap('settings err '+e.message));

  renderRecentSeeds();
  wireRegexPresets();
  loadRuns(); loadPlatforms(); refreshJobs(); syncButtons(); logCap('Init complete (advanced)');
})();