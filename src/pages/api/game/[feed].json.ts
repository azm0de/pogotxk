/**
 * Cached ScrapedDuck feeds.
 *
 *   /api/game/raids.json
 *   /api/game/eggs.json
 *   /api/game/research.json
 *   /api/game/events.json
 *
 * The payload is the upstream array untouched, wrapped in freshness metadata so
 * a client can tell "no raids" from "we could not reach GitHub". Attribution
 * travels with the JSON because any consumer of it inherits the same licence
 * obligation the pages have.
 */

import type { APIContext } from 'astro';
import { ApiError, handler, json } from '~/lib/api';
import { FEEDS, getFeed, isFeedName, LEEKDUCK_URL, SCRAPEDDUCK_URL } from '~/lib/scrapedduck';

export const prerender = false;

export const GET = handler(async (ctx: APIContext) => {
  const feed = ctx.params.feed;
  if (!feed || !isFeedName(feed)) {
    throw new ApiError(404, 'Unknown feed', { known: FEEDS });
  }

  // The adapter sets cfContext on every real request; the cast keeps us honest
  // about dev/test entry points that may not, since a missing waitUntil should
  // fall back to awaiting the KV write rather than throwing.
  const cfContext = ctx.locals.cfContext as ExecutionContext | undefined;

  const result = await getFeed(feed, {
    waitUntil: cfContext ? (promise) => cfContext.waitUntil(promise) : undefined,
  });

  // Nothing cached *and* upstream unreachable is the only genuine failure; a
  // stale-but-present copy is a 200 with `stale: true` so clients keep using it.
  const unavailable = result.fetchedAt === null;

  return json(
    {
      feed: result.feed,
      fetchedAt: result.fetchedAt,
      stale: result.stale,
      count: result.data.length,
      error: result.error,
      attribution: {
        scraper: 'ScrapedDuck',
        scraperUrl: SCRAPEDDUCK_URL,
        source: 'Leek Duck',
        sourceUrl: LEEKDUCK_URL,
        terms:
          'Data from Leek Duck via ScrapedDuck. Reuse requires visible credit to both, ' +
          'with no paywall and no ads.',
      },
      data: result.data,
    },
    unavailable ? 503 : 200,
    {
      'cache-control': unavailable
        ? 'no-store'
        : // Upstream itself only changes every few minutes; a short edge cache
          // plus a long SWR window keeps us well inside GitHub's rate limit.
          'public, max-age=300, stale-while-revalidate=1800',
    },
  );
});
