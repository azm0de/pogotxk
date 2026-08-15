/**
 * Checks for the event model shared by the home page and `/events`.
 *
 * Covers global-event normalisation (upstream ScrapedDuck rows are messy and
 * spelled inconsistently), the live/ongoing/upcoming/past grouping a raid hour
 * depends on, attribution, and the meetup-to-event mapping including UID
 * stability across a rename or reschedule.
 *
 *   npx tsx scripts/test-events.ts
 */

import {
  allDayEndExclusive,
  groupEvents,
  normalizeGameEvents,
  readAttribution,
  type CalendarEvent,
} from '../src/lib/events';
import {
  describeRecurrence,
  markdownToText,
  meetupToCalendarEvent,
  type Meetup,
} from '../src/lib/db/meetups';

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  ${label}${
      ok ? '' : `\n         got      ${JSON.stringify(actual)}\n         expected ${JSON.stringify(expected)}`
    }`,
  );
  if (!ok) failures++;
}

function ok(label: string, condition: boolean, detail = ''): void {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${label}${condition ? '' : `\n         ${detail}`}`);
  if (!condition) failures++;
}

const BASE = new URL('https://pokemontxk.com');
const NOW = new Date('2026-08-05T12:00:00Z');

/** The one imported meetup, as the read model hands it over. */
const meetup: Meetup = {
  id: 1,
  slug: 'imported-next-meetup',
  title: 'Azelf Raid Hour',
  descriptionMd: 'Meet at the **pavilion**. See [the map](https://pokemontxk.com/map).',
  startsAt: '2026-08-05T23:00:00Z',
  endsAt: '2026-08-06T00:00:00Z',
  tz: 'America/Chicago',
  poiId: 104,
  poiName: 'Campsite - Genuine',
  poiSlug: 'campsite-genuine',
  poiLat: 33.4569,
  poiLng: -94.0712,
  locationText: 'Campsite - Genuine',
  campfireUrl: null,
  recurrenceRule: null,
  status: 'published',
  updatedAt: '2026-08-01T10:30:00Z',
  heroKey: null,
  heroAlt: null,
};

/* ------------------------------------------------------------ meetup event -- */

console.log('\n== meetup -> CalendarEvent ==');
const event = meetupToCalendarEvent(meetup, BASE);
check('UID', event.uid, 'meetup-1@pokemontxk.com');
check('start', event.start, '2026-08-05T23:00:00Z');
check('location falls back to the POI name', event.location, 'Campsite - Genuine');
check('GEO carries the POI coordinates', event.geo, { lat: 33.4569, lng: -94.0712 });
ok('description carries the map deep link', Boolean(event.description?.includes('/map?poi=campsite-genuine')));
ok('markdown emphasis is stripped from the description', !event.description?.includes('**'));

/* ---------------------------------------------------------- UID stability -- */

console.log('\n== UID stability ==');
const renamed = meetupToCalendarEvent(
  { ...meetup, title: 'Azelf Raid Hour (moved)', slug: 'azelf-raid-hour-moved' },
  BASE,
);
check('a rename does not change the UID', renamed.uid, event.uid);

const rescheduled = meetupToCalendarEvent(
  { ...meetup, startsAt: '2026-08-12T23:00:00Z', updatedAt: '2026-08-06T09:00:00Z' },
  BASE,
);
check('a reschedule does not change the UID', rescheduled.uid, event.uid);

/* --------------------------------------------------------- cancellation -- */

console.log('\n== cancelled meetups ==');
const cancelled = meetupToCalendarEvent({ ...meetup, status: 'cancelled' }, BASE);
check('keeps its UID so a saved link still resolves', cancelled.uid, event.uid);
check('carries CANCELLED status', cancelled.status, 'CANCELLED');
ok('the summary says so', cancelled.summary.startsWith('CANCELLED:'));

/* ------------------------------------------------------------- all-day -- */

