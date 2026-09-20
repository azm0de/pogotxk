/**
 * `/auth/login` — where every sign-in starts, and where the decision that
 * actually protects phones is made.
 *
 * The history matters for reading this file. The callback has a branch that
 * catches `login_required` and hands phones to `/auth/device`; it has never
 * fired, because Discord answers `prompt=none` from a session-less browser with
 * `200` and its own password form rather than an error (vault/Bugs Worth
 * Remembering.md, measured 2026-09-05). So the phone decision was moved to the
 * front, into `phoneSignInTarget`, where it needs no cooperation from Discord.
 * That is why so much of this suite is about which user agent gets which of two
 * completely different first hops.
 *
 * `scripts/test-auth.ts` already exercises `authorizeUrl`, `safeNext` and
 * `phoneSignInTarget` as pure functions. What it cannot show is that the route
 * calls them with the right arguments, which is what is here.
 */

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { OAUTH_STATE_COOKIE } from '~/lib/auth/session';
import { mockDiscord } from '../helpers/discord-mock';

const ORIGIN = 'https://pogotxk.test';

const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';
const ANDROID_PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari';
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 14; SM-X200) AppleWebKit/537.36 Safari';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15';
const ANDROID_APP = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari PogoTxkApp/1.0';

function login(query = '', userAgent?: string): Promise<Response> {
  const headers = new Headers();
  if (userAgent) headers.set('user-agent', userAgent);
  return SELF.fetch(`${ORIGIN}/auth/login${query}`, { headers, redirect: 'manual' });
}

/** The authorize URL the route bounced to, parsed. */
function authorize(res: Response): URL {
  const location = res.headers.get('location');
  expect(location, 'expected a redirect to Discord').toBeTruthy();
  return new URL(location!);
}

function stateCookieOf(res: Response): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`));
}

function storedState(res: Response): { state: string; verifier: string; next: string; consent?: boolean } {
  const value = stateCookieOf(res)!.slice(OAUTH_STATE_COOKIE.length + 1).split(';')[0]!;
  return JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/')));
}

describe('when Discord is not configured', () => {
  it('says which variable is missing, and does not redirect', async () => {
    const bag = env as unknown as Record<string, string>;
    const saved = bag.DISCORD_CLIENT_SECRET;
    bag.DISCORD_CLIENT_SECRET = '';

    try {
      const res = await login('', DESKTOP);
      const body = await res.text();

      expect(res.status).toBe(503);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(body).toContain('DISCORD_CLIENT_SECRET');
      expect(body).toContain('MISSING');
      // Diagnosing this from outside otherwise needs a terminal, and a missing
      // variable looks identical to a mistyped one.
      expect(body).toContain('DISCORD_CLIENT_ID');
      expect(body).toContain('present');
    } finally {
      bag.DISCORD_CLIENT_SECRET = saved!;
    }
  });

  it('names no values, only presence', async () => {
    const bag = env as unknown as Record<string, string>;
    const saved = bag.DISCORD_CLIENT_SECRET;
    bag.DISCORD_CLIENT_SECRET = '';

    try {
      const body = await (await login('', DESKTOP)).text();

      // The page is public. It may say a variable is set; it may never say what
      // it is set to.
      expect(body).not.toContain('test-client-id');
    } finally {
      bag.DISCORD_CLIENT_SECRET = saved!;
    }
  });

  it('is noindex, because it only ever renders on a broken deploy', async () => {
    const bag = env as unknown as Record<string, string>;
    const saved = bag.DISCORD_CLIENT_ID;
    bag.DISCORD_CLIENT_ID = '';

    try {
      expect(await (await login('', DESKTOP)).text()).toContain('noindex');
    } finally {
      bag.DISCORD_CLIENT_ID = saved!;
    }
  });
});

describe('the redirect to Discord', () => {
  it('carries everything the exchange will need', async () => {
    const discord = mockDiscord();

    const res = await login('', DESKTOP);
    const url = authorize(res);

    expect(res.status).toBe(302);
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('identify guilds.members.read');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback`);
    // The redirect is the browser's to follow. Nothing is fetched here.
    discord.assertNotCalled();
  });

  it('asks for no approval screen by default', async () => {
    // A returning member on a browser Discord knows sails through with no
    // screen at all, which is still the best flow there is when it works.
    expect(authorize(await login('', DESKTOP)).searchParams.get('prompt')).toBe('none');
  });

  it('parks the state and verifier in a short-lived HttpOnly cookie', async () => {
    const res = await login('', DESKTOP);
    const cookie = stateCookieOf(res)!;

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).toContain('SameSite=Lax');

    const stored = storedState(res);
    expect(stored.state).toBe(authorize(res).searchParams.get('state'));
    // The verifier must never leave the server side of the flow.
    expect(authorize(res).toString()).not.toContain(stored.verifier);
  });

  it('mints a different state and verifier every time', async () => {
    const a = storedState(await login('', DESKTOP));
    const b = storedState(await login('', DESKTOP));

    expect(a.state).not.toBe(b.state);
    expect(a.verifier).not.toBe(b.verifier);
  });

  it('never caches the bounce', async () => {
    expect((await login('', DESKTOP)).headers.get('cache-control')).toBe('no-store');
  });

  it('stores a safe next', async () => {
    expect(storedState(await login('?next=%2Fgo', DESKTOP)).next).toBe('/go');
  });

  it.each([
    ['a protocol-relative host', '//evil.example/phish'],
    ['the backslash form', '/\\evil.example'],
    ['an absolute URL', 'https://evil.example'],
  ])('neutralises %s before it is stored', async (_label, next) => {
    // Checked here as well as at the exit, so a bad destination never even
    // reaches the cookie.
    expect(storedState(await login(`?next=${encodeURIComponent(next)}`, DESKTOP)).next).toBe('/');
  });
});

