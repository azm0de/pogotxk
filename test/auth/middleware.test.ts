/**
 * `src/middleware.ts` — session resolution on every request, and the gate in
 * front of the admin surface.
 *
 * How "the skip list short-circuits before any database call" is proved here,
 * because it is not obvious: an expired session is a cookie whose row
 * `getSessionUser` deletes on sight. Send one at a skipped path and the row has
 * to survive; send the same cookie at an ordinary path and it must be gone.
 * That is a real observation of whether the lookup ran, rather than a mock
 * counting calls — and it fails loudly if somebody moves the skip check below
 * the cookie read.
 *
 * The signed-out/signed-in split on `/api/admin/*` is the other thing worth
 * reading for. 401 and 403 are not interchangeable: a `fetch()` caller that
 * sees 401 knows to send the user through sign-in, and one that sees 403 knows
 * that will not help. Collapsing them to either value breaks one of the two.
 */

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '~/lib/auth/session';
import {
  asUser,
  authCookie,
  isoIn,
  seedSession,
  seedUser,
  sessionIdFor,
} from '../helpers/factories';

const ORIGIN = 'https://pogotxk.test';
const DAY = 60 * 60 * 24;

async function sessionCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>();
  return row?.n ?? 0;
}

/** A cookie for a session that lapsed an hour ago. */
async function expiredCookie(): Promise<string> {
  const user = await seedUser(env.DB);
  return authCookie(await seedSession(env.DB, user, { expiresAt: isoIn(-3600) }));
}

function get(path: string, cookie?: string): Promise<Response> {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  return SELF.fetch(`${ORIGIN}${path}`, { headers, redirect: 'manual' });
}

/**
 * Astro's CSRF origin check rejects a POST whose `Origin` does not match the
 * request's, which a bare `SELF.fetch` does not send. Real callers always do.
 */
function post(path: string, cookie?: string): Promise<Response> {
  const headers = new Headers({ origin: ORIGIN });
  if (cookie) headers.set('cookie', cookie);
  return SELF.fetch(`${ORIGIN}${path}`, { method: 'POST', headers, redirect: 'manual' });
}

describe('the skip list', () => {
  // One path per entry in SKIP_PREFIXES. They do not all resolve to a route,
  // and it does not matter: a 404 has been through the middleware just the same.
  it.each([
    ['/_astro/', '/_astro/page.abc123.js'],
    ['/media/', '/media/1'],
    ['/favicon', '/favicon.ico'],
    ['/assets/', '/assets/logo.svg'],
  ])('%s reaches its route without touching the database', async (_prefix, path) => {
    const cookie = await expiredCookie();

    await get(path, cookie);

    // Untouched. `getSessionUser` would have deleted it on sight.
    expect(await sessionCount()).toBe(1);
  });

  it('an ordinary path does do the lookup, which is what makes the above mean something', async () => {
    const cookie = await expiredCookie();

    await get('/api/me.json', cookie);

    expect(await sessionCount()).toBe(0);
  });

  it('matches on the prefix, not on the path containing it', async () => {
    // `startsWith`, so a route merely mentioning one of these words is still
    // guarded and still resolves its session.
    const cookie = await expiredCookie();

    await get('/blog/favicon-design', cookie);

    expect(await sessionCount()).toBe(0);
  });
});

