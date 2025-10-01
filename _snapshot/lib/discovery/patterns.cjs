const { fetchHTML, looksLikeHTML } = require('../http-fetch.cjs');

function htmlDecodeEntities(s){ return String(s||'').replace(/&amp;/g,'&'); }

function collectHrefs(html, base){
  const out=new Set();
  const re=/href=("([^"]+)"|'([^']+)')/gi; let m;
  while((m=re.exec(html))){
    const raw = htmlDecodeEntities(m[2]||m[3]||'').trim();
    if(!raw) continue;
    try{ out.add(new URL(raw, base).toString()); }catch{}
  }
  return Array.from(out);
}

function likelyProductUrl(url){
  const u=new URL(url);
  const q=Array.from(u.searchParams.keys()).join(',');
  if (/product/i.test(u.pathname)) return true;
  if (/(^|,)product_id(,|$)/i.test(q)) return true;
  if (/(^|,)id(,|$)/i.test(q) && /\d/.test(u.searchParams.get('id')||'')) return true;
  // SEO slug heuristic: two or more deep path segments
  if (!u.search && u.pathname.split('/').filter(Boolean).length>=2) return true;
  return false;
}

async function learnProductPatterns(seed, sampleSize=30){
  // Fetch home + sitemap/category pages quickly
  const origin=new URL(seed).origin;
  const seeds=[seed,
    new URL('/index.php?route=information/sitemap', origin).toString(),
    new URL('/index.php?route=product/category', origin).toString()
  ];
  const pool=new Set(seeds);
  const tested=new Set();
  const candidates=new Set();

  async function addPage(u){
    if (tested.has(u) || pool.size>sampleSize) return;
    tested.add(u);
    const r=await fetchHTML(u, 6000);
    if(!looksLikeHTML(r)) return;
    const hrefs=collectHrefs(r.body, u);
    for(const h of hrefs){
      if (likelyProductUrl(h)) candidates.add(h);
      if (/category|catalog|collections|shop|products|store/i.test(h)) pool.add(h);
    }
  }

  for (const s of seeds) await addPage(s);
  for (const p of Array.from(pool).slice(0, sampleSize)) await addPage(p);

  // Return a deduped list of promising product URLs for validation by the scraper
  return Array.from(candidates);
}

module.exports = { learnProductPatterns, collectHrefs, likelyProductUrl, htmlDecodeEntities };
