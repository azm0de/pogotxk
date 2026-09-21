/**
 * The admin console's pages, as opposed to its API.
 *
 * Same gate, different answer: a page route redirects into sign-in and carries
 * where the visitor was going, because a person who lands on `/admin/posts`
 * signed out may well have an account that qualifies and the useful thing to do
 * is ask them to use it. An API route cannot do that — its caller is a
 * `fetch()`, which has nowhere to put a sign-in form — so it gets a status.
 *
 * The matrix below is the page half of the one in `api-matrix.test.ts`. What is
 * worth reading for is the bottom of the file: the `next` the middleware builds
 * is handed straight to `safeNext` on the way back, and those two have never
 * been tested against each other.
 *
 * There is exactly one page under `/admin` that this matrix does not cover, and
 * it is named and argued at `LOGIN_PAGE` below. The list is now checked against
 * the directory, so that exception has to be written down to exist.
 */

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { safeNext } from '~/lib/auth/next';
import { CALLERS, ORIGIN, requestAs, seedFixtures, type Caller } from './surface';

/** Every page under the console that the gate applies to. */
const PAGES = ['/admin', '/admin/map', '/admin/meetups', '/admin/posts', '/admin/media'] as const;

/**
 * The one page under the console that the gate does **not** apply to, and the
 * only one that may ever be.
 *
 * It is the owner's password form. It lives under `/admin` because that is
 * where a login for the admin console belongs, and it is exempted from the role
 * check by `isAdminLoginPath` — matched exactly — because a gate in front of it
 * would bounce the signed-out owner to `/auth/login`, which is the Discord door
 * they are there because they cannot use.
 *
 * Written down as an exception rather than folded into the matrix on purpose.
 * The alternative — loosening `ADMITTED` so that "some pages admit anonymous"
 * — would make every row in the grid below weaker to buy one page its special
 * case, and the grid is the thing that proves the other five are shut. So this
 * page is subtracted by name, right here, where the subtraction is visible, and
 * its own behaviour is asserted separately at the bottom of the file.
 */
const LOGIN_PAGE = '/admin/login';

const PAGE_PREFIX = '../../src/pages/admin/';

/**
 * The pages actually on disk, resolved by Vite at transform time.
 *
 * The matrix is only worth something if it is exhaustive, and the usual way it
 * stops being exhaustive is that somebody adds a page and nobody adds a row —
 * which is exactly the argument `test/admin/surface.ts` makes for the API half
 * and which this half had been taking on trust. Lazy rather than eager: only
 * the filenames are wanted, and importing an `.astro` module here would drag
 * the whole component pipeline into the Worker test pool for nothing.
 */
function pagesOnDisk(): string[] {
  return Object.keys(import.meta.glob('../../src/pages/admin/**/*.astro'))
    .map((key) =>
      `/admin/${key.slice(PAGE_PREFIX.length)}`.replace(/\.astro$/, '').replace(/\/index$/, ''),
    )
    .sort();
}

/** Who gets in. The floor is `ambassador`, and a banned account is nobody. */
const ADMITTED: Record<Caller, boolean> = {
  anonymous: false,
  guest: false,
  member: false,
  ambassador: true,
  admin: true,
  'banned admin': false,
};

const GRID: [string, string, Caller][] = PAGES.flatMap((page) =>
  CALLERS.map((caller): [string, string, Caller] => [`${page} — ${caller}`, page, caller]),
);

