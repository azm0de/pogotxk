/**
 * The game-data presentation helpers.
 *
 *   npx tsx scripts/test-game-format.ts
 *
 * These were untestable until 2026-09-08 — not because they were hard to test,
 * but because they shared a file with the KV cache, and that file imports
 * `cloudflare:workers` at module scope. Ten pure functions were unreachable by
 * association. Splitting them into `lib/game-format.ts` is what makes this file
 * possible, and this file is what keeps the split honest: add a Workers import
 * to that module and this suite stops loading.
 *
 * What is worth asserting here is the behaviour under *bad upstream data*.
 * ScrapedDuck is a third-party scrape of a third-party site: `fetchUpstream`
 * proves the payload is a non-empty array and nothing checks the entries. Every
 * one of these has to degrade rather than throw, because the payload is written
 * to KV before the page renders — so a crash outlives the bad upstream commit.
 */

import {
  eggDistanceRank,
  formatCp,
  groupSorted,
  raidTierRank,
  relativeTime,
  researchCategoryLabel,
  researchCategoryRank,
  slugifyLabel,
  stripTags,
} from '../src/lib/game-format';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`,
  );
  if (!ok) failures++;
}

console.log('\n== stripTags ==');
check('unwraps a span', stripTags('<span>Catch 7 Pokémon</span>'), 'Catch 7 Pokémon');
check('named entity', stripTags('Rock &amp; Roll'), 'Rock & Roll');
check('decimal entity', stripTags('&#233;clair'), 'éclair');
check('hex entity', stripTags('&#x2014;dash'), '—dash');
check('nbsp becomes a space, then collapses', stripTags('a&nbsp;&nbsp;b'), 'a b');
check('collapses whitespace', stripTags('  Catch \n  7  '), 'Catch 7');

// Showing "&hellip;" is honest; showing a wrong glyph is not.
console.log('\n  entities we cannot decode are left visible, not guessed:');
check('unknown named entity', stripTags('a &hellip; b'), 'a &hellip; b');
check('out-of-range codepoint', stripTags('&#1114112;'), '&#1114112;');
check('zero codepoint', stripTags('&#0;'), '&#0;');

// The strip is a safety property, not a formatting one: upstream markup must
// never reach the page as markup.
console.log('\n  upstream markup is stripped, never rendered:');
check('script tags go', stripTags('<script>alert(1)</script>hi'), 'alert(1)hi');
check('img onerror goes', stripTags('<img src=x onerror=alert(1)>'), '');

console.log('\n== formatCp ==');
check('a single value', formatCp({ min: 637, max: 637 }), '637');
check('a spread', formatCp({ min: 688, max: 739 }), '688–739');

// One boss arriving without `combatPower` would otherwise throw out of the
// template and 500 the page — from a payload already committed to KV.
console.log('\n  bad upstream data degrades to a dash, never a throw:');
check('null', formatCp(null), '—');
check('undefined', formatCp(undefined), '—');
check('NaN', formatCp({ min: Number.NaN, max: 10 }), '—');
check('Infinity', formatCp({ min: 0, max: Number.POSITIVE_INFINITY }), '—');

console.log('\n== raidTierRank ==');
check('1-star', raidTierRank('1-Star Raids'), 1);
check('5-star', raidTierRank('5-Star Raids'), 5);
check('spaced', raidTierRank('3 Star'), 3);
// Longest-first matching: "mega legendary" must not be swallowed by "mega".
check('mega', raidTierRank('Mega'), 100);
check('mega legendary beats mega', raidTierRank('Mega Legendary'), 110);
check('primal', raidTierRank('Primal'), 120);
check('elite', raidTierRank('Elite Raids'), 140);
console.log('\n  shadow sorts after everything, keeping its own order:');
check('shadow 3-star', raidTierRank('Shadow 3-Star'), 1003);
check('shadow mega', raidTierRank('Shadow Mega'), 1100);
// Visible at the end rather than silently lost — Niantic invents tiers faster
// than anyone updates a constant.
check('an unknown tier lands last', raidTierRank('Gigantamax'), 900);
check('unknown shadow, still last', raidTierRank('Shadow Gigantamax'), 1900);

console.log('\n== slugifyLabel ==');
check('a tier label', slugifyLabel('5-Star Raids'), '5-star-raids');
check('punctuation collapses', slugifyLabel('Team GO Rocket!'), 'team-go-rocket');
check('no leading or trailing dashes', slugifyLabel('  Mega  '), 'mega');
check('non-ascii drops out', slugifyLabel('Pokémon'), 'pok-mon');

console.log('\n== eggDistanceRank ==');
check('2 km', eggDistanceRank('2 km'), 2);
check('12 km', eggDistanceRank('12 km'), 12);
check('sorts numerically, not as text', eggDistanceRank('10 km') > eggDistanceRank('7 km'), true);
check('no number lands last', eggDistanceRank('Adventure Sync'), 999);

console.log('\n== research categories ==');
check('catch is first', researchCategoryRank('catch'), 0);
check('buddy is last of the known', researchCategoryRank('buddy'), 6);
check('other is always last', researchCategoryRank('other'), 999);
// Between the known set and "other": a new upstream category is visible, in a
// stable place, rather than bucketed away.
check('an unknown category sits before other', researchCategoryRank('fishing'), 500);
check('known label', researchCategoryLabel('rocket'), 'Team GO Rocket');
check('unknown label is title-cased, not "Other"', researchCategoryLabel('fishing'), 'Fishing');

console.log('\n== groupSorted ==');
const tasks = [
  { id: 1, cat: 'buddy' },
  { id: 2, cat: 'catch' },
  { id: 3, cat: 'buddy' },
  { id: 4, cat: 'other' },
  { id: 5, cat: 'catch' },
];
const grouped = groupSorted(tasks, (t) => t.cat, researchCategoryRank);
check('groups come back in rank order', grouped.map((g) => g.key), ['catch', 'buddy', 'other']);
// Grouping must not reorder within a group; the upstream order is the one the
// cards are meant to appear in.
check('items keep their upstream order', grouped[0]?.items.map((t) => t.id), [2, 5]);
check('every item is kept', grouped.reduce((n, g) => n + g.items.length, 0), 5);
check('an empty list is an empty list', groupSorted([], () => 'x', () => 0), []);
// Equal ranks fall back to the key so the order cannot wobble between renders.
check(
  'ties break alphabetically, not by insertion',
  groupSorted([{ k: 'z' }, { k: 'a' }], (i) => i.k, () => 0).map((g) => g.key),
  ['a', 'z'],
);

console.log('\n== relativeTime ==');
const T0 = Date.parse('2026-09-08T12:00:00Z');
const ago = (ms: number) => relativeTime(new Date(T0 - ms).toISOString(), T0);
check('under a minute', ago(30_000), 'just now');
check('one minute is singular', ago(60_000), '1 minute ago');
check('minutes', ago(12 * 60_000), '12 minutes ago');
check('one hour is singular', ago(60 * 60_000), '1 hour ago');
check('hours', ago(5 * 3_600_000), '5 hours ago');
check('days', ago(3 * 86_400_000), '3 days ago');
check('never, with no timestamp', relativeTime(null, T0), 'never');
check('unparseable is admitted, not guessed', relativeTime('not a date', T0), 'unknown');

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
