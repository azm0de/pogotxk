/**
 * The device grant — `/api/auth/device/start` and `/api/auth/device/poll`.
 *
 * This is the door phones actually come through. `prompt=none` cannot serve a
 * browser that holds no Discord session (see vault/Bugs Worth Remembering.md,
 * "A fallback that could never fire"), so `phoneSignInTarget` sends phones
 * here, the member approves in the Discord app they are already signed into,
 * and the server polls until it lands.
 *
 * Two shapes are worth reading for before the assertions:
 *
 * - **The device code never reaches the browser.** It is the credential that
 *   redeems the token, so it lives in an HttpOnly cookie and the JSON response
 *   carries only what a human needs. Several tests exist purely to hold that.
 * - **`error` keeps the cookie; every other terminal state drops it.** Discord
 *   having a bad minute is not the same as the code being spent, and throwing
 *   the cookie away on a transient 500 would end a sign-in the member was
 *   halfway through approving.
 */

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DEVICE_AUTHORIZE_URL } from '~/lib/auth/discord';
import { encodeDevicePayload, type DevicePayload } from '~/lib/auth/device-payload';
import {
  DEVICE_GRANT_COOKIE,
  getSessionUser,
  SESSION_COOKIE,
} from '~/lib/auth/session';
import { mockDiscord } from '../helpers/discord-mock';
import { seedUser } from '../helpers/factories';

const ORIGIN = 'https://pogotxk.test';
const GUILD = 'test-guild-id';
const DISCORD_ID = '100000000000000001';

const START = '/api/auth/device/start';
const POLL = '/api/auth/device/poll';

interface StartBody {
  userCode?: string;
  verificationUriComplete?: string;
  expiresIn?: number;
  interval?: number;
  error?: string;
}

interface PollBody {
  status?: string;
  slowDown?: boolean;
  next?: string;
  message?: string;
}

function post(path: string, init: { cookie?: string; body?: unknown } = {}): Promise<Response> {
  // Astro's CSRF origin check rejects a POST whose Origin does not match.
  const headers = new Headers({ origin: ORIGIN });
  if (init.cookie) headers.set('cookie', init.cookie);
  if (init.body !== undefined) headers.set('content-type', 'application/json');

  return SELF.fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** The cookie a pending sign-in is carried in. */
function pendingCookie(over: Partial<DevicePayload> = {}): string {
  const payload = encodeDevicePayload({
    deviceCode: 'device-code-1',
    userCode: 'ABCD-EFGH',
    uri: 'https://discord.com/activate?user_code=ABCD-EFGH',
    next: '/',
    exp: Math.floor(Date.now() / 1000) + 600,
    interval: 5,
    ...over,
  });
  return `${DEVICE_GRANT_COOKIE}=${payload}`;
}

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}

function deviceCookieOf(res: Response): string | undefined {
  return setCookies(res).find((c) => c.startsWith(`${DEVICE_GRANT_COOKIE}=`));
}

function clearsDeviceCookie(res: Response): boolean {
  const cookie = deviceCookieOf(res);
  return cookie !== undefined && cookie.startsWith(`${DEVICE_GRANT_COOKIE}=;`);
}

function sessionTokenOf(res: Response): string | undefined {
  const cookie = setCookies(res).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  const value = cookie?.slice(SESSION_COOKIE.length + 1).split(';')[0];
  return value ? value : undefined;
}

const GRANT = {
  device_code: 'the-device-code',
  user_code: 'WXYZ-1234',
  verification_uri: 'https://discord.com/activate',
  expires_in: 900,
  interval: 5,
};

