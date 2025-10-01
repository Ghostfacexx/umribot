#!/usr/bin/env node
const { chromium } = require('playwright');

const url = process.argv[2] || 'https://www.theoutnet.com/en-us/shop/';
const host = process.env.PROXY_HOST || 'gate.decodo.com:7000';
let user = process.env.PROXY_USER;
const pass = process.env.PROXY_PASS;

if (!user || !pass) {
  console.error('Set PROXY_USER and PROXY_PASS (and optionally PROXY_HOST).');
  process.exit(1);
}

// Optionally rotate session each run by replacing last token after session-
if ((process.env.ROTATE_SESSION || 'true').toLowerCase()==='true') {
  user = user.replace(/(session-)[A-Za-z0-9_-]+/, (_,p)=> p + Math.random().toString(36).slice(2,10));
  console.log('Rotated proxy user ->', user);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: `http://${host}`, username: user, password: pass },
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--disable-http2'          // test with HTTP/2 disabled first
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
    locale: 'en-US',
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.theoutnet.com/',
      'Upgrade-Insecure-Requests': '1'
    }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator,'webdriver',{get:()=>false});
    window.chrome = { runtime:{} };
    Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});
  });

  const page = await context.newPage();

  page.on('requestfailed', r => console.log('REQ_FAIL', r.url(), r.failure()?.errorText));
  page.on('response', r => {
    if (r.request().resourceType()==='document')
      console.log('DOC_RESP', r.status(), r.url());
  });

  try {
    const t0 = Date.now();
    const resp = await page.goto(url, { waitUntil: 'commit', timeout: 25000 });
    console.log('Commit ms:', Date.now()-t0, 'status:', resp?.status());
    await page.waitForSelector('body', { timeout: 10000 });
    console.log('Title:', await page.title());
    const len = (await page.content()).length;
    console.log('HTML length:', len);
  } catch (e) {
    console.error('Navigation error:', e.message);
  } finally {
    await browser.close();
  }
})();