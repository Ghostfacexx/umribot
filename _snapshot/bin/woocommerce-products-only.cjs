#!/usr/bin/env node
/**
 * One-shot "products only" pipeline for WooCommerce.
 * - Crawl to discover product/category pages (fast)
 * - Scrape product data only (no mirroring)
 * - Export WooCommerce CSV (UTF-8 BOM, normalized prices, absolute images)
 *
 * Usage:
 *   node bin/woocommerce-products-only.cjs https://teashop.bg
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SEED = process.argv[2];
if (!SEED) {
  console.error('Usage: node bin/woocommerce-products-only.cjs <seed_url>');
  process.exit(1);
}
const ROOT = process.cwd();
const RUN_ID = `${new URL(SEED).hostname}-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}-${Math.random().toString(36).slice(2,10)}`;
const RUN_DIR = path.join(ROOT, 'downloaded_pages', RUN_ID);
const OUT_DIR = path.join(ROOT, 'out');

fs.mkdirSync(RUN_DIR, { recursive: true });
fs.writeFileSync(path.join(RUN_DIR, 'seeds.txt'), SEED+'\n', 'utf8');

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
    p.on('close', code => code === 0 ? resolve() : reject(new Error(cmd+' exit '+code)));
  });
}

(async()=>{
  console.log('[PRESET_PRODUCTS_ONLY] start run=', RUN_ID);

  // 1) Crawl — discover product & category pages (no custom regex needed; crawler auto-allows OpenCart)
  await run('node', [ path.join(ROOT, 'crawler.cjs') ], {
    START_URLS: SEED,
    OUTPUT_DIR: RUN_DIR,
    MAX_PAGES: '2000',
    MAX_DEPTH: '4',
    SAME_HOST_ONLY: 'true',
    INCLUDE_SUBDOMAINS: 'true',
    // Leave ALLOW_REGEX empty; crawler will auto-allow product/category routes.
    AUTO_ALLOW_OPENCART: 'true',
    WAIT_AFTER_LOAD: '400',
    NAV_TIMEOUT: '15000'
  });

  // 2) Products-only scrape — visits pages quickly and extracts products into _data/products.ndjson
  await run('node', [ path.join(ROOT, 'bin', 'products-scrape.cjs'), path.join(RUN_DIR, '_crawl', 'urls.txt'), RUN_DIR ], {
    CONCURRENCY: '4',
    NAV_TIMEOUT_MS: '15000',
    WAIT_EXTRA: '300'
  });

  // 3) Export WooCommerce CSV (and WXR pages will be skipped since no pages mirrored; CSV still produced)
  const exporter = require(path.join(ROOT, 'platform', 'exporter.cjs'));
  const res = await exporter.exportRun({ runDir: RUN_DIR, outDir: OUT_DIR, platform: 'woocommerce', options: { inlineCss: false }});
  console.log('[EXPORT_DONE]', JSON.stringify(res, null, 2));
  console.log('\nOutput folder:\n -', res.outDir);
  if (res.productsCsv) console.log('CSV:', res.productsCsv);
  else console.log('CSV: not produced (no products found).');
})().catch(e=>{
  console.error('[PRESET_PRODUCTS_ONLY_FATAL]', e.stack || e.message);
  process.exit(1);
});