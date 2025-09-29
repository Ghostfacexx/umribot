#!/usr/bin/env node
/* Build a page map from a finished run:
   - Reads _crawl/urls.txt (seeds for archive) and manifest.html files (for titles)
   - Classifies URLs: homepage, categories, information pages, others
   - Writes:
     - _reports/page-map.json
     - _reports/seeds-pages-only.txt (homepage + categories + info)
     - _reports/curated-urls.txt (with titles comment)
   Usage:
     node tools/page-map.cjs downloaded_pages/<run_id>
*/
const fs = require('fs');
const path = require('path');

function die(msg){ console.error(msg); process.exit(1); }
function read(p){ try{ return fs.readFileSync(p,'utf8'); }catch{ return ''; } }
function exists(p){ try{ return fs.existsSync(p); }catch{ return false; } }
function ensureDir(p){ fs.mkdirSync(p,{recursive:true}); }
function uniq(arr){ return [...new Set(arr)]; }

function loadSeeds(runDir){
  const p1 = path.join(runDir, '_crawl', 'urls.txt');
  const p2 = path.join(runDir, 'seeds.txt');
  const txt = exists(p1) ? read(p1) : read(p2);
  return txt.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
}

function loadManifest(runDir){
  const fp = path.join(runDir, 'manifest.json');
  if(!exists(fp)) return [];
  try { return JSON.parse(read(fp)); } catch { return []; }
}

function titleFromHtml(fp){
  try{
    const html = read(fp);
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? m[1].replace(/\s+/g,' ').trim() : '';
  }catch{ return ''; }
}

function fileForUrl(runDir, rec){
  // rec.relPath may be '' or 'index' for root
  const rel = (rec.relPath && rec.relPath !== 'index') ? rec.relPath : 'index';
  return path.join(runDir, rel, 'desktop', 'index.html');
}

function classify(url, baseHost){
  const u = new URL(url);
  const qs = u.search || '';
  const route = (qs.match(/(?:^|[?&])route=([^&]+)/) || [,''])[1];
  const productId = /(?:^|[?&])product_id=\d+/.test(qs);

  const isHome = (
    u.hostname === baseHost &&
    (
      u.pathname === '/' ||
      /(?:^|[?&])route=common\/home(?:&|$)/.test(qs)
    )
  );

  const isCategory = route.toLowerCase() === 'product/category';
  const isInfoContact = route.toLowerCase() === 'information/contact';
  const isInfoPage = route.toLowerCase() === 'information/information';
  const isProduct = productId || route.toLowerCase() === 'product/product';

  if (isHome) return 'home';
  if (isProduct) return 'product';
  if (isCategory) return 'category';
  if (isInfoContact || isInfoPage) return 'information';
  return 'other';
}

function extractBaseHost(seeds){
  for(const s of seeds){
    try {
      const u = new URL(s);
      return u.hostname;
    } catch {}
  }
  return '';
}

function main(){
  const runDir = process.argv[2];
  if(!runDir) die('Usage: node tools/page-map.cjs downloaded_pages/<run_id>');
  if(!exists(runDir)) die('Run dir not found: '+runDir);

  const seeds = loadSeeds(runDir);
  if(seeds.length === 0) die('No seeds found (run may not be finished): '+runDir);

  const baseHost = extractBaseHost(seeds) || '';
  const mf = loadManifest(runDir);
  const titleByUrl = new Map();
  for(const rec of mf){
    if(rec && rec.url && rec.profile === 'desktop'){
      const fp = fileForUrl(runDir, rec);
      const t = exists(fp) ? titleFromHtml(fp) : '';
      if (t) titleByUrl.set(rec.url, t);
    }
  }

  const buckets = { home:[], categories:[], information:[], others:[], excluded_products:[] };
  for(const url of seeds){
    let cls = 'other';
    try { cls = classify(url, baseHost); } catch { cls = 'other'; }
    const title = titleByUrl.get(url) || '';
    const entry = title ? { url, title } : { url };
    if (cls === 'home') buckets.home.push(entry);
    else if (cls === 'category') buckets.categories.push(entry);
    else if (cls === 'information') buckets.information.push(entry);
    else if (cls === 'product') buckets.excluded_products.push(entry);
    else buckets.others.push(entry);
  }

  // Build outputs
  const reportDir = path.join(runDir, '_reports');
  ensureDir(reportDir);

  const pageMap = {
    runDir,
    host: baseHost,
    counts: {
      seeds: seeds.length,
      home: buckets.home.length,
      categories: buckets.categories.length,
      information: buckets.information.length,
      others: buckets.others.length,
      excluded_products: buckets.excluded_products.length
    },
    home: buckets.home,
    categories: buckets.categories,
    information: buckets.information,
    others: buckets.others
  };

  fs.writeFileSync(path.join(reportDir, 'page-map.json'), JSON.stringify(pageMap, null, 2));

  const pagesOnly = uniq([
    ...buckets.home.map(x=>x.url),
    ...buckets.categories.map(x=>x.url),
    ...buckets.information.map(x=>x.url)
  ]);

  fs.writeFileSync(path.join(reportDir, 'seeds-pages-only.txt'), pagesOnly.join('\n')+'\n');

  const withTitles = [
    ...buckets.home.map(x=> (x.title?`# ${x.title}\n${x.url}`:x.url)),
    ...buckets.categories.map(x=> (x.title?`# ${x.title}\n${x.url}`:x.url)),
    ...buckets.information.map(x=> (x.title?`# ${x.title}\n${x.url}`:x.url)),
    ...buckets.others.map(x=> (x.title?`# ${x.title}\n${x.url}`:x.url))
  ];
  fs.writeFileSync(path.join(reportDir, 'curated-urls.txt'), withTitles.join('\n')+'\n');

  console.log('[PAGE_MAP_OK]', JSON.stringify(pageMap.counts));
}

if (require.main === module) main();
