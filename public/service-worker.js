/* RunnersHub Progressive Web App (PWA) Service Worker */
const CACHE_NAME = 'runnershub-v23';
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/config.js',
  '/icon.svg',
  '/manifest.json',
  '/3dflyover/3dflyover.js',
  '/3dflyover/camera.js',
  '/3dflyover/gpx-parser.js',
  '/3dflyover/route-simplifier.js',
  '/3dflyover/3dflyover.css'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE_ASSETS).catch(err => {
        console.warn('[SW] Precache partial error:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // API responses are NEVER cached. They are per-user (Strava connection status,
  // rewards/wallet, GPX payloads) and must always be fresh — caching them here
  // made users see another request's data and kept stale route lists on screen.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req));
    return;
  }

  // Navigation requests: Network-first, fallback to cached index.html
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(res => {
        if (res && res.status === 200) {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, resClone));
        }
        return res;
      }).catch(() => {
        return caches.match('/index.html') || caches.match('/');
      })
    );
    return;
  }

  // Map libraries and CDN assets: Cache-first
  if (url.origin.includes('unpkg.com') || url.origin.includes('openstreetmap.org')) {
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(networkRes => {
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          }
          return networkRes;
        });
      })
    );
    return;
  }

  // App shell and local static files: Network-first (fallback to cache).
  // Stale-while-revalidate served old JS after a deploy, so UI markup and
  // script logic went out of sync (new color swatches, old handlers).
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req).then(networkRes => {
        if (networkRes && networkRes.status === 200) {
          const clone = networkRes.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return networkRes;
      }).catch(() => caches.match(req).then(cached => cached || caches.match('/index.html')))
    );
  }
});
