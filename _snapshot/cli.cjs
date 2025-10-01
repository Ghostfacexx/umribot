#!/usr/bin/env node
const path = require('path');
const { spawn } = require('child_process');
function run(rel, args=[]) {
  const p = path.join(__dirname, rel);
  const cp = spawn(process.execPath, [p, ...args], { stdio: 'inherit' });
  cp.on('exit', code => process.exit(code));
}
const argv = process.argv.slice(2);
const cmd = argv[0];
if (!cmd || ['-h','--help','help'].includes(cmd)) {
  console.log(`parser commands:
  archive <args...>   -> archive.cjs
  mirror <args...>    -> mirror.cjs
  serve [--mode=archive|gui] [--dir=out]
  wc export --format [wxr|csv] --scope [pages|products]
`); process.exit(0);
}
if (cmd === 'archive') run('./archive.cjs', argv.slice(1));
else if (cmd === 'mirror') run('./mirror.cjs', argv.slice(1));
else if (cmd === 'serve') {
  const mode = (argv.includes('--mode') ? argv[argv.indexOf('--mode')+1] : 'archive');
  const dir = (argv.includes('--dir') ? argv[argv.indexOf('--dir')+1] : 'out');
  if (mode === 'gui') run('./gui-server.cjs', []);
  else run('./serve-archive.cjs', ['--dir', dir]);
}
else if (cmd === 'wc' && argv[1] === 'export') {
  const fmt = (argv.includes('--format') ? argv[argv.indexOf('--format')+1] : '');
  const scope = (argv.includes('--scope') ? argv[argv.indexOf('--scope')+1] : '');
  if (fmt==='wxr' && scope==='pages') run('./wc-export-pages-wxr.cjs', argv.slice(2));
  else if (fmt==='wxr' && scope==='products') run('./wc-export-wxr.cjs', argv.slice(2));
  else if (fmt==='csv' && scope==='products') run('./wc-export-products-csv.cjs', argv.slice(2));
  else { console.error('Unsupported wc export combination'); process.exit(2); }
}
else { console.error('Unknown command:', cmd); process.exit(2); }
