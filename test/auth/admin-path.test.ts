/**
 * The boundary of the admin gate.
 *
 * This is here rather than in `middleware.test.ts` because the interesting
 * cases are not observable through `SELF.fetch`: `env.ASSETS` is unbound in the
 * Worker test pool, so a path with no route throws inside Astro's static-asset
 * fallback before it can answer anything. In production it does not throw —
 * `fallbackToAssets` returns nothing for a 404 and the app renders the
 * not-found page *through the middleware* — which is exactly why an over-wide
 * prefix mattered there and could not be caught here.
 *
 * So the decision was moved into `~/lib/auth/admin-path`, where a plain test
 * reaches it directly. Same move, and same reason, as `interactionTarget` and
 * `signInHrefFor`.
 *
 * What this pins: every path the console actually uses stays guarded, no path
 * outside it is annexed by sharing a prefix, and the two holes deliberately cut
 * in the gate — the import endpoints and the admin password form — are each
 * exactly as wide as they were meant to be and no wider.
 */

import { describe, expect, it } from 'vitest';
import {
  isAdminLoginPath,
  isAdminPath,
  isAdminResetPath,
  isImportPath,
  isResetToken,
} from '~/lib/auth/admin-path';

/** 64 lowercase hex characters — what `randomToken()` produces. */
const TOKEN = 'a'.repeat(64);
const OTHER_TOKEN = '0123456789abcdef'.repeat(4);

describe('isAdminPath', () => {
  it.each([
    '/admin',
    '/admin/',
    '/admin/map',
    '/admin/posts',
    '/admin/media',
    '/admin/meetups',
    // The admin password form is under the gate like everything else. The
    // middleware skips the *role* check for it; this predicate still covers it.
    '/admin/login',
    '/api/admin',
    '/api/admin/',
    '/api/admin/posts',
    '/api/admin/posts/12',
    '/api/admin/import-legacy',
    '/api/admin/config-check',
  ])('guards %s', (path) => {
    expect(isAdminPath(path)).toBe(true);
  });

  it.each([
    // The case this module was extracted for. Five shared letters, and nothing
    // else in common.
    '/administrators',
    '/adminish',
    '/admin-notes',
    '/adminstrivia',
    '/api/administrators',
    '/api/admin-tools',
  ])('does not annex %s', (path) => {
    expect(isAdminPath(path)).toBe(false);
  });

  it.each([
    '/',
    '/go',
    '/live',
    '/blog/admin-changes',
    '/api/me.json',
    '/api/flares',
    '/auth/login',
  ])('leaves %s alone', (path) => {
    expect(isAdminPath(path)).toBe(false);
  });

  it('is not fooled by the word appearing later in the path', () => {
    // `startsWith` was never at risk of this one, but a switch to `includes`
    // while "fixing" the boundary would be, and it is a plausible mistake.
    expect(isAdminPath('/blog/how-the-admin-console-works')).toBe(false);
    expect(isAdminPath('/media/admin')).toBe(false);
  });
});

