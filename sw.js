// BarberPOS Service Worker v2.4.1
// Offline-first PWA caching strategy

const CACHE_NAME = 'barberpos-v2.4.1';
const OFFLINE_CACHE = 'barberpos-offline';

// Core assets to cache on install
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=DM+Sans:wght@300;400;500&display=swap'
];

// Install: precache core assets
self.addEventListener('install', event => {
  console.log('[SW] Installing BarberPOS v2.4.1');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  console.log('[SW] Activating BarberPOS v2.4.1');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== OFFLINE_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: Cache-first for assets, Network-first for API
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls — network first, queue offline
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstWithQueue(event.request));
    return;
  }

  // Fonts & static assets — cache first
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // App shell — stale while revalidate
  event.respondWith(staleWhileRevalidate(event.request));
});

// ─── Strategies ────────────────────────────────────────────

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const networkFetch = fetch(request).then(response => {
    if (response.ok) {
      caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
    }
    return response;
  }).catch(() => null);
  return cached || await networkFetch || new Response('Offline', { status: 503 });
}

async function networkFirstWithQueue(request) {
  try {
    const response = await fetch(request.clone());
    return response;
  } catch {
    // Queue for sync when back online
    if (request.method !== 'GET') {
      await queueRequest(request.clone());
    }
    // Return cached or offline response
    const cached = await caches.match(request);
    return cached || new Response(
      JSON.stringify({ error: 'offline', queued: request.method !== 'GET' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ─── Offline Queue ──────────────────────────────────────────
const QUEUE_DB_NAME = 'barberpos-queue';

async function queueRequest(request) {
  try {
    const body = await request.text();
    const queued = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
      timestamp: Date.now()
    };
    // Store in IndexedDB for sync
    const db = await openQueueDB();
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').add(queued);
    await tx.complete;
    console.log('[SW] Request queued for sync:', request.url);
    self.registration.sync?.register('sync-invoices').catch(() => {});
  } catch (e) {
    console.warn('[SW] Failed to queue request:', e);
  }
}

async function openQueueDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(QUEUE_DB_NAME, 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

// ─── Background Sync ────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-invoices') {
    event.waitUntil(syncQueuedRequests());
  }
});

async function syncQueuedRequests() {
  try {
    const db = await openQueueDB();
    const tx = db.transaction('queue', 'readwrite');
    const store = tx.objectStore('queue');
    const items = await new Promise((res, rej) => {
      const req = store.getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = rej;
    });

    for (const item of items) {
      try {
        await fetch(item.url, {
          method: item.method,
          headers: item.headers,
          body: item.method !== 'GET' ? item.body : undefined
        });
        store.delete(item.id);
        console.log('[SW] Synced queued request:', item.url);
      } catch {
        console.log('[SW] Still offline, keeping in queue:', item.url);
      }
    }
  } catch (e) {
    console.warn('[SW] Sync failed:', e);
  }
}

// ─── Push Notifications ─────────────────────────────────────
self.addEventListener('push', event => {
  const data = event.data?.json() || { title: 'BarberPOS', body: 'New notification' };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      vibrate: [200, 100, 200],
      data: data.url || '/',
      actions: [
        { action: 'view', title: 'View' },
        { action: 'dismiss', title: 'Dismiss' }
      ]
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action !== 'dismiss') {
    event.waitUntil(clients.openWindow(event.notification.data || '/'));
  }
});

console.log('[SW] BarberPOS Service Worker loaded');
