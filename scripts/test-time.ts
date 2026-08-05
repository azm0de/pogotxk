/**
 * Timezone conversion checks, including the DST boundaries that would otherwise
 * put meetup times an hour out for half the year.
 *
 *   npx tsx scripts/test-time.ts
 */

import { formatInZone, utcToZoned, zonedToUtc } from '../src/lib/time';

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

console.log(failures ? `\nFAILED (${failures})\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
