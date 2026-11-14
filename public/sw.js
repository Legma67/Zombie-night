// Zombie Night Survival – lets the game be installed as an app and start even with a weak connection.
// The game page and its libraries are kept in a cache; online play still needs the internet.
const CACHE = 'zns-v1';
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/', '/icon-192.png', '/icon-512.png'])).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return; const u = new URL(r.url);
  if (u.pathname === '/health' || u.pathname.startsWith('/ws')) return;
  // newest version first, the saved copy when there is no connection
  e.respondWith(fetch(r).then(res => { if (res.ok && (u.origin === location.origin || /cdnjs|jsdelivr|fonts\.g/.test(u.host))) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(r, cp)); } return res; }).catch(() => caches.match(r).then(m => m || (r.mode === 'navigate' ? caches.match('/') : Response.error()))));
});
