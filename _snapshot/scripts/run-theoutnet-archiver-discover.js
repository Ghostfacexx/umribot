#!/usr/bin/env node
const http = require('http');
const payload = {
  urlsText: 'https://www.theoutnet.com/en-us/shop/',
  options: {
    profiles: 'desktop',
    engine: 'chromium',
    concurrency: 1,
    headless: true,
    pageWaitUntil: 'domcontentloaded',
    waitExtra: 1200,
    quietMillis: 2000,
    navTimeout: 45000,
    pageTimeout: 90000,
    maxCaptureMs: 0,
    scrollDelay: 250,
    assetMaxBytes: 3145728,
    rewriteInternal: true,
    mirrorSubdomains: true,
    mirrorCrossOrigin: false,
    includeCrossOrigin: false,
    rewriteHtmlAssets: true,
    flattenRoot: false,
    disableHttp2: true,
    consentRetryAttempts: 12,
    consentRetryInterval: 700,
    consentMutationWindow: 8000,
    consentIframeScan: false,
    consentDebug: false,
    consentDebugScreenshot: false,
    targetPlatform: 'generic',
    // Enable archiver-side discovery instead of external crawler
    discoverInArchiver: true,
    autoExpandDepth: 0,
    autoExpandMaxPages: 3
  }
};
const data = Buffer.from(JSON.stringify(payload));
const req = http.request({hostname:'127.0.0.1',port:8090,path:'/api/run',method:'POST',headers:{'Content-Type':'application/json','Content-Length':data.length}},res=>{let buf='';res.setEncoding('utf8');res.on('data',c=>buf+=c);res.on('end',()=>{console.log('status',res.statusCode);console.log('body',buf);try{console.log('json',JSON.parse(buf));}catch{}})});
req.on('error',e=>{console.error('req error',e.message);process.exitCode=1});
req.write(data);req.end();
