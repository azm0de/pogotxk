/**
 * Service worker for PoGo TXK.
 *
 * Deliberately conservative. This is a map you use standing in a park on a bad
 * signal, so the goal is "the shell opens and tells you the truth", not "cache
 * everything and risk showing a stale raid".
 *
 * Rules:
 *   * App shell, icons, build assets and media: cache-first. They change only
 *     on deploy, and media keys are never rewritten.
 *   * Anything asked for in byte ranges: not touched at all. The basemap is one
 *     pmtiles file read sixteen bytes at a time, and video is probed the same
 *     way on iOS. The Cache API refuses to store a 206 — `cache.put` rejects —
 *     and a rejection inside `respondWith` fails the whole request, which is
 *     how the park map stopped loading for everyone the worker controlled.
 *     The browser's own HTTP cache handles ranges, and /media already sends a
 *     year of `immutable`.
 *   * Anything under /api/: network-only. A cached flare board is worse than
 *     no flare board — it would show a raid that ended twenty minutes ago.
 *   * Navigations: network-first, falling back to the cached shell offline.
 */

// v3: ranged requests bypass the worker, and the raster tile cache is gone with
// the raster tiles. Bumping the version drops the v2 shell cache on activate.
const VERSION = 'v3';
const SHELL_CACHE = `shell-${VERSION}`;

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
        Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  /*
   * A byte-range request is the browser's business, not the worker's.
   *
   * The basemap (`/media/basemap/*.pmtiles`) is a single file that
   * protomaps-leaflet reads in ranges: a 16-byte header, then a slice per
   * tile. iOS probes video the same way before it will play it. Two things go
   * wrong the moment a worker answers these from a cache: `cache.put` of a 206
   * rejects ("partial response is unsupported"), and inside `respondWith` that
   * rejection fails the request outright — which is exactly how the park map
   * printed "not loading" for everyone the worker controlled while the server
   * was answering 206 in 200ms. And a whole 200 that *was* stored would be
   * handed back to a request for sixteen bytes. So: step aside. The response
   * carries a year of `immutable`, and the browser's HTTP cache does ranges.
   */
  if (request.headers.has('range')) return;

  const url = new URL(request.url);

  // Never serve live data from cache. Flares, the map payload and the session
  // are all time-sensitive; a stale answer here is actively misleading.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  // Hashed build assets, our own icons and media never change under the same
  // URL. (The raster tile cache that used to sit here went with the raster
  // tiles; the vector basemap is the ranged file above.)
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
        // Only a complete 200 is worth keeping — `ok` is true for a 206 too —
        // and a cache that will not take it must never fail the request that
        // fetched it: storage full, opaque, partial, whatever the reason, the
        // reader gets the response and the cache goes without.
        if (res.status === 200) {
          try {
            await cache.put(request, res.clone());
          } catch {
            /* served uncached */
          }
        }
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
