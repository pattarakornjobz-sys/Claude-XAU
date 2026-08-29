const C='xauusd-v1';const A=['./','./index.html','./manifest.json','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(A)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(n=>n!==C).map(n=>caches.delete(n)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);
if(u.origin!==location.origin){e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)));return}
e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>{caches.open(C).then(c=>c.put(e.request,res.clone()));return res}).catch(()=>caches.match('./index.html'))))});
