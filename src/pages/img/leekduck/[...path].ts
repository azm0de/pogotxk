/**
 * Caching image proxy for Leek Duck event artwork.
 *
 * Why this exists at all, and why it takes a path rather than a URL, is in
 * src/lib/game-image.ts. The short version: it is their bandwidth, and a route
 * that accepts an arbitrary URL is an open proxy.
 *
 *   /img/leekduck/assets/img/events/foo.jpg
 *     -> https://cdn.leekduck.com/assets/img/events/foo.jpg
 */

import type { APIContext } from 'astro';
import { isRenderableImage, leekduckPath } from '~/lib/game-image';

export const prerender = false;

/**
 * A week at the edge, a day in the browser.
 *
 * Upstream filenames carry the event slug, so a given URL's bytes do not
 * change; the risk of a long TTL is a stale *replacement*, not a wrong image.
 * `stale-while-revalidate` means a CDN hiccup serves the old copy instead of a
 * broken one, which is the whole point of not hotlinking.
 */
const CACHE_CONTROL = 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800';

/** Upstream is a static CDN; anything slower than this is not coming. */
const TIMEOUT_MS = 6000;

function fail(status: number): Response {
  return new Response(null, {
    status,
    // Negative caching, so a bad path cannot become a hot loop against upstream.
    headers: { 'cache-control': 'public, max-age=300' },
  });
}

export async function GET({ params, request }: APIContext): Promise<Response> {
  const upstream = leekduckPath(params.path ?? '');
  if (!upstream) return fail(400);

  // `caches.default` is a Workers extension; the lib.dom CacheStorage type
  // Astro pulls in does not declare it.
  const cache = (caches as CacheStorage & { default: Cache }).default;
  // Key on our own request URL, so the cached entry is scoped to this route.
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });

  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let res: Response;
  try {
    res = await fetch(upstream.toString(), {
      headers: {
        accept: 'image/avif,image/webp,image/jpeg,image/png,*/*;q=0.8',
        // Identify ourselves rather than arriving as an anonymous scraper.
        'user-agent': 'pogotxk/1.0 (+https://pogotxk.gnomelabz.workers.dev)',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return fail(504);
  }

  if (!res.ok) return fail(res.status === 404 ? 404 : 502);

  const contentType = res.headers.get('content-type');
  // Upstream serving an HTML error page with a 200 must not become an <img>.
  if (!isRenderableImage(contentType)) return fail(502);

  const body = await res.arrayBuffer();

  const out = new Response(body, {
    status: 200,
    headers: {
      'content-type': contentType as string,
      'cache-control': CACHE_CONTROL,
      'content-length': String(body.byteLength),
      // The bytes are Leek Duck's. Machine-readable credit travels with them,
      // alongside the visible attribution the pages already carry.
      'x-source': 'https://leekduck.com',
      'x-content-type-options': 'nosniff',
    },
  });

  // Cache the response we actually send, not the upstream one.
  await cache.put(cacheKey, out.clone());
  return out;
}
