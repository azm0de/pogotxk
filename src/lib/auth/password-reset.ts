/**
 * The admin password reset: tokens, the rules around them, and the D1 work.
 *
 * Every decision worth arguing about lives here rather than in the two routes,
 * for the same reason `lockout.ts` exists: a route is plumbing, and plumbing is
 * hard to get a test close to. The database is a parameter, there is no
 * `cloudflare:workers` import and no `~/` alias, so a plain test — or a future
 * `tsx` one — can drive all of it.
 *
 * ---------------------------------------------------------------------------
 * THE TOKEN IS THE SESSION SCHEME, NOT A SECOND ONE
 * ---------------------------------------------------------------------------
 *
 * `randomToken()` and `sha256()` come from `./session`, unchanged. 32 random
 * bytes in the link, the SHA-256 of them in `admin_password_resets.id`, exactly
 * as a session cookie relates to `sessions.id`. A leaked database dump
 * therefore yields no usable reset links, which matters more here than it does
 * for sessions: a reset token does not merely impersonate an admin for a
 * fortnight, it hands over the password permanently.
 *
 * Inventing a second scheme — an HMAC, a signed JWT, a "stateless" token — was
 * never on the table. All three make revocation somebody's follow-up problem,
 * and revocation is most of what this module does: single use, superseded by a
 * newer link, and gone when the password changes.
 *
 * ---------------------------------------------------------------------------
 * THE MIGRATION MAY NOT HAVE RUN YET, AND THAT IS NORMAL HERE
 * ---------------------------------------------------------------------------
 *
 * Every push to this repository deploys to production through Workers Builds,
 * including a push to a branch — so there is always a window where this code is
 * live and `0005_admin_password_reset.sql` has not been applied. In that window
 * `admin_password_resets` does not exist and `admin_credentials.email` does not
 * exist, and D1 answers both with a thrown error rather than an empty result.
 *
 * So every read below is wrapped, and a schema that is not ready reads as
 * **"there is nothing here"** — no address on file, no such token. That is the
 * same answer this feature gives a stranger, so the failure is invisible from
 * outside and impossible to distinguish from the ordinary case, which is
 * exactly what it should be. What it must never do is 500, because a 500 on one
 * input and not another is an oracle, and because the *existing* login route
 * has to keep working through that window regardless. It does. Its username
 * lookup names its columns and none of them are new, so it never touches either
 * of the objects this migration adds. Its address lookup, added 2026-09-23,
 * does read `email`, and is guarded in the same way as the reads below.
 */

import { isResetToken } from './admin-path';
import { randomToken, sha256 } from './session';

/**
 * How long a link lives.
 *
 * Thirty minutes is short enough that a link sitting in an unattended mailbox
 * or in a forwarded thread stops being a credential quickly, and long enough
 * that the ordinary path — read the mail on a phone, walk to a laptop, dig the
 * new passphrase out of a password manager — fits inside it without anybody
 * hurrying. It is deliberately much shorter than the fortnight a session gets,
 * because a session is bounded by having been issued to someone who already
 * proved who they were, and this is issued to whoever can read an inbox.
 */
export const RESET_TTL_MS = 30 * 60 * 1000;

/**
 * How long a live, unused link suppresses the next one.
 *
 * This is the rate limit, and per-account is the right axis for it. The harm
 * this endpoint can do without one is not guessing — the token is 256 bits —
 * it is **mailing a real person over and over**, which anyone who knows an
 * admin's address could do for free, and which no amount of token entropy
 * touches. Binding the limit to the account rather than to the caller means it
 * holds however the requests arrive: one browser, a script, or a thousand
 * addresses on a botnet all hit the same per-account ceiling, and an IP limit
 * would have held against none of them.
 *
 * Five minutes rather than the full TTL. Making the cooldown equal the TTL
 * reads tidier and is worse in the only case that matters: the admin whose
 * first mail went to spam or never arrived is the person who needs this
 * feature, and telling them to wait half an hour is telling them the break-glass
 * door has a queue. Five minutes caps a mailbox at twelve messages an hour —
 * annoying, not a flood, and only reachable for an address that is genuinely on
 * file.
 *
 * It bounds the table too: issuing clears the account's older rows, so there is
 * at most one live token per admin at any moment.
 */
