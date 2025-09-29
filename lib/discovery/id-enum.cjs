function extractIds(html){
  const ids=new Set();
  const rx1=/(?:\?|&|&amp;)(?:product_id|id)=(\d{1,8})/gi; let m;
  while((m=rx1.exec(html))) ids.add(m[1]);
  const rx2=/(product_id|productId|data-product-id|data-id|product-id)[^0-9]{0,12}(\d{1,8})/gi;
  while((m=rx2.exec(html))) ids.add(m[2]);
  return Array.from(ids);
}

function deriveRangeFrom(ids){
  const nums=ids.map(x=>parseInt(x,10)).filter(Number.isFinite);
  if (!nums.length) return null;
  const min=Math.max(1, Math.min(...nums)-100);
  const max=Math.min(Math.max(...nums)+200, 5000);
  return { min, max };
}

function buildUrls(origin, paramName, {min,max}, batch=0){
  const out=[];
  for(let i=min;i<=max;i++){
    const u = new URL('/index.php', origin);
    u.searchParams.set('route','product/product');
    if (paramName==='id') u.searchParams.set('id', String(i));
    else u.searchParams.set('product_id', String(i));
    out.push(u.toString());
  }
  // Optional coarse shuffle to avoid sequential hammering
  for(let i=out.length-1;i>0;i--){ const j=(i*16807+batch)% (i+1); [out[i],out[j]]=[out[j],out[i]]; }
  return out;
}

module.exports = { extractIds, deriveRangeFrom, buildUrls };
