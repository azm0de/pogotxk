/**
 * `/api/account` DELETE and `/api/me.json` — the two endpoints that read and
 * end an account.
 *
 * Deletion is the interesting one, because "delete" here does not mean what the
 * word usually means and the difference is deliberate. The `users` row is
 * anonymised in place rather than removed: flares, RSVPs and the change log all
 * point at `users.id` with a mix of `SET NULL` and `CASCADE`, and destroying
 * other people's history to satisfy one person's request is worse than
 * unlinking it from them. So these tests assert both halves — that nothing can
 * still act as the account, and that the community history it is attached to is
 * still there.
 *
 * The irreversibility test is the one to keep. `anonymizedIdentity` writes a
 * `discord_id` of `deleted:<id>`, which cannot collide with a Discord snowflake
 * and therefore can never match `upsertUser`'s `ON CONFLICT (discord_id)`
 * again. Signing back in with the same real Discord account has to produce a
 * new row, not resurrect this one.
 */

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { OAUTH_STATE_COOKIE, SESSION_COOKIE } from '~/lib/auth/session';
import { mockDiscord } from '../helpers/discord-mock';
import { asToken, asUser, authCookie, seedFlare, seedSession, seedUser } from '../helpers/factories';

const ORIGIN = 'https://pogotxk.test';
const ACCOUNT = `${ORIGIN}/api/account`;
const ME = `${ORIGIN}/api/me.json`;
const GUILD = 'test-guild-id';
const DISCORD_ID = '100000000000000001';

interface MeBody {
  user: {
    id: number;
    discordId: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    role: string;
    team: string | null;
    trainerName: string | null;
    trainerLevel: number | null;
  } | null;
}

/** Astro's CSRF origin check covers DELETE as well as POST. */
function del(token?: string): Promise<Response> {
  const headers = new Headers({ origin: ORIGIN });
  if (token) headers.set('cookie', authCookie(token));
  return SELF.fetch(ACCOUNT, { method: 'DELETE', headers, redirect: 'manual' });
}

async function userRow(id: number): Promise<Record<string, unknown> | null> {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?1')
    .bind(id)
    .first<Record<string, unknown>>();
}

async function count(table: string, where = '1=1'): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