describe('the admin pages, by page and caller', () => {
  it.each(GRID)('%s', async (_title, page, caller) => {
    await seedFixtures();

    const res = await SELF.fetch(await requestAs(caller, `${ORIGIN}${page}`, { method: 'GET' }), {
      redirect: 'manual',
    });

    if (ADMITTED[caller]) {
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      return;
    }

    // 302 rather than 401: there is a useful next step, unlike on the API.
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/auth/login?next=${encodeURIComponent(page)}`);
  });

  it('is the size it claims to be', () => {
    expect(GRID).toHaveLength(5 * 6);
  });

  it('covers every page on disk except the one named exception', () => {
    /*
     * The census. A page added under `src/pages/admin/` fails here until it is
     * either in `PAGES`, and so has stated its answer for all six callers, or
     * written into the exception by name — which is a thing somebody has to do
     * deliberately, in a file about who may reach the console.
     *
     * Both directions, like the API census: a missing entry is an untested
     * page, and an extra one is a row describing a page that no longer exists.
     */
    expect(pagesOnDisk()).toEqual([...PAGES, LOGIN_PAGE].sort());
  });

  it('found the pages at all', () => {
    // Without this, a glob that matched nothing would make the check above
    // pass against an empty directory.
    expect(pagesOnDisk().length).toBeGreaterThanOrEqual(6);
  });
});

describe(`${LOGIN_PAGE}, the one page here that must NOT redirect a stranger`, () => {
  /*
   * The exception, asserted rather than merely described.
   *
   * Everything above says a signed-out visitor gets bounced. This page is the
   * one that must not be, and the failure mode if it ever is would be silent:
   * the owner would get a 302 to `/auth/login`, which looks like a working gate
   * from every angle except the one that matters — it is the door they came
   * here because they could not open.
   */
  it.each(['anonymous', 'guest', 'member', 'banned admin'] as const)(
    'renders for %s',
    async (caller) => {
      await seedFixtures();

      const res = await SELF.fetch(
        await requestAs(caller, `${ORIGIN}${LOGIN_PAGE}`, { method: 'GET' }),
        { redirect: 'manual' },
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      // Not just a 200 — the form is the entire point of the exemption, and a
      // 200 rendering something else would be just as much a dead door.
      expect(await res.text()).toContain('action="/api/auth/admin-login"');
    },
  );

  it.each(['ambassador', 'admin'] as const)('sends %s on, being already through', async (caller) => {
    /*
     * The one caller shape that does not get a 200, and it is the page's own
     * early return rather than the gate: a sign-in form shown to somebody
     * already signed in is a confusing dead end, so it redirects to `next`,
     * which defaults to `/`. Same shape as `/auth/device`.
     *
     * Worth pinning because it is the assertion that would catch the opposite
     * mistake to the one above — an exemption so wide that the page stopped
     * caring who was asking.
     */
    await seedFixtures();

    const res = await SELF.fetch(
      await requestAs(caller, `${ORIGIN}${LOGIN_PAGE}`, { method: 'GET' }),
      { redirect: 'manual' },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  it('is the only thing under /admin that a stranger gets a 200 from', async () => {
    // The control for the whole block. Stated against the matrix's own list so
    // it cannot drift from it.
    for (const page of PAGES) {
      const res = await SELF.fetch(`${ORIGIN}${page}`, { redirect: 'manual' });
      expect(res.status, `${page} answered ${res.status} to a stranger`).toBe(302);
    }
  });
});

describe('the next parameter', () => {
  it.each([
    ['/admin', '/auth/login?next=%2Fadmin'],
    ['/admin/map', '/auth/login?next=%2Fadmin%2Fmap'],
    ['/admin/meetups', '/auth/login?next=%2Fadmin%2Fmeetups'],
    ['/admin/posts', '/auth/login?next=%2Fadmin%2Fposts'],
    ['/admin/media', '/auth/login?next=%2Fadmin%2Fmedia'],
  ])('%s is encoded as %s', async (page, location) => {
    const res = await SELF.fetch(`${ORIGIN}${page}`, { redirect: 'manual' });

    // The slashes are escaped, not left raw. A raw `next=/admin/map` is still
    // parsed correctly by every browser, but it stops being so the moment a
    // path contains a `&` or a `#`, and encoding it is what makes the rule
    // hold for paths nobody has written yet.
    expect(res.headers.get('location')).toBe(location);
  });

  it('survives the round trip through safeNext unchanged', async () => {
    /*
     * The two halves of this have only ever been tested apart: the middleware
     * builds `next`, and `/auth/login` runs whatever arrives through
     * `safeNext`, which answers `/` to anything it distrusts. If the middleware
     * ever emitted a value `safeNext` rejected, the symptom would not be an
     * error — it would be every admin silently landing on the home page after
     * signing in, which nobody would report as a bug for weeks.
     */
    for (const page of PAGES) {
      const res = await SELF.fetch(`${ORIGIN}${page}`, { redirect: 'manual' });
      const next = new URL(res.headers.get('location')!, ORIGIN).searchParams.get('next');

      expect(next).toBe(page);
      expect(safeNext(next)).toBe(page);
    }
  });

  it('cannot be talked into a protocol-relative target', async () => {
    /*
     * `//admin` would make `next=%2F%2Fadmin`, and a browser resolves a
     * `Location` of `//host` against the *scheme* rather than the origin — an
     * open redirect. It does not happen, because the path is normalised to
     * `/admin` before the middleware reads it, so the value is single-slashed
     * at the source. Asserted rather than assumed: this is a property of the
     * runtime's URL handling, not of any line in this repo, and it is exactly
     * the kind of thing that changes underneath you.
     */
    const res = await SELF.fetch(`${ORIGIN}//admin`, { redirect: 'manual' });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/auth/login?next=%2Fadmin');
  });

  it('carries the path but not the query string', async () => {
    /*
     * Documented, not endorsed. `context.url.pathname` drops `?status=draft`,
     * so an ambassador who follows a filtered link, signs in, and comes back
     * lands on the unfiltered list. Harmless, and a real if small papercut —
     * reported rather than changed, because widening what goes into `next`
     * touches an open-redirect surface and is not a thing to do in passing.
     */
    const res = await SELF.fetch(`${ORIGIN}/admin/posts?status=draft`, { redirect: 'manual' });

    expect(res.headers.get('location')).toBe('/auth/login?next=%2Fadmin%2Fposts');
  });
});

