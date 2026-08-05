/**
 * Subscribable calendar feeds.
 *
 *   /calendar/meetups.ics   community meetups only
 *   /calendar/game.ics      the global Pokémon GO event calendar
 *   /calendar/all.ics       both
 *
 * These URLs are the contract: once somebody pastes one into Google Calendar it
 * is effectively permanent, so the feed names and the event UIDs must not
 * change. `game` and `all` degrade to whatever is available — if the global
 * event source is down, `all` still serves the meetups rather than erroring, on
 * the grounds that a subscriber would rather see fewer events than none.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import {
  attributionText,
  buildIcs,
  fetchGameEvents,
  icsEtag,
  icsResponse,
  type CalendarEvent,
  type CalendarMeta,
} from '~/lib/ics';
import { listPublicMeetups, meetupToCalendarEvent } from '~/lib/db/meetups';

export const prerender = false;

type Feed = 'meetups' | 'game' | 'all';

// `description` is required here, unlike on CalendarMeta: the attribution line
// is appended to it below, and appending to `undefined` would ship the literal
// string "undefined" into every subscriber's calendar.
const FEEDS: Record<Feed, Omit<CalendarMeta, 'source'> & { description: string }> = {
  meetups: {
    name: 'PoGo TXK Meetups',
    description: 'Community meetups, raid hours and events for Pokémon GO in Texarkana.',
    refreshInterval: 'PT1H',
  },
  game: {
    name: 'Pokémon GO Events',
    description: 'The global Pokémon GO event calendar, in Texarkana local time.',
    refreshInterval: 'PT6H',
  },
  all: {
    name: 'PoGo TXK — All Events',
    description:
      'Community meetups in Texarkana plus the global Pokémon GO event calendar.',
    refreshInterval: 'PT1H',
  },
};

function isFeed(value: string | undefined): value is Feed {
  return value === 'meetups' || value === 'game' || value === 'all';
}

export async function GET(ctx: APIContext): Promise<Response> {
  const feed = ctx.params.feed;
  if (!isFeed(feed)) {
    return new Response('Unknown calendar feed. Try /calendar/meetups.ics.', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const base = new URL(ctx.site ?? ctx.url.origin);

  // The two sources are independent; there is no reason to wait for D1 before
  // starting the subrequest. Origin-relative so it reaches this deployment
  // rather than production when running locally or on a preview URL.
  const [meetups, global] = await Promise.all([
    feed === 'game' ? Promise.resolve([]) : listPublicMeetups(env.DB),
    feed === 'meetups' ? Promise.resolve(null) : fetchGameEvents(new URL(ctx.url.origin)),
  ]);

  const events: CalendarEvent[] = [
    ...meetups.map((meetup) => meetupToCalendarEvent(meetup, base)),
    ...(global?.events ?? []),
  ];
  events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  // Leek Duck and ScrapedDuck ask to be credited wherever their data appears,
  // and an .ics file has exactly one place to put that.
  const credit = attributionText(global?.attribution ?? null);
  const meta = FEEDS[feed];

  const body = buildIcs(
    {
      ...meta,
      description: credit ? `${meta.description} ${credit}` : meta.description,
      source: new URL(`/calendar/${feed}.ics`, base).toString(),
    },
    events,
  );

  // Every event carries its own DTSTAMP, so identical data serialises to
  // identical bytes and a polling client gets a 304 instead of the whole file.
  const etag = icsEtag(body);
  if (ctx.request.headers.get('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { etag, 'cache-control': 'public, max-age=900, stale-while-revalidate=3600' },
    });
  }

  return icsResponse(body, { filename: `pogotxk-${feed}.ics`, etag });
}
