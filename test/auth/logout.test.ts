/**
 * `/auth/logout`.
 *
 * The thing worth understanding before reading the `?switch=1` tests: signing
 * out here does not sign you out of Discord. The two sessions are separate, and
 * `/auth/login` asks for `prompt=none` so returning members are not made to
 * click through an approval screen every visit. Put those together and a plain
 * sign-out followed by a sign-in silently re-authorises the *same* Discord
 * account — there is no point in the round trip where anybody is asked who they
 * are, so someone with two accounts can never reach the second one.
 *
 * `?switch=1` is the answer: drop our session, then start sign-in with
 * `consent=1`, which forces the one Discord screen that offers to switch.
 */

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '~/lib/auth/session';
import { asToken, authCookie, seedSession, seedUser } from '../helpers/factories';

const ORIGIN = 'https://pogotxk.test';

function logout(query = '', token?: string, method: 'GET' | 'POST' = 'GET'): Promise<Response> {
  const headers = new Headers({ origin: ORIGIN });
  if (token) headers.set('cookie', authCookie(token));
  return SELF.fetch(`${ORIGIN}/auth/logout${query}`, { method, headers, redirect: 'manual' });
}

async function sessionCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>();
  return row?.n ?? 0;
}

function clearsSession(res: Response): boolean {
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return cookie !== undefined && cookie.includes('Max-Age=0');
}

describe('signing out', () => {
  it.each(['GET', 'POST'] as const)('works over %s', async (method) => {
    // GET is supported so a plain link works without JavaScript: the session
    // token is the only thing being destroyed and the user is the one asking.
    const user = await seedUser(env.DB);
    const token = await seedSession(env.DB, user);

    const res = await logout('', token, method);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(clearsSession(res)).toBe(true);
    expect(await sessionCount()).toBe(0);
  });

  it('really ends the session, not just the cookie', async () => {
    const user = await seedUser(env.DB);
    const token = await seedSession(env.DB, user);

    await logout('', token);

    // Replaying the token afterwards must get nowhere — clearing the browser's
    // copy alone would leave a working credential in anything that kept it.
    const res = await SELF.fetch(asToken(token, `${ORIGIN}/api/me.json`));
    expect(((await res.json()) as { user: unknown }).user).toBeNull();
  });

  it('signs out this device only', async () => {
    const user = await seedUser(env.DB);
    const phone = await seedSession(env.DB, user);
    const laptop = await seedSession(env.DB, user);

    await logout('', phone);

    // Deliberate: sessions are per-device, and "sign out" on one is not a
    // request to end the others.
    expect(await sessionCount()).toBe(1);
    const res = await SELF.fetch(asToken(laptop, `${ORIGIN}/api/me.json`));
    expect(((await res.json()) as { user: { id: number } | null }).user?.id).toBe(user.id);
  });

  it('is harmless when nobody is signed in', async () => {
    const res = await logout();

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(clearsSession(res)).toBe(true);
  });

  it('is harmless for a token that is not in the table', async () => {
    const res = await logout('', 'f'.repeat(64));

    expect(res.status).toBe(302);
  });

  it('never caches the answer', async () => {
    expect((await logout()).headers.get('cache-control')).toBe('no-store');
  });
});

/**
 * Admin audit, 2026-10, A-09: sign-out was a GET link, and with
 * `SameSite=Lax` the cookie rides along on a cross-site top-level navigation —
 * so any page could sign a visitor out with a link. POST is now the canonical
 * shape (the account menu posts a form), and a GET the browser marks as
 * coming from another site no longer ends anything.
 */
