(function(){
  // Try to piggyback on your existing “selected run” storage, otherwise ask user to select a run first.
  let selectedRunId = null;

  // If your UI sets a global or element for the selected run, wire into it here:
  // Example: window.__setSelectedRunId = (id) => { selectedRunId = id; };
  // If you already have a handler when a table row is selected, just assign to selectedRunId there.

  // Fallback: try to infer last run from /api/runs when user clicks Export
  async function getLastRunId() {
    const res = await fetch('/api/runs');
    const js = await res.json();
    if (js && js.runs && js.runs.length) return js.runs[0].id;
    return null;
  }

  async function doExport() {
    const platform = document.getElementById('exportPlatform').value;
    const statusEl = document.getElementById('exportStatus');
    const resultEl = document.getElementById('exportResult');
    statusEl.textContent = 'Exporting...';
    resultEl.textContent = '';

    let runId = selectedRunId;
    if (!runId) {
      runId = await getLastRunId();
    }
    if (!runId) {
      statusEl.textContent = 'Select a run first (from the Runs table).';
      return;
    }
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, platform })
      });
      const js = await res.json();
      if (!res.ok || !js.ok) {
        statusEl.textContent = 'Failed';
        resultEl.textContent = (js && js.error) ? js.error : ('HTTP ' + res.status);
        return;
      }
      statusEl.textContent = 'Done';
      const p = js.outDir || (js.result && js.result.outDir) || '';
      resultEl.innerText = `Output: ${p}\nDetails: ${JSON.stringify(js.result || js, null, 2)}`;
    } catch (e) {
      statusEl.textContent = 'Error';
      resultEl.textContent = e.message || String(e);
    }
  }

  function bootstrap() {
    const btn = document.getElementById('exportRunBtn');
    if (btn) btn.addEventListener('click', doExport);

    // If your existing code exposes a selection function, you can uncomment and adapt:
    // window.onRunRowSelected = (runId) => { selectedRunId = runId; };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
