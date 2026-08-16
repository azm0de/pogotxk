/**
 * Checks for the Discord scheduled-event mapping behind "Next meetup".
 *
 * The filtering is the part that matters. A cancelled or finished event shown as
 * "next" is the one failure here with a physical cost — somebody drives to the
 * park for a meetup that is not happening — so the status and time rules are
 * pinned rather than trusted.
 *
 *   npx tsx scripts/test-discord-events.ts
 */

import {
  mapEvents,
  nextDiscordMeetup,
  type RawScheduledEvent,
} from '../src/lib/discord-events-map';

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

const GUILD = '1249232349972004897';

function raw(over: Partial<RawScheduledEvent> = {}): RawScheduledEvent {
  return {
    id: '100',
    name: 'Community Day',
    description: 'Meet at the pavilion',
    scheduled_start_time: '2026-08-20T18:00:00Z',
    scheduled_end_time: '2026-08-20T21:00:00Z',
    status: 1,
    entity_metadata: { location: 'Spring Lake Park' },
    image: null,
    ...over,
  };
}

console.log('\n== status filtering ==');

check(
  'SCHEDULED (1) is kept',
  mapEvents([raw({ status: 1 })], GUILD).length,
  1,
);
check(
  'ACTIVE (2) is kept — an event in progress is still the one people are looking for',
  mapEvents([raw({ status: 2 })], GUILD).length,
  1,
);
check('COMPLETED (3) is dropped', mapEvents([raw({ status: 3 })], GUILD).length, 0);
check(
  'CANCELED (4) is dropped — the failure that would send someone to an empty park',
  mapEvents([raw({ status: 4 })], GUILD).length,
  0,
);

console.log('\n== malformed input ==');

check(
  'unparseable start time is dropped rather than sorted unpredictably',
  mapEvents([raw({ scheduled_start_time: 'not a date' })], GUILD).length,
  0,
);
check('empty start time is dropped', mapEvents([raw({ scheduled_start_time: '' })], GUILD).length, 0);
check(
  'empty description becomes null, not an empty string',
  mapEvents([raw({ description: '' })], GUILD)[0].descriptionMd,
  null,
);
check(
  'missing entity_metadata does not throw and yields no location',
  mapEvents([raw({ entity_metadata: null })], GUILD)[0].locationText,
  null,
);

console.log('\n== shaping ==');

const mapped = mapEvents([raw({ image: 'abc123' })], GUILD)[0];
check('start time is normalised to ISO UTC', mapped.startsAt, '2026-08-20T18:00:00.000Z');
check('location comes through', mapped.locationText, 'Spring Lake Park');
check(
  'cover art becomes a CDN url',
  mapped.imageUrl,
  'https://cdn.discordapp.com/guild-events/100/abc123.png?size=1024',
);
check('no cover art yields null', mapEvents([raw()], GUILD)[0].imageUrl, null);
check('jump link is built from the guild', mapped.url, `https://discord.com/events/${GUILD}/100`);

console.log('\n== ordering and selection ==');

const three = mapEvents(
  [
    raw({ id: '3', scheduled_start_time: '2026-09-01T18:00:00Z', scheduled_end_time: null }),
    raw({ id: '1', scheduled_start_time: '2026-08-18T18:00:00Z', scheduled_end_time: null }),
    raw({ id: '2', scheduled_start_time: '2026-08-25T18:00:00Z', scheduled_end_time: null }),
  ],
  GUILD,
);
check('sorted soonest first', three.map((e) => e.id), ['1', '2', '3']);

check(
  'next skips events that already ended',
  nextDiscordMeetup(three, '2026-08-26T00:00:00Z')?.id,
  '3',
);
check(
  'an event running right now is still "next", not skipped',
  nextDiscordMeetup(
    mapEvents([raw({ id: '9', scheduled_start_time: '2026-08-20T18:00:00Z', scheduled_end_time: '2026-08-20T21:00:00Z' })], GUILD),
    '2026-08-20T19:30:00Z',
  )?.id,
  '9',
);
check(
  'an event with no end time is past once its start has passed',
  nextDiscordMeetup(
    mapEvents([raw({ id: '9', scheduled_start_time: '2026-08-20T18:00:00Z', scheduled_end_time: null })], GUILD),
    '2026-08-20T18:00:01Z',
  ),
  null,
);
check('nothing upcoming yields null, not a throw', nextDiscordMeetup([], '2026-08-20T00:00:00Z'), null);

console.log('\n== empty is a valid answer ==');
ok(
  'an empty guild maps to an empty list without error',
  Array.isArray(mapEvents([], GUILD)) && mapEvents([], GUILD).length === 0,
  'an empty list must not be treated as an upstream failure — unlike the raid feed, a guild genuinely can have no events',
);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
