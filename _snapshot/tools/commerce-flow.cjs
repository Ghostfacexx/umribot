#!/usr/bin/env node
/**
 * tools/commerce-flow.cjs
 * External helper to exercise a minimal product -> add-to-cart -> cart -> checkout flow
 * so archiver can mirror those pages too. Keeps archiver.cjs clean.
 *
 * Usage:
 *   node tools/commerce-flow.cjs --start https://site/ --platform opencart --out run/_commerce [--mode once]
 *
 * Output:
 *   Writes URLs discovered into <out>/urls.txt (unique, newline-separated)
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

function arg(name, def) {
  const i = process.argv.indexOf('--'+name);
  return i>0 ? (process.argv[i+1]||'') : def;
}
const START = arg('start','').trim();
const OUT = path.resolve(arg('out', './_commerce'));
const PLATFORM = (arg('platform','opencart')||'').toLowerCase();
const MODE = (arg('mode','once')||'').toLowerCase();

if (!START) {
  console.error('[COMMERCE_FLOW] missing --start');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

function uniq(list){ return Array.from(new Set(list)); }

async function findFirstProduct(page){
  // Heuristics per platform; fallbacks to any link with product_id or /product/
  const origin = new URL(START).origin;
  await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(()=>{});
  await page.waitForTimeout(600);
  const candidates = await page.$$eval('a[href]', as => as.map(a => a.getAttribute('href')).filter(Boolean));
  let abs = [];
  for (const raw of candidates){ try{ abs.push(new URL(raw, location.href).href); }catch{} }
  abs = uniq(abs.filter(u => u.startsWith(origin)));
  const pick = abs.find(u => /route=product\/product&product_id=/.test(u))
           || abs.find(u => /\/product(\?.*)?$/.test(u))
           || abs.find(u => /add-to-cart=/.test(u))
           || abs[0];
  return pick || START;
}

async function run(){
  const urls = new Set();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // 1) Navigate to a product page
  const productUrl = await findFirstProduct(page);
  if (productUrl) urls.add(productUrl);
  await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(()=>{});
  await page.waitForTimeout(500);

  // 2) Click buy/add-to-cart using common selectors
  const buySelectors = [
    '#button-cart', 'button#button-cart',
    'button[name="button-add-to-cart"]', 'button[name="add-to-cart"]',
    'button.add-to-cart', 'a.add-to-cart',
    '.product-cart button', '.product-cart a',
  ];
  for (const sel of buySelectors){
    try{ const el = await page.$(sel); if (el) { await el.click(); await page.waitForTimeout(800); break; } }catch{}
  }
  // Some themes post to index.php?route=checkout/cart/add via XHR; we still collect the URL
  try{ const u = new URL(productUrl); u.searchParams.set('route','checkout/cart'); urls.add(u.toString()); }catch{}

  // 3) Open mini cart / cart page
  const cartSelectors = [
    'a[href*="route=checkout/cart"]', 'a[href*="/cart"]',
    '#cart > button', '.header-cart a', 'a.top-link-cart'
  ];
  let cartUrl = '';
  for (const sel of cartSelectors){
    try{
      const el = await page.$(sel);
      if (el) {
        const href = await el.getAttribute('href');
        if (href) { cartUrl = new URL(href, productUrl).href; break; }
        await el.click(); await page.waitForTimeout(800);
      }
    }catch{}
  }
  if (!cartUrl){
    // Guess common cart URL
    try{ const u = new URL(productUrl); u.searchParams.set('route','checkout/cart'); cartUrl=u.toString(); }catch{}
  }
  if (cartUrl){ urls.add(cartUrl); await page.goto(cartUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(()=>{}); }

  // 4) Proceed to checkout
  const checkoutSelectors = [
    'a[href*="route=checkout/checkout"]', 'a[href*="/checkout"]',
    'button.checkout-button', '#button-checkout', '.btn-checkout'
  ];
  let checkoutUrl = '';
  for (const sel of checkoutSelectors){
    try{
      const el = await page.$(sel);
      if (el) {
        const href = await el.getAttribute('href');
        if (href) { checkoutUrl = new URL(href, cartUrl || productUrl).href; break; }
        await el.click(); await page.waitForTimeout(800);
        checkoutUrl = page.url();
        break;
      }
    }catch{}
  }
  if (!checkoutUrl){
    try{ const u = new URL(productUrl); u.searchParams.set('route','checkout/checkout'); checkoutUrl=u.toString(); }catch{}
  }
  if (checkoutUrl) urls.add(checkoutUrl);

  await browser.close();

  const outList = Array.from(urls);
  fs.writeFileSync(path.join(OUT, 'urls.txt'), outList.join('\n') + '\n', 'utf8');
  console.log('[COMMERCE_FLOW] wrote', path.join(OUT,'urls.txt'), 'count', outList.length);
}

run().catch(e=>{ console.error('[COMMERCE_FLOW_FATAL]', e); process.exit(1); });
