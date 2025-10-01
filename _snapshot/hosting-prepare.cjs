#!/usr/bin/env node
/**
 * hosting-prepare.cjs
 * CLI wrapper for lib/hostingPrep.js
 * Usage:
 *   node hosting-prepare.cjs <RUN_DIR> <OUT_DIR> --mode=switch --strip-analytics --precompress --base-url=https://example.com --platform=netlify
 */

const { prepareHosting } = require('./lib/hostingPrep');
const path = require('path');

function parseArgs(argv){
  const args={ _:[] };
  for(let i=2;i<argv.length;i++){
    const a=argv[i];
    if(a.startsWith('--')){
      const [k,vRaw]=a.slice(2).split('=');
      args[k]= vRaw===undefined ? true : vRaw;
    } else args._.push(a);
  }
  return args;
}

(async ()=>{
  const args=parseArgs(process.argv);
  if(args._.length<2){
    console.error('Usage: node hosting-prepare.cjs <RUN_DIR> <OUT_DIR> [--mode=...] [--strip-analytics] [--precompress] [--no-sw] [--base-url=...] [--no-sitemap] [--no-mobile] [--platform=netlify|cloudflare|s3|generic|shopify] [--extra-analytics-regex=...] [--zip]');
    process.exit(2);
  }
  const runDir=path.resolve(args._[0]);
  const outDir=path.resolve(args._[1]);
  const opt={
    mode: (args.mode||'switch').toLowerCase(),
    stripAnalytics: !!args['strip-analytics'],
    precompress: !!args['precompress'],
    noServiceWorker: !!args['no-sw'],
    baseUrl: args['base-url']||'',
    noSitemap: !!args['no-sitemap'],
    noMobile: !!args['no-mobile'],
    extraAnalyticsRegex: args['extra-analytics-regex']||'',
    platform: (args.platform||'generic').toLowerCase(),
    addShopifyEmbed: !!args['shopify-embed'],
    createZip: !!args['zip']
  };
  console.log('[HOSTPREP_CLI] options:', opt);
  try{
    const result=await prepareHosting(runDir, outDir, opt, msg=>console.log('[HOSTPREP]',msg));
    console.log('[HOSTPREP_CLI] DONE', result);
  }catch(e){
    console.error('ERROR', e.message);
    process.exit(1);
  }
})();