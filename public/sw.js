const CACHE_NAME = 'starfishnotes-assets-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/favicon.png',
  '/favicon.svg',
  '/icons.svg',
  '/fonts/fonts.css',
  '/fonts/QGYvz_MVcBeNP4NJtEtq.woff2',
  '/fonts/QGYvz_MVcBeNP4NJuktqQ4E.woff2',
  '/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa0ZL7SUc.woff2',
  '/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2',
  '/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1pL7SUc.woff2',
  '/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa25L7SUc.woff2',
  '/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2JL7SUc.woff2',
  '/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2ZL7SUc.woff2',
  '/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2pL7SUc.woff2',
  '/fonts/FwZY7-Qmy14u9lezJ-6D6MmTpA.woff2',
  '/fonts/FwZY7-Qmy14u9lezJ-6H6Mk.woff2',
  '/fonts/FwZY7-Qmy14u9lezJ-6I6MmTpA.woff2',
  '/fonts/FwZY7-Qmy14u9lezJ-6J6MmTpA.woff2',
  '/fonts/FwZY7-Qmy14u9lezJ-6K6MmTpA.woff2',
  '/fonts/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPx3cwhsk.woff2',
  '/fonts/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPx7cwhsk.woff2',
  '/fonts/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPxDcwg.woff2',
  '/fonts/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPxPcwhsk.woff2',
  '/fonts/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPxTcwhsk.woff2',
  '/fonts/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPx_cwhsk.woff2',
];

// Install Event - Pre-cache the main shell files
self.addEventListener('install', (event) => {
  // Cast to ExtendableEvent to avoid type clashes in compilation if checked
  const extendableEvent = event;
  extendableEvent.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Pre-caching offline shell');
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate Event - Clean up old caches
self.addEventListener('activate', (event) => {
  const extendableEvent = event;
  extendableEvent.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('[Service Worker] Clearing old cache:', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event - Dynamic cache with intelligent strategy
self.addEventListener('fetch', (event) => {
  const fetchEvent = event;
  const requestUrl = new URL(fetchEvent.request.url);

  // Only handle same-origin requests (internal assets)
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  // Exclude non-GET requests
  if (fetchEvent.request.method !== 'GET') {
    return;
  }

  // Strategy: Cache-First for static assets, Network-First for HTML/routing
  const isStaticAsset = requestUrl.pathname.includes('/assets/') || 
                        requestUrl.pathname.endsWith('.png') || 
                        requestUrl.pathname.endsWith('.svg') || 
                        requestUrl.pathname.endsWith('.woff2');

  if (isStaticAsset) {
    // Cache-First (Fast loading for static, hashed resources)
    fetchEvent.respondWith(
      caches.match(fetchEvent.request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(fetchEvent.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const cacheCopy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(fetchEvent.request, cacheCopy);
            });
          }
          return networkResponse;
        }).catch(() => {
          return new Response('Offline asset not cached.', { status: 503 });
        });
      })
    );
  } else {
    // Network-First (Ensure we get the latest HTML/configs if online, fallback to cache if offline)
    fetchEvent.respondWith(
      fetch(fetchEvent.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const cacheCopy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(fetchEvent.request, cacheCopy);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // Fallback to cache
          return caches.match(fetchEvent.request).then((cachedResponse) => {
            if (cachedResponse) {
              return cachedResponse;
            }
            // Fallback for navigation requests (HTML pages) -> serve root /index.html
            if (fetchEvent.request.mode === 'navigate') {
              return caches.match('/');
            }
            return new Response('Offline content not available.', { status: 503 });
          });
        })
    );
  }
});
