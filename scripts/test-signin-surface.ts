/**
 * Checks the intent URL that carries sign-in out of the installed app.
 *
 * Worth testing rather than eyeballing: the shape is fiddly, a malformed
 * intent URL fails by doing *nothing* when tapped, and the only place the
 * mistake shows up is on a phone.
 *
 *   npx tsx scripts/test-signin-surface.ts
 */

import {
  SIGN_IN_SELECTOR,
  externalLoginHref,
  isInstalledApp,
  signInHrefFor,
} from '../src/lib/auth/signin-surface';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`,
  );
  if (!ok) failures++;
}

const ORIGIN = 'https://pogotxk.gnomelabz.workers.dev';
const LOGIN = '/auth/login?next=%2Fgo';

console.log('\n== intent url shape ==');

const href = externalLoginHref(LOGIN, ORIGIN);

check('starts with the intent scheme', href.startsWith('intent://'), true);
check(
  'carries host and path, with https stripped from the front',
  href.startsWith('intent://pogotxk.gnomelabz.workers.dev/auth/login'),
  true,
);
check('declares the scheme in the fragment', href.includes(';scheme=https;'), true);
check('terminates the intent', href.endsWith(';end;'), true);

/*
 * The whole point of the fallback: a device that cannot resolve an intent URL
 * must still get somewhere. Without this, tapping sign-in on iOS or desktop
 * would do nothing at all.
 */
console.log('\n== fallback ==');
const fallback = decodeURIComponent(
  href.match(/S\.browser_fallback_url=([^;]*)/)?.[1] ?? '',
);
check('falls back to the real https url', fallback, `${ORIGIN}${LOGIN}`);

/*
 * The fallback is a whole URL sitting inside a `;`-delimited list. Left raw,
 * its own `?`, `&` and `/` would be read as intent syntax and the URL would be
 * truncated at the first delimiter.
 */
check(
  'fallback is encoded, so its query cannot be read as intent syntax',
  href.includes('S.browser_fallback_url=https%3A%2F%2F'),
  true,
);
check('no raw ? survives inside the fragment', href.split('#')[1].includes('?'), false);

/*
 * `next` is what varies, and it arrives already validated by safeNext. It has
 * to survive the round trip intact or the trainer lands on the wrong page.
 */
console.log('\n== next survives ==');
check(
  'query is preserved on the intent half',
  href.includes('/auth/login?next=%2Fgo#'),
  true,
);
check(
  'a bare path with no query still works',
  externalLoginHref('/auth/login', ORIGIN).startsWith(
    'intent://pogotxk.gnomelabz.workers.dev/auth/login#Intent;',
  ),
  true,
);

/*
 * Pinning a browser package is the obvious-looking thing to do and is wrong:
 * it would force Chrome onto a phone whose Discord session lives in Samsung
 * Internet, recreating the empty-cookie-jar bug this exists to fix.
 */
console.log('\n== no browser is presumed ==');
check('does not pin a package', /(^|;)package=/.test(href), false);

/*
 * SSR runs this module too. `window` is absent there, and a throw would take
 * the whole page down rather than degrade.
 */
console.log('\n== server-side ==');
check('isInstalledApp is false without a window', isInstalledApp(), false);

/*
 * Which clicks the delegated listener claims. This is the part that can be
 * wrong in a way nothing else catches: too greedy and it hijacks ordinary
 * links, too narrow and the PWA keeps showing a password form.
 *
 * A fake `closest` standing in for the DOM — enough to exercise the decision
 * without pulling in a whole DOM implementation for four assertions.
 */
console.log('\n== which clicks are claimed ==');

const fakeTarget = (href: string | null) => ({
  closest: (selector: string) =>
    selector === SIGN_IN_SELECTOR && href !== null ? { getAttribute: () => href } : null,
});

check('claims a sign-in link', signInHrefFor(fakeTarget(LOGIN)), LOGIN);
check('ignores a click on nothing', signInHrefFor(null), null);
check('ignores a non-matching element', signInHrefFor(fakeTarget(null)), null);

/*
 * The selector is the whole allowlist, so it is worth pinning: it must catch
 * every /auth/login link the site renders and nothing else. `/auth/logout` in
 * particular sits one character away and must never be diverted.
 */
check('selector targets only /auth/login anchors', SIGN_IN_SELECTOR, 'a[href^="/auth/login"]');
check('would not match /auth/logout', '/auth/logout'.startsWith('/auth/login'), false);

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
