(function(){
  async function startRun() {
    const urlsText = document.getElementById('prepStartUrls').value.trim();
    const autoDepth = parseInt(document.getElementById('prepAutoDepth').value || '0', 10);
    const autoMax = parseInt(document.getElementById('prepAutoMax').value || '0', 10);
    const sameHost = document.getElementById('prepSameHost').checked;
    const subdomains = document.getElementById('prepSubdomains').checked;
    const targetPlatform = document.getElementById('targetPlatform').value;

    const status = document.getElementById('startPrepRunStatus');
    status.textContent = 'Submitting...';

    if (!urlsText) { status.textContent = 'Enter at least one URL.'; return; }

    const payload = {
      urlsText,
      options: {
        autoExpandDepth: autoDepth,
        autoExpandMaxPages: autoMax,
        autoExpandSameHostOnly: sameHost,
        autoExpandSubdomains: subdomains,
        targetPlatform
      }
    };

    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const js = await window.safeParseJson(res);
      if (!res.ok || js.error) {
        status.textContent = 'Error: ' + (js.error || ('HTTP ' + res.status));
        return;
      }
      status.textContent = 'Run started: ' + js.runId;
    } catch (e) {
      status.textContent = 'Error: ' + (e.message || String(e));
    }
  }

  function bootstrap() {
    const btn = document.getElementById('startPrepRunBtn');
    if (btn) btn.addEventListener('click', startRun);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap);
  else bootstrap();
})();
