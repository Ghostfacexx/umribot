#!/usr/bin/env node
/* eslint-disable no-console */
const path = require('path');
const { exportRun } = require('../platform/exporter.cjs');

function arg(name, def) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx > -1 ? process.argv[idx+1] : def;
}

(async () => {
  try {
    const platform = arg('platform');
    const runDir = path.resolve(arg('run-dir', './downloaded_pages/latest'));
    const outDir = path.resolve(arg('out', `./out/${platform || 'export'}`));
    if (!platform) throw new Error('Missing --platform (shopify|woocommerce)');
    console.log(`[export-run] platform=${platform} runDir=${runDir} outDir=${outDir}`);
    await exportRun({ runDir, outDir, platform });
    console.log('[export-run] OK');
  } catch (e) {
    console.error('[export-run] ERROR:', e.message);
    process.exit(1);
  }
})();
