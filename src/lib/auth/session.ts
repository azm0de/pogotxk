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

/** Sessions last two weeks, and any use inside that window slides them forward. */
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
/**
 * How stale a session may get before use renews it.
 *
 * This exists to bound writes, not to bound the session: renewing on literally
 * every request would mean a D1 write per page view. Once a day is plenty.
 *
 * It previously read as "only renew when less than a day REMAINS", which made
 * the fortnight a hard deadline rather than a rolling window — the comment
 * above said sessions slid forward on use, and they did not. Anyone who did not
 * happen to open the site during the final 24 hours of the two weeks was signed
 * out and sent back through Discord. That is a sign-in prompt nobody could
 * predict or avoid, and on Android it is the expensive kind: Discord will not
 * hand OAuth to its own app, so every one of those costs a browser login.
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

export async function createSession(
  db: D1Database,
  userId: number,
  userAgent: string | null,
): Promise<string> {
  const token = randomToken();
  await db
    .prepare(
      'INSERT INTO sessions (id, user_id, expires_at, user_agent_hash) VALUES (?1, ?2, ?3, ?4)',
    )
    .bind(
      await sha256(token),
      userId,
      isoIn(SESSION_TTL_SECONDS),
      userAgent ? (await sha256(userAgent)).slice(0, 32) : null,
    )
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

/**
 * Resolve a session cookie to a user. Returns undefined for missing, expired,
 * unknown, or banned sessions.
 */
export async function getSessionUser(
  db: D1Database,
  token: string | undefined,
): Promise<SessionUser | undefined> {
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
    id: row.id,
    discordId: row.discord_id,
    username: row.username,
    displayName: row.global_name ?? row.username,
    avatarUrl: avatarUrl(row.discord_id, row.avatar_hash),
    role: row.role,
    team: row.team,
    trainerName: row.trainer_name,
    trainerLevel: row.trainer_level,
  };
}

/**
 * Push the expiry back so active users are not logged out mid-session. Only
 * writes when the session is close to lapsing, to keep this off the hot path.
 */
export async function touchSession(db: D1Database, token: string): Promise<void> {
  const id = await sha256(token);
  const row = await db
    .prepare('SELECT expires_at FROM sessions WHERE id = ?1')
    .bind(id)
    .first<{ expires_at: string }>();
  if (!row) return;

  // Renew once the session has aged by a day, rather than waiting until it is
  // nearly dead. Same write volume — at most one a day — but the fortnight
  // becomes a genuinely rolling window instead of a deadline.
  const remaining = Date.parse(row.expires_at) - Date.now();
  if (remaining > (SESSION_TTL_SECONDS - SLIDE_INTERVAL_SECONDS) * 1000) return;

  await db
    .prepare('UPDATE sessions SET expires_at = ?2 WHERE id = ?1')
    .bind(id, isoIn(SESSION_TTL_SECONDS))
    .run();
}

export async function destroySession(db: D1Database, token: string | undefined): Promise<void> {
  if (!token) return;
  await db.prepare('DELETE FROM sessions WHERE id = ?1').bind(await sha256(token)).run();
}

/** Housekeeping for the cron trigger. */
export async function pruneExpiredSessions(db: D1Database): Promise<number> {
  const res = await db
    .prepare("DELETE FROM sessions WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')")
    .run();
  return res.meta.changes ?? 0;
}
