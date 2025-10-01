const { chromium } = require('playwright');
(async()=>{
  const url = process.argv[2] || 'https://www.vivacom.bg/';
  const browser = await chromium.launch({ headless:true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil:'domcontentloaded', timeout:30000 });
  await page.waitForTimeout(1500);
  const texts = await page.evaluate(()=>{
    const out=[];
    const norm=s=>s.replace(/\u00A0/g,' ').replace(/\s+/g,' ').trim();
    function grab(root){
      root.querySelectorAll('button,a,[role=button],input[type=button],input[type=submit]').forEach(el=>{
        const t=norm(el.textContent||el.value||'');
        if(t) out.push(t);
      });
      root.querySelectorAll('*').forEach(n=>{
        if(n.shadowRoot) grab(n.shadowRoot);
      });
    }
    grab(document);
    document.querySelectorAll('iframe').forEach(fr=>{
      try { if(fr.contentDocument) grab(fr.contentDocument); }catch{}
    });
    return out;
  });
  console.log('BUTTON TEXTS:');
  texts.forEach(t=>console.log('-', t));
  await browser.close();
})();
