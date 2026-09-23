/**
 * The admin password sign-in, posted to by `/admin/login`.
 *
 * Turns a username — or the recovery address on file — and a password from
 * `admin_credentials` into a session. The accounts it serves are standalone
 * identities with no Discord account behind them, so there is no fallback to
 * offer a caller this route refuses — Discord OAuth is the door for members,
 * and it is not a second way into an admin account. It also depends on nothing
 * but D1, which is why it survives Discord being down, the guild being
 * misconfigured, or `DISCORD_BOOTSTRAP_ADMIN_ID` being gone. See
 * `migrations/0004_owner_password.sql`, named for the terminology this feature
 * has since left behind.
 *
 * ---------------------------------------------------------------------------
 * USERNAME OR EMAIL, AND ONE CHARACTER DECIDES WHICH
 * ---------------------------------------------------------------------------
 *
 * Added 2026-09-23. An admin reset his password by email twice, both resets
 * worked, and he was then refused here: the recovery flow is addressed by
 * email and nothing in it had ever told him his username, so he typed the
 * address into the box, and a lookup that only knew `username` answered "did
 * not match" to the right password.
 *
 * An identifier containing `@` is looked up by `admin_credentials.email`, and
 * anything else by `username`. Never both, and never `OR`-ed into one query:
 *
 *   * Each lookup is an equality on its own UNIQUE index — the `username`
 *     constraint, or `idx_admin_credentials_email` (partial, and still usable,
 *     because `email = ?` implies `email IS NOT NULL`). One index, one row at
 *     most. An `OR` across two columns can match two different rows, and
 *     `.first()` would pick one of them without saying so.
 *   * The two namespaces cannot overlap. Every stored address contains `@`
 *     (the column's CHECK requires it) and no login name can (the setter's
 *     `SAFE_NAME` refuses it, a refusal this branch now depends on — see
 *     `scripts/set-admin-password.ts`).
 *
 * The address goes through `normalizeEmail`, the validator the reset request
 * and the setter use, so the address that was stored and the address looked
 * up are the same string. Something with an `@` that it refuses is an unknown
 * identifier — `dummyVerify`, then `bad` — and is never retried as a username.
 *
 * Nothing else about the door moved. An unknown identifier of either kind is
 * answered exactly as a wrong password is, in the same time; the lockout
 * counts per account, so a guess by address and a guess by username come out
 * of the same five; and the audit row records which kind was typed (`via`),
 * never what was typed.
 *
 * The email lookup is guarded and the username lookup is not. `email` arrived
 * with `0005_admin_password_reset.sql`, and every push deploys before its
 * migration is applied (`~/lib/auth/password-reset` has the argument), so for
 * a while the column may not exist and D1 throws. That has to read as "no such
 * account": a 500 for addresses beside a 303 for usernames would be an oracle,
 * and the username path must keep working through that window regardless —
 * which it does, because its query touches nothing `0005` added.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT UNDER `/api/admin/`
 * ---------------------------------------------------------------------------
 *
 * The form it serves is the one door a signed-out visitor needs, and every path
 * under `/api/admin/` is gated by the middleware's role check — so a route
 * there would answer 401 to precisely the caller it exists for. It would also
 * owe a row in `test/admin/surface.ts`, a table about who may act on the admin
 * console, which is not the question this route answers.
 *
 * Under `/api/auth/` it sits with `device/` and `mobile.ts` instead: the other
 * routes that turn a credential into a session. Neither the path nor its
 * obscurity is a control — the repository is public — and the password and the
 * lockout below are what actually hold the door.
 *
 * ---------------------------------------------------------------------------
 * NOT `handler()` FROM `~/lib/api`
 * ---------------------------------------------------------------------------
 *
 * That wrapper renders errors as JSON, which is a dead end for a top-level
 * browser navigation: the person is looking at a page, and a JSON blob is not
 * an answer they can act on. `src/pages/auth/callback.ts` made the same choice
 * for the same reason and uses a local `fail()` that redirects. This does too —
 * every path here answers **303 See Other** with a `Location`, so the browser
 * replaces the POST with a GET and a refresh cannot resubmit the password.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import {
  isLocked,
  lockoutUntil,
  MAX_ATTEMPTS,
  windowStart,
} from '~/lib/auth/lockout';
import { safeNext } from '~/lib/auth/next';
import {
  DEFAULT_ITERATIONS,
  dummyVerify,
  hashPassword,
  needsRehash,
  verifyPassword,
  type StoredHash,
} from '~/lib/auth/password';
import { createSession, sessionCookie } from '~/lib/auth/session';
import { recordAudit } from '~/lib/db/audit';
import { normalizeEmail } from '~/lib/notify/email';

export const prerender = false;

/**
 * Form encoding only. Anything else is 415, and the reason is CSRF rather than
 * taste.
 *
 * Astro's origin check is content-type-dependent — read
 * `node_modules/astro/dist/core/app/origin-check.js`: it compares `Origin`
 * against the request URL for form-like content types and for bodies with no
 * content type at all, and **`application/json` skips the check entirely**.
 * That is already written down in `vault/Platform Limits and Traps.md`, where
 * it reads as a convenience for `fetch` callers. Here it would be a hole:
 * accepting JSON would quietly remove the only CSRF protection this route has,
 * and a cross-site page could then submit a guess on a visiting admin's behalf.
 *
 * So the narrow encoding is deliberate, and `multipart/form-data` is refused
 * too — the form below never sends it, and every accepted shape is a shape
 * somebody has to reason about.
 */
