/**
 * Service worker for PoGo TXK.
 *
 * Deliberately conservative. This is a map you use standing in a park on a bad
 * signal, so the goal is "the shell opens and tells you the truth", not "cache
 * everything and risk showing a stale raid".
 *
 * Rules:
 *   * App shell and icons: cache-first. They change only on deploy.
 *   * Map tiles: cache-first with a bounded cache. The park does not move.
 *   * Anything under /api/: network-only. A cached flare board is worse than
 *     no flare board — it would show a raid that ended twenty minutes ago.
 *   * Navigations: network-first, falling back to the cached shell offline.
 */

const VERSION = 'v2';
const SHELL_CACHE = `shell-${VERSION}`;
const TILE_CACHE = `tiles-${VERSION}`;

/**
 * Trailing slash is load-bearing. Prerendered pages are served as static assets
 * and `/offline` 307s to `/offline/`. Cache.put() rejects a redirected
 * response, and cache.add() is fetch-then-put — so requesting the unslashed
 * form makes the install silently fail to cache the one page whose entire job
 * is to work when nothing else does.
 */
const OFFLINE_URL = '/offline/';

/** Enough to open the app and explain itself; not the whole site. */
const SHELL_ASSETS = [
  OFFLINE_URL,
  '/icons/icon-192.png',
  '/icons/apple-touch-icon.png',
  '/favicon.svg',
  '/site.webmanifest',
];

/** Roughly a few zoom levels over one park. Old entries are evicted FIFO. */
const MAX_TILES = 400;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // addAll is atomic: one 404 would leave the shell uncached entirely, so
      // each asset is added independently.
      .then((cache) => Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== TILE_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** Keep a cache from growing without bound, oldest first. */
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((key) => cache.delete(key)));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never serve live data from cache. Flares, the map payload and the session
  // are all time-sensitive; a stale answer here is actively misleading.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  // Map tiles — immutable for our purposes, and the expensive thing to refetch.
  if (/basemaps\.cartocdn\.com|tile\.openstreetmap\.org/.test(url.hostname)) {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        try {
          const res = await fetch(request);
          if (res.ok) {
            await cache.put(request, res.clone());
            void trimCache(TILE_CACHE, MAX_TILES);
          }
          return res;
        } catch {
          // No tile is better than a broken image; Leaflet handles the gap.
          return new Response('', { status: 504 });
        }
      }),
    );
    return;
  }

  // Hashed build assets and our own icons never change under the same URL.
  if (
    url.origin === self.location.origin &&
    (url.pathname.startsWith('/_astro/') ||
      url.pathname.startsWith('/icons/') ||
      url.pathname.startsWith('/media/'))
  ) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok) await cache.put(request, res.clone());
        return res;
      }),
    );
    return;
  }

  // Page navigations: always try the network so content is current, and fall
  // back to the offline page only when genuinely offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match(OFFLINE_URL)) ?? new Response('Offline', { status: 503 });
      }),
    );
  }
});

/**
 * Web push. The payload is a JSON body posted by the Worker; anything
 * unparseable still shows a generic notification rather than nothing, because a
 * silent failure here looks identical to "nobody flared".
 */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title || 'PoGo TXK';
  const options = {
    body: payload.body || 'Something is happening at the park.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: payload.tag || 'pogotxk',
    // Replace rather than stack: three notifications for the same raid is noise.
    renotify: Boolean(payload.tag),
    data: { url: payload.url || '/live' },
    vibrate: [80, 40, 80],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/live';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Reuse an open tab if there is one, rather than piling up windows.
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate?.(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
