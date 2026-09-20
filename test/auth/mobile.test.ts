/**
 * `/api/auth/mobile` — the half of the Android sign-in that cannot happen on
 * the phone, because finishing the exchange needs the client secret and a
 * secret shipped inside an APK is not a secret.
 *
 * The assertion this route exists for is the `redirect_uri`. The app authorises
 * against a custom scheme rather than a URL, Discord requires the token
 * exchange to repeat what authorize time used **byte for byte**, and the shape
 * is Discord's own — `discord-<application id>:/authorize/callback`, with one
 * slash after the colon, not two. Get a character wrong and every Android
 * sign-in fails with an error that says nothing about which character.
 *
 * There is no CSRF state check here and that is deliberate: the flow began in a
 * native app, so there is no cookie to compare against. PKCE replaces it, which
 * is why the verifier is mandatory rather than optional — hence the block of
 * tests on rejecting a missing or malformed one.
 */

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { mobileRedirectUri } from '~/lib/auth/discord';
import { getSessionUser, SESSION_COOKIE } from '~/lib/auth/session';
import { mockDiscord } from '../helpers/discord-mock';
import { seedUser } from '../helpers/factories';

const ORIGIN = 'https://pogotxk.test';
const GUILD = 'test-guild-id';
const CLIENT_ID = 'test-client-id';
const DISCORD_ID = '100000000000000001';

const VALID = { code: 'the-code', verifier: 'the-verifier' };

function post(body?: unknown, raw?: string): Promise<Response> {
  const headers = new Headers({ origin: ORIGIN, 'content-type': 'application/json' });
  return SELF.fetch(`${ORIGIN}/api/auth/mobile`, {
    method: 'POST',
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

function sessionTokenOf(res: Response): string | undefined {
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  const value = cookie?.slice(SESSION_COOKIE.length + 1).split(';')[0];
  return value ? value : undefined;
}

async function errorOf(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { error?: string }).error;
}

describe('the redirect_uri the app authorised against', () => {
  it('is the custom scheme, with one slash after the colon', () => {
    // Written out in full rather than rebuilt from the helper, because the
    // helper is the thing under test. Two slashes here would make Discord read
    // `authorize` as a host.
    expect(mobileRedirectUri({ clientId: CLIENT_ID, clientSecret: 's' })).toBe(
      'discord-test-client-id:/authorize/callback',
    );
  });

  it('is repeated byte for byte in the exchange', async () => {
    const discord = mockDiscord().tokenOk().userOk().memberOk(GUILD);

    await post(VALID);

    const body = new URLSearchParams(discord.assertCalled('/oauth2/token').body ?? '');
    expect(body.get('redirect_uri')).toBe('discord-test-client-id:/authorize/callback');
    // And emphatically not this deployment's browser callback, which is what a
    // shared code path would have sent.
    expect(body.get('redirect_uri')).not.toBe(`${ORIGIN}/auth/callback`);
  });

  it('carries the code and verifier the app supplied', async () => {
    const discord = mockDiscord().tokenOk().userOk().memberOk(GUILD);

    await post(VALID);

    const body = new URLSearchParams(discord.assertCalled('/oauth2/token').body ?? '');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toBe('the-verifier');
    expect(body.get('grant_type')).toBe('authorization_code');
  });
});

describe('what the route refuses', () => {
  it('refuses when Discord is not configured', async () => {
    const bag = env as unknown as Record<string, string>;
    const saved = bag.DISCORD_CLIENT_ID;
    bag.DISCORD_CLIENT_ID = '';

    try {
      const res = await post(VALID);

      expect(res.status).toBe(503);
      expect(await errorOf(res)).toContain('not configured');
    } finally {
      bag.DISCORD_CLIENT_ID = saved!;
    }
  });

  it('refuses a body that is not JSON', async () => {
    const res = await post(undefined, 'this is not json');

    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('Expected a JSON body');
  });

  it('refuses no body at all', async () => {
    const res = await post();

    expect(res.status).toBe(400);
  });

  it.each([
    ['no code', { verifier: 'v' }],
    ['no verifier', { code: 'c' }],
    ['neither', {}],
    ['an empty code', { code: '', verifier: 'v' }],
    ['an empty verifier', { code: 'c', verifier: '' }],
    ['both empty', { code: '', verifier: '' }],
    ['a numeric code', { code: 42, verifier: 'v' }],
    ['a numeric verifier', { code: 'c', verifier: 42 }],
    ['a null code', { code: null, verifier: 'v' }],
    ['an object verifier', { code: 'c', verifier: { toString: 'nice try' } }],
    ['an array code', { code: ['c'], verifier: 'v' }],
    ['a boolean verifier', { code: 'c', verifier: true }],
  ])('refuses %s', async (_label, body) => {
    const discord = mockDiscord();

    const res = await post(body);

    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('Both code and verifier are required');
    // Refused before anything is sent — a truthiness check alone would have let
    // the numbers and the object through to Discord.
    discord.assertNotCalled();
  });

  it('refuses a JSON body that is not an object', async () => {
    const res = await post(undefined, '"just a string"');

    expect(res.status).toBe(400);
  });

  it('surfaces a rejected exchange without issuing anything', async () => {
    mockDiscord().tokenFails(400, { error: 'invalid_grant' });

    const res = await post(VALID);

    expect(res.status).toBe(500);
    expect(await errorOf(res)).toBe('Discord token exchange failed (400)');
    expect(sessionTokenOf(res)).toBeUndefined();
  });

  it('refuses a banned account', async () => {
    mockDiscord().tokenOk().userOk().memberOk(GUILD);
    await seedUser(env.DB, { discordId: DISCORD_ID, isBanned: true });

    const res = await post(VALID);

    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe('This account is banned');
    expect(sessionTokenOf(res)).toBeUndefined();
  });
});

describe('a successful app sign-in', () => {
  it('answers with a real Set-Cookie for the WebView to adopt', async () => {
    mockDiscord().tokenOk().userOk().memberOk(GUILD);

    const res = await post(VALID);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // A header rather than a token in the body, so the APK never has to know
    // the cookie's name, flags or expiry.
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
  });

  it('lands in the same session table as every other door', async () => {
    mockDiscord().tokenOk().userOk().memberOk(GUILD);

    const res = await post(VALID);
    const user = await getSessionUser(env.DB, sessionTokenOf(res)!);

    expect(user?.discordId).toBe(DISCORD_ID);
    expect(user?.role).toBe('member');
  });

  it('never caches the answer', async () => {
    mockDiscord().tokenOk().userOk().memberOk(GUILD);

    expect((await post(VALID)).headers.get('cache-control')).toBe('no-store');
  });

  it('does not demote a hand-promoted admin', async () => {
    const bag = env as unknown as Record<string, string>;
    const saved = bag.DISCORD_GUILD_ID;
    bag.DISCORD_GUILD_ID = '';

    try {
      mockDiscord().tokenOk().userOk();
      await seedUser(env.DB, { discordId: DISCORD_ID, role: 'admin' });

      const res = await post(VALID);

      expect((await getSessionUser(env.DB, sessionTokenOf(res)!))?.role).toBe('admin');
    } finally {
      bag.DISCORD_GUILD_ID = saved!;
    }
  });

  it('makes somebody who left the Discord a guest', async () => {
    mockDiscord().tokenOk().userOk().memberNotFound(GUILD);
    await seedUser(env.DB, { discordId: DISCORD_ID, role: 'ambassador' });

    const res = await post(VALID);

    expect((await getSessionUser(env.DB, sessionTokenOf(res)!))?.role).toBe('guest');
  });
});
