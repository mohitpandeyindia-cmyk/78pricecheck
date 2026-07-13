const CACHE_NAME = '78pricecheck-v1.0.0';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './css/customer.css',
  './js/customer.js',
  './assets/logo.png',
  './assets/mascot.png',
  './manifest.json'
];

// Install Event - Pre-cache shell assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[Service Worker] Pre-caching app shell assets');
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

// Activate Event - Clear old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            console.log('[Service Worker] Removing old cache key:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event - Handle strategy based on endpoint rules
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  // 1. Network Only for API routes (exclusions list)
  if (
    url.pathname.includes('/api/products/lookup/') || 
    url.pathname.includes('/api/admin/upload') ||
    url.pathname.includes('/api/auth/login') ||
    url.pathname.includes('/api/version')
  ) {
    event.respondWith(fetch(event.request));
    return;
  }
  
  // 2. Network First for main index.html document shell
  if (url.pathname === '/' || url.pathname.endsWith('/index.html')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }
  
  // 3. Cache First for static brand images
  if (url.pathname.includes('/assets/')) {
    event.respondWith(
      caches.match(event.request).then(cachedResponse => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(event.request).then(response => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
          return response;
        });
      })
    );
    return;
  }
  
  // 4. Stale-While-Revalidate for local JS/CSS files
  if (url.pathname.endsWith('.css') || url.pathname.endsWith('.js') || url.pathname.endsWith('.json')) {
    event.respondWith(
      caches.match(event.request).then(cachedResponse => {
        const fetchPromise = fetch(event.request).then(networkResponse => {
          if (networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
          }
          return networkResponse;
        }).catch(() => null);
        
        return cachedResponse || fetchPromise;
      })
    );
    return;
  }
  
  // Default fallback strategy
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
