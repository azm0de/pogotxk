/**
 * `fetchGuildRoles` and `upsertUser` — the two functions that decide what a
 * sign-in is allowed to do to somebody's role.
 *
 * They are tested together because the guarantee only exists in the pair. The
 * lookup's job is to distinguish "Discord says they are not a member" from "we
 * never asked", and the upsert's job is to overwrite the stored role in the
 * first case and leave it alone in the second. Collapse either half and one of
 * two regressions follows, both of which have a name in this repo:
 *
 * - **The two nulls.** `{ known: false }` and `{ known: true, roles: null }`
 *   were once the same value, so leaving the Discord server cost nobody their
 *   role — "not a member" was indistinguishable from "not configured", and the
 *   stored role stood forever.
 * - **The demoted admin.** Writing the resolved role back unconditionally
 *   demotes a hand-promoted admin to guest on their next sign-in, which is
 *   precisely the account used to wire the guild up in the first place.
 */

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { fetchGuildRoles, upsertUser, type DiscordUser } from '~/lib/auth/discord';
import { getSessionUser, OAUTH_STATE_COOKIE, SESSION_COOKIE } from '~/lib/auth/session';
import type { Role } from '~/lib/auth/types';
import { mockDiscord } from '../helpers/discord-mock';
import { seedUser } from '../helpers/factories';

const GUILD = 'test-guild-id';
const ORIGIN = 'https://pogotxk.test';
const DISCORD_ID = '100000000000000001';

const TOKEN = 'test-access-token';

function discordUser(over: Partial<DiscordUser> = {}): DiscordUser {
  return { id: DISCORD_ID, username: 'testtrainer', global_name: null, avatar: null, ...over };
}

describe('fetchGuildRoles', () => {
  it('asks nothing when no guild is configured', async () => {
    const discord = mockDiscord();

    // Not `{ known: true, roles: null }`. The caller reads `known` to decide
    // whether Discord is allowed to set the role at all, and "we did not ask"
    // must never authorise a demotion.
    expect(await fetchGuildRoles(TOKEN, undefined)).toEqual({ known: false });
    expect(await fetchGuildRoles(TOKEN, '')).toEqual({ known: false });
    discord.assertNotCalled();
  });

  it('reads a 404 as an answer: not a member', async () => {
    mockDiscord().memberNotFound(GUILD);

    // `known: true` is the load-bearing half. This is Discord telling us
    // something, and it has to be authoritative or leaving the server would
    // never cost anyone their role.
    expect(await fetchGuildRoles(TOKEN, GUILD)).toEqual({ known: true, roles: null });
  });

  it('returns the roles a member holds', async () => {
    mockDiscord().memberOk(GUILD, ['ROLE_A', 'ROLE_B']);

    expect(await fetchGuildRoles(TOKEN, GUILD)).toEqual({
      known: true,
      roles: ['ROLE_A', 'ROLE_B'],
    });
  });

  it('returns an empty array for a member with no roles', async () => {
    mockDiscord().memberOk(GUILD, []);

    expect(await fetchGuildRoles(TOKEN, GUILD)).toEqual({ known: true, roles: [] });
  });

  it('returns an empty array when the answer omits roles entirely', async () => {
    // `roles: undefined` must not reach `resolveRole`, which reads `null` as
    // "not a member" — a missing field would silently become a demotion.
    // `mockDiscord` always sends the key, so this one stubs `fetch` directly.
    vi.stubGlobal('fetch', async () =>
      Response.json({ user: { id: DISCORD_ID }, nick: null }, { status: 200 }),
    );

    expect(await fetchGuildRoles(TOKEN, GUILD)).toEqual({ known: true, roles: [] });
  });

  it.each([401, 403, 429, 500, 502])('throws on %d rather than guessing', async (status) => {
    // Anything that is not an answer has to stop the sign-in. Reading a 500 as
    // "not a member" would demote the whole guild for the length of an outage.
    mockDiscord().memberFails(GUILD, status);

    await expect(fetchGuildRoles(TOKEN, GUILD)).rejects.toThrow(
      `Discord guild member lookup failed (${status})`,
    );
  });

  it('presents the access token as a bearer', async () => {
    const discord = mockDiscord().memberOk(GUILD);

    await fetchGuildRoles('a-token', GUILD);

    const call = discord.assertCalled(`/guilds/${GUILD}/member`);
    expect(call.method).toBe('GET');
    expect(call.headers.authorization).toBe('Bearer a-token');
  });
});

