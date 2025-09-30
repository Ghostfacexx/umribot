/* Platform export panel with download links and ZIP action. */
(function () {
  function findSelectedRunId() {
    // Try the Host card input labeled "Select a run from table"
    const inputs = Array.from(document.querySelectorAll('input[type="text"], input'));
    const byPlaceholder = inputs.find(
      el => (el.placeholder || '').toLowerCase().includes('select a run') ||
            (el.getAttribute('aria-label') || '').toLowerCase().includes('select a run')
    );
    const v = (byPlaceholder && byPlaceholder.value || '').trim();
    return v || null;
  }

  async function getLastRunId() {
    try {
      const res = await fetch('/api/runs');
      const js = await res.json();
      if (js && js.runs && js.runs.length) return js.runs[0].id;
    } catch {}
    return null;
  }

  function insertPanel() {
    const card = document.createElement('section');
    card.className = 'card';
    card.id = 'platform-export-card';
    card.style.marginTop = '16px';

    card.innerHTML = `
      <div class="card-header">Platform export</div>
      <div class="card-body">
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <label for="exportPlatform" style="min-width:120px;">Platform</label>
          <select id="exportPlatform" class="form-select" style="max-width:220px;">
            <option value="woocommerce">WooCommerce</option>
            <option value="shopify">Shopify</option>
          </select>
          <button id="exportRunBtn" class="btn btn-primary">Export</button>
          <button id="zipExportBtn" class="btn btn-secondary" disabled>Create ZIP</button>
          <span id="exportStatus" style="margin-left:8px; color:#555;"></span>
        </div>
        <div id="exportLinks" style="margin-top:8px;"></div>
        <div id="exportResult" style="margin-top:8px; font-family:monospace; white-space:pre-wrap; color:#444;"></div>
      </div>
    `;

    // Place after Hosting Prep card if present
    const headers = Array.from(document.querySelectorAll('.card .card-header'));
    const hostPrepHeader = headers.find(h => /hosting prep/i.test(h.textContent || ''));
    if (hostPrepHeader) {
      const hostPrepCard = hostPrepHeader.closest('.card');
      hostPrepCard.parentNode.insertBefore(card, hostPrepCard.nextSibling);
    } else {
      document.body.appendChild(card);
    }
  }

  function renderLinks({ folderUrl, productsCsvUrl, pagesWxrUrl, zipUrl }) {
    const linksEl = document.getElementById('exportLinks');
    const rows = [];
    if (folderUrl) rows.push(`<div>Folder: <a href="${folderUrl}" target="_blank" rel="noopener">${folderUrl}</a></div>`);
    if (productsCsvUrl) rows.push(`<div>Products CSV: <a href="${productsCsvUrl}" target="_blank" rel="noopener" download>Download</a></div>`);
    if (pagesWxrUrl) rows.push(`<div>Pages WXR: <a href="${pagesWxrUrl}" target="_blank" rel="noopener" download>Download</a></div>`);
    if (zipUrl) rows.push(`<div>Archive: <a href="${zipUrl}" target="_blank" rel="noopener" download>Download ZIP</a></div>`);
    linksEl.innerHTML = rows.join('') || '<em>No links available.</em>';
  }

  let lastOutDirAbs = null;
  let lastFolderUrl = null;

  async function doExport() {
    const platform = document.getElementById('exportPlatform').value;
    const statusEl = document.getElementById('exportStatus');
    const resultEl = document.getElementById('exportResult');
    const zipBtn = document.getElementById('zipExportBtn');
    statusEl.textContent = 'Exporting...';
    resultEl.textContent = '';
    renderLinks({});

    let runId = findSelectedRunId();
    if (!runId) runId = await getLastRunId();
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
      const js = await window.safeParseJson(res);
      if (!res.ok || !js.ok) {
        statusEl.textContent = 'Failed';
        resultEl.textContent = (js && js.error) ? js.error : ('HTTP ' + res.status);
        zipBtn.disabled = true;
        return;
      }
      statusEl.textContent = 'Done';
      lastOutDirAbs = js.outDir || (js.result && js.result.outDir) || null;
      lastFolderUrl = js.folderUrl || null;
      renderLinks({
        folderUrl: js.folderUrl,
        productsCsvUrl: js.productsCsvUrl,
        pagesWxrUrl: js.pagesWxrUrl
      });
      resultEl.textContent = JSON.stringify(js.result || js, null, 2);
      zipBtn.disabled = !lastOutDirAbs;
    } catch (e) {
      statusEl.textContent = 'Error';
      resultEl.textContent = e.message || String(e);
      zipBtn.disabled = true;
    }
  }

  async function makeZip() {
    const statusEl = document.getElementById('exportStatus');
    const resultEl = document.getElementById('exportResult');
    statusEl.textContent = 'Creating ZIP...';
    try {
      const res = await fetch('/api/export-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: lastOutDirAbs })
      });
      const js = await window.safeParseJson(res);
      if (!res.ok || !js.ok) {
        statusEl.textContent = 'ZIP failed';
        resultEl.textContent = js.error || ('HTTP ' + res.status);
        return;
      }
      statusEl.textContent = 'ZIP ready';
      renderLinks({ folderUrl: lastFolderUrl, zipUrl: js.url });
    } catch (e) {
      statusEl.textContent = 'ZIP error';
      resultEl.textContent = e.message || String(e);
    }
  }

  function bootstrap() {
    insertPanel();
    document.getElementById('exportRunBtn')?.addEventListener('click', doExport);
    document.getElementById('zipExportBtn')?.addEventListener('click', makeZip);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap);
  else bootstrap();
})();