describe('the console is not reachable by a name that merely looks like it', () => {
  it.each(['/administrators', '/admin-notes', '/adminish'])(
    '%s is not annexed by the guard, and does not exist',
    async (path) => {
      /*
       * The other direction of the boundary, and the one `~/lib/auth/admin-path`
       * was extracted to fix: the failure mode is not a leak, it is a public
       * page that bounces every visitor through Discord sign-in for a
       * permission it never wanted. A 404 proves the guard kept its hands off —
       * a redirect here would mean it had annexed the name.
       */
      const res = await SELF.fetch(`${ORIGIN}${path}`, { redirect: 'manual' });

      expect(res.status).toBe(404);
      expect(res.headers.get('location')).toBeNull();
    },
  );

  it('and the real console is still guarded, which is what makes that mean something', async () => {
    const res = await SELF.fetch(`${ORIGIN}/admin`, { redirect: 'manual' });
    expect(res.status).toBe(302);
  });
});

describe('a session that lapses mid-visit', () => {
  it('stops admitting the holder to a page they were just on', async () => {
    // Role is mirrored from Discord on login, but a ban takes effect on the
    // next request — `getSessionUser` refuses the row rather than waiting for
    // the session to expire. This is the page-route half of that; the API half
    // is the `banned admin` column of the matrix.
    await seedFixtures();

    const admin = await requestAs('admin', `${ORIGIN}/admin`, { method: 'GET' });
    const cookie = admin.headers.get('cookie')!;

    expect((await SELF.fetch(admin, { redirect: 'manual' })).status).toBe(200);

    await env.DB.prepare('UPDATE users SET is_banned = 1').run();

    const after = await SELF.fetch(`${ORIGIN}/admin`, {
      headers: { cookie },
      redirect: 'manual',
    });

    expect(after.status).toBe(302);
    expect(after.headers.get('location')).toBe('/auth/login?next=%2Fadmin');
  });
});