describe('upsertUser', () => {
  async function roleOf(discordId: string): Promise<Role | undefined> {
    const row = await env.DB.prepare('SELECT role FROM users WHERE discord_id = ?1')
      .bind(discordId)
      .first<{ role: Role }>();
    return row?.role;
  }

  it('inserts an account that has never signed in', async () => {
    const result = await upsertUser(env.DB, discordUser(), 'member', true);

    expect(result.role).toBe('member');
    expect(result.isBanned).toBe(false);
    expect(await roleOf(DISCORD_ID)).toBe('member');
  });

  it('overwrites the stored role when Discord was authoritative', async () => {
    await seedUser(env.DB, { discordId: DISCORD_ID, role: 'admin' });

    // Discord answered for a configured guild and this person is no longer an
    // admin there. That answer wins, or a role removed in Discord never takes
    // effect on the site.
    const result = await upsertUser(env.DB, discordUser(), 'member', true);

    expect(result.role).toBe('member');
    expect(await roleOf(DISCORD_ID)).toBe('member');
  });

  it('demotes to guest when Discord authoritatively says "not a member"', async () => {
    await seedUser(env.DB, { discordId: DISCORD_ID, role: 'ambassador' });

    await upsertUser(env.DB, discordUser(), 'guest', true);

    expect(await roleOf(DISCORD_ID)).toBe('guest');
  });

  it('leaves the stored role alone when Discord was not authoritative', async () => {
    await seedUser(env.DB, { discordId: DISCORD_ID, role: 'admin' });

    // No guild configured, so `resolveRole` could only ever have answered
    // 'guest'. Writing that back is how the first admin loses the console.
    const result = await upsertUser(env.DB, discordUser(), 'guest', false);

    expect(result.role).toBe('admin');
    expect(await roleOf(DISCORD_ID)).toBe('admin');
  });

  it('re-syncs the profile on every sign-in, authoritative or not', async () => {
    await seedUser(env.DB, {
      discordId: DISCORD_ID,
      username: 'oldname',
      globalName: 'Old Name',
      avatarHash: 'oldhash',
      role: 'admin',
    });

    await upsertUser(
      env.DB,
      discordUser({ username: 'newname', global_name: 'New Name', avatar: 'a_newhash' }),
      'guest',
      false,
    );

    const row = await env.DB.prepare(
      'SELECT username, global_name, avatar_hash, role FROM users WHERE discord_id = ?1',
    )
      .bind(DISCORD_ID)
      .first<{ username: string; global_name: string; avatar_hash: string; role: Role }>();

    // Profile follows Discord; role does not. The two rules are independent and
    // this is the case where they disagree.
    expect(row?.username).toBe('newname');
    expect(row?.global_name).toBe('New Name');
    expect(row?.avatar_hash).toBe('a_newhash');
    expect(row?.role).toBe('admin');
  });

  it('never touches the fields this site owns', async () => {
    await seedUser(env.DB, {
      discordId: DISCORD_ID,
      team: 'mystic',
      trainerName: 'AshK',
      trainerCode: '1234 5678 9012',
      trainerLevel: 42,
    });

    await upsertUser(env.DB, discordUser(), 'member', true);

    const row = await env.DB.prepare(
      'SELECT team, trainer_name, trainer_code, trainer_level FROM users WHERE discord_id = ?1',
    )
      .bind(DISCORD_ID)
      .first<Record<string, unknown>>();

    expect(row).toMatchObject({
      team: 'mystic',
      trainer_name: 'AshK',
      trainer_code: '1234 5678 9012',
      trainer_level: 42,
    });
  });

  it('reports a ban rather than clearing it', async () => {
    await seedUser(env.DB, { discordId: DISCORD_ID, isBanned: true, banReason: 'spoofing' });

    const result = await upsertUser(env.DB, discordUser(), 'member', true);

    expect(result.isBanned).toBe(true);
    const row = await env.DB.prepare('SELECT is_banned, ban_reason FROM users WHERE discord_id = ?1')
      .bind(DISCORD_ID)
      .first<{ is_banned: number; ban_reason: string }>();
    expect(row?.is_banned).toBe(1);
    expect(row?.ban_reason).toBe('spoofing');
  });

  it('stamps last_seen_at', async () => {
    const user = await seedUser(env.DB, { discordId: DISCORD_ID, lastSeenAt: null });
    expect(user.last_seen_at).toBeNull();

    await upsertUser(env.DB, discordUser(), 'member', true);

    const row = await env.DB.prepare('SELECT last_seen_at FROM users WHERE discord_id = ?1')
      .bind(DISCORD_ID)
      .first<{ last_seen_at: string | null }>();
    expect(row?.last_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('matches on discord_id, not on username', async () => {
    // Discord usernames are changeable; the snowflake is not. Two accounts
    // sharing a display name must stay two rows.
    await seedUser(env.DB, { discordId: '900', username: 'testtrainer', role: 'admin' });

    await upsertUser(env.DB, discordUser(), 'member', true);

    const { results } = await env.DB.prepare('SELECT discord_id, role FROM users ORDER BY id').all<{
      discord_id: string;
      role: Role;
    }>();
    expect(results).toEqual([
      { discord_id: '900', role: 'admin' },
      { discord_id: DISCORD_ID, role: 'member' },
    ]);
  });
});

/**
 * The rule the two functions compose into, exercised through the route that
 * uses it. Unit tests can show `upsertUser` honours `authoritative`; only this
 * shows the callback computes it correctly from what the lookup returned.
 */
describe('the authoritative rule, end to end through /auth/callback', () => {
  const STATE = 'state-abc';

  function stateCookie(next = '/'): string {
    const payload = btoa(JSON.stringify({ state: STATE, verifier: 'v', next }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return `${OAUTH_STATE_COOKIE}=${payload}`;
  }

  async function signIn(): Promise<Response> {
    return SELF.fetch(`${ORIGIN}/auth/callback?code=c&state=${STATE}`, {
      headers: { cookie: stateCookie() },
      redirect: 'manual',
    });
  }

  async function roleAfter(res: Response): Promise<Role | undefined> {
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    const token = cookie?.slice(SESSION_COOKIE.length + 1).split(';')[0];
    return token ? (await getSessionUser(env.DB, token))?.role : undefined;
  }

  it('keeps a hand-promoted admin when no guild is configured', async () => {
    const bag = env as unknown as Record<string, string>;
    const saved = bag.DISCORD_GUILD_ID;
    bag.DISCORD_GUILD_ID = '';

    try {
      mockDiscord().tokenOk().userOk();
      await seedUser(env.DB, { discordId: DISCORD_ID, role: 'admin' });

      // No guild means no lookup, which means `resolveRole` can only answer
      // 'guest'. That answer is not authoritative and must not be written.
      expect(await roleAfter(await signIn())).toBe('admin');
    } finally {
      bag.DISCORD_GUILD_ID = saved!;
    }
  });

  it('demotes an admin who has left the Discord', async () => {
    mockDiscord().tokenOk().userOk().memberNotFound(GUILD);
    await seedUser(env.DB, { discordId: DISCORD_ID, role: 'admin' });

    // The other side of the same coin, and the reason the two nulls have to
    // stay apart: this answer *is* authoritative.
    expect(await roleAfter(await signIn())).toBe('guest');
  });

  it('promotes the bootstrap admin with no guild at all', async () => {
    const bag = env as unknown as Record<string, string>;
    const savedGuild = bag.DISCORD_GUILD_ID;
    const savedBootstrap = bag.DISCORD_BOOTSTRAP_ADMIN_ID;
    bag.DISCORD_GUILD_ID = '';
    bag.DISCORD_BOOTSTRAP_ADMIN_ID = DISCORD_ID;

    try {
      mockDiscord().tokenOk().userOk();

      // How a fresh deployment reaches the admin console before the Discord
      // server has been wired up at all.
      expect(await roleAfter(await signIn())).toBe('admin');
    } finally {
      bag.DISCORD_GUILD_ID = savedGuild!;
      bag.DISCORD_BOOTSTRAP_ADMIN_ID = savedBootstrap!;
    }
  });

  it('leaves everyone else a guest while the bootstrap admin is set', async () => {
    const bag = env as unknown as Record<string, string>;
    const savedGuild = bag.DISCORD_GUILD_ID;
    const savedBootstrap = bag.DISCORD_BOOTSTRAP_ADMIN_ID;
    bag.DISCORD_GUILD_ID = '';
    bag.DISCORD_BOOTSTRAP_ADMIN_ID = '999999999999999999';

    try {
      mockDiscord().tokenOk().userOk();

      // A brand-new row, so there is no stored role to preserve: the
      // non-authoritative 'guest' is what gets inserted.
      expect(await roleAfter(await signIn())).toBe('guest');
    } finally {
      bag.DISCORD_GUILD_ID = savedGuild!;
      bag.DISCORD_BOOTSTRAP_ADMIN_ID = savedBootstrap!;
    }
  });
});