describe('the admin pages', () => {
  /*
   * The bounce goes to `/admin/login`, the admin password form — not to
   * Discord's `/auth/login`, which is where it went until 2026-09-23. Discord
   * cannot produce anybody this gate admits any more (no `DISCORD_ROLE_*` ids
   * are set and the bootstrap id is gone), so for the two admins, who have no
   * Discord account at all, it was a dead end.
   */
  it('sends a signed-out visitor to the admin sign-in, carrying where they were going', async () => {
    const res = await get('/admin');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login?next=%2Fadmin');
  });

  it('encodes a deeper path into next', async () => {
    const res = await get('/admin/map');

    expect(res.headers.get('location')).toBe('/admin/login?next=%2Fadmin%2Fmap');
  });

  it('turns a member away too', async () => {
    const member = await seedUser(env.DB, { role: 'member' });

    const res = await SELF.fetch(await asUser(env.DB, member, `${ORIGIN}/admin`), {
      redirect: 'manual',
    });

    // Signed in, but not enough. The bounce through sign-in is the honest
    // answer for a page: they may have a second account that does qualify.
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login?next=%2Fadmin');
  });

  it('lands a signed-out visitor on a working form, with next in it', async () => {
    // The redirect is only as good as the page it points at. Followed by hand,
    // one hop, so a loop would show up as a second 302 rather than hang.
    const bounced = await get('/admin/posts');
    const landed = await get(bounced.headers.get('location')!);

    expect(landed.status).toBe(200);
    expect(landed.headers.get('location')).toBeNull();
    const html = await landed.text();
    expect(html).toContain('action="/api/auth/admin-login"');
    expect(html).toContain('name="next" value="/admin/posts"');
  });

  it('lands a signed-in member on the same form, rather than bouncing them again', async () => {
    /*
     * The page shows the form to anybody below `ambassador` and forwards
     * anybody at or above it, and the gate admits exactly the second group —
     * so the two can never pass a caller back and forth. A member standing on
     * the form can still use the Discord link beside it, which carries `next`.
     */
    const member = await seedUser(env.DB, { role: 'member' });
    const cookie = authCookie(await seedSession(env.DB, member));

    const bounced = await get('/admin/meetups', cookie);
    expect(bounced.headers.get('location')).toBe('/admin/login?next=%2Fadmin%2Fmeetups');

    const landed = await get(bounced.headers.get('location')!, cookie);
    expect(landed.status).toBe(200);
    expect(landed.headers.get('location')).toBeNull();
    const html = await landed.text();
    expect(html).toContain('action="/api/auth/admin-login"');
    expect(html).toContain('href="/auth/login?next=%2Fadmin%2Fmeetups"');
  });

  it.each(['ambassador', 'admin'] as const)('lets an %s through', async (role) => {
    const user = await seedUser(env.DB, { role });

    const res = await SELF.fetch(await asUser(env.DB, user, `${ORIGIN}/admin`), {
      redirect: 'manual',
    });

    expect(res.status).toBe(200);
  });

  // `/admin/login` is deliberately not in this list. It is the admin password
  // form and the one path under `/admin` the gate exempts, by exact match — see
  // `isAdminLoginPath`, and `admin-login.test.ts` for what that exemption does
  // and does not cover. Adding it here would be asserting the opposite.
  it.each(['/admin', '/admin/map', '/admin/posts', '/admin/media', '/admin/meetups'])(
    'still guards %s',
    async (path) => {
      const res = await get(path);

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`/admin/login?next=${encodeURIComponent(path)}`);
    },
  );
});

/**
 * The prefix boundary in `~/lib/auth/admin-path`, observed where it actually
 * bites: `/administrators` is not under `/admin`, and a bare `startsWith`
 * would bounce a stranger to the admin sign-in form to reach a page that was
 * never private.
 *
 * `admin-path.test.ts` pins the predicate exhaustively. This is the other half
 * — that the predicate is what the request meets — and it is only writable now
 * that `vitest.config.ts` binds `ASSETS`. Until then the adapter's asset
 * fallback threw on a path with no route and nothing could be observed at all.
 *
 * Two of the three tests exist to stop the first one passing for the wrong
 * reason: a 404 proves nothing on its own if the middleware never ran, and an
 * unrouted path is exactly where it might plausibly be skipped.
 */
describe('a path with no route', () => {
  it('404s rather than being annexed by the admin gate', async () => {
    const res = await get('/administrators');

    expect(res.status).toBe(404);
    // The failure this guards against is not a leak. It is a public page that
    // sends every visitor to sign in and then refuses them.
    expect(res.headers.get('location')).toBeNull();
  });

  it('has been through the middleware even so', async () => {
    // Without this the test above would pass on a middleware that never saw
    // the request. An expired session is the observation: `getSessionUser`
    // deletes the row on sight, so an empty table means the lookup ran.
    const cookie = await expiredCookie();

    await get('/administrators', cookie);

    expect(await sessionCount()).toBe(0);
  });

  it('is still guarded when it genuinely is under /admin', async () => {
    // No `/admin/nothing-here.astro` exists, so this reaches the same fallback
    // as `/administrators` and separates "unrouted" from "unguarded".
    const res = await get('/admin/nothing-here');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login?next=%2Fadmin%2Fnothing-here');
  });
});

