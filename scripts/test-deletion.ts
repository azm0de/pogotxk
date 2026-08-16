/**
 * Checks the pure part of account deletion — the anonymised values written
 * to `users` — without touching D1.
 *
 *   npx tsx scripts/test-deletion.ts
 */

import { anonymizedIdentity } from '../src/lib/auth/deletion';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
  if (!ok) failures++;
}

console.log('\n== anonymized identity ==');
check('discordId is deterministic per user id', anonymizedIdentity(42).discordId, 'deleted:42');
check('username is the same placeholder for everyone', anonymizedIdentity(42).username, 'Deleted user');
check('two different ids never collide', anonymizedIdentity(1).discordId === anonymizedIdentity(2).discordId, false);

console.log('\n  cannot collide with a real Discord snowflake, or be re-derived from one:');
// Discord snowflakes are digits only. `deleted:<id>` is never a bare digit
// string, so `upsertUser`'s `ON CONFLICT (discord_id)` can never match this
// row again from a real sign-in — that is the entire deletion guarantee.
for (const id of [1, 42, 999001, 123456789012345678]) {
  check(`deleted:${id} is not a bare digit string`, /^\d+$/.test(anonymizedIdentity(id).discordId), false);
}

console.log(failures ? `\nFAILED (${failures})\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
