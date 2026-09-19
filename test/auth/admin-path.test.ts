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
 * What this pins: every path the console actually uses stays guarded, and no
 * path outside it is annexed by sharing a prefix.
 */

import { describe, expect, it } from 'vitest';
import { isAdminPath, isImportPath } from '~/lib/auth/admin-path';

describe('isAdminPath', () => {
  it.each([
    '/admin',
    '/admin/',
    '/admin/map',
    '/admin/posts',
    '/admin/media',
    '/admin/meetups',
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
