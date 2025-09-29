#!/usr/bin/env node
/**
 * Split a WXR (WordPress eXtended RSS) file into <= maxBytes parts.
 * - Preserves header/footer and namespaces.
 * - Topological sort by parent so parents import before children.
 * - Designed for pages-only exports, but works for posts too.
 *
 * Usage:
 *   node tools/wxr-split.cjs --in /path/to/wordpress-pages-wxr.xml --out /path/to/outdir --max 1900000
 *
 * Outputs:
 *   outdir/wordpress-pages-wxr.part01.xml, part02.xml, ...
 *   outdir/index.json (summary)
 */
const fs = require('fs');
const path = require('path');

function arg(k, d){ const i=process.argv.indexOf(k); return i> -1 ? process.argv[i+1] : d; }
function bLen(s){ return Buffer.byteLength(s, 'utf8'); }
function ensureDir(p){ fs.mkdirSync(p, { recursive:true }); }
function die(msg){ console.error('[WXR_SPLIT_ERR]', msg); process.exit(1); }

const inPath = arg('--in');
const outDir = arg('--out', path.join(process.cwd(), 'wxr-split'));
const maxBytes = Math.max(1, parseInt(arg('--max','1900000'),10));

if(!inPath) die('Missing --in <path-to-wxr.xml>');
if(!fs.existsSync(inPath)) die('Input not found: '+inPath);

const xml = fs.readFileSync(inPath,'utf8');

// Find all <item>...</item>
const itemRx = /<item\b[\s\S]*?<\/item>/gi;
const items = [];
let m;
while((m=itemRx.exec(xml))){
  items.push({ xml: m[0], start: m.index, end: m.index + m[0].length });
}
if(items.length === 0) die('No <item> blocks found; is this a valid WXR?');

// Header (everything before first <item>) and footer (after last </item>)
const header = xml.slice(0, items[0].start);
const footer = xml.slice(items.at(-1).end);

// Extract minimal metadata for sorting (post_id, post_parent, post_type)
function extractTag(txt, tag){ const rx = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'); const mm = rx.exec(txt); return mm ? mm[1].trim() : ''; }
function extractNsTag(txt, ns, tag){ return extractTag(txt, `${ns}:${tag}`); }

for (let i=0;i<items.length;i++){
  const it = items[i];
  const id = parseInt(extractNsTag(it.xml,'wp','post_id') || '0', 10);
  const parent = parseInt(extractNsTag(it.xml,'wp','post_parent') || '0', 10);
  const type = extractNsTag(it.xml,'wp','post_type') || '';
  it.post_id = id;
  it.post_parent = parent;
  it.post_type = type;
  it.size = bLen(it.xml);
  it.idx = i; // original order tiebreaker
}

// Topological order: parent first (for pages)
const byId = new Map(items.map(it => [it.post_id, it]));
const indeg = new Map();
const children = new Map();
for (const it of items){
  indeg.set(it.post_id, 0);
  children.set(it.post_id, []);
}
for (const it of items){
  if (it.post_parent && byId.has(it.post_parent)){
    indeg.set(it.post_id, (indeg.get(it.post_id)||0) + 1);
    children.get(it.post_parent).push(it.post_id);
  }
}
const q = [];
for (const it of items){
  if ((indeg.get(it.post_id)||0) === 0) q.push(it.post_id);
}
// Stable: sort by original index for deterministic output
q.sort((a,b)=> (byId.get(a).idx - byId.get(b).idx));

const topoOrder = [];
while(q.length){
  const id = q.shift();
  topoOrder.push(byId.get(id));
  for (const ch of (children.get(id)||[])){
    indeg.set(ch, indeg.get(ch)-1);
    if (indeg.get(ch) === 0) q.push(ch);
  }
}
// Fallback: append any stragglers by original order
if (topoOrder.length !== items.length){
  const seen = new Set(topoOrder.map(x=>x.idx));
  const rest = items.filter(it => !seen.has(it.idx)).sort((a,b)=> a.idx - b.idx);
  topoOrder.push(...rest);
}

// Chunking
ensureDir(outDir);
const baseName = path.basename(inPath).replace(/\.xml$/i,'');
const headerBytes = bLen(header);
const footerBytes = bLen(footer);
const budget = Math.max(1024, maxBytes);
const parts = [];
let cur = [];
let curSize = headerBytes + footerBytes;

for (const it of topoOrder){
  const joinOver = cur.length ? 1 : 0; // newline
  if (cur.length && (curSize + it.size + joinOver) > budget){
    parts.push(cur);
    cur = [];
    curSize = headerBytes + footerBytes;
  }
  cur.push(it);
  curSize += it.size + joinOver;
}
if (cur.length) parts.push(cur);

// Write files
const written = [];
for (let i=0;i<parts.length;i++){
  const list = parts[i];
  const body = list.map(x=>x.xml).join('\n');
  const outXml = header + body + footer;
  const outPath = path.join(outDir, `${baseName}.part${String(i+1).padStart(2,'0')}.xml`);
  fs.writeFileSync(outPath, outXml, 'utf8');
  written.push({
    file: outPath,
    bytes: Buffer.byteLength(outXml,'utf8'),
    items: list.length
  });
}

// Summary
const sum = {
  source: inPath,
  outDir,
  maxBytes,
  totals: {
    items: items.length,
    parts: written.length,
    bytesSource: Buffer.byteLength(xml,'utf8'),
    headerBytes, footerBytes
  },
  parts: written
};
fs.writeFileSync(path.join(outDir,'index.json'), JSON.stringify(sum,null,2));
console.log('[WXR_SPLIT_OK]', JSON.stringify(sum, null, 2));

// Warn if any single item exceeds maxBytes alone
const tooBig = items.filter(it => (it.size + headerBytes + footerBytes) > maxBytes);
if (tooBig.length){
  console.warn(`[WXR_SPLIT_WARN] ${tooBig.length} item(s) exceed maxBytes alone. Consider re-export with inlineCss=false or edit content.`);
}