console.log('\n== all-day events ==');
const allDay: CalendarEvent = {
  uid: 'gofest@pokemontxk.com',
  summary: 'Go Fest',
  start: '2026-08-22T00:00:00.000Z',
  end: '2026-08-23T23:59:59.000Z',
  allDay: true,
  source: 'global',
};
// The event runs through the 23rd, so the exclusive end is the 24th at midnight.
check(
  'exclusive end rounds up to the following midnight',
  new Date(allDayEndExclusive(allDay)).toISOString(),
  '2026-08-24T00:00:00.000Z',
);

/* ------------------------------------------------ global event adapter -- */

console.log('\n== global event normalisation ==');
check('a non-array payload yields nothing', normalizeGameEvents({ nope: true }), []);
check('null yields nothing', normalizeGameEvents(null), []);

const scraped = normalizeGameEvents([
  {
    eventID: 'community-day-august-2026',
    name: 'Community Day: Litten',
    eventType: 'community-day',
    heading: 'Community Day',
    link: 'https://leekduck.com/events/community-day-august-2026/',
    image: 'https://example.test/cd.jpg',
    // ScrapedDuck publishes "local time" events as a naive wall clock.
    start: '2026-08-15T14:00:00',
    end: '2026-08-15T17:00:00',
  },
  { name: 'Missing a start time' },
  { start: '2026-09-01T10:00:00Z' },
]);

check('drops rows with no name or no start', scraped.length, 1);
check('UID is derived from the upstream id', scraped[0]!.uid, 'game-community-day-august-2026@pokemontxk.com');
// 2 PM Central on 15 Aug 2026 is CDT, i.e. 19:00 UTC.
check('naive wall clock resolves against Central', scraped[0]!.start, '2026-08-15T19:00:00.000Z');
check('and so does the end', scraped[0]!.end, '2026-08-15T22:00:00.000Z');
check('heading is carried through', scraped[0]!.heading, 'Community Day');
check('source is marked global', scraped[0]!.source, 'global');

check(
  'an {events:[...]} envelope works too',
  normalizeGameEvents({ events: [{ name: 'Raid Day', start: '2026-08-15T14:00:00Z' }] }).length,
  1,
);
check(
  'an explicit offset is respected rather than re-zoned',
  normalizeGameEvents([{ name: 'X', start: '2026-08-15T14:00:00-04:00' }])[0]!.start,
  '2026-08-15T18:00:00.000Z',
);
check(
  'a date-only value becomes an all-day event',
  normalizeGameEvents([{ name: 'X', start: '2026-08-15' }])[0]!.allDay,
  true,
);
check(
  'epoch seconds are understood',
  normalizeGameEvents([{ name: 'X', start: 1786000000 }])[0]!.start,
  new Date(1786000000_000).toISOString(),
);

const twice = [{ name: 'Same Event', start: '2026-08-15T14:00:00Z' }];
check(
  'the same upstream row yields the same UID on every refresh',
  normalizeGameEvents(twice)[0]!.uid,
  normalizeGameEvents(twice)[0]!.uid,
);
check(
  'and the ids stay collision-free without an upstream id',
  new Set(
    normalizeGameEvents([
      { name: 'A', start: '2026-08-15T14:00:00Z' },
      { name: 'B', start: '2026-08-15T14:00:00Z' },
    ]).map((e) => e.uid),
  ).size,
  2,
);

/* ------------------------------------------------------------- grouping -- */

console.log('\n== grouping ==');

function stub(uid: string, start: string, end: string | null): CalendarEvent {
  return { uid, summary: uid, start, end, source: 'global' };
}

const groups = groupEvents(
  [
    stub('finished', '2026-08-05T09:00:00Z', '2026-08-05T10:00:00Z'),
    stub('raid-hour-now', '2026-08-05T11:30:00Z', '2026-08-05T12:30:00Z'),
    stub('season', '2026-06-02T15:00:00Z', '2026-09-08T15:00:00Z'),
    stub('later-today', '2026-08-05T23:00:00Z', null),
    stub('next-week', '2026-08-12T23:00:00Z', null),
  ],
  NOW,
);

