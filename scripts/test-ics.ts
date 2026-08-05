/**
 * RFC 5545 conformance checks for the calendar feeds.
 *
 * A calendar subscription is fire-and-forget: a bug here surfaces months later
 * as "the meetup is an hour off" or "I have four copies of raid hour", and by
 * then nobody connects it to a deploy. So the wire format is pinned here rather
 * than eyeballed — line endings, folding at 75 *octets*, TEXT escaping, UTC
 * stamps, UID stability, and the headers a subscriber's client reads.
 *
 *   npx tsx scripts/test-ics.ts
 */

import {
  buildIcs,
  escapeText,
  foldLine,
  groupEvents,
  icsEtag,
  icsResponse,
  normalizeGameEvents,
  readAttribution,
  toIcsUtc,
  unfold,
  type CalendarEvent,
} from '../src/lib/ics';
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

/* --------------------------------------------------------------- escaping -- */

console.log('\n== TEXT escaping (RFC 5545 §3.3.11) ==');
check('backslash', escapeText('a\\b'), 'a\\\\b');
check('comma', escapeText('a,b'), 'a\\,b');
check('semicolon', escapeText('a;b'), 'a\\;b');
check('newline', escapeText('a\nb'), 'a\\nb');
check('CRLF collapses to one \\n', escapeText('a\r\nb'), 'a\\nb');
check('bare CR', escapeText('a\rb'), 'a\\nb');
check('all four at once', escapeText('a\\b,c;d\ne'), 'a\\\\b\\,c\\;d\\ne');
// The classic double-escape bug: escape the backslash last and `,` becomes `\\,`.
check('backslash before comma is not double-escaped', escapeText('\\,'), '\\\\\\,');
check('colon is NOT escaped in TEXT', escapeText('a:b'), 'a:b');

/* ---------------------------------------------------------------- folding -- */

console.log('\n== line folding (75 octets) ==');
const encoder = new TextEncoder();
const shortLine = 'SUMMARY:Raid hour';
check('short lines are untouched', foldLine(shortLine), shortLine);

const long = `SUMMARY:${'x'.repeat(200)}`;
const foldedLong = long.split('\r\n');
ok(
  'every folded segment is <= 75 octets',
  foldLine(long)
    .split('\r\n')
    .every((line) => encoder.encode(line).length <= 75),
  foldedLong.map((l) => encoder.encode(l).length).join(', '),
);
ok(
  'continuation lines start with a single space',
  foldLine(long)
    .split('\r\n')
    .slice(1)
    .every((line) => line.startsWith(' ')),
);
check('unfolding restores the original line', unfold(foldLine(long)), long);

// Multi-byte input is where a naive `slice(0, 75)` quietly corrupts the feed.
const emoji = `SUMMARY:${'🎃'.repeat(60)}`;
const accents = `DESCRIPTION:${'é'.repeat(120)}`;
for (const [label, line] of [
  ['emoji (4-byte)', emoji],
  ['accents (2-byte)', accents],
] as const) {
  const folded = foldLine(line);
  ok(
    `${label} folds within 75 octets`,
    folded.split('\r\n').every((part) => encoder.encode(part).length <= 75),
  );
  check(`${label} survives the round trip`, unfold(folded), line);
  ok(`${label} contains no replacement character`, !folded.includes('�'));
}

const exactly75 = 'X'.repeat(75);
check('a line of exactly 75 octets is not folded', foldLine(exactly75), exactly75);
ok('a line of 76 octets is folded', foldLine('X'.repeat(76)).includes('\r\n'));

/* -------------------------------------------------------------- timestamps -- */

console.log('\n== UTC timestamps ==');
check('ISO instant', toIcsUtc('2026-08-05T23:00:00Z'), '20260805T230000Z');
check('milliseconds are dropped', toIcsUtc('2026-08-05T23:00:00.456Z'), '20260805T230000Z');
check('an offset is normalised to UTC', toIcsUtc('2026-08-05T18:00:00-05:00'), '20260805T230000Z');
check('Date input', toIcsUtc(new Date(Date.UTC(2026, 0, 1, 0, 0, 0))), '20260101T000000Z');
ok(
  'invalid input throws rather than emitting NaN',
  (() => {
    try {
      toIcsUtc('not a date');
      return false;
    } catch {
      return true;
    }
  })(),
);

/* ------------------------------------------------------------- the calendar -- */

console.log('\n== calendar document ==');
const event = meetupToCalendarEvent(meetup, BASE);
const ics = buildIcs(
  {
    name: 'PoGo TXK Meetups',
    description: 'Community meetups, raid hours and events.',
    refreshInterval: 'PT1H',
    source: 'https://pokemontxk.com/calendar/meetups.ics',
  },
  [event],
  NOW,
);