describe('isAdminLoginPath', () => {
  /*
   * The whole of this predicate is that it is an equality check, so the only
   * tests worth writing are the ones that would fail against a looser one. A
   * file that asserted `isAdminLoginPath('/admin/login')` and stopped would
   * pass identically against `startsWith`, against `isUnder`, and against
   * `includes` — three implementations that each hand out a different amount of
   * the admin console to anyone who is not signed in.
   */
  it('exempts the admin password form, which is the one path it is for', () => {
    expect(isAdminLoginPath('/admin/login')).toBe(true);

    // And it is still an admin path. The middleware skips the role check for
    // it, not the whole branch — the same relationship `isImportPath` has.
    expect(isAdminPath('/admin/login')).toBe(true);
  });

  it.each([
    // The trailing slash. `isUnder` treats this as "below the section" and
    // would exempt it; nothing routes there, and an unrouted path inside the
    // gate must keep bouncing rather than reach Astro's asset fallback.
    '/admin/login/',
    // Anything nested. The exemption is for one page, not for a section that
    // does not exist and that nobody has had to think about yet.
    '/admin/login/extra',
    '/admin/login/extra/deeper',
    // The prefix collisions, which are the same failure `/administrators` is
    // at the top of the module, pointed the other way: here a shared prefix
    // would hand a real admin page to a stranger rather than annex a public one.
    '/admin/logins',
    '/admin/login-notes',
    '/admin/login.json',
    // Astro routes case-sensitively, so this reaches no page — but it is under
    // the gate, and the safe answer for an unrouted admin path is the gate.
    '/admin/Login',
    // The API half of the console. A login *route* there would be gated into
    // uselessness, which is why the real one lives at /api/auth/admin-login.
    '/api/admin/login',
  ])('does not exempt %s, which stays gated', (path) => {
    expect(isAdminLoginPath(path)).toBe(false);
    expect(isAdminPath(path)).toBe(true);
  });

  it('does not exempt /adminlogin, which is not an admin path at all', () => {
    // The other direction of the boundary. This one is outside `isAdminPath`
    // entirely, so it is not "gated" — it is simply none of the gate's
    // business, and a public page by that name would 404 rather than bounce.
    expect(isAdminLoginPath('/adminlogin')).toBe(false);
    expect(isAdminPath('/adminlogin')).toBe(false);
  });

  it('would not survive a switch to a prefix match', () => {
    // Stated as the mechanism rather than as a list of paths, so the reason
    // the cases above were chosen is legible: every one of them satisfies the
    // `startsWith` an implementer might reach for, and none may be exempt.
    for (const path of ['/admin/login/', '/admin/login/extra', '/admin/logins', '/admin/login-notes']) {
      expect(path.startsWith('/admin/login')).toBe(true);
      expect(isAdminLoginPath(path)).toBe(false);
    }
  });

  it('would not survive a switch to isUnder either', () => {
    // `isUnder(path, '/admin/login')` is `path === section || startsWith(
    // section + '/')`, which is narrower than a bare prefix and still too wide:
    // it exempts the trailing slash and everything under it.
    for (const path of ['/admin/login/', '/admin/login/extra', '/admin/login/extra/deeper']) {
      expect(path.startsWith('/admin/login/')).toBe(true);
      expect(isAdminLoginPath(path)).toBe(false);
    }
  });

  it('leaves the rest of the console alone', () => {
    for (const path of ['/admin', '/admin/', '/admin/map', '/admin/posts', '/admin/media']) {
      expect(isAdminLoginPath(path)).toBe(false);
    }
  });
});