const FORM_TYPE = 'application/x-www-form-urlencoded';

/** Everything here is a 303, and nothing here may be cached. */
function seeOther(location: string, extra?: Headers): Response {
  const headers = extra ?? new Headers();
  headers.set('location', location);
  headers.set('cache-control', 'no-store');
  return new Response(null, { status: 303, headers });
}

type Failure = 'bad' | 'locked';

/**
 * Back to the form with a reason.
 *
 * Only two reasons exist, and the split is the whole of what this route is
 * willing to say. `bad` covers a wrong password, an unknown username or
 * address, a string with an `@` that is not an address at all, a username
 * with no credential configured, and a row too corrupt to check — situations
 * that must be indistinguishable, because telling them apart is exactly how an
 * attacker learns which identifier to keep guessing at.
 */
function back(kind: Failure, next: string): Response {
  const params = new URLSearchParams({ error: kind });
  // '/' is the page's own default; sending it makes for a longer URL and no
  // difference in behaviour.
  if (next !== '/') params.set('next', next);
  return seeOther(`/admin/login?${params}`);
}

interface CredentialRow extends StoredHash {
  user_id: number;
  failed_attempts: number;
  locked_until: string | null;
  is_banned: number;
}

/**
 * Which kind of identifier found the row. The audit rows carry this and never
 * the identifier itself — see the note on `recordFailure`.
 */
type Via = 'username' | 'email';

function isoNow(at: number): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/*
 * The two lookups, written out in full rather than sharing a template with the
 * column name spliced in: a SQL string with an identifier interpolated into it
 * is a pattern this repository refuses on sight, whatever the value is, and two
 * greppable statements cost less than an exception to that rule.
 *
 * Both are one statement, joined, so a missing credential and a missing user
 * are the same miss.
 */

/**
 * By login name.
 *
 * The comparison is against the column directly rather than `lower(username)`
 * because the schema's CHECK guarantees every stored username is already
 * lowercase — so the bound value being lowercased is enough, and the UNIQUE
 * index is usable. Wrapping the column in `lower()` would have forced a scan
 * to get the identical answer.
 */
function findByUsername(username: string): Promise<CredentialRow | null> {
  return env.DB.prepare(
    `SELECT c.user_id, c.algorithm, c.iterations, c.salt, c.hash,
            c.failed_attempts, c.locked_until, u.is_banned
       FROM admin_credentials c
       JOIN users u ON u.id = c.user_id
      WHERE c.username = ?1`,
  )
    .bind(username)
    .first<CredentialRow>();
}

/**
 * By recovery address, already through `normalizeEmail` — which lowercases,
 * matching the column's own `lower()` CHECK, so the partial UNIQUE index
 * answers this the same way it does for the reset request.
 *
 * Guarded, and only this one: `email` is a `0005` column, and a schema that is
 * not there yet must look like an address nobody has. See the header.
 */
async function findByEmail(email: string): Promise<CredentialRow | null> {
  try {
    return await env.DB.prepare(
      `SELECT c.user_id, c.algorithm, c.iterations, c.salt, c.hash,
              c.failed_attempts, c.locked_until, u.is_banned
         FROM admin_credentials c
         JOIN users u ON u.id = c.user_id
        WHERE c.email = ?1`,
    )
      .bind(email)
      .first<CredentialRow>();
  } catch {
    return null;
  }
}

