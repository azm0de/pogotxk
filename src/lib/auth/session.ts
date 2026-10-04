/**
 * Session handling.
 *
 * The cookie carries a random 256-bit token. What lands in D1 is its SHA-256
 * hash, never the token itself — so a leaked database dump cannot be replayed
 * as a login. Verification hashes the incoming cookie and looks that up.
 */

import { avatarUrl, type Role, type SessionUser, type Team } from './types';

export const SESSION_COOKIE = 'pogotxk_session';
export const OAUTH_STATE_COOKIE = 'pogotxk_oauth';
export const DEVICE_GRANT_COOKIE = 'pogotxk_device';

/**
 * Sessions last two weeks, and use inside that window slides them forward —
 * both halves of them: the D1 row and the browser's cookie.
 */
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
/**
 * How stale a session may get before use renews it.
 *
 * This exists to bound writes, not to bound the session: renewing on literally
 * every request would mean a D1 write per page view. Once a day is plenty.
 *
 * It previously read as "only renew when less than a day REMAINS", which made
 * the fortnight a hard deadline rather than a rolling window. Anyone who did
 * not happen to open the site during the final 24 hours of the two weeks was
 * signed out and sent back through Discord. That is a sign-in prompt nobody
 * could predict or avoid, and on Android it is the expensive kind: Discord will
 * not hand OAuth to its own app, so every one of those costs a browser login.
 *
 * Fixing that rule was still only half the job, and the half nobody could see
 * (admin audit, 2026-10, A-01). The ROW slid; the COOKIE never did. It was set
 * once at sign-in with a fortnight's `Max-Age` and never re-issued, so the
 * browser threw it away on day fourteen however active the person had been,
 * and the freshly slid row was left with nobody holding its token.
 *
 * What happens now, on a request carrying a session aged past a day: the
 * middleware asks `slideDue` (synchronously, from the `expires_at` that
 * `resolveSession` already read), schedules `renewSession` under `waitUntil`,
 * and appends a fresh `sessionCookie` to the response — so the browser's copy
 * and the row are renewed by the same request and agree to within a second.
 * At most once a day per session, for the write-volume reason above.
 */
const SLIDE_INTERVAL_SECONDS = 60 * 60 * 24;

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
}

export function randomToken(bytes = 32): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)).buffer);
}

function isoIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function sessionCookie(token: string, url: URL): string {
  const secure = url.protocol === 'https:' ? ' Secure;' : '';
  // Lax rather than Strict: the OAuth callback is a cross-site top-level
  // navigation, and Strict would drop the cookie on the way back from Discord.
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearedSessionCookie(url: URL): string {
  const secure = url.protocol === 'https:' ? ' Secure;' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=0`;
}

export function stateCookie(value: string, url: URL): string {
  const secure = url.protocol === 'https:' ? ' Secure;' : '';
  return `${OAUTH_STATE_COOKIE}=${value}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=600`;
}

export function clearedStateCookie(url: URL): string {
  const secure = url.protocol === 'https:' ? ' Secure;' : '';
  return `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=0`;
}

/**
 * Parks a pending device-grant sign-in — same shape as the OAuth state cookie,
 * because it is the same job: an HttpOnly holding pen for a flow secret the
 * page must never see. `maxAge` comes from Discord's `expires_in` rather than
 * a constant, so the cookie dies with the code it carries.
 */
export function deviceGrantCookie(value: string, url: URL, maxAge: number): string {
  const secure = url.protocol === 'https:' ? ' Secure;' : '';
  return `${DEVICE_GRANT_COOKIE}=${value}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${Math.max(60, Math.floor(maxAge))}`;
}

export function clearedDeviceGrantCookie(url: URL): string {
  const secure = url.protocol === 'https:' ? ' Secure;' : '';
  return `${DEVICE_GRANT_COOKIE}=; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=0`;
}

/**
 * Mints a session and returns the cookie token.
 *
 * `userAgent` is accepted and **deliberately not stored** (admin audit,
 * 2026-10). `sessions.user_agent_hash` used to get half a SHA-256 of it, and
 * nothing ever read the value back. The one use it could have is binding a
 * session to a browser — refuse the cookie once the hash stops matching — and
 * that is the wrong trade here: a user agent string changes on every browser
 * update, so members on auto-updating phones would be signed out at random,
 * while a stolen cookie travels with whatever user agent the thief sends.
 * Writing a fingerprint nobody reads is collecting data for nothing, so the
 * column is left NULL and kept (dropping it is a migration, for no gain).
 *
 * The parameter stays so the four sign-in routes and the test factory need not
 * change shape; remove it together with the column if that ever happens.
 */
export async function createSession(
  db: D1Database,
  userId: number,
  userAgent?: string | null,
): Promise<string> {
  void userAgent;
  const token = randomToken();
  await db
    .prepare(
      'INSERT INTO sessions (id, user_id, expires_at, user_agent_hash) VALUES (?1, ?2, ?3, NULL)',
    )
    .bind(await sha256(token), userId, isoIn(SESSION_TTL_SECONDS))
    .run();
  return token;
}

interface SessionRow {
  session_id: string;
  expires_at: string;
  id: number;
  discord_id: string;
  username: string;
  global_name: string | null;
  avatar_hash: string | null;
  role: Role;
  team: Team | null;
  trainer_name: string | null;
  trainer_level: number | null;
  is_banned: number;
}

/** A resolved session: who it is, and when its row currently expires. */
export interface ResolvedSession {
  user: SessionUser;
  /** `sessions.expires_at` as read, for `slideDue`. */
  expiresAt: string;
}

/**
 * Resolve a session cookie to a user. Returns undefined for missing, expired,
 * unknown, or banned sessions.
 *
 * The shape every caller but the middleware wants. The middleware also needs
 * the row's expiry, to decide whether to re-issue the cookie, and asks
 * `resolveSession` instead — the same single query either way.
 */
export async function getSessionUser(
  db: D1Database,
  token: string | undefined,
): Promise<SessionUser | undefined> {
  return (await resolveSession(db, token))?.user;
}

/** `getSessionUser`, plus the row's `expires_at`. Same refusals, same query. */
export async function resolveSession(
  db: D1Database,
  token: string | undefined,
): Promise<ResolvedSession | undefined> {
  if (!token) return undefined;

  const row = await db
    .prepare(
      `SELECT s.id AS session_id, s.expires_at,
              u.id, u.discord_id, u.username, u.global_name, u.avatar_hash,
              u.role, u.team, u.trainer_name, u.trainer_level, u.is_banned
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = ?1`,
    )
    .bind(await sha256(token))
    .first<SessionRow>();

  if (!row) return undefined;

  if (row.expires_at <= new Date().toISOString()) {
    await db.prepare('DELETE FROM sessions WHERE id = ?1').bind(row.session_id).run();
    return undefined;
  }

  if (row.is_banned === 1) return undefined;

  return {
    user: {
      id: row.id,
      discordId: row.discord_id,
      username: row.username,
      displayName: row.global_name ?? row.username,
      avatarUrl: avatarUrl(row.discord_id, row.avatar_hash),
      role: row.role,
      team: row.team,
      trainerName: row.trainer_name,
      trainerLevel: row.trainer_level,
    },
    expiresAt: row.expires_at,
  };
}

/**
 * Whether a session expiring at `expiresAt` has aged past the slide interval.
 *
 * The one statement of the rule, shared by `touchSession` and the middleware,
 * so the D1 write and the re-issued cookie can never be decided differently.
 * Pure, so the middleware can decide before the response exists. Renew once
 * the session has aged by a day, rather than waiting until it is nearly dead:
 * same write volume — at most one a day — but the fortnight is a rolling
 * window instead of a deadline. An unparseable value is never due.
 */
export function slideDue(expiresAt: string, now: number = Date.now()): boolean {
  const expires = Date.parse(expiresAt);
  if (Number.isNaN(expires)) return false;
  return expires - now <= (SESSION_TTL_SECONDS - SLIDE_INTERVAL_SECONDS) * 1000;
}

/** Pushes the row back to a full fortnight. The caller has decided it is due. */
export async function renewSession(db: D1Database, token: string): Promise<void> {
  await db
    .prepare('UPDATE sessions SET expires_at = ?2 WHERE id = ?1')
    .bind(await sha256(token), isoIn(SESSION_TTL_SECONDS))
    .run();
}

/**
 * Push the expiry back so active users are not logged out mid-session, reading
 * the row first to decide.
 *
 * The middleware no longer calls this: it already holds `expires_at` from
 * `resolveSession` and has to know the answer before the response leaves, in
 * order to re-issue the cookie, so it uses `slideDue` and `renewSession`
 * directly. Kept for a caller that holds only a token.
 */
export async function touchSession(db: D1Database, token: string): Promise<void> {
  const row = await db
    .prepare('SELECT expires_at FROM sessions WHERE id = ?1')
    .bind(await sha256(token))
    .first<{ expires_at: string }>();
  if (!row || !slideDue(row.expires_at)) return;

  await renewSession(db, token);
}

export async function destroySession(db: D1Database, token: string | undefined): Promise<void> {
  if (!token) return;
  await db.prepare('DELETE FROM sessions WHERE id = ?1').bind(await sha256(token)).run();
}

/**
 * Bulk-delete lapsed sessions.
 *
 * `getSessionUser` clears a lapsed row lazily, when somebody presents its
 * cookie. That is correct but not exhaustive: a row whose owner never returns
 * would stay forever. Harmless — an expired row can never authenticate — but
 * the table only grew. This was written for a cron trigger that was removed
 * deliberately (vault/Why there is no cron.md) and sat uncalled until the
 * admin audit, 2026-10.
 *
 * Wired up rather than deleted, in the shape this codebase uses instead of
 * cron — the work rides an ordinary request, as the announcement and flare
 * sweeps do. See `maybePruneExpiredSessions`. `idx_sessions_expiry` makes the
 * DELETE an index range rather than a scan.
 */
export async function pruneExpiredSessions(db: D1Database): Promise<number> {
  const res = await db
    .prepare("DELETE FROM sessions WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')")
    .run();
  return res.meta.changes ?? 0;
}

/**
 * One request in this many that carries a session cookie also sweeps lapsed
 * rows. Nothing lapsed can sign in, so the sweep is not urgent: it only has to
 * run often enough that the table stops growing, and rarely enough to be
 * invisible in D1's free-plan write budget. A few hundred signed-in requests a
 * day comes to a handful of sweeps a day.
 */
export const PRUNE_ONE_IN = 50;

/**
 * The read-path sweep: prunes when `roll` (a `Math.random()` in [0, 1)) lands
 * in the bottom 1/`PRUNE_ONE_IN`.
 *
 * A probability rather than a clock, because a clock needs somewhere to
 * remember when it last ran — a KV write on every check, to save a D1 write
 * now and then. `roll` is a parameter so a test can pin both outcomes without
 * stubbing `Math`. Returns how many rows went, or null when the roll said no.
 */
export async function maybePruneExpiredSessions(
  db: D1Database,
  roll: number = Math.random(),
): Promise<number | null> {
  if (!(roll < 1 / PRUNE_ONE_IN)) return null;
  return pruneExpiredSessions(db);
}