describe('/api/auth/device/start', () => {
  it('refuses when Discord is not configured', async () => {
    const bag = env as unknown as Record<string, string>;
    const saved = bag.DISCORD_CLIENT_SECRET;
    bag.DISCORD_CLIENT_SECRET = '';

    try {
      const res = await post(START);

      expect(res.status).toBe(503);
      expect(((await res.json()) as StartBody).error).toContain('not configured');
    } finally {
      bag.DISCORD_CLIENT_SECRET = saved!;
    }
  });

  it('hands the page a code and keeps the credential in a cookie', async () => {
    mockDiscord().deviceAuthorizeOk(GRANT);

    const res = await post(START);
    const body = (await res.json()) as StartBody;

    expect(res.status).toBe(200);
    expect(body.userCode).toBe('WXYZ-1234');
    expect(body.expiresIn).toBe(900);
    expect(body.interval).toBe(5);
    // Derived, because `verification_uri_complete` is optional and the tappable
    // link must not depend on an optional field.
    expect(body.verificationUriComplete).toBe(
      'https://discord.com/activate?user_code=WXYZ-1234',
    );

    // The device code is the credential that redeems the token. It must be in
    // the cookie and nowhere else.
    expect(JSON.stringify(body)).not.toContain('the-device-code');
    expect(deviceCookieOf(res)).toContain('HttpOnly');
  });

  it('gives the cookie the lifetime Discord assigned', async () => {
    mockDiscord().deviceAuthorizeOk(GRANT);

    const res = await post(START);

    expect(deviceCookieOf(res)).toContain('Max-Age=900');
  });

  it('never caches the answer', async () => {
    mockDiscord().deviceAuthorizeOk(GRANT);

    const res = await post(START);

    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('re-uses a healthy pending code instead of spending another request', async () => {
    const discord = mockDiscord().deviceAuthorizeOk(GRANT);

    const res = await post(START, { cookie: pendingCookie() });
    const body = (await res.json()) as StartBody;

    // A page refresh should not cost a Discord request, and the member may
    // already be mid-approval on their phone with the old code on screen.
    expect(body.userCode).toBe('ABCD-EFGH');
    discord.assertNotCalled();
    // Nothing to re-set: the cookie it is re-using is already in the browser.
    expect(deviceCookieOf(res)).toBeUndefined();
  });

  it('counts down the remaining life of a re-used code', async () => {
    mockDiscord().deviceAuthorizeOk(GRANT);

    const res = await post(START, {
      cookie: pendingCookie({ exp: Math.floor(Date.now() / 1000) + 300 }),
    });

    expect((await res.json() as StartBody).expiresIn).toBeLessThanOrEqual(300);
  });

  it('replaces a pending code that is about to expire', async () => {
    const discord = mockDiscord().deviceAuthorizeOk(GRANT);

    // Inside the sixty seconds of margin: adopting this would hand the member a
    // code that dies under their thumb.
    const res = await post(START, {
      cookie: pendingCookie({ exp: Math.floor(Date.now() / 1000) + 30 }),
    });

    expect((await res.json() as StartBody).userCode).toBe('WXYZ-1234');
    discord.assertCalled(DEVICE_AUTHORIZE_URL);
    expect(discord.calls).toHaveLength(1);
  });

  it('replaces a pending cookie that does not decode', async () => {
    mockDiscord().deviceAuthorizeOk(GRANT);

    const res = await post(START, { cookie: `${DEVICE_GRANT_COOKIE}=not-a-payload` });

    expect((await res.json() as StartBody).userCode).toBe('WXYZ-1234');
  });

  it('offers the browser fallback rather than crashing when Discord refuses', async () => {
    // A client without "Public Client" enabled answers a plain API error here.
    // The page's job is then to offer the ordinary sign-in, so this is a
    // signal, not a crash.
    mockDiscord().deviceAuthorizeFails();

    const res = await post(START);

    expect(res.status).toBe(503);
    expect(((await res.json()) as StartBody).error).toContain('not available');
    expect(deviceCookieOf(res)).toBeUndefined();
  });

  it('offers the same fallback for an answer that is the wrong shape', async () => {
    mockDiscord().deviceAuthorizeFails(200, { device_code: 'x' });

    expect((await post(START)).status).toBe(503);
  });

  it('carries a safe next through to the cookie', async () => {
    mockDiscord().deviceAuthorizeOk(GRANT);

    const res = await post(START, { body: { next: '/go' } });

    const value = deviceCookieOf(res)!.slice(DEVICE_GRANT_COOKIE.length + 1).split(';')[0]!;
    const stored = JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/'))) as DevicePayload;
    expect(stored.next).toBe('/go');
  });

  it.each([
    ['a protocol-relative host', '//evil.example/phish'],
    ['an absolute URL', 'https://evil.example'],
    ['a non-string', 42],
  ])('neutralises %s in the request body', async (_label, next) => {
    mockDiscord().deviceAuthorizeOk(GRANT);

    const res = await post(START, { body: { next } });

    const value = deviceCookieOf(res)!.slice(DEVICE_GRANT_COOKIE.length + 1).split(';')[0]!;
    const stored = JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/'))) as DevicePayload;
    expect(stored.next).toBe('/');
  });

  it('accepts no body at all', async () => {
    mockDiscord().deviceAuthorizeOk(GRANT);

    const res = await post(START);

    expect(res.status).toBe(200);
  });
});

describe('/api/auth/device/poll', () => {
  it('refuses when Discord is not configured', async () => {
    const bag = env as unknown as Record<string, string>;
    const saved = bag.DISCORD_CLIENT_SECRET;
    bag.DISCORD_CLIENT_SECRET = '';

    try {
      const res = await post(POLL, { cookie: pendingCookie() });

      expect(res.status).toBe(503);
    } finally {
      bag.DISCORD_CLIENT_SECRET = saved!;
    }
  });

  it('reports expired when there is no pending sign-in', async () => {
    const discord = mockDiscord();

    const res = await post(POLL);

    expect(((await res.json()) as PollBody).status).toBe('expired');
    expect(clearsDeviceCookie(res)).toBe(true);
    // Nothing to poll with, so nothing is asked.
    discord.assertNotCalled();
  });

  it('reports expired for a cookie whose code has already lapsed', async () => {
    const discord = mockDiscord();

    const res = await post(POLL, {
      cookie: pendingCookie({ exp: Math.floor(Date.now() / 1000) - 1 }),
    });

    expect(((await res.json()) as PollBody).status).toBe('expired');
    expect(clearsDeviceCookie(res)).toBe(true);
    discord.assertNotCalled();
  });

  it('reports pending while the member has not approved yet', async () => {
    mockDiscord().tokenFails(400, { error: 'authorization_pending' });

    const res = await post(POLL, { cookie: pendingCookie() });
    const body = (await res.json()) as PollBody;

    expect(res.status).toBe(200);
    expect(body.status).toBe('pending');
    expect(body.slowDown).toBe(false);
    // Still pending, so the credential must survive for the next tick.
    expect(deviceCookieOf(res)).toBeUndefined();
  });

  it('passes slow_down through so the page can stretch its interval', async () => {
    mockDiscord().tokenFails(400, { error: 'slow_down' });

    const body = (await (await post(POLL, { cookie: pendingCookie() })).json()) as PollBody;

    // RFC 8628 says add five seconds and keep going — not a failure.
    expect(body.status).toBe('pending');
    expect(body.slowDown).toBe(true);
  });

  it.each([
    ['access_denied', 'denied'],
    ['expired_token', 'expired'],
  ])('treats %s as terminal and spends the cookie', async (discordError, status) => {
    mockDiscord().tokenFails(400, { error: discordError });

    const res = await post(POLL, { cookie: pendingCookie() });

    expect(((await res.json()) as PollBody).status).toBe(status);
    expect(clearsDeviceCookie(res)).toBe(true);
  });

  it('answers 502 and keeps the cookie when Discord answers something unexpected', async () => {
    mockDiscord().tokenFails(500, { error: 'server_error' });

    const res = await post(POLL, { cookie: pendingCookie() });

    // Possibly transient. Dropping the cookie here would end a sign-in the
    // member is halfway through approving, over a bad minute on Discord's side.
    expect(res.status).toBe(502);
    expect(((await res.json()) as PollBody).status).toBe('error');
    expect(deviceCookieOf(res)).toBeUndefined();
  });

  it('answers 502 for a body it cannot read at all', async () => {
    mockDiscord().tokenFails(500, { message: 'Internal Server Error' });

    const res = await post(POLL, { cookie: pendingCookie() });

    expect(res.status).toBe(502);
    expect(((await res.json()) as PollBody).message).toBe('Unexpected device-grant response');
  });

  it('presents the device code Discord issued, and not to the page', async () => {
    const discord = mockDiscord().tokenFails(400, { error: 'authorization_pending' });

    const res = await post(POLL, { cookie: pendingCookie({ deviceCode: 'secret-code' }) });

    const body = new URLSearchParams(discord.assertCalled('/oauth2/token').body ?? '');
    expect(body.get('device_code')).toBe('secret-code');
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(await res.text()).not.toContain('secret-code');
  });

  describe('once the approval lands', () => {
    it('signs the member in and spends the device cookie', async () => {
      mockDiscord().tokenOk().userOk().memberOk(GUILD);

      const res = await post(POLL, { cookie: pendingCookie() });
      const body = (await res.json()) as PollBody;

      expect(res.status).toBe(200);
      expect(body.status).toBe('ok');
      expect(body.next).toBe('/');

      const user = await getSessionUser(env.DB, sessionTokenOf(res)!);
      expect(user?.discordId).toBe(DISCORD_ID);
      expect(user?.role).toBe('member');
      expect(clearsDeviceCookie(res)).toBe(true);
    });

    it('returns the stored destination', async () => {
      mockDiscord().tokenOk().userOk().memberOk(GUILD);

      const res = await post(POLL, { cookie: pendingCookie({ next: '/go' }) });

      expect(((await res.json()) as PollBody).next).toBe('/go');
    });

    it('re-validates that destination at the moment it is handed back', async () => {
      mockDiscord().tokenOk().userOk().memberOk(GUILD);

      const res = await post(POLL, { cookie: pendingCookie({ next: '//evil.example' }) });

      expect(((await res.json()) as PollBody).next).toBe('/');
    });

    it('refuses a banned account and spends the cookie', async () => {
      mockDiscord().tokenOk().userOk().memberOk(GUILD);
      await seedUser(env.DB, { discordId: DISCORD_ID, isBanned: true });

      const res = await post(POLL, { cookie: pendingCookie() });

      expect(res.status).toBe(403);
      expect(sessionTokenOf(res)).toBeUndefined();
      expect(clearsDeviceCookie(res)).toBe(true);
    });

    it('keeps a hand-promoted admin when Discord could not answer for the guild', async () => {
      const bag = env as unknown as Record<string, string>;
      const saved = bag.DISCORD_GUILD_ID;
      bag.DISCORD_GUILD_ID = '';

      try {
        mockDiscord().tokenOk().userOk();
        await seedUser(env.DB, { discordId: DISCORD_ID, role: 'admin' });

        // The same only-overwrite-when-authoritative rule as the browser
        // callback. This is an extra door, not a second identity system.
        const res = await post(POLL, { cookie: pendingCookie() });

        expect((await getSessionUser(env.DB, sessionTokenOf(res)!))?.role).toBe('admin');
      } finally {
        bag.DISCORD_GUILD_ID = saved!;
      }
    });

    it('answers 500 when the profile fetch fails after a good token', async () => {
      mockDiscord().tokenOk().userFails(401);

      const res = await post(POLL, { cookie: pendingCookie() });

      expect(res.status).toBe(500);
      expect(((await res.json()) as PollBody).message).toBe('Discord /users/@me failed (401)');
    });

    it('answers 500 rather than guessing when the guild lookup fails', async () => {
      mockDiscord().tokenOk().userOk().memberFails(GUILD, 500);

      const res = await post(POLL, { cookie: pendingCookie() });

      expect(res.status).toBe(500);
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>();
      expect(row?.n).toBe(0);
    });
  });
});
