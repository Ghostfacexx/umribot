const { fetchHTML, looksLikeHTML } = require('../http-fetch.cjs');
const https = require('https');
const http = require('http');

async function fetchText(u){
  try{
    const U = new URL(u);
    const mod = U.protocol === 'https:' ? https : http;
    return await new Promise((res)=> {
      const r = mod.get(u, resp => {
        const chunks=[]; resp.on('data', c=>chunks.push(c));
        resp.on('end', ()=>res(Buffer.concat(chunks).toString('utf8')));
      }).on('error', ()=>res(''));
    });
  }catch{return '';}
}

function parseRobotsForSitemaps(txt, origin){
  const out=[];
  (txt||'').split(/\r?\n/).forEach(line=>{
    const m=line.match(/^\s*sitemap\s*:\s*(\S+)/i);
    if (m){
      try{ out.push(new URL(m[1], origin).toString()); }catch{}
    }
  });
  return out;
}

function extractUrlsFromXml(xml, origin){
  const out=[];
  const re = /<loc>([\s\S]*?)<\/loc>/gi; let m;
  while((m=re.exec(xml))){ const raw=(m[1]||'').trim(); if(!raw) continue;
    try{ out.push(new URL(raw, origin).toString()); }catch{}
  }
  return out;
}

async function discoverFromSitemaps(origin, max=5000){
  const robots = await fetchText(new URL('/robots.txt', origin).toString());
  const sitemaps = parseRobotsForSitemaps(robots, origin);
  const urls=new Set();
  for (const sm of sitemaps){
    const xml = await fetchText(sm);
    const locs = extractUrlsFromXml(xml, origin);
    for (const loc of locs){
      if (urls.size>=max) break;
      // If this is another sitemap, fetch it
      if (/\.xml(\.gz)?$/i.test(loc)){
        const xml2 = await fetchText(loc);
        const locs2 = extractUrlsFromXml(xml2, origin);
        for (const l2 of locs2){ if (urls.size<max) urls.add(l2); }
      } else {
        urls.add(loc);
      }
    }
    if (urls.size>=max) break;
  }
  return Array.from(urls);
}

module.exports = { discoverFromSitemaps };
