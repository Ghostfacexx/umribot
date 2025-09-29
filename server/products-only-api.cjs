// server/products-only-api.cjs
// POST /api/products-only -> crawl (JS-ready) -> products scraper (expands) -> export CSV
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

function run(cmd, args, env = {}, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'pipe', env: { ...process.env, ...env }, cwd });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => { stdout += d.toString(); process.stdout.write(d); });
    p.stderr.on('data', d => { stderr += d.toString(); process.stderr.write(d); });
    p.on('close', code => {
      if (code === 0) return resolve({ code, stdout, stderr });
      reject(new Error(`${cmd} exited ${code}\n${stderr}`));
    });
  });
}

module.exports = function attachProductsOnlyApi(app, opts = {}) {
  const ROOT = opts.rootDir || process.cwd();
  const DOWNLOAD_BASE_URL = (opts.downloadBaseUrl || '/download').replace(/\/+$/,'');
  const downloadedPagesDir = path.join(ROOT, 'downloaded_pages');
  const outDirRoot = path.join(ROOT, 'out');

  app.post('/api/products-only', async (req, res) => {
    try {
      const seed = (req.body && req.body.seed || '').trim();

      // Clamp depth/maxPages to safe defaults if missing/0
      const depthIn = Number(req.body?.depth);
      const maxPagesIn = Number(req.body?.maxPages);
      const depth = Number.isFinite(depthIn) && depthIn > 0 ? depthIn : 5;
      const maxPages = Number.isFinite(maxPagesIn) && maxPagesIn > 0 ? maxPagesIn : 1200;

      if (!seed) return res.status(400).json({ ok:false, error:'seed required' });

      console.log('[P_ONLY_API]', { seed, depth, maxPages });

      const runId = `${new URL(seed).hostname}-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}-${Math.random().toString(36).slice(2,10)}`;
      const runDir = path.join(downloadedPagesDir, runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'seeds.txt'), seed+'\n', 'utf8');

      // 1) Crawl (JS-ready; bootstrap hops to reach categories; add hint endpoints if needed)
      const crawlEnv = {
        START_URLS: seed,
        OUTPUT_DIR: runDir,
        MAX_PAGES: String(maxPages),
        MAX_DEPTH: String(depth),
        SAME_HOST_ONLY: 'true',
        INCLUDE_SUBDOMAINS: 'true',
        AUTO_ALLOW_OPENCART: 'true',
        WAIT_AFTER_LOAD: '500',
        WAIT_FOR_LINKS_MS: '3500',
        NAV_TIMEOUT: '15000',
        STEALTH: 'true',
        BOOTSTRAP_HOPS: '2'
      };
      const crawlerPath = path.join(ROOT, 'crawler.cjs');
      await run('node', [crawlerPath], crawlEnv, ROOT);

      const urlsTxt = path.join(runDir, '_crawl', 'urls.txt');
      if (!fs.existsSync(urlsTxt)) {
        return res.status(500).json({ ok:false, error:'crawler produced no urls.txt' });
      }

      // 2) Products-only scrape (expands into category/product pages; also self-seeds hints if needed)
      const scraperPath = path.join(ROOT, 'bin', 'products-scrape.cjs');
      await run('node', [scraperPath, urlsTxt, runDir], {
        CONCURRENCY: '4',
        NAV_TIMEOUT_MS: '15000',
        WAIT_EXTRA: '300',
        MAX_VISITS_PONLY: '1000'
      }, ROOT);

      // 3) Export WooCommerce CSV (BOM, normalized price, absolute images)
      const exporter = require(path.join(ROOT, 'platform', 'exporter.cjs'));
      const result = await exporter.exportRun({
        runDir,
        outDir: outDirRoot,
        platform: 'woocommerce',
        options: { inlineCss: false }
      });

      const outWoo = result.outDir;
      const folderUrl = `${DOWNLOAD_BASE_URL}/${path.relative(path.join(ROOT,'out'), outWoo).replace(/\\/g,'/')}`;
      const productsCsvUrl = result.productsCsv ? `${DOWNLOAD_BASE_URL}/${path.relative(path.join(ROOT,'out'), result.productsCsv).replace(/\\/g,'/')}` : null;

      res.json({
        ok: true,
        runId,
        outDir: outWoo,
        folderUrl,
        productsCsvUrl,
        stats: result.stats || {}
      });
    } catch (e) {
      res.status(500).json({ ok:false, error: e.message });
    }
  });
};