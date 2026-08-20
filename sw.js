// sw.js — service worker เบาๆ แค่ทำให้ "ติดตั้งเป็นแอป" ได้ (installable) และ cache หน้าตาแอป (shell)
// ไม่แคชข้อมูลราคา/ผลวิเคราะห์จาก Supabase เลย เพื่อให้เห็นข้อมูลล่าสุดเสมอเวลามีเน็ต
const CACHE_NAME = 'xauusd-dashboard-v1';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // เฉพาะ GET request ที่มาจากโดเมนตัวเองเท่านั้น (ปล่อย Supabase/CDN ภายนอกให้วิ่งผ่านเน็ตปกติ ไม่ยุ่ง)
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
