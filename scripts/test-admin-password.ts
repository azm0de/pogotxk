/**
 * Checks the pure half of the admin password login: the hashing primitives, the
 * lockout schedule, and the address a reset link is mailed to.
 *
 *   npx tsx scripts/test-admin-password.ts
 *
 * All three modules are deliberately free of `cloudflare:workers` imports and of
 * the `~/` alias, which is what lets this run under plain `tsx` — and what lets
 * `scripts/set-admin-password.ts` write a hash the Worker can actually verify.
 * The route's own behaviour (status codes, cookies, the counter's SQL) needs a
 * runtime and lives in `test/auth/admin-login.test.ts`.
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
import { normalizeEmail } from '../src/lib/notify/email';
import { D1ShapeError, rows } from './d1-json';

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
 * `test/auth/admin-login.test.ts` makes the identical claim inside workerd. Two
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
 * schedule stops growing. The cap is the design — the person locked out is an
 * admin, whose account has no Discord sign-in behind it, so an unbounded
 * schedule is a denial of service aimed at the few people with no second door.
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
// shut, which is the right way round for an admin's own recovery.
check('the exact instant is not locked', isLocked('2026-09-19T12:00:00Z', NOW), false);
check('one second later is', isLocked('2026-09-19T12:00:01Z', NOW), true);
/*
 * Garbage reads as NOT locked, deliberately. An unparseable value can only
 * arrive by a hand-written UPDATE, and treating it as a lock would strand an
 * admin behind a door with no expiry and no reset path — exactly the failure
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

/* ------------------------------------------------- reading wrangler's --json */

/*
 * These two payloads are not invented. They are what wrangler 4.119.0 actually
 * printed for the SAME query on 2026-09-21 — `SELECT id, username FROM users
 * WHERE id = 1` — differing only in --local versus --remote with --file. The
 * remote one is the shape that reached a production run, read a summary object
 * as a user row, and announced it was "reusing" a row that did not exist.
 */
const LOCAL_ROWS = JSON.stringify([
  { results: [{ id: 1, username: 'azm.0' }], success: true, meta: {} },
]);
const REMOTE_FILE_SUMMARY = JSON.stringify([
  {
    results: [
      {
        'Total queries executed': 1,
        'Rows read': 72,
        'Rows written': 0,
        'Database size (MB)': '0.30',
      },
    ],
    success: true,
    meta: {},
  },
]);

function threw(label: string, raw: string, expected: boolean): void {
  let didThrow = false;
  try {
    rows(raw);
  } catch (err) {
    didThrow = err instanceof D1ShapeError;
  }
  check(label, didThrow, expected);
}

console.log('\n== reading rows out of wrangler --json ==');
check('real rows parse', rows<{ id: number }>(LOCAL_ROWS), [{ id: 1, username: 'azm.0' }]);
threw('real rows do not throw', LOCAL_ROWS, false);

console.log(`
  The whole point: --file against --remote answers a summary, not rows. Silence
  here would be worse than an error — the caller's next move after "no such row"
  is to offer to create one, in production.`);
threw('the remote --file summary throws', REMOTE_FILE_SUMMARY, true);

console.log('\n  And the shapes that must stay quiet:');
// A SELECT that matched nothing has no rows at all, so it has no summary key in
// it either. This is the case that must NOT be confused with the one above.
threw('a genuinely empty result set does not throw', JSON.stringify([{ results: [] }]), false);
check('a genuinely empty result set is []', rows(JSON.stringify([{ results: [] }])), []);
check('a missing results key is []', rows(JSON.stringify([{ success: true }])), []);
check('output with no JSON array at all is []', rows('wrangler said something else'), []);
check('banner text before the array is skipped', rows(`├ Uploading\n│\n${LOCAL_ROWS}`), [
  { id: 1, username: 'azm.0' },
]);

/* ------------------------------------------------------ the reset address */

/*
 * Asserted here, under `tsx`, for the same reason the PBKDF2 vector is:
 * `scripts/set-admin-password.ts` writes the address in Node and the reset
 * route looks it up inside workerd, and only the same function passing in both
 * places makes "what was written is what will be found" a fact.
 *
 * There is a second reason this one belongs under `tsx` specifically. The
 * setter interpolates the result straight into SQL text — `--file` has no
 * parameter binding — so the character set is not a formatting preference, it
 * is the thing standing between a surprising address and a statement that
 * means something else. The injection shapes below are the point of the block.
 */
console.log('\n== the reset address ==');

check('an ordinary address survives', normalizeEmail('justin@example.com'), 'justin@example.com');
check('case is folded', normalizeEmail('Justin@Example.COM'), 'justin@example.com');
check('surrounding space is trimmed', normalizeEmail('  a@b.co  '), 'a@b.co');
check('plus addressing is fine', normalizeEmail('a+admin@example.com'), 'a+admin@example.com');
check('a subdomain is fine', normalizeEmail('a@mail.example.co.uk'), 'a@mail.example.co.uk');

console.log('\n  Nothing that is not an address:');
for (const [label, value] of [
  ['empty', ''],
  ['null', null],
  ['no at sign', 'nobody'],
  ['nothing before the at', '@example.com'],
  ['nothing after the at', 'nobody@'],
  ['no dot in the domain', 'a@example'],
  ['a space inside', 'two words@example.com'],
  ['angle brackets', '<a@example.com>'],
  ['a display name', 'Justin <a@example.com>'],
  ['two addresses', 'a@example.com,b@example.com'],
  ['a trailing dot', 'a@example.com.'],
  ['a leading dot in the local part', '.a@example.com'],
] as const) {
  check(`  ${label}`, normalizeEmail(value), null);
}

console.log(`
  And the shapes that would matter if one reached the setter's SQL, which
  interpolates rather than binds. The refusal is what makes that safe rather
  than lucky — and the first two are the ones that actually caught something:
  an apostrophe and a backtick are LEGAL in a local part, so the character
  class permitted them until this block was written:`);
for (const [label, value] of [
  ['a single quote, SQLite’s string delimiter', "a'@example.com"],
  ['a backtick, SQLite’s identifier quote', 'a`@example.com'],
  ['a real name that pays the price for it', "o'brien@example.com"],
  ['a quoted local part, which RFC 5322 allows and this does not', '"a b"@example.com'],
  ['a statement terminator', 'a@example.com; DROP TABLE users;--'],
  ['a comment', 'a@example.com--'],
  ['a backslash', 'a\\@example.com'],
  ['a newline', 'a@example.com\nb@example.com'],
  ['a carriage return, for header injection', 'a@example.com\r\nBcc: c@example.com'],
  ['a null byte', 'a@example.com '],
] as const) {
  check(`  ${label}`, normalizeEmail(value), null);
}

// 254 is SMTP's path limit, and the boundary is where an off-by-one would live.
const longLocal = 'a'.repeat(254 - '@example.com'.length);
check('an address at the 254 limit survives', normalizeEmail(`${longLocal}@example.com`)?.length, 254);
check('one character over is refused', normalizeEmail(`${longLocal}a@example.com`), null);

console.log(failures ? `\nFAILED (${failures})\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
