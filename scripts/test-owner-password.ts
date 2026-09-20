/**
 * Checks the pure half of the owner password login: the hashing primitives and
 * the lockout schedule.
 *
 *   npx tsx scripts/test-owner-password.ts
 *
 * Both modules are deliberately free of `cloudflare:workers` imports and of the
 * `~/` alias, which is what lets this run under plain `tsx` — and what lets
 * `scripts/set-admin-password.ts` write a hash the Worker can actually verify.
 * The route's own behaviour (status codes, cookies, the counter's SQL) needs a
 * runtime and lives in `test/auth/owner-login.test.ts`.
 */

import {
  ALGORITHM,
  DEFAULT_ITERATIONS,
  hashPassword,
  needsRehash,
  pbkdf2Sha256,
  timingSafeEqual,
  verifyPassword,
  type StoredHash,
} from '../src/lib/auth/password';
import {
  ATTEMPT_WINDOW_MS,
  isLocked,
  lockoutUntil,
  MAX_ATTEMPTS,
  nextFailureCount,
} from '../src/lib/auth/lockout';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`,
  );
  if (!ok) failures++;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------ the known-answer vector */

console.log('\n== PBKDF2-HMAC-SHA256 known-answer vector ==');
/*
 * The load-bearing assertion in this file.
 *
 * `test/auth/owner-login.test.ts` makes the identical claim inside workerd. Two
 * runtimes, one vector, one function: that pair is what proves the hash this
 * script writes from Node is the hash the Worker will verify, rather than
 * hoping that sharing a module is enough. If either side ever drifts — a
 * different Web Crypto, a different normalisation, a different output width —
 * exactly one of these two goes red.
 */
const KAT = '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b';
const vector = await pbkdf2Sha256('password', new TextEncoder().encode('salt'), 1, 32);
check('password/salt/1 iteration/32 bytes', hex(vector), KAT);
check('the vector is 32 bytes wide', vector.length, 32);

/* ----------------------------------------------------- hash and verify */

console.log('\n== hash, then verify ==');
// A cheap count throughout: this suite is about correctness, not cost, and
// twenty derivations at 100k would make `npm test` visibly slower for nothing.
const CHEAP = 10_000;
const PASSWORD = 'correct horse battery staple';

const stored = await hashPassword(PASSWORD, CHEAP);
check('names the one algorithm', stored.algorithm, ALGORITHM);
check('records the cost it was derived at', stored.iterations, CHEAP);
check('salt is unpadded base64url', /^[A-Za-z0-9_-]+$/.test(stored.salt), true);
check('hash is unpadded base64url', /^[A-Za-z0-9_-]+$/.test(stored.hash), true);
check('16-byte salt encodes to 22 chars', stored.salt.length, 22);
check('32-byte hash encodes to 43 chars', stored.hash.length, 43);

check('the right password verifies', await verifyPassword(PASSWORD, stored), true);
check('a wrong password does not', await verifyPassword('wrong password entirely', stored), false);
check('nor does the empty string', await verifyPassword('', stored), false);
check('nor a one-character change', await verifyPassword(`${PASSWORD}!`, stored), false);

console.log('\n  the salt is what makes two identical passwords differ:');
const again = await hashPassword(PASSWORD, CHEAP);
check('a second hash uses a different salt', again.salt === stored.salt, false);
check('and therefore a different hash', again.hash === stored.hash, false);
check('but still verifies the same password', await verifyPassword(PASSWORD, again), true);

console.log('\n  Unicode normalisation, so macOS and Windows agree:');
// U+00E9 composed, then e + U+0301 decomposed. Different bytes, same passphrase
// as far as anyone typing it is concerned.
const composed: string = 'r\u00e9sum\u00e9 passphrase 1234';
const decomposed: string = 're\u0301sume\u0301 passphrase 1234';
check('the two spellings are different strings', composed === decomposed, false);
const accented = await hashPassword(composed, CHEAP);
check('the decomposed form still verifies', await verifyPassword(decomposed, accented), true);

/* ------------------------------------------- verify fails closed, always */

console.log('\n== a corrupt row is indistinguishable from a wrong password ==');
/*
 * Every one of these must answer `false` rather than throw. A throw would reach
 * the route as a 500, and a 500 that happens for one username and not others is
 * an oracle — it says "this row exists and is broken", which is more than a
 * wrong password says.
 */
async function survives(label: string, row: StoredHash): Promise<void> {
  let result: unknown;
  try {
    result = await verifyPassword(PASSWORD, row);
  } catch (err) {
    result = `THREW ${err instanceof Error ? err.message : String(err)}`;
  }
  check(label, result, false);
}

await survives('an algorithm we cannot compute', { ...stored, algorithm: 'bcrypt' });
await survives('an empty algorithm', { ...stored, algorithm: '' });
await survives('iterations: 0', { ...stored, iterations: 0 });
await survives('iterations below the 10k floor', { ...stored, iterations: 9_999 });
await survives('iterations that are not an integer', { ...stored, iterations: 10_000.5 });
await survives('negative iterations', { ...stored, iterations: -100_000 });
await survives('NaN iterations', { ...stored, iterations: Number.NaN });
await survives('a non-base64url salt', { ...stored, salt: 'not base64url!!' });
await survives('a salt with standard-base64 padding', { ...stored, salt: `${stored.salt}==` });
await survives('an empty salt', { ...stored, salt: '' });
await survives('a salt of the wrong width', { ...stored, salt: 'c2FsdA' });
await survives('a truncated hash', { ...stored, hash: stored.hash.slice(0, 20) });
await survives('a non-base64url hash', { ...stored, hash: 'nope nope nope' });
await survives('an empty hash', { ...stored, hash: '' });

/* --------------------------------------------------------- needsRehash */

console.log('\n== needsRehash ==');
check('below target', needsRehash({ ...stored, iterations: 2_000 }, 100_000), true);
check('at target', needsRehash({ ...stored, iterations: 100_000 }, 100_000), false);
check('above target', needsRehash({ ...stored, iterations: 200_000 }, 100_000), false);
check('one short of target', needsRehash({ ...stored, iterations: 99_999 }, 100_000), true);
check('defaults to the module constant', needsRehash({ ...stored, iterations: 2_000 }), true);
check(
  'a row already at the default needs nothing',
  needsRehash({ ...stored, iterations: DEFAULT_ITERATIONS }),
  false,
);
check('a nonsense count is always stale', needsRehash({ ...stored, iterations: Number.NaN }), true);

/* -------------------------------------------------- constant-time compare */

console.log('\n== timingSafeEqual ==');
check('equal strings', timingSafeEqual('abc123', 'abc123'), true);
check('a single differing byte', timingSafeEqual('abc123', 'abc124'), false);
check('a prefix is not a match', timingSafeEqual('abc', 'abc123'), false);
check('a suffix is not a match', timingSafeEqual('abc123', 'abc'), false);
check('two empty strings', timingSafeEqual('', ''), true);
check('empty against non-empty', timingSafeEqual('', 'x'), false);

/* --------------------------------------------------------------- lockout */

console.log('\n== lockoutUntil, over the whole schedule ==');
const NOW = Date.parse('2026-09-19T12:00:00Z');
/*
 * A table rather than four assertions, because the interesting cases are the
 * edges: the attempt that first locks (5, not 4 and not 6) and the point the
 * schedule stops growing. The cap is the design — the person locked out is the
 * site owner, and an unbounded schedule is a denial of service aimed at the one
 * human who cannot route around it.
 */
const SCHEDULE: [number, string | null][] = [
  [0, null],
  [1, null],
  [2, null],
  [3, null],
  [4, null],
  [5, '2026-09-19T12:01:00Z'],
  [6, '2026-09-19T12:05:00Z'],
  [7, '2026-09-19T12:30:00Z'],
  [8, '2026-09-19T13:00:00Z'],
  [9, '2026-09-19T13:00:00Z'],
  [10, '2026-09-19T13:00:00Z'],
  [11, '2026-09-19T13:00:00Z'],
  [12, '2026-09-19T13:00:00Z'],
];
for (const [attempts, expected] of SCHEDULE) {
  check(`${attempts} failure(s)`, lockoutUntil(attempts, NOW), expected);
}
check('MAX_ATTEMPTS is the first locking count', lockoutUntil(MAX_ATTEMPTS, NOW) !== null, true);
check('one below it does not lock', lockoutUntil(MAX_ATTEMPTS - 1, NOW), null);
check('the cap never exceeds an hour', lockoutUntil(10_000, NOW), '2026-09-19T13:00:00Z');
check('a negative count cannot lock', lockoutUntil(-3, NOW), null);
check('NaN cannot lock', lockoutUntil(Number.NaN, NOW), null);
check(
  'seconds precision, matching the schema',
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(lockoutUntil(5, NOW)!),
  true,
);

console.log('\n== isLocked ==');
check('null is not locked', isLocked(null, NOW), false);
check('undefined is not locked', isLocked(undefined, NOW), false);
check('an empty string is not locked', isLocked('', NOW), false);
check('a future timestamp is locked', isLocked('2026-09-19T12:30:00Z', NOW), true);
check('a past timestamp is not', isLocked('2026-09-19T11:30:00Z', NOW), false);
// Exactly now is not locked: the boundary opens the door rather than holding it
// shut, which is the right way round for the owner's own recovery.
check('the exact instant is not locked', isLocked('2026-09-19T12:00:00Z', NOW), false);
check('one second later is', isLocked('2026-09-19T12:00:01Z', NOW), true);
/*
 * Garbage reads as NOT locked, deliberately. An unparseable value can only
 * arrive by a hand-written UPDATE, and treating it as a lock would strand the
 * owner behind a door with no expiry and no reset path — exactly the failure
 * this feature exists to avoid. The counter is untouched, so the next wrong
 * password locks the account again on a value the code did write.
 */
check('garbage is not locked', isLocked('not a timestamp', NOW), false);
check('a half-written timestamp is not locked', isLocked('2026-13-45T99:99:99Z', NOW), false);
check('a bare number is not locked', isLocked('12345', NOW), false);

console.log('\n== the failure counter decays, because nothing sweeps it ==');
check('no previous failure starts at 1', nextFailureCount(0, null, NOW), 1);
check('a garbage timestamp starts at 1', nextFailureCount(4, 'nonsense', NOW), 1);
check('a recent failure increments', nextFailureCount(2, '2026-09-19T11:00:00Z', NOW), 3);
check(
  'a failure just inside the window increments',
  nextFailureCount(4, new Date(NOW - ATTEMPT_WINDOW_MS + 1000).toISOString(), NOW),
  5,
);
check(
  'a failure just outside the window resets',
  nextFailureCount(4, new Date(NOW - ATTEMPT_WINDOW_MS - 1000).toISOString(), NOW),
  1,
);
check(
  'a week-old failure resets',
  nextFailureCount(9, '2026-09-12T12:00:00Z', NOW),
  1,
);

console.log(failures ? `\nFAILED (${failures})\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
