/* Custom Service Worker (override generated one if placed after running hosting-prepare) */
const CACHE='archive-custom-v1';
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['/'])).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET'){ return; }
  e.respondWith(
    caches.match(req).then(hit=> hit || fetch(req).then(r=>{
      if(r.ok){
        const clone=r.clone();
        caches.open(CACHE).then(c=>c.put(req,clone));
      }
      return r;
    }).catch(()=>caches.match('/')))
  );
});