describe('a sign-out another site starts', () => {
  function getFrom(site: string | null, token: string, query = ''): Promise<Response> {
    const headers = new Headers({ cookie: authCookie(token) });
    if (site !== null) headers.set('sec-fetch-site', site);
    return SELF.fetch(`${ORIGIN}/auth/logout${query}`, { headers, redirect: 'manual' });
  }

  it.each(['cross-site', 'same-site'])('does not end the session over a %s GET', async (site) => {
    const user = await seedUser(env.DB);
    const token = await seedSession(env.DB, user);

    const res = await getFrom(site, token);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(await sessionCount()).toBe(1);
  });

  it('drops switch=1 on a refused GET rather than starting a Discord round trip', async () => {
    const user = await seedUser(env.DB);
    const token = await seedSession(env.DB, user);

    const res = await getFrom('cross-site', token, '?switch=1&next=%2Fgo');

    expect(res.headers.get('location')).toBe('/go');
    expect(await sessionCount()).toBe(1);
  });

  it.each([
    ['our own link', 'same-origin'],
    ['a typed URL or bookmark', 'none'],
    ['a browser too old to say', null],
  ])('still signs out over GET from %s', async (_label, site) => {
    const user = await seedUser(env.DB);
    const token = await seedSession(env.DB, user);

    const res = await getFrom(site, token);

    expect(clearsSession(res)).toBe(true);
    expect(await sessionCount()).toBe(0);
  });

  it('refuses a cross-site POST before the route runs — Astro’s origin check', async () => {
    const user = await seedUser(env.DB);
    const token = await seedSession(env.DB, user);

    const res = await SELF.fetch(`${ORIGIN}/auth/logout`, {
      method: 'POST',
      headers: {
        cookie: authCookie(token),
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      redirect: 'manual',
    });

    expect(res.status).toBe(403);
    expect(await sessionCount()).toBe(1);
  });

  it('the account menu signs out with a POST form, not a link', async () => {
    /*
     * The menu is built in the browser by an inline script in `Base.astro`, so
     * what can be pinned here is that script as served: it builds a form that
     * posts to `/auth/logout`, and no longer an anchor pointing at it.
     */
    const html = await (await SELF.fetch(`${ORIGIN}/auth/error`)).text();

    expect(html).toContain("method: 'post'");
    expect(html).toContain("action: '/auth/logout?' + query");
    expect(html).not.toContain("href: '/auth/logout");
  });
});

describe('where it sends you', () => {
  it('honours a same-origin next', async () => {
    expect((await logout('?next=%2Fgo')).headers.get('location')).toBe('/go');
  });

  it.each([
    ['a protocol-relative host', '//evil.example/phish'],
    ['the backslash form', '/\\evil.example'],
    ['an absolute URL', 'https://evil.example'],
  ])('sends %s home instead', async (_label, next) => {
    // It arrives as a query parameter on a GET and ends up in a Location header
    // either way, so it goes through `safeNext` like every other destination.
    expect((await logout(`?next=${encodeURIComponent(next)}`)).headers.get('location')).toBe('/');
  });
});

describe('use a different account', () => {
  it('restarts sign-in asking Discord for consent', async () => {
    const user = await seedUser(env.DB);
    const token = await seedSession(env.DB, user);

    const res = await logout('?switch=1', token);

    // Not '/'. Without this hop the next sign-in silently re-authorises the
    // account that was just signed out of.
    expect(res.headers.get('location')).toBe('/auth/login?consent=1');
    expect(await sessionCount()).toBe(0);
  });

  it('carries a destination through the switch', async () => {
    const res = await logout('?switch=1&next=%2Fgo');

    expect(res.headers.get('location')).toBe('/auth/login?consent=1&next=%2Fgo');
  });

  it('leaves the default destination implicit', async () => {
    // '/' is /auth/login's own default; sending it makes for a uglier URL and
    // no change in behaviour.
    expect((await logout('?switch=1&next=%2F')).headers.get('location')).toBe(
      '/auth/login?consent=1',
    );
  });

  it('does not let a hostile next ride along', async () => {
    const res = await logout('?switch=1&next=%2F%2Fevil.example');

    expect(res.headers.get('location')).toBe('/auth/login?consent=1');
  });

  it('only triggers on exactly switch=1', async () => {
    expect((await logout('?switch=true')).headers.get('location')).toBe('/');
    expect((await logout('?switch=0')).headers.get('location')).toBe('/');
  });
});