check('a finished event is past', groups.past.map((e) => e.uid), ['finished']);
check('an hour-long event in progress is live', groups.live.map((e) => e.uid), ['raid-hour-now']);
// The whole point of the split: a three-month season must not bury the raid hour.
check('a three-month season is ongoing, not live', groups.ongoing.map((e) => e.uid), ['season']);
check('future events are upcoming, soonest first', groups.upcoming.map((e) => e.uid), [
  'later-today',
  'next-week',
]);

check(
  'an event with no end runs for the default hour',
  groupEvents([stub('untimed', '2026-08-05T11:30:00Z', null)], NOW).live.length,
  1,
);
check(
  'and is past once that hour is up',
  groupEvents([stub('untimed', '2026-08-05T10:30:00Z', null)], NOW).past.length,
  1,
);
check(
  'exactly 24h in progress still counts as live',
  groupEvents([stub('day', '2026-08-05T00:00:00Z', '2026-08-06T00:00:00Z')], NOW).live.length,
  1,
);
check(
  'a minute past 24h is ongoing',
  groupEvents([stub('day+', '2026-08-05T00:00:00Z', '2026-08-06T00:01:00Z')], NOW).ongoing.length,
  1,
);
check('unparseable dates are dropped, not crashed on', groupEvents([stub('bad', 'nope', null)], NOW), {
  live: [],
  ongoing: [],
  upcoming: [],
  past: [],
});

/* ---------------------------------------------------------- attribution -- */

console.log('\n== attribution ==');
check('absent when the payload has none', readAttribution({ data: [] }), null);
check(
  'read from the ScrapedDuck envelope',
  readAttribution({
    attribution: {
      scraper: 'ScrapedDuck',
      scraperUrl: 'https://github.com/bigfoott/ScrapedDuck',
      source: 'Leek Duck',
      sourceUrl: 'https://leekduck.com',
    },
  }),
  {
    source: 'Leek Duck',
    sourceUrl: 'https://leekduck.com',
    scraper: 'ScrapedDuck',
    scraperUrl: 'https://github.com/bigfoott/ScrapedDuck',
  },
);

/* ---------------------------------------------------------- meetup text -- */

console.log('\n== meetup helpers ==');
check('markdown link becomes text plus URL', markdownToText('[map](https://x.test)'), 'map (https://x.test)');
check('headings lose their hashes', markdownToText('## Raid hour'), 'Raid hour');
check('bold loses its asterisks', markdownToText('the **pavilion**'), 'the pavilion');
check('empty markdown is null', markdownToText('   '), null);
check('null passes through', markdownToText(null), null);

check('no rule, no badge', describeRecurrence(null), null);
check('weekly', describeRecurrence('FREQ=WEEKLY'), 'Weekly');
check('weekly on a day', describeRecurrence('FREQ=WEEKLY;BYDAY=WE'), 'Weekly on Wed');
check('with the RRULE: prefix', describeRecurrence('RRULE:FREQ=WEEKLY;BYDAY=WE,SA'), 'Weekly on Wed, Sat');
check('an interval', describeRecurrence('FREQ=WEEKLY;INTERVAL=2'), 'Every 2 weeks');
check('an ordinal BYDAY', describeRecurrence('FREQ=MONTHLY;BYDAY=2WE'), 'Monthly on Wed');
check('an unparseable rule still says something', describeRecurrence('nonsense'), 'Repeats');

const recurring = meetupToCalendarEvent({ ...meetup, recurrenceRule: 'FREQ=WEEKLY;BYDAY=WE' }, BASE);
check('the rrule reaches the event verbatim', recurring.rrule, 'FREQ=WEEKLY;BYDAY=WE');

console.log(failures ? `\nFAILED (${failures})\n` : '\nAll event-model checks passed.\n');
process.exit(failures ? 1 : 0);