export const RESET_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * The floor `scripts/set-admin-password.ts` enforces, enforced again here.
 *
 * It has to be the same number, and it has to be stated somewhere both can see
 * it, or the two doors onto the same credential end up with two different
 * standards — and the weaker one is the one an attacker uses. The setter's
 * reasoning is unchanged and still governs: at 10,000 PBKDF2 rounds the
 * iteration count is not what protects this credential, the password's own
 * entropy is, so a short password is not made safe by anything downstream.
 */
export const MIN_PASSWORD_LENGTH = 16;

/** Seconds precision, matching every other timestamp in this schema. */
function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Where a token is redeemed. One definition, used by the mail and the gate. */
export function resetPath(token: string): string {
  return `/admin/reset/${token}`;
}

/**
 * The absolute link that goes in the mail.
 *
 * `origin` comes from the request the reset was asked for on, which is the same
 * source `announceToDiscord`'s callers use for post and meetup links. It is not
 * read from configuration: `SITE_URL` is a *build* variable (see
 * vault/Configuration.md) and is not visible to the Worker at runtime at all,
 * so reading it here would produce `undefined` and a link to nowhere.
 */
export function resetLink(origin: string, token: string): string {
  return new URL(resetPath(token), origin).toString();
}

/**
 * Runs a read that touches something `0005` added, and answers `fallback` if
 * the schema is not there yet.
 *
 * Catches everything rather than matching on "no such table", deliberately.
 * The alternative is a string comparison against a database error message,
 * which is a thing that changes under you — and the safe answer to *any* failure
 * on this path is the same refusal, for the same reason `verifyPassword` never
 * throws: a route that 500s for one input and redirects for another has told a
 * stranger which inputs are interesting.
 *
 * The cost is that a genuine D1 fault here looks like "no address on file"
 * rather than like a fault. That is the correct trade for a security route and
 * the wrong one for most things, which is why this is a local helper and not a
 * general one.
 */
async function guarded<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------- requesting */

/**
 * What a request for a reset link did.
 *
 * Note what is *not* here: anything the route is allowed to say out loud. All
 * three outcomes produce the identical response — see the enumeration note on
 * `src/pages/api/auth/admin-reset.ts`. The distinction exists so the route
 * knows whether to send mail and whether to write an audit row, not so it can
 * report which one happened.
 */
export type ResetRequest =
  | { status: 'issued'; userId: number; email: string; token: string; expiresAt: string }
  /** No such address, no address on file, the account is banned, or no schema. */
  | { status: 'none' }
  /** A live unused link already went out recently. */
  | { status: 'cooling'; userId: number };

interface CredentialByEmailRow {
  user_id: number;
  email: string;
  /** The newest live, unused token for this user, or null. */
  recent: string | null;
}

/**
 * Find the admin with this address and, if the cooldown allows, mint a token.
 *
 * One statement for the lookup and the cooldown together. Two would mean two
 * round trips whose costs differ by branch, which is a timing signal about
 * whether the address exists — the thing this whole endpoint is built not to
 * disclose.
 *
 * `u.is_banned = 0` is part of the join rather than a check afterwards. A
 * banned account cannot sign in through any door (`getSessionUser` refuses it
 * before it reads the role, and the login route refuses it even on a correct
 * password), so mailing it a reset link would be mailing somebody a key to a
 * door that is welded shut. Folding it into the lookup means that account is
 * simply not found, which is the same answer as every other refusal here.
 */
