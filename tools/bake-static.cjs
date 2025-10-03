#!/usr/bin/env node
// Bake captured HTML into static, non-hydrating pages by removing scripts and skeletons.
const fs = require('fs');
const path = require('path');

function* walk(dir){
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for(const e of ents){
    const full = path.join(dir, e.name);
    if(e.isDirectory()) yield* walk(full);
    else if(e.isFile()) yield full;
  }
}

function bakeHtml(html){
  // Remove external scripts
  html = html.replace(/<script([^>]*?)\s+src=("|')[^"']+(\2)([^>]*)>\s*<\/script>/gi, '<script type="application/ld+json" data-archiver-blocked="x"></script>');
  // Remove modulepreload/preload for scripts
  html = html.replace(/<link[^>]+rel=("|')(?:modulepreload|preload)\1[^>]+as=("|')script\2[^>]*>/gi, '');
  // Convert inline scripts except JSON/LD+JSON
  html = html.replace(/<script(?![^>]*\bsrc=)([^>]*?)>([\s\S]*?)<\/script>/gi, (m, attrs)=>{
    try{ if(/type\s*=\s*("|')application\/(ld\+json|json)\1/i.test(String(attrs||''))) return m; }catch{}
    return '<script type="application/ld+json" data-archiver-blocked="inline"></script>';
  });
  // Convert type=module
  html = html.replace(/<script([^>]*\btype=("|')module\2[^>]*)>([\s\S]*?)<\/script>/gi, '<script type="application/ld+json" data-archiver-blocked="module"></script>');
  // Remove any remaining scripts except JSON/LD+JSON
  html = html.replace(/<script([^>]*)>[\s\S]*?<\/script>/gi, (m, attrs)=>{
    try{ if(/type\s*=\s*("|')application\/(ld\+json|json)\1/i.test(String(attrs||''))) return m; }catch{}
    return '<script type="application/ld+json" data-archiver-blocked="catchall"></script>';
  });
  // Strip inline event handlers
  html = html.replace(/\son[a-z0-9_-]+\s*=\s*("[^"]*"|'[^']*')/gi, '');
  // Inject CSS patch
  const cssPatch = '<style id="__archive_css_patch">\n'
    + 'html,body{opacity:1!important;visibility:visible!important;filter:none!important;}\n'
    + '[class*="skeleton"],[class*="placeholder"],[class*="shimmer"],.skeleton,.placeholder,.shimmer{display:none!important;}\n'
    + '.plp,.plp-grid,.ProductList,.Products,[data-component="ProductList"],[id*="product"],[class*="product-list"],[class*="plp-grid"],[class*="results"],.ais-InfiniteHits,.ais-Hits{opacity:1!important;visibility:visible!important;filter:none!important;}\n'
    + '[id*="overlay"],[class*="overlay"],.ts-trustbadge,#onetrust-banner-sdk,#usercentrics-root{display:none!important;}\n'
    + '</style>\n';
  if(/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m)=> m + '\n' + cssPatch);
  else if(html.includes('</head>')) html = html.replace('</head>', cssPatch + '\n</head>');
  else if(html.includes('<body')) html = html.replace('<body', '<body>' + cssPatch);
  else html = cssPatch + html;
  return html;
}

function main(){
  const root = path.resolve(process.argv[2]||'');
  if(!root || !fs.existsSync(root)){
    console.error('Usage: node tools/bake-static.cjs <run-dir>');
    process.exit(1);
  }
  let count=0, changed=0;
  for(const file of walk(root)){
    if(!/\/(desktop|mobile)\/index\.html$/i.test(file) && !/\/index\.html$/i.test(file)) continue;
    try{
      const orig = fs.readFileSync(file,'utf8');
      const baked = bakeHtml(orig);
      count++;
      if(baked !== orig){ fs.writeFileSync(file, baked); changed++; }
    }catch(e){ console.warn('[BAKE_WARN]', file, e.message); }
  }
  console.log('[BAKE] scanned:', count, 'updated:', changed);
}

main();
