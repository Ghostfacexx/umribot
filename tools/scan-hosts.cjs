#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const ROOT = process.argv[2] || 'downloaded_pages';
const hosts = new Map();

function walk(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(p)) walk(path.join(p, n));
  } else if (st.isFile() && /\.(html?|htm)$/i.test(p)) {
    const $ = cheerio.load(fs.readFileSync(p, 'utf8'));
    const cand =
      $('link[rel="canonical"]').attr('href') ||
      $('meta[property="og:url"]').attr('content') ||
      $('meta[name="og:url"]').attr('content') || '';
    let host = '';
    try { host = cand ? (new URL(cand)).host.toLowerCase() : ''; } catch {}
    hosts.set(host, (hosts.get(host) || 0) + 1);
  }
}
walk(ROOT);
console.log([...hosts.entries()].sort((a,b)=>b[1]-a[1]).map(([h,c]) => `${h || '(no host)'}\t${c}`).join('\n'));