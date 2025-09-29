// Add to gui-server.cjs after other API routes
app.get('/api/page-map', (req, res) => {
  try{
    const runId = String(req.query.runId || '').trim();
    if (!runId) return res.status(400).json({ error: 'runId required' });
    const run = runs.find(r=>r.id===runId);
    if(!run) return res.status(404).json({ error:'run not found' });

    const tool = path.join(__dirname, 'tools', 'page-map.cjs');
    if (!fs.existsSync(tool)) return res.status(500).json({ error:'tools/page-map.cjs missing' });

    // Generate (idempotent) and return the JSON
    const { spawnSync } = require('child_process');
    const out = spawnSync(process.execPath, [tool, run.dir], { encoding:'utf8' });
    if (out.status !== 0) return res.status(500).json({ error: out.stderr || out.stdout || 'page-map failed' });

    const reportPath = path.join(run.dir, '_reports', 'page-map.json');
    if (!fs.existsSync(reportPath)) return res.status(500).json({ error:'page-map.json not found' });
    const json = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    res.json({ ok:true, map: json, seedsFile: '/download/' + path.relative(path.join(__dirname,'out'), reportPath).split(path.sep).join('/') });
  } catch(e){
    res.status(500).json({ error: e.message });
  }
});