export async function requestReset(
  db: D1Database,
  email: string,
  now: number = Date.now(),
): Promise<ResetRequest> {
  const row = await guarded(
    () =>
      db
        .prepare(
          `SELECT c.user_id, c.email,
                  (SELECT max(r.created_at)
                     FROM admin_password_resets r
                    WHERE r.user_id = c.user_id
                      AND r.used_at IS NULL
                      AND r.expires_at > ?2) AS recent
             FROM admin_credentials c
             JOIN users u ON u.id = c.user_id
            WHERE c.email = ?1 AND u.is_banned = 0`,
        )
        .bind(email, isoSeconds(now))
        .first<CredentialByEmailRow>(),
    null,
  );

  if (!row) return { status: 'none' };

  const recent = row.recent ? Date.parse(row.recent) : NaN;
  if (!Number.isNaN(recent) && now - recent < RESET_COOLDOWN_MS) {
    return { status: 'cooling', userId: row.user_id };
  }

  const token = randomToken();
  const expiresAt = isoSeconds(now + RESET_TTL_MS);

  /*
   * The account's older tokens go first, in the same batch — so a link that
   * has been superseded stops working at the moment its replacement exists,
   * rather than at the moment somebody happens to use one of them. Two live
   * links for one account is a state with no legitimate use and one obvious
   * abuse: an attacker who got a link once keeps it warm by never spending it.
   *
   * `batch` is a transaction, so there is never a window with both rows or
   * neither.
   */
  await db.batch([
    db.prepare('DELETE FROM admin_password_resets WHERE user_id = ?1').bind(row.user_id),
    db
      .prepare(
        `INSERT INTO admin_password_resets (id, user_id, expires_at, created_at)
         VALUES (?1, ?2, ?3, ?4)`,
      )
      .bind(await sha256(token), row.user_id, expiresAt, isoSeconds(now)),
  ]);

  return { status: 'issued', userId: row.user_id, email: row.email, token, expiresAt };
}

/* --------------------------------------------------------------- redeeming */

/**
 * Why a link will not work, or that it will.
 *
 * `expired` and `used` are told apart on purpose and it costs nothing: the
 * token is spent either way, so neither message helps an attacker, and the
 * person holding a dead link is almost always the admin who took too long or
 * clicked twice. "That link is not valid" for all three would make the one
 * recoverable case — ask for another — look like a bug in the site.
 */
export type ResetLookup =
  | { status: 'valid'; userId: number }
  | { status: 'unknown' }
  | { status: 'expired' }
  | { status: 'used' };

interface ResetRow {
  user_id: number;
  expires_at: string;
  used_at: string | null;
}

/** Read a token's state without spending it — what the form page needs. */
export async function lookupReset(
  db: D1Database,
  token: string,
  now: number = Date.now(),
): Promise<ResetLookup> {
  if (!isResetToken(token)) return { status: 'unknown' };

  const id = await sha256(token);
  const row = await guarded(
    () =>
      db
        .prepare('SELECT user_id, expires_at, used_at FROM admin_password_resets WHERE id = ?1')
        .bind(id)
        .first<ResetRow>(),
    null,
  );

  if (!row) return { status: 'unknown' };
  if (row.used_at !== null) return { status: 'used' };
  if (Date.parse(row.expires_at) <= now) return { status: 'expired' };
  return { status: 'valid', userId: row.user_id };
}

/**
 * Spend a token, atomically.
 *
 * **One statement, and the conditions are inside it.** Reading the row,
 * deciding it is usable, and then stamping it would let two requests arriving
 * together both read `used_at IS NULL` and both proceed — which on this route
 * means two different passwords set from one link, and the second one winning.
 * That is the same argument, and the same shape, as the single-statement
 * failure counter in `admin-login.ts`.
 *
 * `RETURNING user_id` is how we learn whether we won: a row comes back only if
 * this statement is the one that flipped it. When nothing comes back, a second
 * read classifies *why* for the message — and that read is safe precisely
 * because the deciding write already happened.
 */