describe('DELETE /api/account', () => {
  it('refuses a signed-out caller', async () => {
    const res = await del();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Sign in required' });
  });

  it('refuses a caller whose session has lapsed', async () => {
    const user = await seedUser(env.DB);
    const token = await seedSession(env.DB, user, { expiresAt: '2020-01-01T00:00:00Z' });

    expect((await del(token)).status).toBe(401);
    // And the account is untouched.
    expect((await userRow(user.id))?.username).toBe(user.username);
  });

  it('anonymises the row rather than removing it', async () => {
    const user = await seedUser(env.DB, {
      username: 'ashk',
      globalName: 'Ash Ketchum',
      avatarHash: 'a_hash',
      team: 'mystic',
      trainerName: 'AshK',
      trainerCode: '1234 5678 9012',
      trainerLevel: 42,
      role: 'ambassador',
    });
    const token = await seedSession(env.DB, user);

    const res = await del(token);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const row = await userRow(user.id);
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      discord_id: `deleted:${user.id}`,
      username: 'Deleted user',
      global_name: null,
      avatar_hash: null,
      team: null,
      trainer_code: null,
      trainer_level: null,
      trainer_name: null,
      role: 'guest',
    });
  });

  it('clears the cookie the request arrived on', async () => {
    const user = await seedUser(env.DB);

    const res = await del(await seedSession(env.DB, user));

    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(cookie).toContain('Max-Age=0');
  });

  it('drops every session the account had, not only this one', async () => {
    const user = await seedUser(env.DB);
    const phone = await seedSession(env.DB, user);
    await seedSession(env.DB, user);
    await seedSession(env.DB, user);

    await del(phone);

    // A plain UPDATE does not cascade the way a row DELETE would, so the
    // sessions have to be taken out by hand — and all of them, or the laptop
    // still signed in elsewhere keeps acting as the deleted account.
    expect(await count('sessions')).toBe(0);
  });

  it('leaves other people signed in', async () => {
    const mine = await seedUser(env.DB);
    const theirs = await seedUser(env.DB, { username: 'misty' });
    const theirToken = await seedSession(env.DB, theirs);

    await del(await seedSession(env.DB, mine));

    const res = await SELF.fetch(asToken(theirToken, ME));
    expect(((await res.json()) as MeBody).user?.username).toBe('misty');
  });

  it('unsubscribes the account from push', async () => {
    const user = await seedUser(env.DB);
    await env.DB.prepare(
      'INSERT INTO push_subs (user_id, endpoint, p256dh, auth) VALUES (?1, ?2, ?3, ?4)',
    )
      .bind(user.id, 'https://push.example/endpoint-1', 'key', 'auth')
      .run();

    await del(await seedSession(env.DB, user));

    // Nothing should still be able to page a deleted account.
    expect(await count('push_subs')).toBe(0);
  });

  it('keeps the community history the account is attached to', async () => {
    const user = await seedUser(env.DB);
    const flare = await seedFlare(env.DB, { createdBy: user.id, note: 'Mewtwo at the park' });

    await del(await seedSession(env.DB, user));

    const row = await env.DB.prepare('SELECT created_by, note FROM flares WHERE id = ?1')
      .bind(flare.id)
      .first<{ created_by: number | null; note: string }>();

    // Still there, still pointing at the id — which now resolves to "Deleted
    // user" with no Discord identity behind it. That is the promise privacy.astro
    // already makes about the change log.
    expect(row?.note).toBe('Mewtwo at the park');
    expect(row?.created_by).toBe(user.id);
  });

  it('cannot be undone by signing back in', async () => {
    const user = await seedUser(env.DB, { discordId: DISCORD_ID, role: 'admin' });
    await del(await seedSession(env.DB, user));

    // Same real Discord account, arriving through the ordinary callback.
    mockDiscord().tokenOk().userOk().memberOk(GUILD);
    const state = btoa(JSON.stringify({ state: 's', verifier: 'v', next: '/' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const res = await SELF.fetch(`${ORIGIN}/auth/callback?code=c&state=s`, {
      headers: { cookie: `${OAUTH_STATE_COOKIE}=${state}` },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);

    // A brand new row, because `deleted:<id>` can never match the conflict
    // target again. The old row keeps its anonymity and its history.
    const { results } = await env.DB.prepare(
      'SELECT id, discord_id, role FROM users ORDER BY id',
    ).all<{ id: number; discord_id: string; role: string }>();

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ discord_id: `deleted:${user.id}`, role: 'guest' });
    expect(results[1]).toMatchObject({ discord_id: DISCORD_ID, role: 'member' });
  });

  it('is idempotent enough not to damage a second attempt', async () => {
    const user = await seedUser(env.DB);
    const token = await seedSession(env.DB, user);

    expect((await del(token)).status).toBe(200);
    // The session is gone with the first call, so the second is simply signed
    // out — not a 500, and not a second anonymisation of somebody else's row.
    expect((await del(token)).status).toBe(401);
    expect(await count('users')).toBe(1);
  });
});

describe('GET /api/me.json', () => {
  it('answers null when signed out', async () => {
    const res = await SELF.fetch(ME);

    expect(res.status).toBe(200);
    expect((await res.json()) as MeBody).toEqual({ user: null });
  });

  it('answers the whole session user when signed in', async () => {
    const user = await seedUser(env.DB, {
      discordId: '4242',
      username: 'ashk',
      globalName: 'Ash Ketchum',
      avatarHash: 'abc',
      role: 'ambassador',
      team: 'valor',
      trainerName: 'AshK',
      trainerLevel: 40,
    });

    const res = await SELF.fetch(await asUser(env.DB, user, ME));

    // The shape client islands are built against — every field, so a rename
    // cannot pass silently.
    expect(((await res.json()) as MeBody).user).toEqual({
      id: user.id,
      discordId: '4242',
      username: 'ashk',
      displayName: 'Ash Ketchum',
      avatarUrl: 'https://cdn.discordapp.com/avatars/4242/abc.png?size=128',
      role: 'ambassador',
      team: 'valor',
      trainerName: 'AshK',
      trainerLevel: 40,
    });
  });

  it('never carries the trainer code, which is not the browser’s business', async () => {
    const user = await seedUser(env.DB, { trainerCode: '1234 5678 9012' });

    const res = await SELF.fetch(await asUser(env.DB, user, ME));

    expect(await res.text()).not.toContain('1234 5678 9012');
  });

  it('answers null for a banned account', async () => {
    const user = await seedUser(env.DB, { isBanned: true });

    const res = await SELF.fetch(await asUser(env.DB, user, ME));

    expect(((await res.json()) as MeBody).user).toBeNull();
  });

  it('is never cached anywhere', async () => {
    const res = await SELF.fetch(ME);

    // Per-user and cheap to recompute. A shared cache holding this would serve
    // one member's identity to another.
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