export async function POST(ctx: APIContext): Promise<Response> {
  const { request, url } = ctx;

  const contentType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (contentType !== FORM_TYPE) {
    return new Response(`This endpoint accepts ${FORM_TYPE} only.`, {
      status: 415,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  /*
   * Parsed as a query string rather than through `formData()`: the content type
   * is already pinned above, so there is no multipart case to handle, and this
   * way there is no parser here that can be surprised by one.
   *
   * Decoded from the raw bytes rather than with `request.text()`, which workerd
   * warns about on any body whose content type is not text-ish — a warning it
   * prints once per request, which in a test run is dozens of lines between a
   * real failure and whoever is reading for it.
   */
  const form = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));

  // Validated at the moment it becomes a `Location`, exactly as
  // `callback.ts:149` does — and the argument is stronger here, because this
  // value arrives from a form field the submitter controls completely rather
  // than from a cookie we minted.
  const next = safeNext(form.get('next'));

  // The field is still called `username`: it is what the form has always sent,
  // and what a password manager has saved against. It holds either kind now.
  const identifier = (form.get('username') ?? '').trim().toLowerCase();
  const password = form.get('password') ?? '';

  // Nothing submitted: no database read, no derivation. There is no identifier
  // to compare timings against, so there is nothing to hide and no reason to
  // spend a tenth of the request's CPU budget hiding it.
  if (!identifier || !password) return back('bad', next);

  // See the header: the `@` alone decides the column, and the two never mix.
  const via: Via = identifier.includes('@') ? 'email' : 'username';

  let row: CredentialRow | null;
  if (via === 'email') {
    // Not an address at all means no lookup, and the miss below. That is
    // decidable from the characters, so skipping the read leaks nothing.
    const email = normalizeEmail(identifier);
    row = email ? await findByEmail(email) : null;
  } else {
    row = await findByUsername(identifier);
  }

  const now = Date.now();

  if (!row) {
    // Burn the same cost a real row would have, so "no such username or
    // address" and "wrong password" take the same time. This also covers the
    // fresh-deploy case — no credential configured at all — which is what a
    // scanner finds, and which must be a 303 to the form rather than a 500.
    await dummyVerify();
    return back('bad', next);
  }

  /*
   * Locked, and **no hashing on this path**, deliberately.
   *
   * The usual reason to spend a derivation is to hide which branch was taken.
   * That reasoning does not apply here, because the response says `locked` out
   * loud on purpose: the admin has to be able to tell "wrong password" from
   * "wait eleven minutes", and they have no other door to try instead.
   * Paying a full PBKDF2 to conceal a fact the message already states would be
   * pure waste — and worse than waste on a 10 ms CPU budget, since it hands an
   * attacker a way to spend the Worker's time five times an hour.
   *
   * It leaks nothing about the password either: this response is byte-identical
   * whether the submitted password was right or wrong, which is the headline
   * assertion in `test/auth/admin-login.test.ts`.
   */
  if (isLocked(row.locked_until, now)) return back('locked', next);

  const ok = await verifyPassword(password, {
    algorithm: row.algorithm,
    iterations: row.iterations,
    salt: row.salt,
    hash: row.hash,
  });

  if (!ok) {
    await recordFailure(row, now, via);
    return back('bad', next);
  }

  /*
   * Authenticated, but still refused: a banned account gets no session.
   *
   * `getSessionUser` already returns undefined for a banned row, so a session
   * minted here would be inert — but minting one anyway would be a session for
   * an account we have decided cannot act, and `/auth/callback` sets the
   * precedent of refusing outright. The counter is reset because the password
   * was in fact correct, and the answer is `bad` because that is all this route
   * ever says about why it will not let you in.
   */
  if (row.is_banned === 1) {
    await clearFailures(row.user_id, now);
    await recordAudit(env.DB, {
      actorId: row.user_id,
      action: 'login',
      entity: 'admin_credentials',
      entityId: row.user_id,
      diff: { method: 'password', outcome: 'banned', via },
    });
    return back('bad', next);
  }

  await clearFailures(row.user_id, now);

  /*
   * Rehash inline, never under `waitUntil`.
   *
   * `waitUntil` defers the work past the response but bills it to the same
   * request's CPU budget, so it would buy a faster-looking login and an
   * identical chance of being killed halfway through — with the row left at the
   * old cost and nothing to show for it. Inline is honest.
   *
   * This only ever fires once per raise of `DEFAULT_ITERATIONS`: the setter
   * script writes at the current constant, and after this runs the row is at it
   * too. The one-off cost is a second derivation on a single sign-in.
   */
  if (needsRehash({ algorithm: row.algorithm, iterations: row.iterations, salt: row.salt, hash: row.hash })) {
    const fresh = await hashPassword(password, DEFAULT_ITERATIONS);
    await env.DB.prepare(
      `UPDATE admin_credentials
          SET algorithm = ?2, iterations = ?3, salt = ?4, hash = ?5, updated_at = ?6
        WHERE user_id = ?1`,
    )
      .bind(row.user_id, fresh.algorithm, fresh.iterations, fresh.salt, fresh.hash, isoNow(now))
      .run();
  }

  // The app's own session, table and scheme. A second session mechanism is
  // precisely the thing this feature is not: the password proves which existing
  // user you are, and everything after that is the code every other door runs.
  const token = await createSession(env.DB, row.user_id, request.headers.get('user-agent'));

  // `via` so that "somebody signed in by address" is findable later — the
  // address itself stays out, for the reason on `recordFailure`.
  await recordAudit(env.DB, {
    actorId: row.user_id,
    action: 'login',
    entity: 'admin_credentials',
    entityId: row.user_id,
    diff: { method: 'password', via },
  });

  const headers = new Headers();
  headers.append('set-cookie', sessionCookie(token, url));
  return seeOther(next, headers);
}

/**
 * Counts a wrong password, and locks the account when the count reaches the
 * threshold.
 *
 * The increment is **one statement**. Reading the count and writing count+1
 * would let two simultaneous attempts both read 4 and both write 5, which is a
 * free extra guess for anyone willing to open two connections — and the
 * decay rule has to be inside it for the same reason, or a request could apply
 * a window decision made against a value that has since changed.
 *
 * `lastFailedAt < windowStart` is the decay: a failure whose predecessor is
 * older than 24 hours starts the count again at 1 rather than incrementing.
 * There is no cron here (`vault/Why there is no cron.md`), so the decay rides
 * the next attempt — the same shape as the announcement and flare sweeps. The
 * comparison is lexicographic on TEXT, which is correct because every timestamp
 * in this schema is fixed-width ISO-8601 UTC.
 *
 * The escalation schedule itself stays in `~/lib/auth/lockout`, not buried in
 * SQL where no plain test can reach it.
 *
 * It is keyed on `user_id`, never on what was typed, which is what makes the
 * lockout per account: a wrong password by username and a wrong password by
 * address land on the same counter.
 */
async function recordFailure(row: CredentialRow, now: number, via: Via): Promise<void> {
  const stamp = isoNow(now);

  const counted = await env.DB.prepare(
    `UPDATE admin_credentials
        SET failed_attempts = CASE WHEN last_failed_at IS NULL OR last_failed_at < ?2
                                   THEN 1 ELSE failed_attempts + 1 END,
            last_failed_at = ?3, updated_at = ?3
      WHERE user_id = ?1
    RETURNING failed_attempts`,
  )
    .bind(row.user_id, windowStart(now), stamp)
    .first<{ failed_attempts: number }>();

  const attempts = counted?.failed_attempts ?? 0;

  /*
   * The failure audit carries no username, no address and no attempted
   * password — nothing that identifies who was being guessed at. One day an
   * admin will type their password into the username field, and `audit_log` is
   * readable by every ambassador; a log that records the attempt is a log that
   * eventually records a password in clear text. An admin's mailbox is not
   * every ambassador's to read either. `via` says which *kind* of identifier
   * was typed, and that is all it says.
   *
   * It is written only for a real credential row, never for an unknown
   * username or address. An unknown identifier has no counter and therefore no
   * lockout to bound it, so auditing it would let anyone append to `audit_log`
   * at will — the amplifier this is otherwise careful to avoid. A known-row
   * failure is capped at five rows before the door shuts, and that holds for
   * both kinds together, because they share the one counter.
   */
  await recordAudit(env.DB, {
    actorId: null,
    action: 'login',
    entity: 'admin_credentials',
    entityId: null,
    diff: { outcome: 'bad-credentials', via },
  });

  if (attempts < MAX_ATTEMPTS) return;

  const until = lockoutUntil(attempts, now);
  if (!until) return;

  await env.DB.prepare(
    'UPDATE admin_credentials SET locked_until = ?2, updated_at = ?2 WHERE user_id = ?1',
  )
    .bind(row.user_id, until)
    .run();

  /*
   * Written once, when the lock actually trips — not once per attempt. An
   * attempt made while already locked returns above without reaching this
   * function at all, so a sustained attack produces five rows and then silence
   * until the lock expires, rather than turning the audit log into its own
   * amplifier.
   */
  await recordAudit(env.DB, {
    actorId: null,
    action: 'lockout',
    entity: 'admin_credentials',
    entityId: row.user_id,
    diff: { attempts, until },
  });
}

/** Clears the counter and any expired lock, and stamps the success. */
async function clearFailures(userId: number, now: number): Promise<void> {
  const stamp = isoNow(now);
  await env.DB.prepare(
    `UPDATE admin_credentials
        SET failed_attempts = 0, locked_until = NULL, last_success_at = ?2, updated_at = ?2
      WHERE user_id = ?1`,
  )
    .bind(userId, stamp)
    .run();
}