export async function consumeReset(
  db: D1Database,
  token: string,
  now: number = Date.now(),
): Promise<ResetLookup> {
  if (!isResetToken(token)) return { status: 'unknown' };

  const stamp = isoSeconds(now);
  const id = await sha256(token);

  const won = await guarded(
    () =>
      db
        .prepare(
          `UPDATE admin_password_resets
              SET used_at = ?2
            WHERE id = ?1 AND used_at IS NULL AND expires_at > ?2
          RETURNING user_id`,
        )
        .bind(id, stamp)
        .first<{ user_id: number }>(),
    null,
  );

  if (won) return { status: 'valid', userId: won.user_id };

  return lookupReset(db, token, now);
}

/* ---------------------------------------------------------------- applying */

/** What `applyNewPassword` did, for the route's decision and the audit row. */
export interface ResetEffects {
  /**
   * Whether a credential row was actually written.
   *
   * False means the account's `admin_credentials` row went away between the
   * link being issued and being redeemed — which only `deleteAccount` does,
   * and which now clears outstanding links as it goes, so this should be
   * unreachable. It is reported anyway because the alternative is a route that
   * redirects to "your password has been reset" having changed nothing, and a
   * recovery flow that lies about succeeding is worse than one that fails.
   */
  credentialUpdated: boolean;
  /** Sessions destroyed. A reset is the answer to a compromise. */
  sessionsRevoked: number;
  /** Other outstanding links for this admin, now dead. */
  tokensRevoked: number;
}

/**
 * The new credential, and everything a reset has to invalidate with it.
 *
 * One batch, so one transaction. A partial apply here is the worst outcome
 * available: a password changed but sessions left alive, or sessions killed
 * while the old password still works.
 *
 * WHAT IT DESTROYS, AND WHY EACH ONE
 *
 *   * **Every session for this user.** A reset is what somebody does after a
 *     compromise, and an attacker's session outliving the password change
 *     would defeat the entire exercise — they would simply keep browsing. This
 *     is why the feature is worth the mailbox dependency in the first place.
 *     It signs the admin out of their own other devices too, which is correct:
 *     "I am resetting because something is wrong" and "please keep my phone
 *     signed in" cannot both be honoured.
 *   * **Every other reset token for this user.** Same argument one step back —
 *     a spare link is a spare password.
 *   * **The lockout counter and any lock.** Proving control of the mailbox is
 *     strictly stronger evidence than the counter that got tripped, and
 *     leaving the lock in place would mean an admin resets their password and
 *     is then told to wait an hour before using it. The lock exists to stop
 *     guessing, and nobody guessed.
 *
 * The consumed token itself is left stamped rather than deleted, so a second
 * click on the same link can be told it was already used.
 */
export async function applyNewPassword(
  db: D1Database,
  userId: number,
  stored: { algorithm: string; iterations: number; salt: string; hash: string },
  consumedTokenId: string,
  now: number = Date.now(),
): Promise<ResetEffects> {
  const stamp = isoSeconds(now);

  const [credential, tokens, sessions] = await db.batch([
    db
      .prepare(
        `UPDATE admin_credentials
            SET algorithm = ?2, iterations = ?3, salt = ?4, hash = ?5,
                failed_attempts = 0, locked_until = NULL, last_failed_at = NULL,
                updated_at = ?6
          WHERE user_id = ?1`,
      )
      .bind(userId, stored.algorithm, stored.iterations, stored.salt, stored.hash, stamp),
    db
      .prepare('DELETE FROM admin_password_resets WHERE user_id = ?1 AND id <> ?2')
      .bind(userId, consumedTokenId),
    db.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId),
  ]);

  return {
    credentialUpdated: (credential?.meta.changes ?? 0) > 0,
    sessionsRevoked: sessions?.meta.changes ?? 0,
    tokensRevoked: tokens?.meta.changes ?? 0,
  };
}

/** The id a consumed token occupies, for `applyNewPassword`'s exclusion. */
export function resetRowId(token: string): Promise<string> {
  return sha256(token);
}
