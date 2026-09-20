/**
 * Password hashing for the owner's break-glass login.
 *
 * ---------------------------------------------------------------------------
 * THIS MODULE MUST STAY IMPORTABLE BY PLAIN `tsx`
 * ---------------------------------------------------------------------------
 *
 * No `cloudflare:workers` import, no `~/` path alias, no binding. The setter
 * script (`scripts/set-admin-password.ts`) runs under `tsx`, which resolves
 * neither — so the constraint is what makes "the script and the Worker use the
 * same algorithm" a fact rather than a promise. If they diverged, a password
 * set from the terminal would simply never verify, and the failure would look
 * like a wrong password rather than like a bug.
 *
 * `src/lib/auth/next.ts` and `src/lib/auth/admin-path.ts` already follow this
 * rule for the same reason.
 *
 * Everything here is Web Crypto, which workerd and Node both implement.
 */

export const ALGORITHM = 'pbkdf2-sha256';

/**
 * PBKDF2 iterations for a newly written hash.
 *
 * PROVISIONAL, and low on purpose. OWASP's 2023 floor for PBKDF2-HMAC-SHA256 is
 * 600,000; this is deliberately far below it, because a Cloudflare Worker on
 * the free plan gets **10 ms of CPU per request** — there is no `limits` block
 * in `wrangler.jsonc`, so the plan default applies — and PBKDF2 costs roughly
 * 10 ms per 100,000 iterations. 600k would not be a slow login, it would be a
 * login that can never complete.
 *
 * Because the cost is stored per row, raising this constant is a one-line
 * change that invalidates nothing: `verifyPassword` uses the row's own count,
 * and `needsRehash` plus the login route re-derive at the new one on the next
 * successful sign-in.
 *
 * The other half of the trade is the setter script's 16-character minimum. A
 * 16-character passphrase carries far more entropy than any iteration count can
 * buy back, and these two numbers were chosen together.
 */
export const DEFAULT_ITERATIONS = 100_000;

/** 128 bits. Enough that two rows never share a salt; not a secret. */
export const SALT_BYTES = 16;
/** SHA-256's own output width. Truncating it would buy nothing. */
export const HASH_BYTES = 32;

/**
 * One `admin_credentials` row's worth of hash, in the shape the columns store
 * it: `salt` and `hash` are unpadded base64url, the encoding `pkceChallenge()`
 * and `scripts/generate-vapid.ts` already use in this repo.
 */
export interface StoredHash {
  algorithm: string;
  iterations: number;
  salt: string;
  hash: string;
}

/* -------------------------------------------------------------- base64url */

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  // A byte at a time rather than `String.fromCharCode(...bytes)`: the spread
  // form is a stack-depth bet on the array staying short, and there is no
  // reason to take it.
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Strict: null for anything that is not unpadded base64url, rather than a
 * best-effort decode. A row that cannot be decoded is a corrupt row, and the
 * only safe answer to a corrupt row is "that password is wrong".
 */
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;

  const standard = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, '=');
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/* ------------------------------------------------- constant-time compare */

/**
 * Byte comparison whose duration does not depend on where the first difference
 * falls. This is the repo's one copy — `src/lib/admin-auth.ts` imports it
 * rather than keeping the private version it used to have.
 *
 * workerd ships a native `crypto.subtle.timingSafeEqual` (non-standard, typed
 * in this repo's `worker-configuration.d.ts` as a `SubtleCrypto` member). It is
 * preferred where it exists and **guarded on equal lengths**, because
 * Cloudflare's implementation throws on unequal ones — and a throw escaping
 * `verifyPassword` would turn a corrupt row into a 500, which is an oracle:
 * a status that appears for one username and not others.
 *
 * Node's Web Crypto has no such method (checked on Node 22), so the XOR
 * accumulator is the path `tsx` takes. It is the same form the bearer-token
 * check has always used.
 */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  const subtle = crypto.subtle as {
    timingSafeEqual?: (x: Uint8Array, y: Uint8Array) => boolean;
  };
  if (typeof subtle.timingSafeEqual === 'function' && a.length === b.length) {
    return subtle.timingSafeEqual(a, b);
  }

  // No early return: the length difference is folded into the same accumulator
  // as the bytes, and the loop always runs the longer of the two.
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** The string form, for callers comparing tokens rather than digests. */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  return timingSafeEqualBytes(encoder.encode(a), encoder.encode(b));
}

