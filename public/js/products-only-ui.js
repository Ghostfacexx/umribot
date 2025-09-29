/* Adds a "WooCommerce: Products only" card in the GUI.
   - Reads the seed from #seedInput
   - Optional: reads auto-expand depth/max pages if present
   - Calls /api/products-only and displays the CSV link
*/
(function(){
  function el(tag, props={}, children=[]){
    const e=document.createElement(tag);
    Object.assign(e, props);
    for(const c of children) e.appendChild(c);
    return e;
  }
  function qs(sel){ return document.querySelector(sel); }

  function insertCard(){
    if (document.getElementById('products-only-card')) return;
    const card = el('section', { className:'card', id:'products-only-card' });
    card.innerHTML = `
      <h2>WooCommerce: Products only</h2>
      <div class="flex" style="gap:.5rem; align-items:center; flex-wrap:wrap;">
        <button id="btnProductsOnly" class="btn">Run products-only</button>
        <span id="poStatus" class="small"></span>
      </div>
      <div class="small" style="margin-top:.35rem;">
        Uses the URL in the Capture seed. Crawls product/category pages quickly and produces a WooCommerce CSV without mirroring pages.
      </div>
      <pre id="poLog" style="max-height:160px"></pre>
      <div id="poLinks" class="small"></div>
    `;
    // Insert the card near “Hosting Prep” or at the end
    const main = document.querySelector('main') || document.body;
    const hostPrep = Array.from(document.querySelectorAll('section')).find(s => /Hosting Prep/i.test(s.textContent||''));
    if (hostPrep && hostPrep.parentNode) hostPrep.parentNode.insertBefore(card, hostPrep);
    else main.appendChild(card);

    const btn = card.querySelector('#btnProductsOnly');
    const poStatus = card.querySelector('#poStatus');
    const poLog = card.querySelector('#poLog');
    const poLinks = card.querySelector('#poLinks');

    btn.addEventListener('click', async ()=>{
      const seed = (document.querySelector('#seedInput')?.value
           || document.querySelector('textarea[name="urlsText"]')?.value
           || document.querySelector('input[name="urlsText"]')?.value
           || '').trim();
      if (!seed) { poStatus.textContent = 'Enter a URL in Capture → seed first.'; return; }

      // Read defaults from GUI if present
      const depth = parseInt(qs('#autoDepth')?.value || '4',10);
      const maxPages = parseInt(qs('#autoMaxPages')?.value || '2000',10);

      poStatus.textContent = 'Running… this may take a bit.';
      poLinks.textContent = '';
      poLog.textContent = '';

      try {
        const res = await fetch('/api/products-only', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seed, depth, maxPages })
        });
        const js = await res.json().catch(()=>({}));
        if (!res.ok || !js.ok){
          poStatus.textContent = 'Failed.';
          poLog.textContent = (js && js.error) ? js.error : `HTTP ${res.status}`;
          return;
        }
        poStatus.textContent = 'Done.';
        const links = [];
        if (js.folderUrl) links.push(`<div>Folder: <a class="zipLink" href="${js.folderUrl}" target="_blank">${js.folderUrl}</a></div>`);
        if (js.productsCsvUrl) links.push(`<div>Products CSV: <a class="zipLink" href="${js.productsCsvUrl}" target="_blank">Download</a></div>`);
        if (js.stats){
          links.push(`<pre>${JSON.stringify(js.stats,null,2)}</pre>`);
        }
        poLinks.innerHTML = links.join('');
      } catch (e) {
        poStatus.textContent = 'Error.';
        poLog.textContent = e.message || String(e);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insertCard);
  } else {
    insertCard();
  }
})();
