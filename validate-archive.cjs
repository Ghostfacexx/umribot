#!/usr/bin/env node
/**
 * Validates internal links & asset references inside the archive.
 * Reports missing targets (HTML directories or asset files).
 *
 * Usage:
 *   node validate-archive.cjs /var/www/outnet-archive > link-report.txt
 *
 * Skips external (http/https/protocol-relative) URLs and mailto/tel/javascript:.
 * Designed to be dependency-free (regex HTML scanning).
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2];
if (!ROOT) {
  console.error('Usage: node validate-archive.cjs <archive-root>');
  process.exit(1);
}

function listHtmlFiles(root) {
  const out = [];
  (function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.toLowerCase() === 'index.html') out.push(full);
    }
  })(root);
  return out;
}

const htmlFiles = listHtmlFiles(ROOT);
console.error(`Found ${htmlFiles.length} index.html files.`);

const attrRegex = /\b(?:href|src)\s*=\s*(['"])(.*?)\1/gi;

function isExternal(u) {
  return /^https?:\/\//i.test(u) || /^\/\//.test(u) || /^(?:mailto|tel|javascript):/i.test(u);
}

let missing = {};
let totalLinks = 0;
let checkedPages = 0;

function checkRef(pageDir, ref) {
  // Root-absolute path
  if (ref.startsWith('/')) {
    const local = ref.replace(/^\/+/, '').replace(/\/+$/,'');
    if (!local) {
      // root itself
      const idx = path.join(ROOT, 'index.html');
      if (!fs.existsSync(idx)) addMissing(ref, 'index');
      return;
    }
    // directory form: /abc/ -> should map to /abc/index.html
    const fullDir = path.join(ROOT, local);
    const idxPath = path.join(fullDir,'index.html');
    if (ref.endsWith('/')) {
      if (!(fs.existsSync(fullDir) && fs.existsSync(idxPath))) {
        if (!fs.existsSync(idxPath)) addMissing(ref,'dir-index');
      }
    } else {
      // treat as file path (maybe asset or .html)
      const direct = path.join(ROOT, local);
      if (!fs.existsSync(direct)) {
        // Implicit directory?
        if (fs.existsSync(fullDir) && fs.existsSync(idxPath)) return;
        addMissing(ref,'file');
      }
    }
    return;
  }

  // Relative
  let target = ref;
  // Remove query/hash
  target = target.split('#')[0].split('?')[0];
  if (!target) return;
  const full = path.join(pageDir, target);
  if (fs.existsSync(full)) return;

  // Directory relative?
  if (target.endsWith('/')) {
    const idx = path.join(full,'index.html');
    if (!fs.existsSync(idx)) addMissing(ref,'rel-dir-index');
    return;
  }
  // Try adding index.html if path refers to a folder style missing slash
  if (fs.existsSync(full + '/index.html')) return;

  // Try .html variant
  if (fs.existsSync(full + '.html')) return;

  addMissing(ref,'rel');
}

function addMissing(ref, kind) {
  missing[ref] = missing[ref] || { count:0, kinds:new Set() };
  missing[ref].count++;
  missing[ref].kinds.add(kind);
}

for (const file of htmlFiles) {
  try {
    const html = fs.readFileSync(file,'utf8');
    const pageDir = path.dirname(file);
    let m;
    while ((m = attrRegex.exec(html)) !== null) {
      const ref = m[2].trim();
      if (!ref || isExternal(ref)) continue;
      totalLinks++;
      checkRef(pageDir, ref);
    }
    checkedPages++;
  } catch (e) {
    console.error('Read error', file, e.message);
  }
}

const missingArr = Object.entries(missing).map(([ref,obj])=>({
  ref,
  count: obj.count,
  kinds: Array.from(obj.kinds)
})).sort((a,b)=> b.count - a.count);

console.log('=== VALIDATION REPORT ===');
console.log('Root:', ROOT);
console.log('Pages checked:', checkedPages);
console.log('Total internal refs scanned:', totalLinks);
console.log('Missing/Unresolved refs:', missingArr.length);
console.log('');
if (missingArr.length) {
  console.log('Top 50 (ref, count, kinds):');
  for (const r of missingArr.slice(0,50)) {
    console.log(`- ${r.ref}  (count=${r.count}, kinds=${r.kinds.join(',')})`);
  }
} else {
  console.log('No missing internal references detected.');
}
