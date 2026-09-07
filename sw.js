// sw.js — network-first สำหรับหน้า HTML และไฟล์ในโดเมนตัวเอง
// ทุก path เป็น relative (./) ใช้ได้ทั้ง root และ subfolder
// ไม่แคช request ไป Supabase/CDN เลย เพื่อให้ข้อมูลเป็นล่าสุดเสมอ
const CACHE = 'xauusd-v3';
const SHELL = ['./', './index.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// หน้าเว็บสั่งให้ SW ตัวใหม่ทำงานทันทีเมื่อผู้ใช้กด "อัปเดตเลย"
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // ปล่อย Supabase / CDN ผ่านเน็ตปกติ

  // network-first ทุกไฟล์ในโดเมนตัวเอง — มีเน็ตคือได้ของใหม่เสมอ, แคชเป็นแค่ทางสำรองตอนออฟไลน์
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
