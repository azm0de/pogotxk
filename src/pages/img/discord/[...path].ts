/**
 * Caching image proxy for Discord event cover art.
 *
 * Why this exists, and why it takes a path rather than a URL, is in
 * src/lib/discord-image.ts. The short version: pointing an `<img>` at
 * `cdn.discordapp.com` sets a `__cf_bm` third-party cookie in the visitor's
 * browser, and a route that accepts an arbitrary URL is an open proxy.
 *
 *   /img/discord/guild-events/<event id>/<hash>.webp?size=512
 *     -> https://cdn.discordapp.com/guild-events/<event id>/<hash>.webp?size=512
 *
 * A sibling of src/pages/img/leekduck/[...path].ts, deliberately kept as its own
 * route rather than generalised into one: each upstream gets its own prefix and
 * its own allowlist, so widening one can never silently widen the other.
 */

import type { APIContext } from 'astro';
import { discordUpstream } from '~/lib/discord-image';
import { isRenderableImage } from '~/lib/game-image';

export const prerender = false;

/**
 * A week at the edge, a day in the browser.
 *
 * The hash in the path is content-derived — Discord mints a new one when an
 * organiser changes the cover — so a given URL's bytes never change and the
 * risk of a long TTL is a stale *replacement*, not a wrong image.
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
  const requestUrl = new URL(request.url);
  const upstream = discordUpstream(params.path ?? '', requestUrl.searchParams.get('size'));
  if (!upstream) return fail(400);

  // `caches.default` is a Workers extension; the lib.dom CacheStorage type
  // Astro pulls in does not declare it.
  const cache = (caches as CacheStorage & { default: Cache }).default;
  // Key on our own request URL, so the cached entry is scoped to this route —
  // and so two sizes of the same art are two entries rather than one.
  const cacheKey = new Request(requestUrl.toString(), { method: 'GET' });

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

  // A Response built from scratch, which is the point of the whole exercise:
  // upstream's `Set-Cookie` is not among the headers copied, because none are.
  const out = new Response(body, {
    status: 200,
    headers: {
      'content-type': contentType as string,
      'cache-control': CACHE_CONTROL,
      'content-length': String(body.byteLength),
      'x-source': 'https://discord.com',
      'x-content-type-options': 'nosniff',
    },
  });

  // Cache the response we actually send, not the upstream one.
  await cache.put(cacheKey, out.clone());
  return out;
}
