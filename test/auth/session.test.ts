/**
 * `src/lib/auth/session.ts`, which had no coverage at all despite being the
 * module every authenticated request runs through.
 *
 * Two of these tests exist because of specific incidents rather than for
 * symmetry:
 *
 * - **Banned must not delete the row.** `getSessionUser` returns undefined for
 *   a banned user and for an expired one, and the tempting simplification is to
 *   treat them the same way. It is wrong: deleting the session of someone who
 *   is banned would let them sign in again and get a fresh one, so the ban
 *   would read as "signed out" rather than "refused". The row staying put is
 *   the observable difference between the two branches.
 * - **The slide is measured from age, not from what remains.** See the comment
 *   at session.ts:17-30 — the renewal rule was once written the other way
 *   round, which quietly turned the rolling fortnight into a hard deadline.
 *   "Fresh session writes nothing" and "a day-old session slides" are the pair
 *   that tells those two readings apart.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  clearedDeviceGrantCookie,
  clearedSessionCookie,
  clearedStateCookie,
  createSession,
  deviceGrantCookie,
  getSessionUser,
  pruneExpiredSessions,
  sessionCookie,
  sha256,
  stateCookie,
  touchSession,
} from '~/lib/auth/session';
import { iso, isoIn, seedSession, seedUser, sessionIdFor } from '../helpers/factories';

const DAY = 60 * 60 * 24;

async function sessionCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>();
  return row?.n ?? 0;
}

async function expiryOf(token: string): Promise<string | undefined> {
  const row = await env.DB.prepare('SELECT expires_at FROM sessions WHERE id = ?1')
    .bind(await sessionIdFor(token))
    .first<{ expires_at: string }>();
  return row?.expires_at;
}

describe('getSessionUser', () => {
  it('resolves a live session to its user', async () => {
    const user = await seedUser(env.DB, { username: 'brock', role: 'ambassador' });
    const token = await seedSession(env.DB, user);

    const resolved = await getSessionUser(env.DB, token);

    expect(resolved?.id).toBe(user.id);
    expect(resolved?.role).toBe('ambassador');
  });

  it('returns undefined for no token', async () => {
    expect(await getSessionUser(env.DB, undefined)).toBeUndefined();
    expect(await getSessionUser(env.DB, '')).toBeUndefined();
  });

  it('returns undefined for a token whose hash is not in the table', async () => {
    await seedUser(env.DB);

    // Well-formed and completely unrelated — the shape a guessed or stale
    // cookie arrives in.
    expect(await getSessionUser(env.DB, 'f'.repeat(64))).toBeUndefined();
  });

  it('deletes the row for an expired session', async () => {
    const user = await seedUser(env.DB);
    const token = await seedSession(env.DB, user, { expiresAt: isoIn(-60) });

    expect(await getSessionUser(env.DB, token)).toBeUndefined();
    expect(await sessionCount()).toBe(0);
  });

  it('leaves the row in place for a banned user', async () => {
    const user = await seedUser(env.DB, { isBanned: true, banReason: 'spoofing' });
    const token = await seedSession(env.DB, user);

    expect(await getSessionUser(env.DB, token)).toBeUndefined();
    // Not housekeeping — see the file header. Deleting here would turn a ban
    // into a sign-out, and the next sign-in would hand back a working session.
    expect(await sessionCount()).toBe(1);
  });

  it('falls back to the username when global_name is null', async () => {
    const user = await seedUser(env.DB, { username: 'gary', globalName: null });
    const token = await seedSession(env.DB, user);

    expect((await getSessionUser(env.DB, token))?.displayName).toBe('gary');
  });

  it('prefers global_name when there is one', async () => {
    const user = await seedUser(env.DB, { username: 'gary', globalName: 'Blue' });
    const token = await seedSession(env.DB, user);

    expect((await getSessionUser(env.DB, token))?.displayName).toBe('Blue');
  });

  it('serves an animated avatar as .gif and a static one as .png', async () => {
    const animated = await seedUser(env.DB, { discordId: '11', avatarHash: 'a_deadbeef' });
    const still = await seedUser(env.DB, { discordId: '22', avatarHash: 'deadbeef' });

    const a = await getSessionUser(env.DB, await seedSession(env.DB, animated));
    const s = await getSessionUser(env.DB, await seedSession(env.DB, still));

    expect(a?.avatarUrl).toBe('https://cdn.discordapp.com/avatars/11/a_deadbeef.gif?size=128');
    expect(s?.avatarUrl).toBe('https://cdn.discordapp.com/avatars/22/deadbeef.png?size=128');
  });

  it('has no avatar url when the hash is null', async () => {
    const user = await seedUser(env.DB, { avatarHash: null });

    expect((await getSessionUser(env.DB, await seedSession(env.DB, user)))?.avatarUrl).toBeNull();
  });
});

describe('touchSession', () => {
  it('writes nothing for a session created moments ago', async () => {
    const user = await seedUser(env.DB);
    const token = await seedSession(env.DB, user);
    const before = await expiryOf(token);

    await touchSession(env.DB, token);

    expect(await expiryOf(token)).toBe(before);
  });

  it('slides a session that has aged past a day', async () => {
    const user = await seedUser(env.DB);
    // A fortnight minus a day and a minute of life left: one minute older than
    // the slide interval, so this is the first request that renews it.
    const token = await seedSession(env.DB, user, { expiresAt: isoIn(13 * DAY - 60) });
    const before = await expiryOf(token);

    await touchSession(env.DB, token);

    const after = await expiryOf(token);
    expect(after).not.toBe(before);
    // Back to a full fortnight, not merely nudged.
    expect(Date.parse(after!) - Date.now()).toBeGreaterThan((14 * DAY - 60) * 1000);
  });

  it('does not resurrect a session that is not there', async () => {
    await touchSession(env.DB, 'f'.repeat(64));

    expect(await sessionCount()).toBe(0);
  });
});

describe('createSession', () => {
  it('stores the hash of the token and never the token', async () => {
    const user = await seedUser(env.DB);
    const token = await createSession(env.DB, user.id, null);

    const row = await env.DB.prepare(
      'SELECT id, user_id, user_agent_hash FROM sessions',
    ).first<{ id: string; user_id: number; user_agent_hash: string | null }>();

    expect(row?.id).toBe(await sha256(token));
    expect(row?.id).not.toBe(token);
    expect(row?.user_id).toBe(user.id);
    expect(row?.user_agent_hash).toBeNull();
  });

  it('records a truncated hash of the user agent when one is given', async () => {
    const user = await seedUser(env.DB);
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)';
    await createSession(env.DB, user.id, ua);

    const row = await env.DB.prepare('SELECT user_agent_hash FROM sessions').first<{
      user_agent_hash: string | null;
    }>();

    expect(row?.user_agent_hash).toBe((await sha256(ua)).slice(0, 32));
    expect(row?.user_agent_hash).toHaveLength(32);
  });

  it('mints a different token every time', async () => {
    const user = await seedUser(env.DB);

    const a = await createSession(env.DB, user.id, null);
    const b = await createSession(env.DB, user.id, null);

    expect(a).not.toBe(b);
    expect(await sessionCount()).toBe(2);
  });
});

describe('cookie builders', () => {
  const https = new URL('https://pogotxk.test/auth/callback');
  const http = new URL('http://localhost:4321/auth/callback');

  /**
   * Every builder in the module, so a new one cannot be added without a test
   * deciding what it does about `Secure` — the flag is invisible when it is
   * wrong, because the cookie keeps working over https either way.
   */
  const builders: Array<[string, (url: URL) => string]> = [
    ['sessionCookie', (url) => sessionCookie('tok', url)],
    ['clearedSessionCookie', clearedSessionCookie],
    ['stateCookie', (url) => stateCookie('payload', url)],
    ['clearedStateCookie', clearedStateCookie],
    ['deviceGrantCookie', (url) => deviceGrantCookie('payload', url, 600)],
    ['clearedDeviceGrantCookie', clearedDeviceGrantCookie],
  ];

  it.each(builders)('%s is Secure over https', (_name, build) => {
    expect(build(https)).toContain('Secure');
  });

  it.each(builders)('%s drops Secure over http, so `astro dev` can sign in', (_name, build) => {
    expect(build(http)).not.toContain('Secure');
  });

  it.each(builders)('%s is HttpOnly and SameSite=Lax', (_name, build) => {
    // Lax rather than Strict throughout: the OAuth callback is a cross-site
    // top-level navigation and Strict would drop the cookie on the way back.
    expect(build(https)).toContain('HttpOnly');
    expect(build(https)).toContain('SameSite=Lax');
  });

  it('sets the session for a fortnight and clears it with Max-Age=0', () => {
    expect(sessionCookie('tok', https)).toContain(`Max-Age=${14 * DAY}`);
    expect(clearedSessionCookie(https)).toContain('Max-Age=0');
    expect(clearedSessionCookie(https)).toContain('pogotxk_session=;');
  });

  it('gives the OAuth state ten minutes', () => {
    expect(stateCookie('payload', https)).toContain('Max-Age=600');
  });
});