describe('the admin API', () => {
  // One endpoint for all three outcomes, so the comparison is between callers
  // rather than between routes. `GET /api/admin/posts` asks for `ambassador`
  // and nothing else, which is exactly the floor the middleware applies.
  const POSTS = `${ORIGIN}/api/admin/posts`;

  it('answers 401 to a signed-out caller', async () => {
    const res = await get('/api/admin/posts');

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('answers 403 to a signed-in caller who is not an ambassador', async () => {
    const member = await seedUser(env.DB, { role: 'member' });

    const res = await SELF.fetch(await asUser(env.DB, member, POSTS));

    // Not 401: this caller is signed in, and sending them back through sign-in
    // would return them to the same refusal.
    expect(res.status).toBe(403);
  });

  it('answers 403 to a guest as well', async () => {
    const guest = await seedUser(env.DB, { role: 'guest' });

    const res = await SELF.fetch(await asUser(env.DB, guest, POSTS));

    expect(res.status).toBe(403);
  });

  it('lets an ambassador past the gate', async () => {
    const amb = await seedUser(env.DB, { role: 'ambassador' });

    const res = await SELF.fetch(await asUser(env.DB, amb, POSTS));

    expect(res.status).toBe(200);
  });

  it('returns JSON, not a redirect, so fetch() callers can read it', async () => {
    const res = await get('/api/admin/posts');

    expect(res.status).not.toBe(302);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

describe('the import endpoints carry their own guard', () => {
  it('reaches the route rather than the role gate when signed out', async () => {
    const res = await post('/api/admin/import-legacy');

    // Still 401, but the route's own — `requireImportToken` sends a
    // `WWW-Authenticate` challenge and says "Unauthorized". The middleware's
    // refusal says "Unauthorized" and sends no challenge, so this proves which one
    // answered.
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('bypasses the gate for import-media too, not just import-legacy', async () => {
    const res = await post('/api/admin/import-media');

    expect(res.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('is the only shape of admin path that bypasses the gate', async () => {
    // The bypass is `/api/admin/import-`, not `/api/admin/`. Everything else
    // under that prefix still meets the middleware first.
    const res = await post('/api/admin/media');

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });
});

/**
 * The rolling fortnight, cookie half (admin audit, 2026-10, A-01).
 *
 * The D1 row has slid on use for a while; the cookie was set once at sign-in
 * with a fortnight's `Max-Age` and never again, so the browser dropped it on
 * day fourteen however active its owner was. The middleware now re-issues it
 * on the same request that slides the row — at most once a day, decided by the
 * same `slideDue` rule — and these pin when it does and when it must not.
 */
describe('the session cookie is re-issued as it slides', () => {
  /** A session one minute past a day old: the first request that renews it. */
  async function agedToken(opts: { banned?: boolean; role?: 'member' | 'ambassador' } = {}) {
    const user = await seedUser(env.DB, { role: opts.role ?? 'member', isBanned: opts.banned });
    return seedSession(env.DB, user, { expiresAt: isoIn(13 * DAY - 60) });
  }

  function sessionSetCookie(res: Response): string | undefined {
    return res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  }

  async function expiryOf(token: string): Promise<string | undefined> {
    const row = await env.DB.prepare('SELECT expires_at FROM sessions WHERE id = ?1')
      .bind(await sessionIdFor(token))
      .first<{ expires_at: string }>();
    return row?.expires_at;
  }

  it('renews an aged session on an ordinary response, for a full fortnight', async () => {
    const token = await agedToken();

    const res = await get('/api/me.json', authCookie(token));

    expect(res.status).toBe(200);
    const cookie = sessionSetCookie(res);
    // The same token — renewing is not rotating — with the full lifetime and
    // every flag the sign-in cookie carries.
    expect(cookie).toContain(`${SESSION_COOKIE}=${token};`);
    expect(cookie).toContain(`Max-Age=${14 * DAY}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    // The body is untouched by the copy the middleware makes to add a header.
    expect(((await res.json()) as { user: unknown }).user).not.toBeNull();
  });

  it('renews on a rendered page too, not only on JSON', async () => {
    const token = await agedToken({ role: 'ambassador' });

    const res = await get('/admin', authCookie(token));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(sessionSetCookie(res)).toContain(`Max-Age=${14 * DAY}`);
  });

  it('slides the row in the background on that same request', async () => {
    const token = await agedToken();
    const before = await expiryOf(token);

    await get('/api/me.json', authCookie(token));

    // The write is under `waitUntil`, so it may land a moment after the
    // response. Each read is I/O, which is what lets it run; a handful is
    // plenty, and a slide that never lands fails here rather than hanging.
    let after = await expiryOf(token);
    for (let i = 0; i < 20 && after === before; i++) after = await expiryOf(token);

    expect(after).not.toBe(before);
    expect(Date.parse(after!) - Date.now()).toBeGreaterThan((14 * DAY - 60) * 1000);
  });

  it('sends no cookie for a fresh session — at most once a day', async () => {
    const user = await seedUser(env.DB);
    const token = await seedSession(env.DB, user);

    const res = await get('/api/me.json', authCookie(token));

    expect(res.status).toBe(200);
    expect(sessionSetCookie(res)).toBeUndefined();
  });

  it('sends no cookie for a banned user, however old the session', async () => {
    const token = await agedToken({ banned: true });

    const res = await get('/api/me.json', authCookie(token));

    expect(sessionSetCookie(res)).toBeUndefined();
  });

  it('sends no cookie for a lapsed session', async () => {
    const res = await get('/api/me.json', await expiredCookie());

    expect(sessionSetCookie(res)).toBeUndefined();
  });

  it('leaves a redirect alone, which the next request will renew instead', async () => {
    // A member at `/admin` is bounced; the bounce carries no cookie.
    const token = await agedToken({ role: 'member' });

    const res = await get('/admin', authCookie(token));

    expect(res.status).toBe(302);
    expect(sessionSetCookie(res)).toBeUndefined();
  });

  it('does not fight a route that sets the session cookie itself', async () => {
    // Sign-out clears the cookie. A renewal appended beside the clearing would
    // leave the browser to pick between them.
    const token = await agedToken();

    const res = await post('/auth/logout', authCookie(token));

    const cookies = res.headers.getSetCookie().filter((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain('Max-Age=0');
  });
});

/**
 * `next` keeps the query string (admin audit, 2026-10, A-03), through
 * `safeNext`, so a bounced filter comes back — and a query is still only ever
 * part of a same-origin path.
 */
describe('the admin bounce carries the query string', () => {
  it('keeps a filter', async () => {
    const res = await get('/admin/posts?status=draft');

    expect(res.headers.get('location')).toBe(
      `/admin/login?next=${encodeURIComponent('/admin/posts?status=draft')}`,
    );
  });

  it.each([
    ['a protocol-relative shape in the query', '/admin?x=//evil.example'],
    ['a backslash shape in the query', '/admin?x=%5C%5Cevil.example'],
    ['an encoded CRLF', '/admin?%0d%0a'],
  ])('keeps %s as inert text in a same-origin path', async (_label, path) => {
    const res = await get(path);
    const next = new URL(res.headers.get('location')!, ORIGIN).searchParams.get('next')!;

    expect(next.startsWith('/admin?')).toBe(true);
    // Wherever the login form finally sends the browser, it is this origin.
    expect(new URL(next, ORIGIN).origin).toBe(ORIGIN);
  });
});

describe('locals.user', () => {
  it('is populated for a live session and absent for a lapsed one', async () => {
    const user = await seedUser(env.DB, { username: 'ashk' });

    const live = await SELF.fetch(await asUser(env.DB, user, `${ORIGIN}/api/me.json`));
    expect(((await live.json()) as { user: { username: string } | null }).user?.username).toBe(
      'ashk',
    );

    const lapsed = await get('/api/me.json', await expiredCookie());
    expect(((await lapsed.json()) as { user: unknown }).user).toBeNull();
  });

  it('is absent for a cookie that decodes to nothing', async () => {
    const res = await get('/api/me.json', `${SESSION_COOKIE}=${'0'.repeat(64)}`);

    expect(((await res.json()) as { user: unknown }).user).toBeNull();
  });
});