ok('every line ends with CRLF', /\r\n/.test(ics) && !/[^\r]\n/.test(ics), JSON.stringify(ics.slice(0, 80)));
ok('no bare CR', !/\r(?!\n)/.test(ics));
ok('the document ends with CRLF', ics.endsWith('\r\n'));
ok(
  'no line exceeds 75 octets',
  ics
    .split('\r\n')
    .every((line) => encoder.encode(line).length <= 75),
  ics
    .split('\r\n')
    .filter((line) => encoder.encode(line).length > 75)
    .join(' | '),
);

const lines = ics.split('\r\n');
check('opens with BEGIN:VCALENDAR', lines[0], 'BEGIN:VCALENDAR');
check('closes with END:VCALENDAR', lines[lines.length - 2], 'END:VCALENDAR');

for (const required of [
  'VERSION:2.0',
  'CALSCALE:GREGORIAN',
  'METHOD:PUBLISH',
  'X-WR-CALNAME:PoGo TXK Meetups',
  'X-WR-TIMEZONE:America/Chicago',
  'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
  'X-PUBLISHED-TTL:PT1H',
  'SOURCE;VALUE=URI:https://pokemontxk.com/calendar/meetups.ics',
]) {
  ok(`carries ${required}`, lines.includes(required));
}
ok('carries a PRODID', lines.some((line) => line.startsWith('PRODID:-//PoGo TXK//')));

console.log('\n== the event ==');

/**
 * Properties inside the VEVENT, not the calendar header. DESCRIPTION legally
 * appears at both levels, so an unscoped lookup silently reads the wrong one.
 */
function eventLines(document: string): string[] {
  const all = unfold(document).split('\r\n');
  return all.slice(all.indexOf('BEGIN:VEVENT'), all.indexOf('END:VEVENT') + 1);
}

const unfolded = eventLines(ics);
const prop = (name: string) => unfolded.find((line) => line.startsWith(`${name}:`)) ?? '';

check('UID', prop('UID'), 'UID:meetup-1@pokemontxk.com');
check('DTSTART', prop('DTSTART'), 'DTSTART:20260805T230000Z');
check('DTEND', prop('DTEND'), 'DTEND:20260806T000000Z');
check('SUMMARY', prop('SUMMARY'), 'SUMMARY:Azelf Raid Hour');
// The POI name has no separators to escape, but the LOCATION property must
// still exist — a meetup with no location is a meetup nobody can attend.
check('LOCATION', prop('LOCATION'), 'LOCATION:Campsite - Genuine');
check('GEO uses a semicolon separator', prop('GEO'), 'GEO:33.4569;-94.0712');
check('STATUS', prop('STATUS'), 'STATUS:CONFIRMED');
check('DTSTAMP tracks updated_at, not the clock', prop('DTSTAMP'), 'DTSTAMP:20260801T103000Z');
check('LAST-MODIFIED matches', prop('LAST-MODIFIED'), 'LAST-MODIFIED:20260801T103000Z');
ok('DESCRIPTION escapes its newlines', prop('DESCRIPTION').includes('\\n'));
ok('DESCRIPTION carries the map deep link', prop('DESCRIPTION').includes('/map?poi=campsite-genuine'));
ok('markdown emphasis is stripped', !prop('DESCRIPTION').includes('**'));

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
ok(
  'a reschedule does raise SEQUENCE',
  Number(
    unfold(buildIcs({ name: 'x' }, [rescheduled], NOW))
      .split('\r\n')
      .find((line) => line.startsWith('SEQUENCE:'))
      ?.slice(9) ?? '0',
  ) >
    Number(
      unfold(ics)
        .split('\r\n')
        .find((line) => line.startsWith('SEQUENCE:'))
        ?.slice(9) ?? '0',
    ),
);

ok(
  'serialising the same data twice is byte-identical',
  buildIcs({ name: 'PoGo TXK Meetups' }, [event], NOW) ===
    buildIcs({ name: 'PoGo TXK Meetups' }, [event], new Date('2027-01-01T00:00:00Z')),
);

/* ------------------------------------------------------ escaping in situ -- */

console.log('\n== escaping inside a real calendar ==');
const nastyEvents: CalendarEvent[] = [
  {
    uid: 'nasty-1@pokemontxk.com',
    summary: 'Raid, Hour; the \\sequel\\',
    start: '2026-08-05T23:00:00Z',
    end: '2026-08-06T00:00:00Z',
    description: 'Line one\nLine two, with a comma; and a semicolon',
    location: 'Pavilion, Spring Lake Park; Texarkana',
    categories: ['Community, Meetup', 'Raid'],
    updatedAt: '2026-08-01T10:30:00Z',
    source: 'meetup',
  },
];
const nasty = buildIcs({ name: 'Feed, with; punctuation\\here' }, nastyEvents, NOW);