describe('deviceGrantCookie lifetime', () => {
  const url = new URL('https://pogotxk.test/auth/device');

  function maxAge(cookie: string): number {
    return Number(/Max-Age=(-?\d+)/.exec(cookie)?.[1]);
  }

  it('uses the expires_in Discord gave, as given', () => {
    expect(maxAge(deviceGrantCookie('p', url, 900))).toBe(900);
  });

  it.each([
    ['a negative lifetime', -1],
    ['zero', 0],
    ['less than the floor', 59],
  ])('clamps %s up to sixty seconds', (_label, seconds) => {
    // A cookie shorter than the poll interval would expire between two ticks of
    // the device page and read as "expired" when the member simply had not
    // approved yet.
    expect(maxAge(deviceGrantCookie('p', url, seconds))).toBe(60);
  });

  it('floors a fractional lifetime rather than emitting a decimal Max-Age', () => {
    // `Max-Age=599.9` is not a valid cookie attribute; browsers discard the
    // whole cookie rather than rounding it.
    expect(maxAge(deviceGrantCookie('p', url, 599.9))).toBe(599);
    expect(deviceGrantCookie('p', url, 599.9)).not.toContain('.');
  });

  it('keeps the floor over a fractional value below it', () => {
    expect(maxAge(deviceGrantCookie('p', url, 0.5))).toBe(60);
  });
});

