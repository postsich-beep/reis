// Браузерна версія: спершу мережа, без мережі — збережена копія застосунку.
const C = 'reis-shell-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(C);
    try { const r = await fetch(e.request); if (r.ok) cache.put(e.request, r.clone()); return r; }
    catch (err) { const hit = await cache.match(e.request, { ignoreSearch: true }); if (hit) return hit; throw err; }
  })());
});