const nastyLines = eventLines(nasty);
const nastyProp = (name: string) =>
  (name.startsWith('X-WR-') ? unfold(nasty).split('\r\n') : nastyLines).find((line) =>
    line.startsWith(`${name}:`),
  ) ?? '';

check('SUMMARY escapes , ; and \\', nastyProp('SUMMARY'), 'SUMMARY:Raid\\, Hour\\; the \\\\sequel\\\\');
check(
  'DESCRIPTION escapes the newline and the punctuation',
  nastyProp('DESCRIPTION'),
  'DESCRIPTION:Line one\\nLine two\\, with a comma\\; and a semicolon',
);
check(
  'LOCATION escapes the separators',
  nastyProp('LOCATION'),
  'LOCATION:Pavilion\\, Spring Lake Park\\; Texarkana',
);
check(
  'CATEGORIES escapes commas inside an item but not the list separator',
  nastyProp('CATEGORIES'),
  'CATEGORIES:Community\\, Meetup,Raid',
);
check('X-WR-CALNAME is escaped too', nastyProp('X-WR-CALNAME'), 'X-WR-CALNAME:Feed\\, with\\; punctuation\\\\here');

/* --------------------------------------------------------- cancellation -- */

console.log('\n== cancelled meetups ==');
const cancelled = meetupToCalendarEvent({ ...meetup, status: 'cancelled' }, BASE);
check('keeps its UID so subscribers see the update', cancelled.uid, event.uid);
check('carries STATUS:CANCELLED', cancelled.status, 'CANCELLED');
ok('the summary says so', cancelled.summary.startsWith('CANCELLED:'));

/* ------------------------------------------------------------- all-day -- */

console.log('\n== all-day events ==');
const allDay = buildIcs({ name: 'x' }, [
  {
    uid: 'allday-1@pokemontxk.com',
    summary: 'Go Fest',
    start: '2026-08-22T00:00:00.000Z',
    end: '2026-08-23T23:59:59.000Z',
    allDay: true,
    updatedAt: '2026-08-01T00:00:00Z',
    source: 'global',
  },
], NOW).split('\r\n');

check('DTSTART is a DATE', allDay.find((l) => l.startsWith('DTSTART')), 'DTSTART;VALUE=DATE:20260822');
// DTEND is exclusive: an event through the 23rd ends on the 24th.
check('DTEND is the exclusive next day', allDay.find((l) => l.startsWith('DTEND')), 'DTEND;VALUE=DATE:20260824');

/* ------------------------------------------------------------- response -- */

console.log('\n== HTTP response ==');
const body = buildIcs({ name: 'PoGo TXK Meetups' }, [event], NOW);
const res = icsResponse(body, { filename: 'pogotxk-meetups.ics', etag: icsEtag(body) });
check('content-type', res.headers.get('content-type'), 'text/calendar; charset=utf-8');
check(
  'content-disposition',
  res.headers.get('content-disposition'),
  'inline; filename="pogotxk-meetups.ics"',
);
ok('sets an etag', Boolean(res.headers.get('etag')));
ok('sets cache-control', (res.headers.get('cache-control') ?? '').startsWith('public, max-age='));
check('the etag is stable for identical bytes', icsEtag(body), icsEtag(body));
ok('the etag changes when the body does', icsEtag(body) !== icsEtag(`${body}X`));

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

const recurring = buildIcs({ name: 'x' }, [
  meetupToCalendarEvent({ ...meetup, recurrenceRule: 'FREQ=WEEKLY;BYDAY=WE' }, BASE),
], NOW);
ok('an RRULE reaches the calendar verbatim', recurring.includes('\r\nRRULE:FREQ=WEEKLY;BYDAY=WE\r\n'));

/* ----------------------------------------------------------- empty feed -- */

console.log('\n== empty feed ==');
const empty = buildIcs({ name: 'PoGo TXK Meetups' }, [], NOW);
ok('still a valid calendar', empty.startsWith('BEGIN:VCALENDAR\r\n') && empty.endsWith('END:VCALENDAR\r\n'));
ok('contains no VEVENT', !empty.includes('BEGIN:VEVENT'));

console.log(failures ? `\nFAILED (${failures})\n` : '\nAll ICS checks passed.\n');
process.exit(failures ? 1 : 0);