/**
 * Two things that work and that nothing uses. Pinned rather than endorsed: if
 * either is ever wired up, these say what it already does; if either is deleted
 * instead, deleting the tests with it is the honest change.
 *
 * - `pruneExpiredSessions` is written for a cron trigger that does not exist.
 *   `wrangler.jsonc` has no `crons`, and the built entry exports no
 *   `scheduled()` — it says so itself, in the comment explaining why the
 *   trigger was removed. Nothing calls this function anywhere in the repo.
 * - `sessions.user_agent_hash` is written by `createSession` and read by
 *   nothing. There is no "your sessions" screen and no device list.
 *
 * Neither is a leak: `getSessionUser` deletes an expired row the moment it is
 * presented, so the table accumulates only sessions nobody ever comes back to.
 */
describe('written, correct, and called by nothing', () => {
  it('pruneExpiredSessions removes exactly the lapsed rows', async () => {
    const user = await seedUser(env.DB);
    await seedSession(env.DB, user, { expiresAt: isoIn(-3600) });
    await seedSession(env.DB, user, { expiresAt: isoIn(-1) });
    const live = await seedSession(env.DB, user);

    const removed = await pruneExpiredSessions(env.DB);

    expect(removed).toBe(2);
    expect(await sessionCount()).toBe(1);
    expect(await getSessionUser(env.DB, live)).toBeDefined();
  });

  it('pruneExpiredSessions reports zero on an empty table', async () => {
    expect(await pruneExpiredSessions(env.DB)).toBe(0);
  });

  it('the user agent hash is stored but nothing resolves it back', async () => {
    const user = await seedUser(env.DB);
    const ua = 'Mozilla/5.0 (iPhone)';
    await createSession(env.DB, user.id, ua);

    // Truncated to 32 hex characters — half a SHA-256, which is a fingerprint
    // and not a reversible record of the device.
    const row = await env.DB.prepare('SELECT user_agent_hash FROM sessions').first<{
      user_agent_hash: string;
    }>();
    expect(row?.user_agent_hash).not.toContain(ua);
    expect(row?.user_agent_hash).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('a seeded session row matches the schema the app writes', () => {
  it('uses the timestamp shape every comparison in this suite assumes', async () => {
    const user = await seedUser(env.DB);
    await seedSession(env.DB, user);

    const row = await env.DB.prepare('SELECT created_at, expires_at FROM sessions').first<{
      created_at: string;
      expires_at: string;
    }>();

    // Comparisons in this schema are lexicographic on TEXT, so a stray `.000`
    // in either column sorts wrong against `iso()`.
    expect(row?.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(row!.created_at <= iso()).toBe(true);
  });
});
