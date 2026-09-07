// sw.js — service worker เบาๆ แค่ทำให้ "ติดตั้งเป็นแอป" ได้ (installable)
// ไม่แคชข้อมูลราคา/ผลวิเคราะห์จาก Supabase เลย เพื่อให้เห็นข้อมูลล่าสุดเสมอเวลามีเน็ต
//
// v2: เปลี่ยนกลยุทธ์การแคชหน้า HTML หลักเป็น "network-first" (ของเดิม v1 เป็น
// stale-while-revalidate ซึ่งทำให้เปิดแอปแล้วเจอโค้ดเก่าค้างอยู่เสมอ ต้องเปิดซ้ำอีกรอบ
// ถึงจะเห็นของใหม่ — เจอปัญหานี้ตอนอัปเดตแอปบ่อยๆ) ตอนนี้พอมีเน็ต จะดึงหน้า HTML ล่าสุด
// จากเซิร์ฟเวอร์ตรงๆ ทุกครั้งที่เปิดแอป ไม่มีของค้าง ส่วน cache ใช้เป็นแค่ตัวสำรอง
// ตอนไม่มีเน็ตจริงๆ เท่านั้น
const CACHE_NAME = 'xauusd-dashboard-v2';
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

  const isPageRequest = req.mode === 'navigate' || req.destination === 'document';

  if (isPageRequest) {
    // Network-first: พอมีเน็ต ดึงหน้าล่าสุดจากเซิร์ฟเวอร์เสมอ ไม่ใช้ของแคชเก่า
    // ใช้แคชเป็นแค่ทางสำรองตอนไม่มีเน็ตจริงๆ เท่านั้น
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // asset อื่นๆ (manifest/icons) เปลี่ยนไม่บ่อย ใช้ stale-while-revalidate ได้ตามปกติ
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
