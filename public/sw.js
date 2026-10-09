// SpeedyChap Service Worker Notre-tontine— v6 (PWABuilder optimisé)
const CACHE_STATIC  = 'Notre-tontine-static-v6';
const CACHE_DYNAMIC = 'Notre-tontine-dynamic-v6';
const CACHE_IMAGES  = 'Notre-tontine-images-v6';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/Notre-tontine_icon_192.png',
  '/icons/Notre-tontine_icon_512.png',
  '/screenshots/screen_home.png',
  '/screenshots/screen_services.png',
  '/screenshots/screen_dashboard.png'
];

// ── INSTALL : mise en cache des ressources statiques ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_STATIC)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE : nettoyage des anciens caches ──
self.addEventListener('activate', e => {
  const VALID = [CACHE_STATIC, CACHE_DYNAMIC, CACHE_IMAGES];
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => !VALID.includes(k))
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH : stratégies par type de ressource ──
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Ignorer les requêtes non-GET et les APIs externes
  if (request.method !== 'GET') return;
  if (!request.url.startsWith('http')) return;

  // Firebase, googleapis → réseau uniquement (pas de cache)
  if (
    url.hostname.includes('firebase') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('firestore.googleapis.com')
  ) return;

  // Fonts & CDN → cache then network (stale-while-revalidate)
  if (
    url.hostname.includes('fonts.g') ||
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('fontawesome')
  ) {
    e.respondWith(staleWhileRevalidate(request, CACHE_STATIC));
    return;
  }

  // Images → cache first (longue durée)
  if (request.destination === 'image') {
    e.respondWith(cacheFirst(request, CACHE_IMAGES));
    return;
  }

  // Pages HTML → network first avec fallback cache
  if (request.destination === 'document') {
    e.respondWith(networkFirst(request, CACHE_STATIC));
    return;
  }

  // Tout le reste → stale-while-revalidate
  e.respondWith(staleWhileRevalidate(request, CACHE_DYNAMIC));
});

// ── STRATÉGIES ──

// Cache d'abord, réseau en arrière-plan
async function staleWhileRevalidate(request, cacheName) {
  const cache    = await caches.open(cacheName);
  const cached   = await cache.match(request);
  const fetching = fetch(request).then(response => {
    if (response && response.status === 200 && response.type !== 'opaque') {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);
  return cached || await fetching || new Response('Hors ligne', { status: 503 });
}

// Cache d'abord, réseau si absent
async function cacheFirst(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Image non disponible', { status: 503 });
  }
}

// Réseau d'abord, cache en fallback
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request) || await cache.match('/');
    return cached || new Response('Hors ligne — SpeedyChap', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

// ── PUSH NOTIFICATIONS ──
self.addEventListener('push', e => {
  let data = { title: 'SpeedyChap', body: 'Vous avez une nouvelle notification.', icon: '/icons/speedychap_icon_192.png', badge: '/icons/speedychap_icon_96.png' };
  try { if (e.data) data = { ...data, ...e.data.json() }; } catch (_) {}

  e.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    data.icon,
      badge:   data.badge,
      vibrate: [200, 100, 200],
      tag:     data.tag || 'speedychap-notif',
      renotify: true,
      data:    { url: data.url || '/' }
    })
  );
});

// ── NOTIFICATION CLICK ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url === target && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});

// ── BACKGROUND SYNC (pour commandes hors ligne) ──
self.addEventListener('sync', e => {
  if (e.tag === 'sync-pending-orders') {
    e.waitUntil(syncPendingOrders());
  }
});

async function syncPendingOrders() {
  // Placeholder : synchronise les actions effectuées hors ligne
  const allClients = await clients.matchAll();
  allClients.forEach(client => {
    client.postMessage({ type: 'SYNC_COMPLETE', tag: 'sync-pending-orders' });
  });
}

// ── PERIODIC BACKGROUND SYNC ──
self.addEventListener('periodicsync', e => {
  if (e.tag === 'update-livreurs') {
    e.waitUntil(updateLivreursCache());
  }
});

async function updateLivreursCache() {
  // Placeholder : mise à jour périodique du cache livreurs
  const allClients = await clients.matchAll();
  allClients.forEach(client => {
    client.postMessage({ type: 'PERIODIC_SYNC', tag: 'update-livreurs' });
  });
}
