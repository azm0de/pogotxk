/**
 * Where sign-in should open when the site is running as an installed app.
 *
 * The problem this exists to solve, which is not ours and cannot be fixed by
 * anything we send to Discord:
 *
 * `/go` is installed to the home screen with `display: standalone`, and
 * `scope` covers our origin only. So tapping sign-in navigates in-scope to
 * /auth/login, which redirects to discord.com — *out* of scope — and Android
 * hands that to an in-app Custom Tab. That tab does not necessarily share the
 * cookie jar of the browser the trainer actually uses, and Discord shows its
 * email-and-password form whenever it cannot see a session of its own. The
 * trainer is signed into Discord one app away and gets asked for a password
 * anyway.
 *
 * Our OAuth request is already correct — /auth/login asks for `prompt=none`
 * and the callback retries with no prompt at all, so a browser holding a
 * Discord session sails through with no screen. The variable is *which
 * browser opens the page*, so that is what this changes.
 *
 * This is the same root cause the Android app documents at
 * MainActivity.startSignIn: "it shares the browser's cookie jar, so a trainer
 * already signed into Discord in Chrome is not asked again". The app solved it
 * with a Custom Tab because it starts from a WebView whose jar is *always*
 * empty. The PWA has to go one step further and leave for the real browser.
 *
 * Free of `cloudflare:workers` imports so a plain tsx test can import it.
 */

/**
 * True when the page is running as an installed app rather than a browser tab.
 *
 * Both checks are needed. `display-mode: standalone` is the standard and is
 * what Android reports for a home-screen install; `navigator.standalone` is
 * Apple's non-standard predecessor and is still the only signal on iOS.
 *
 * Returns false during SSR, where `window` does not exist and no handoff is
 * possible or wanted.
 */
export function isInstalledApp(): boolean {
  if (typeof window === 'undefined') return false;

  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;

  // iOS only, and absent from the DOM lib's Navigator type.
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/**
 * An Android intent URL that opens `path` in the trainer's default browser.
 *
 * `intent://` is the only way out of an installed app's own browsing context.
 * A plain `target="_blank"` does not do it — the PWA host resolves that itself
 * and the trainer stays in the same jar, which is the entire bug.
 *
 * Two deliberate choices:
 *
 * **No `package=`.** Pinning `com.android.chrome` would presume which browser
 * holds the Discord session. Plenty of phones default to Samsung Internet or
 * Firefox, and on those, forcing Chrome would produce exactly the empty jar we
 * are trying to escape. Leaving it out makes Android resolve the default
 * `https` handler, which is by definition the browser the trainer uses.
 *
 * **`S.browser_fallback_url`.** A device that cannot resolve the intent — iOS,
 * a desktop browser, anything non-Android — follows this instead, so the worst
 * case is the ordinary navigation we would have done anyway rather than a tap
 * that does nothing.
 *
 * @param path Same-origin path to open. Pass the value you would have used as
 *   the anchor's `href`; it is not re-validated here because it never comes
 *   from user input — `safeNext` already guards the only part that varies.
 * @param origin Absolute origin, normally `window.location.origin`.
 */
export function externalLoginHref(path: string, origin: string): string {
  const absolute = new URL(path, origin);

  // The intent URL carries host and path itself and takes the scheme from the
  // fragment, so the `https://` prefix is dropped from the front and declared
  // at the back.
  const withoutScheme = `${absolute.host}${absolute.pathname}${absolute.search}`;

  const parts = [
    'scheme=https',
    `S.browser_fallback_url=${encodeURIComponent(absolute.toString())}`,
    'end',
  ];

  return `intent://${withoutScheme}#Intent;${parts.join(';')};`;
}

/**
 * Click handler for a sign-in link inside an installed app.
 *
 * Returns true when it has taken over and the caller should prevent the
 * default navigation; false when the plain `href` is already right, which is
 * every ordinary browser tab, every desktop, and the Android app's WebView
 * (which intercepts /auth/login before a click handler ever runs).
 *
 * Keeping the real `href` on the anchor and only diverting here means the link
 * stays a link — long-press, middle click and "open in new tab" all keep
 * working, and nothing breaks if scripting is unavailable.
 */
export function divertSignInToBrowser(href: string): boolean {
  if (!isInstalledApp()) return false;

  // Android only. iOS has no intent scheme and Safari will not hand a page to
  // another browser, so an iPhone install keeps the in-app flow and pays a
  // one-time Discord login. Nothing here can change that.
  if (!/android/i.test(window.navigator.userAgent)) return false;

  window.location.href = externalLoginHref(href, window.location.origin);
  return true;
}

/** Matches every way the site starts sign-in, and nothing else. */
export const SIGN_IN_SELECTOR = 'a[href^="/auth/login"]';

/**
 * Whether a click on `target` should be diverted, and to where.
 *
 * Split out from the listener so the decision is testable without a DOM: the
 * listener below is three lines of plumbing, this is the part that can be
 * wrong.
 */
export function signInHrefFor(target: {
  closest(selector: string): { getAttribute(name: string): string | null } | null;
} | null): string | null {
  return target?.closest(SIGN_IN_SELECTOR)?.getAttribute('href') ?? null;
}

/**
 * Diverts every sign-in link on the page, however it got there.
 *
 * Delegated from the document rather than bound per link, for one reason that
 * decides it: the header's account control is built at runtime by an
 * `is:inline` script in Base.astro, which cannot import this module. Binding
 * per link would mean reimplementing the intent URL inside that script, and
 * two copies of this logic would drift the first time either changed.
 *
 * Delegation also covers the React islands (`QuickActions`, `LiveBoard`) and
 * `/account/delete` without any of them importing anything — their anchors are
 * ordinary DOM anchors and their clicks bubble. Every sign-in entry point is
 * handled in one place, and no component has to remember to opt in.
 *
 * Non-passive, because the whole job is to call `preventDefault` — and only
 * ever inside an installed app on Android, so an ordinary tab keeps following
 * the plain `href` exactly as before.
 */
export function attachSignInHandoff(doc: Document): void {
  doc.addEventListener('click', (event) => {
    // A modified click is asking for a new tab or a download; leave it alone.
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const href = signInHrefFor(event.target as Element | null);
    if (href && divertSignInToBrowser(href)) event.preventDefault();
  });
}
