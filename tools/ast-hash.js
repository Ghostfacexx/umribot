const crypto = require('crypto');
const fs = require('fs');
const glob = require('glob');
const esprima = require('esprima');

function normAst(ast) {
  function walk(n) {
    if (n && typeof n === 'object') {
      delete n.range; delete n.loc; delete n.start; delete n.end; delete n.raw;
      for (const k of Object.keys(n)) {
        const v = n[k];
        if (Array.isArray(v)) n[k] = v.map(walk);
        else if (v && typeof v === 'object') n[k] = walk(v);
      }
    }
    return n;
  }
  return walk(JSON.parse(JSON.stringify(ast)));
}
function hashAst(ast) {
  return crypto.createHash('sha256').update(JSON.stringify(ast)).digest('hex');
}

const files = glob.sync('**/*.{js,cjs,mjs}', {
  ignore: ['**/node_modules/**', '**/.git/**', '**/out/**', '**/downloaded_pages/**']
});
const results = [];
for (const fp of files) {
  const src = fs.readFileSync(fp, 'utf8');
  let ast = null, err = null;
  try { ast = esprima.parseModule(src, { tolerant: true, jsx: true }); }
  catch (e) { try { ast = esprima.parseScript(src, { tolerant: true }); } catch (e2) { err = String(e2 && e2.message || e2); } }
  if (ast) results.push({ path: fp, ast: hashAst(normAst(ast)) });
  else results.push({ path: fp, ast: null, error: err });
}
fs.mkdirSync('report', { recursive: true });
fs.writeFileSync('report/ast-hashes.jsonl', results.map(r => JSON.stringify(r)).join('\n'));
