const https = require('https');
const http = require('http');
const zlib = require('zlib');

const agentHttp = new http.Agent({ keepAlive:true, maxSockets:256 });
const agentHttps = new https.Agent({ keepAlive:true, maxSockets:256 });

function decompress(body, encoding){
  return new Promise((resolve)=>{
    if (!encoding) return resolve(body);
    const enc = String(encoding).toLowerCase();
    if (enc.includes('br')) return zlib.brotliDecompress(body, (e,b)=>resolve(e?body:b));
    if (enc.includes('gzip')) return zlib.gunzip(body, (e,b)=>resolve(e?body:b));
    if (enc.includes('deflate')) return zlib.inflate(body, (e,b)=>resolve(e?body:b));
    resolve(body);
  });
}

async function fetchHTML(url, timeoutMs=8000, ua='Mozilla/5.0 (UniversalProducts)'){
  return new Promise((resolve) => {
    try {
      const U = new URL(url);
      const mod = U.protocol === 'https:' ? https : http;
      const agent = U.protocol === 'https:' ? agentHttps : agentHttp;
      const req = mod.request({
        hostname: U.hostname,
        port: U.port || (U.protocol === 'https:' ? 443 : 80),
        path: (U.pathname || '/') + (U.search || ''),
        method: 'GET',
        agent,
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive'
        },
        timeout: timeoutMs
      }, async (res) => {
        const ct = (res.headers['content-type'] || '').toLowerCase();
        const ce = res.headers['content-encoding'] || '';
        const status = res.statusCode || 0;
        const chunks=[];
        res.on('data', c => chunks.push(c));
        res.on('end', async () => {
          const raw = Buffer.concat(chunks);
          const bodyBuf = await decompress(raw, ce);
          const body = bodyBuf.toString('utf8');
          resolve({ ok:true, status, ct, body });
        });
      });
      req.on('timeout', () => { try{ req.destroy(); }catch{} resolve({ ok:false }); });
      req.on('error', () => resolve({ ok:false }));
      req.end();
    } catch {
      resolve({ ok:false });
    }
  });
}

function looksLikeHTML(resp){
  if (!resp || !resp.ok) return false;
  if (resp.status >= 400) return false;
  if (/text\/html|application\/xhtml\+xml/.test(resp.ct)) return true;
  return /<html[\s>]/i.test(resp.body || '');
}

module.exports = { fetchHTML, looksLikeHTML };
