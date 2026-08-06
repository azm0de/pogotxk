/**
 * Server tag normalisation must agree with the client's slugify.
 *
 *   npx tsx scripts/test-tags.ts
 *
 * They are separate functions in separate files for good reasons — one bounds
 * length and drops empties, the other has a fallback — but if they disagree on
 * a character, a ?tag= link the UI builds silently matches nothing.
 */

import { normalizeTag, normalizeTags } from '../src/lib/db/posts';
import { slugify } from '../src/lib/slug';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`,
  );
  if (!ok) failures++;
}

console.log('\n== client and server agree ==');
// The regression: NFKD splits an accent off, and without stripping the
// combining mark it becomes a separator — "poke-mon" server-side against
// "pokemon" from the client.
for (const input of [
  'Pokémon',
  'Pokémon GO',
  'Raid Hour',
  'raid-hour',
  'Raid  Hour',
  'Community Day',
  'GO Fest 2026',
  'café',
  'naïve',
  'Åland',
  'ÜBER',
]) {
  check(`"${input}"`, normalizeTag(input), slugify(input));
}

console.log('\n== the specific bug ==');
check('Pokémon -> pokemon', normalizeTag('Pokémon'), 'pokemon');
check('not poke-mon', normalizeTag('Pokémon') === 'poke-mon', false);

console.log('\n== normalisation rules ==');
check('lowercased', normalizeTag('RAIDS'), 'raids');
check('spaces collapse', normalizeTag('a   b'), 'a-b');
check('punctuation stripped', normalizeTag('raid!!hour'), 'raid-hour');
check('trimmed of separators', normalizeTag('--raids--'), 'raids');
check('capped at 40 chars', normalizeTag('x'.repeat(80)).length, 40);
check('empty stays empty', normalizeTag('!!!'), '');

console.log('\n== normalizeTags ==');
check('dedupes after normalising', normalizeTags(['Raids', 'raids', 'RAIDS']), ['raids']);
check('drops empties', normalizeTags(['ok', '!!!', '']), ['ok']);
check('caps at 12', normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`)).length, 12);
check('sorted', normalizeTags(['zebra', 'apple']), ['apple', 'zebra']);

// slugify has an 'item' fallback for POI slugs, which must never leak into a
// tag — an unusable tag is better than a wrong one.
console.log('\n== the one place they must differ ==');
check('slugify falls back to "item"', slugify('!!!'), 'item');
check('normalizeTag does not', normalizeTag('!!!'), '');

console.log(failures ? `\nFAILED (${failures})\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
