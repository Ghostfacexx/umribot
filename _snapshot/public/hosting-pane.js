// Minimal, DOM-safe add-on panel for SMART hosting prep.
// Loads only if an element with id 'hostingPaneMount' exists.
(function(){
  if(document.getElementById('hostingPaneMount') == null){
    console.log('[HOSTING_PANE] mount not found, skipping add-on UI');
    return;
  }
  const mount = document.getElementById('hostingPaneMount');
  mount.innerHTML = `
    <style>
      #hostingPane *{box-sizing:border-box;font-family:inherit}
      #hostingPane{border:1px solid #d0d7de;padding:.75rem;border-radius:8px;background:#fff;margin-top:.75rem}
      #hostingPane h3{margin:.2rem 0 .6rem;font-size:.85rem;text-transform:uppercase;letter-spacing:.06em}
      #hostingPane label{display:flex;align-items:center;gap:.4rem;font-size:.65rem;margin-bottom:.35rem;flex-wrap:wrap}
      #hostingPane input[type=text]{width:100%;padding:.35rem;border:1px solid #b6bec6;border-radius:4px;font-size:.65rem}
      #hostingPane select{width:100%;padding:.35rem;border:1px solid #b6bec6;border-radius:4px;font-size:.65rem}
      #hostingPane button{background:#0a57ff;color:#fff;border:none;padding:.45rem .8rem;border-radius:4px;cursor:pointer;font-size:.65rem;font-weight:600}
      #hostingPane pre{background:#111;color:#eee;font-size:.6rem;padding:.55rem;border-radius:4px;max-height:160px;overflow:auto;margin-top:.5rem}
      #hostingPane .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:.35rem}
      #hostingPane .badge{background:#eef;padding:.15rem .4rem;border:1px solid #ccd;border-radius:3px;font-size:.55rem}
      #hpJobs table{width:100%;font-size:.55rem;border-collapse:collapse;margin-top:.5rem}
      #hpJobs th,#hpJobs td{padding:.3rem .35rem;border-bottom:1px solid #eee;text-align:left}
      #hpSuggest{background:#fff8d6;border:1px solid #ffe58a;color:#6b5200;padding:.4rem .5rem;border-radius:4px;font-size:.6rem;margin-bottom:.4rem;white-space:nowrap;overflow-x:auto}
    </style>
    <div id="hostingPane">
      <h3>SMART Hosting Prep</h3>
      <div id="hpSuggest">Select a run (click in your existing list) then press "Load Suggestions".</div>
      <div class="grid">
        <label><input type="radio" name="hpMode" value="switch" checked>Mode: switch</label>
        <label><input type="radio" name="hpMode" value="desktop">Mode: desktop</label>
        <label><input type="radio" name="hpMode" value="both">Mode: both</label>
        <label><input type="checkbox" id="hpIncludeMobile" checked>Include mobile</label>
        <label><input type="checkbox" id="hpStripAnalytics">Strip analytics</label>
        <label><input type="checkbox" id="hpSW" checked>ServiceWorker</label>
        <label><input type="checkbox" id="hpPrecompress">Precompress</label>
        <label><input type="checkbox" id="hpSitemap" checked>Sitemap</label>
        <label><input type="checkbox" id="hpShopify">Shopify Embed</label>
        <label><input type="checkbox" id="hpZip" checked>ZIP</label>
      </div>
      <label>Platform
        <select id="hpPlatform"></select>
      </label>
      <label>Base URL
        <input type="text" id="hpBaseUrl" placeholder="https://archive.example.com">
      </label>
      <label>Extra Analytics Regex
        <input type="text" id="hpExtraRegex" placeholder="(adroll|xyz)">
      </label>
      <div class="grid">
        <button id="hpLoadBtn" type="button">Load Suggestions</button>
        <button id="hpPrepareBtn" type="button">Prepare Package</button>
        <button id="hpRefreshJobsBtn" type="button">Refresh Jobs</button>
      </div>
      <pre id="hpLog"></pre>
      <div id="hpJobs"></div>
    </div>
  `;

  let currentRun = null;

  // Attempt to infer selected run if your existing UI sets a global or attribute:
  // Provide a hook function; you can call window.setHostingCurrentRun(runId) from your original code.
  window.setHostingCurrentRun = function(runId){
    currentRun = runId;
    document.getElementById('hpSuggest').textContent = 'Selected run: '+runId+'. Click "Load Suggestions".';
  };

  async function loadPlatforms(){
    try{
      const r=await fetch('/api/hosting/platform-presets');
      const j=await r.json();
      const sel=document.getElementById('hpPlatform');
      sel.innerHTML='';
      (j.platforms||[]).forEach(p=>{
        const o=document.createElement('option');
        o.value=p.id; o.textContent=p.label;
        sel.appendChild(o);
      });
    }catch(e){
      log('Platform fetch error '+e.message);
    }
  }

  function log(msg){
    const el=document.getElementById('hpLog');
    el.textContent += msg + '\n';
    if(el.textContent.length>14000) el.textContent = el.textContent.slice(-12000);
    el.scrollTop=el.scrollHeight;
  }

  async function loadSuggestions(){
    if(!currentRun){ log('No run selected'); return; }
    try{
      const r=await fetch(`/api/hosting/${currentRun}/suggestions`);
      if(!r.ok){ log('Suggest status '+r.status); return; }
      const s=await r.json();
      document.getElementById('hpSuggest').textContent =
        `pages≈${s.pagesApprox} mobile=${s.hasMobile} assets≈${s.totalAssetsApprox} inline=${s.largestInlineScriptBytes} analyticsHits=${s.analyticsMatches}`;
      // apply
      document.querySelectorAll('[name="hpMode"]').forEach(r=>{
        r.checked = (r.value===s.recommendations.mode);
      });
      document.getElementById('hpIncludeMobile').checked = s.hasMobile;
      document.getElementById('hpStripAnalytics').checked = s.recommendations.stripAnalytics;
      document.getElementById('hpPrecompress').checked = s.recommendations.precompress;
      document.getElementById('hpSW').checked = s.recommendations.serviceWorker;
      if(s.recommendations.baseUrl) document.getElementById('hpBaseUrl').value = s.recommendations.baseUrl;
    }catch(e){ log('Suggest error '+e.message); }
  }

  async function prepare(){
    if(!currentRun){ log('No run selected'); return; }
    const mode = [...document.querySelectorAll('[name="hpMode"]')].find(r=>r.checked)?.value || 'switch';
    const payload={
      runId: currentRun,
      options:{
        mode,
        includeMobile: document.getElementById('hpIncludeMobile').checked,
        stripAnalytics: document.getElementById('hpStripAnalytics').checked,
        serviceWorker: document.getElementById('hpSW').checked,
        precompress: document.getElementById('hpPrecompress').checked,
        sitemap: document.getElementById('hpSitemap').checked,
        baseUrl: document.getElementById('hpBaseUrl').value.trim(),
        extraAnalyticsRegex: document.getElementById('hpExtraRegex').value.trim(),
        platform: document.getElementById('hpPlatform').value,
        shopifyEmbed: document.getElementById('hpShopify').checked,
        createZip: document.getElementById('hpZip').checked
      }
    };
    log('POST /api/hosting/prepare '+JSON.stringify(payload));
    try{
      const r=await fetch('/api/hosting/prepare',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(payload)
      });
      const j=await r.json();
      log('Prep job response '+JSON.stringify(j));
      refreshJobs();
    }catch(e){ log('Prepare error '+e.message); }
  }

  async function refreshJobs(){
    try{
      const r=await fetch('/api/hosting/jobs');
      const j=await r.json();
      const jobs=(j||[]).sort((a,b)=> (a.startedAt<b.startedAt?1:-1));
      let html='<table><thead><tr><th>ID</th><th>Status</th><th>ZIP</th><th>Run</th><th>Action</th></tr></thead><tbody>';
      jobs.forEach(job=>{
        html+=`<tr>
          <td>${job.id}</td>
          <td>${job.status}</td>
          <td>${job.zip?'<a href="/api/hosting/jobs/'+job.id+'/download">zip</a>':''}</td>
          <td>${job.runId}</td>
          <td><button data-j="${job.id}" data-act="view">View</button></td>
        </tr>`;
      });
      html+='</tbody></table>';
      document.getElementById('hpJobs').innerHTML=html;
      document.getElementById('hpJobs').onclick=e=>{
        const id=e.target.getAttribute('data-j');
        if(!id) return;
        viewJob(id);
      };
    }catch(e){ log('Jobs error '+e.message); }
  }

  async function viewJob(id){
    try{
      const r=await fetch('/api/hosting/jobs/'+id);
      const j=await r.json();
      log('JOB '+id+' status='+j.status);
      if(j.log){
        const tail=j.log.slice(-40).join('\n');
        log(tail);
      }
    }catch(e){ log('View job err '+e.message); }
  }

  // Bindings
  document.getElementById('hpLoadBtn').onclick=loadSuggestions;
  document.getElementById('hpPrepareBtn').onclick=prepare;
  document.getElementById('hpRefreshJobsBtn').onclick=refreshJobs;

  loadPlatforms();
  refreshJobs();

  console.log('[HOSTING_PANE] initialized');
})();
