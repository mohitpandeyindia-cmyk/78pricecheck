const CACHE_NAME = '78pricecheck-202607202137';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './css/customer.css',
  './js/customer.js',
  './js/build-env.js',
  './js/libs/html5-qrcode.min.js',
  './js/smoke-tests.js',
  './assets/logo.png',
  './assets/brand.png',
  './assets/mascot.png',
  './assets/scan-button.png',
  './assets/scan-logo.jpg',
  './manifest.json'
];

// Install Event - Pre-cache shell assets with HTTP cache bypass
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[Service Worker] Pre-caching app shell assets (bypassing HTTP cache)');
      const requests = ASSETS_TO_CACHE.map(url => new Request(url, { cache: 'reload' }));
      return cache.addAll(requests);
    })
  );
});

// Activate Event - Clear all old legacy caches completely
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            console.log('[Service Worker] Evicting legacy cache key:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Production Update Manager: Listen for manual activation trigger
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') {
    console.log('[Service Worker] Received SKIP_WAITING trigger.');
    self.skipWaiting();
  }
});

// Fetch Event - Dynamic caching policy matching
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  // 1. Network Only for API data routes & health checks
  if (
    url.pathname.includes('/api/') || 
    url.pathname.includes('/health') ||
    url.pathname.includes('/version')
  ) {
    event.respondWith(fetch(event.request));
    return;
  }
  
  // 2. Network First for app logic, script files, CSS, manifest, and dynamic settings
  if (
    url.pathname === '/' || 
    url.pathname.endsWith('.html') || 
    url.pathname.endsWith('.js') || 
    url.pathname.endsWith('.css') || 
    url.pathname.endsWith('.json')
  ) {
    // Bypass HTTP cache to avoid caching outdated locally cached files
    const fetchRequest = new Request(event.request, { cache: 'reload' });
    event.respondWith(
      fetch(fetchRequest)
        .then(response => {
          // If request is successful, clone and put it in cache
          if (response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }
  
  // 3. Cache First for static images and typography fonts
  if (
    url.pathname.includes('/assets/') || 
    url.pathname.endsWith('.png') || 
    url.pathname.endsWith('.jpg') || 
    url.pathname.endsWith('.jpeg') || 
    url.pathname.endsWith('.woff') || 
    url.pathname.endsWith('.woff2') || 
    url.pathname.endsWith('.ttf')
  ) {
    event.respondWith(
      caches.match(event.request).then(cachedResponse => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(event.request).then(response => {
          if (response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
          }
          return response;
        });
      })
    );
    return;
  }
  
  // Fallback: match cache first, then fetch
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