/* ---------------------------------------------------------------- deriving */

/**
 * Unicode normalisation before encoding, and it is load-bearing rather than
 * tidy: the same passphrase typed on macOS and on Windows can arrive as
 * different byte sequences — decomposed against composed — for any character
 * carrying an accent, and would then hash to different values. Sharing this
 * module with the setter script is what makes the normalisation identical on
 * the side that writes the hash and the side that checks it.
 */
function encodePassword(password: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(password.normalize('NFC'));
}

/**
 * The derivation itself, with nothing decided for you.
 *
 * Exported so both test layers can put the RFC known-answer vector through the
 * exact function the login route uses (`password` / `salt` / 1 iteration / 32
 * bytes). Asserting that vector twice — once under `tsx`, once inside workerd —
 * is the only thing that actually proves the setter script and the Worker
 * derive identical bytes, rather than merely sharing a file. Nothing in the app
 * calls it with these parameters; `hashPassword` and `verifyPassword` are the
 * real entry points and they enforce the floors.
 *
 * NFC normalisation is applied here, so it applies to the vector too. Both the
 * RFC's inputs are ASCII, where normalisation is the identity — the vector
 * stays valid.
 */
export async function pbkdf2Sha256(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
  bytes: number = HASH_BYTES,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', encodePassword(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

/** A fresh salt and hash for a new or rotated password. */
export async function hashPassword(
  password: string,
  iterations: number = DEFAULT_ITERATIONS,
): Promise<StoredHash> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2Sha256(password, salt, iterations);
  return {
    algorithm: ALGORITHM,
    iterations,
    salt: toBase64Url(salt),
    hash: toBase64Url(hash),
  };
}

/**
 * Fails closed, and **never throws**.
 *
 * Every way a row can be wrong — an algorithm this code cannot compute, an
 * iteration count below the floor or not an integer at all, a salt or hash that
 * is not base64url or decodes to the wrong width, Web Crypto refusing the
 * parameters outright — returns `false`. A corrupt row has to be
 * indistinguishable from a wrong password: anything else tells a stranger which
 * usernames exist and which of them are broken, and turns a bad row into a 500
 * on a route whose entire job is to be boring.
 */
export async function verifyPassword(password: string, stored: StoredHash): Promise<boolean> {
  try {
    if (stored.algorithm !== ALGORITHM) return false;
    if (!Number.isInteger(stored.iterations) || stored.iterations < 10_000) return false;

    const salt = fromBase64Url(stored.salt);
    const expected = fromBase64Url(stored.hash);
    if (!salt || salt.length !== SALT_BYTES) return false;
    if (!expected || expected.length !== HASH_BYTES) return false;

    const actual = await pbkdf2Sha256(password, salt, stored.iterations);
    return timingSafeEqualBytes(actual, expected);
  } catch {
    return false;
  }
}

/** Fixed, so the dummy derivation is deterministic. A salt is not a secret. */
const DUMMY_SALT = new Uint8Array([
  0x70, 0x6f, 0x67, 0x6f, 0x74, 0x78, 0x6b, 0x2d, 0x64, 0x75, 0x6d, 0x6d, 0x79, 0x2d, 0x76, 0x31,
]);

/**
 * Burns a real derivation so "no such username" costs what "wrong password"
 * costs, then answers `false`.
 *
 * The return type is the literal `false` rather than `boolean`, so no call site
 * can mistake it for a success — `if (await dummyVerify())` fails to typecheck,
 * which is the point of writing it this way.
 *
 * Honest about what it buys: it matches a real row's cost only while that row
 * sits at `DEFAULT_ITERATIONS`. The setter script writes at that count and the
 * login route rehashes up to it on success, so it holds in practice. The
 * residual window is the stretch after the constant is raised and before the
 * owner next signs in, and what leaks through it is one bit — "this username
 * exists" — about a username the attacker must already have guessed, on an
 * account that locks out after five tries. That is the correct size of worry
 * for this, and it is written down here so nobody re-derives it in a panic.
 */
export async function dummyVerify(): Promise<false> {
  await pbkdf2Sha256('', DUMMY_SALT, DEFAULT_ITERATIONS);
  return false;
}

/** True when the row was derived more cheaply than new rows are being written. */
export function needsRehash(stored: StoredHash, target: number = DEFAULT_ITERATIONS): boolean {
  return !Number.isInteger(stored.iterations) || stored.iterations < target;
}
