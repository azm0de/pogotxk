/**
 * Timezone conversion checks, including the DST boundaries that would otherwise
 * put meetup times an hour out for half the year.
 *
 *   npx tsx scripts/test-time.ts
 */

import {
  DEFAULT_TZ,
  formatInZone,
  isRealLocalDateTime,
  isValidTimeZone,
  safeZone,
  utcToZoned,
  zonedToUtc,
} from '../src/lib/time';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `\n         got      ${actual}\n         expected ${expected}`}`);
  if (!ok) failures++;
}

console.log('\n== Central Daylight Time (summer, UTC-5) ==');
// The legacy meetup.js said "Wednesday August 5th, 6 PM - 7 PM CST" — which is
// really CDT in August, i.e. 23:00 UTC.
check('6 PM Aug 5 -> 23:00Z', zonedToUtc('2026-08-05T18:00'), '2026-08-05T23:00:00Z');
check('midnight Jul 1 -> 05:00Z', zonedToUtc('2026-07-01T00:00'), '2026-07-01T05:00:00Z');

console.log('\n== Central Standard Time (winter, UTC-6) ==');
check('6 PM Jan 15 -> 00:00Z next day', zonedToUtc('2026-01-15T18:00'), '2026-01-16T00:00:00Z');
check('noon Dec 25 -> 18:00Z', zonedToUtc('2026-12-25T12:00'), '2026-12-25T18:00:00Z');

console.log('\n== DST transitions ==');
// US DST 2026: forward Sun Mar 8, back Sun Nov 1.
check('day before spring forward', zonedToUtc('2026-03-07T12:00'), '2026-03-07T18:00:00Z');
check('day after spring forward', zonedToUtc('2026-03-09T12:00'), '2026-03-09T17:00:00Z');
check('day before fall back', zonedToUtc('2026-10-31T12:00'), '2026-10-31T17:00:00Z');
check('day after fall back', zonedToUtc('2026-11-02T12:00'), '2026-11-02T18:00:00Z');

console.log('\n== round trip ==');
for (const wall of ['2026-08-05T18:00', '2026-01-15T09:30', '2026-03-09T12:00', '2026-11-02T12:00']) {
  check(`${wall} survives round trip`, utcToZoned(zonedToUtc(wall)), wall);
}

console.log('\n== other zones ==');
check('UTC is a no-op', zonedToUtc('2026-08-05T18:00', 'UTC'), '2026-08-05T18:00:00Z');
check('Tokyo is UTC+9 year-round', zonedToUtc('2026-08-05T18:00', 'Asia/Tokyo'), '2026-08-05T09:00:00Z');

console.log('\n== display ==');
const aug = formatInZone('2026-08-05T23:00:00Z');
const jan = formatInZone('2026-01-16T00:00:00Z');
console.log(`  August  -> ${aug}`);
console.log(`  January -> ${jan}`);
check('August shows CDT', aug.includes('CDT'), true);
check('January shows CST', jan.includes('CST'), true);
check('August shows 6:00 PM', aug.includes('6:00 PM'), true);
check('January shows 6:00 PM', jan.includes('6:00 PM'), true);

console.log('\n== zone validation (admin audit, 2026-10, B-01) ==');
check('America/Chicago is a zone', isValidTimeZone('America/Chicago'), true);
check('UTC is a zone', isValidTimeZone('UTC'), true);
check('Asia/Tokyo is a zone', isValidTimeZone('Asia/Tokyo'), true);
check('Bad/Zone is not', isValidTimeZone('Bad/Zone'), false);
check('an empty string is not', isValidTimeZone(''), false);
check('whitespace is not', isValidTimeZone('   '), false);
check('a number is not', isValidTimeZone(5), false);
check('null is not', isValidTimeZone(null), false);
check('asking twice gives the same answer', isValidTimeZone('Bad/Zone'), false);
check('safeZone keeps a real zone', safeZone('Asia/Tokyo'), 'Asia/Tokyo');
check('safeZone falls back to Central', safeZone('Bad/Zone'), DEFAULT_TZ);

// The renderers must survive a stored bad zone rather than throw.
let rendered = '';
let threw = false;
try {
  rendered = formatInZone('2026-08-05T23:00:00Z', 'Bad/Zone');
} catch {
  threw = true;
}
check('formatInZone does not throw on a bad zone', threw, false);
check('…and renders it in Central', rendered.includes('6:00 PM CDT'), true);
check(
  'utcToZoned falls back to Central',
  utcToZoned('2026-08-05T23:00:00Z', 'Bad/Zone'),
  '2026-08-05T18:00',
);

let writeThrew = false;
try {
  zonedToUtc('2026-08-05T18:00', 'Bad/Zone');
} catch {
  writeThrew = true;
}
check('zonedToUtc refuses a bad zone (the write path)', writeThrew, true);

console.log('\n== calendar validation (admin audit, 2026-10, B-13) ==');
check('a real date', isRealLocalDateTime('2026-02-28T18:00'), true);
check('with seconds', isRealLocalDateTime('2026-02-28T18:00:30'), true);
check('a leap day in a leap year', isRealLocalDateTime('2028-02-29T18:00'), true);
check('Feb 30 is not', isRealLocalDateTime('2026-02-30T18:00'), false);
check('Feb 29 in a common year is not', isRealLocalDateTime('2026-02-29T18:00'), false);
check('Apr 31 is not', isRealLocalDateTime('2026-04-31T18:00'), false);
check('month 13 is not', isRealLocalDateTime('2026-13-01T18:00'), false);
check('day 00 is not', isRealLocalDateTime('2026-01-00T18:00'), false);
check('hour 24 is not', isRealLocalDateTime('2026-01-01T24:00'), false);
check('minute 60 is not', isRealLocalDateTime('2026-01-01T18:60'), false);
check('second 60 is not', isRealLocalDateTime('2026-01-01T18:00:60'), false);
check('a date with no time is not', isRealLocalDateTime('2026-01-01'), false);
check('a trailing Z is not', isRealLocalDateTime('2026-01-01T18:00Z'), false);

let rolled = false;
try {
  zonedToUtc('2026-02-30T18:00');
} catch {
  rolled = true;
}
check('zonedToUtc refuses Feb 30 instead of rolling into March', rolled, true);

console.log(failures ? `\nFAILED (${failures})\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