describe('the prompt, which decides which Discord screen appears', () => {
  it('sends prompt=consent for "use a different account"', async () => {
    // The approval screen is the only screen Discord offers that can switch
    // accounts, so this one case really does want it.
    expect(authorize(await login('?consent=1', DESKTOP)).searchParams.get('prompt')).toBe('consent');
  });

  it('sends no prompt at all on the retry', async () => {
    // `default`, not `consent`: the commonest way to reach a retry is "no
    // Discord session in this browser", and forcing approval there would put an
    // extra screen in front of somebody who authorised the app years ago.
    // Sending `prompt=` empty is not the same as omitting it.
    const url = authorize(await login('?retry=1', DESKTOP));

    expect(url.searchParams.has('prompt')).toBe(false);
    expect(url.toString()).not.toContain('prompt=');
  });

  it('marks both as already-interactive, so the callback cannot loop', async () => {
    // `consent` in the payload is the loop guard the callback reads. Both
    // entry points set it, for different reasons and with the same effect.
    expect(storedState(await login('?consent=1', DESKTOP)).consent).toBe(true);
    expect(storedState(await login('?retry=1', DESKTOP)).consent).toBe(true);
    expect(storedState(await login('', DESKTOP)).consent).toBe(false);
  });
});

describe('phones start at the device page instead', () => {
  it.each([
    ['an iPhone', IPHONE],
    ['an Android phone', ANDROID_PHONE],
  ])('sends %s to /auth/device', async (_label, ua) => {
    // The redirect below cannot serve a phone browser holding no Discord
    // session, and Discord will not tell us that is the case — so the decision
    // is made here, before leaving the site.
    const res = await login('', ua);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/auth/device');
    // And no OAuth state is minted for a flow that is not starting.
    expect(stateCookieOf(res)).toBeUndefined();
  });

  it('carries the destination across', async () => {
    expect((await login('?next=%2Fgo', IPHONE)).headers.get('location')).toBe(
      '/auth/device?next=%2Fgo',
    );
  });

  it('drops a destination that is itself a sign-in page', async () => {
    // The header's sign-in control builds its href from the page it is on, so
    // on /auth/device it reads `next=/auth/device`. Nobody wants to land on a
    // sign-in screen after signing in.
    expect((await login('?next=%2Fauth%2Fdevice', IPHONE)).headers.get('location')).toBe(
      '/auth/device',
    );
  });

  it.each([
    ['an Android tablet', ANDROID_TABLET],
    ['an iPad', IPAD],
    ['a desktop browser', DESKTOP],
  ])('leaves %s on the redirect flow', async (_label, ua) => {
    // A tablet has a big enough screen to want the ordinary redirect, and a
    // desktop with a Discord session sails through with no screen at all.
    expect(authorize(await login('', ua)).hostname).toBe('discord.com');
  });

  it('leaves a request with no user agent on the redirect flow', async () => {
    expect(authorize(await login('')).hostname).toBe('discord.com');
  });

  it('leaves the Android shell alone', async () => {
    // It intercepts /auth/login before the request is made, so this should be
    // unreachable — but the marker exists precisely so the server can tell the
    // shell from a phone browser rather than being correct by luck.
    expect(authorize(await login('', ANDROID_APP)).hostname).toBe('discord.com');
  });

  it.each(['?retry=1', '?consent=1'])(
    'does not bounce a phone back to the device page on %s',
    async (query) => {
      // The device page's own escape link is `/auth/login?retry=1`. Without
      // this guard a phone would bounce between the two forever.
      expect(authorize(await login(query, IPHONE)).hostname).toBe('discord.com');
    },
  );
});