describe('isResetToken', () => {
  /*
   * The shape the gate below leans on, so it is pinned on its own first. Every
   * rejection here is a path that would otherwise be carried out of the admin
   * gate by `isAdminResetPath`.
   */
  it('accepts exactly what randomToken() produces', () => {
    expect(isResetToken(TOKEN)).toBe(true);
    expect(isResetToken(OTHER_TOKEN)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['one character short', 'a'.repeat(63)],
    ['one character long', 'a'.repeat(65)],
    ['uppercase hex', 'A'.repeat(64)],
    ['not hex at all', 'z'.repeat(64)],
    ['base64url of the right length', `${'-'.repeat(32)}${'_'.repeat(32)}`],
    ['a path segment smuggled in', `${'a'.repeat(62)}/x`],
    ['whitespace around a good one', ` ${TOKEN} `],
    ['a newline after a good one', `${TOKEN}\n`],
  ])('refuses %s', (_label, value) => {
    expect(isResetToken(value)).toBe(false);
  });

  it('is anchored at both ends', () => {
    // An unanchored pattern would accept a token with anything appended, which
    // in a path is the difference between one page and a whole section.
    expect(isResetToken(`${TOKEN}${TOKEN}`)).toBe(false);
    expect(isResetToken(`prefix${TOKEN}`)).toBe(false);
  });
});

describe('isAdminResetPath', () => {
  /*
   * The second hole in the gate, and the one that could not be an equality
   * check — the redemption path is different every time. So the tests that
   * matter are the ones that would pass against a looser rule: anything that
   * satisfies `startsWith('/admin/reset')` and must still be gated.
   */
  it('exempts the request form, matched exactly', () => {
    expect(isAdminResetPath('/admin/reset')).toBe(true);
    // Still an admin path. The middleware skips the role check for it, not the
    // whole branch — the same relationship `isAdminLoginPath` has.
    expect(isAdminPath('/admin/reset')).toBe(true);
  });

  it('exempts a redemption link, and only in the one shape it mints', () => {
    expect(isAdminResetPath(`/admin/reset/${TOKEN}`)).toBe(true);
    expect(isAdminResetPath(`/admin/reset/${OTHER_TOKEN}`)).toBe(true);
    expect(isAdminPath(`/admin/reset/${TOKEN}`)).toBe(true);
  });

  it.each([
    // The trailing slash, which redeems nothing and which `isUnder` would
    // exempt. This is the case the token half is most at risk of admitting.
    '/admin/reset/',
    // A prefix collision, the same failure `/administrators` is at the top of
    // the module — pointed the other way, so it would hand a real admin page
    // to a stranger.
    '/admin/resets',
    '/admin/reset-notes',
    '/admin/reset.json',
    // Nested below a genuine token. The exemption is one page, not a section
    // rooted at whatever a token happens to be.
    `/admin/reset/${TOKEN}/extra`,
    `/admin/reset/${TOKEN}/`,
    // Two segments that are each half a token.
    `/admin/reset/${'a'.repeat(32)}/${'a'.repeat(32)}`,
    // Wrong shapes in the token position.
    '/admin/reset/abc',
    `/admin/reset/${'A'.repeat(64)}`,
    `/admin/reset/${'a'.repeat(63)}`,
    // Astro routes case-sensitively, so this reaches no page — and an unrouted
    // path inside the gate must keep bouncing.
    '/admin/Reset',
    // The API half of the console, where a gated reset route would be useless.
    '/api/admin/reset',
  ])('does not exempt %s, which stays gated', (path) => {
    expect(isAdminResetPath(path)).toBe(false);
    expect(isAdminPath(path)).toBe(true);
  });

  it('would not survive a switch to a prefix match', () => {
    // Stated as the mechanism, exactly as the login block does: every one of
    // these satisfies the `startsWith` an implementer would reach for.
    for (const path of [
      '/admin/reset/',
      '/admin/resets',
      '/admin/reset-notes',
      `/admin/reset/${TOKEN}/extra`,
    ]) {
      expect(path.startsWith('/admin/reset')).toBe(true);
      expect(isAdminResetPath(path)).toBe(false);
    }
  });

  it('would not survive a switch to isUnder either', () => {
    // `isUnder(path, '/admin/reset')` exempts the trailing slash and
    // everything below it, which is most of what is refused above.
    for (const path of ['/admin/reset/', `/admin/reset/${TOKEN}/extra`, '/admin/reset/abc']) {
      expect(path.startsWith('/admin/reset/')).toBe(true);
      expect(isAdminResetPath(path)).toBe(false);
    }
  });

  it('does not exempt /adminreset, which is not an admin path at all', () => {
    expect(isAdminResetPath('/adminreset')).toBe(false);
    expect(isAdminPath('/adminreset')).toBe(false);
  });

  it('leaves the rest of the console alone, including the login form', () => {
    for (const path of ['/admin', '/admin/', '/admin/map', '/admin/posts', '/admin/login']) {
      expect(isAdminResetPath(path)).toBe(false);
    }
    // And the two exemptions do not overlap: each covers its own paths and
    // neither has quietly grown into the other.
    expect(isAdminLoginPath('/admin/reset')).toBe(false);
    expect(isAdminLoginPath(`/admin/reset/${TOKEN}`)).toBe(false);
  });
});

describe('isImportPath', () => {
  it.each(['/api/admin/import-legacy', '/api/admin/import-media'])('exempts %s', (path) => {
    // These carry their own bearer-token guard, because the first run happens
    // on a fresh deployment where nobody can sign in yet.
    expect(isImportPath(path)).toBe(true);
    // And they are still admin paths — the middleware skips the *role* check
    // for them, not the whole branch.
    expect(isAdminPath(path)).toBe(true);
  });

  it.each([
    '/api/admin/posts',
    '/api/admin/media',
    '/api/admin/config-check',
    // The exemption is the `import-` prefix, not the word "import" anywhere.
    '/api/admin/imports',
    '/api/admin/posts/import-legacy',
  ])('does not exempt %s', (path) => {
    expect(isImportPath(path)).toBe(false);
  });

  it('cannot be reached from outside the admin API', () => {
    // A bypass that matched `/import-` anywhere would be a hole rather than an
    // exemption.
    expect(isImportPath('/import-legacy')).toBe(false);
    expect(isImportPath('/api/import-legacy')).toBe(false);
  });
});
