/* Delete runs from the GUI using /api/delete-run.
   - Adds a "Delete selected" button next to the Host card input (uses the selected run ID).
   - Adds a "Delete run" card with a dropdown of all runs and a Delete button.
   - Confirms before deletion and shows status/results.
*/

(function () {
  const API = {
    runs: '/api/runs',
    deleteRun: '/api/delete-run'
  };

  async function fetchRuns() {
    try {
      const res = await fetch(API.runs);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const js = await res.json();
      return js && Array.isArray(js.runs) ? js.runs : [];
    } catch (e) {
      console.error('[delete-run-ui] runs load failed', e);
      return [];
    }
  }

  function findHostCardAndInput() {
    const headers = Array.from(document.querySelectorAll('.card .card-header'));
    const hostHeader = headers.find(h => /host/i.test(h.textContent || ''));
    const hostCard = hostHeader ? hostHeader.closest('.card') : null;

    // Heuristic to find the "Select a run from table" input inside Host card
    let runInput = null;
    if (hostCard) {
      runInput = hostCard.querySelector('input[type="text"], input');
      // Prefer by placeholder text
      const allInputs = hostCard.querySelectorAll('input');
      for (const el of allInputs) {
        const ph = (el.placeholder || '').toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        if (ph.includes('select a run') || aria.includes('select a run')) { runInput = el; break; }
      }
    }
    return { hostCard, runInput };
  }

  function insertInlineDelete(hostCard, runInput) {
    if (!hostCard) return;
    if (hostCard.querySelector('#delete-selected-run-btn')) return;

    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.gap = '8px';
    wrap.style.marginTop = '8px';
    wrap.style.alignItems = 'center';

    const btn = document.createElement('button');
    btn.id = 'delete-selected-run-btn';
    btn.textContent = 'Delete selected';
    btn.className = 'btn btn-danger';

    const status = document.createElement('span');
    status.id = 'delete-selected-run-status';
    status.style.marginLeft = '6px';
    status.style.color = '#555';

    btn.addEventListener('click', async () => {
      const runId = (runInput && runInput.value || '').trim();
      if (!runId) { status.textContent = 'No run selected.'; return; }
      const sure = confirm(`Delete run "${runId}"? This removes its folder from disk.`);
      if (!sure) return;

      status.textContent = 'Deleting...';
      try {
        const res = await fetch(API.deleteRun, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId })
        });
        const js = await res.json().catch(() => ({}));
        if (!res.ok || !js.ok) {
          status.textContent = js.error ? `Failed: ${js.error}` : `HTTP ${res.status}`;
          return;
        }
        status.textContent = 'Deleted';
        // Clear input if it matches the deleted run
        if (runInput && runInput.value === runId) runInput.value = '';
        // Ask the page to refresh its Runs view (best effort)
        try { await fetch(API.runs); } catch {}
      } catch (e) {
        status.textContent = 'Error: ' + (e.message || e);
      }
    });

    wrap.appendChild(btn);
    wrap.appendChild(status);

    // Put just under the existing input or at bottom of the Host card
    if (runInput && runInput.parentNode) {
      runInput.parentNode.appendChild(wrap);
    } else {
      hostCard.querySelector('.card-body')?.appendChild(wrap);
    }
  }

  function insertDeleteCard() {
    if (document.getElementById('delete-run-card')) return;

    const card = document.createElement('section');
    card.className = 'card';
    card.id = 'delete-run-card';
    card.style.marginTop = '16px';

    card.innerHTML = `
      <div class="card-header">Delete run</div>
      <div class="card-body">
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <select id="delete-run-select" class="form-select" style="min-width:260px; max-width:420px;"></select>
          <button id="delete-run-btn" class="btn btn-danger">Delete run</button>
          <span id="delete-run-status" style="margin-left:8px; color:#555;"></span>
        </div>
        <div style="font-size:12px; color:#666; margin-top:6px;">
          Tip: You can also use "Delete selected" in the Host card after choosing a run from the table.
        </div>
      </div>
    `;

    // Place near the Host card if possible; else append to body
    const { hostCard } = findHostCardAndInput();
    if (hostCard && hostCard.parentNode) {
      hostCard.parentNode.insertBefore(card, hostCard.nextSibling);
    } else {
      document.body.appendChild(card);
    }

    // Wire events
    const sel = card.querySelector('#delete-run-select');
    const btn = card.querySelector('#delete-run-btn');
    const status = card.querySelector('#delete-run-status');

    async function refreshSelect() {
      status.textContent = 'Loading...';
      const runs = await fetchRuns();
      sel.innerHTML = '';
      if (!runs.length) {
        const opt = document.createElement('option');
        opt.textContent = '(no runs found)';
        opt.value = '';
        sel.appendChild(opt);
        status.textContent = 'No runs';
        return;
      }
      runs.forEach(r => {
        const opt = document.createElement('option');
        const pages = r.stats && (r.stats.pages || r.stats.pagesCrawled) || 0;
        const label = `${r.id}  — pages:${pages}${r.stopped ? ' (stopped)' : ''}${r.pending ? ' (pending)' : ''}`;
        opt.value = r.id;
        opt.textContent = label;
        sel.appendChild(opt);
      });
      status.textContent = '';
    }

    btn.addEventListener('click', async () => {
      const runId = sel.value;
      if (!runId) { status.textContent = 'Pick a run.'; return; }
      const sure = confirm(`Delete run "${runId}"? This removes its folder from disk.`);
      if (!sure) return;

      status.textContent = 'Deleting...';
      try {
        const res = await fetch(API.deleteRun, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId })
        });
        const js = await res.json().catch(() => ({}));
        if (!res.ok || !js.ok) {
          status.textContent = js.error ? `Failed: ${js.error}` : `HTTP ${res.status}`;
          return;
        }
        status.textContent = 'Deleted';
        await refreshSelect();
        // Best-effort notify other panels to refresh
        try { await fetch(API.runs); } catch {}
      } catch (e) {
        status.textContent = 'Error: ' + (e.message || e);
      }
    });

    // Initial load
    refreshSelect();
  }

  function bootstrap() {
    const { hostCard, runInput } = findHostCardAndInput();
    insertInlineDelete(hostCard, runInput);
    insertDeleteCard();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
