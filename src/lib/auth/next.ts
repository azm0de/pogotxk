/**
 * Validation for the post-sign-in `next` redirect target.
 *
 * Lives in its own module, free of `cloudflare:workers` imports, so both
 * /auth/login and /auth/callback can use it and a plain tsx test can import it.
 */

/** True for C0 controls and DEL. Written as codepoint maths rather than a
 *  character class because literal control bytes in source do not survive
 *  every editor and linter round-trip. */
function isControl(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}

/**
 * Only same-origin paths, so `next` can never become an open redirect.
 *
 * Rejecting `//host` is not enough. Browsers resolve `Location` with the WHATWG
 * URL parser, which folds a backslash into a slash and strips ASCII tab, LF and
 * CR *before* resolving. So `/\host` and `/<TAB>//host` both leave the origin
 * while sailing past a naive "starts with / but not //" check.
 *
 * This is the same bug class already fixed once in src/lib/markdown.ts, whose
 * URL allowlist deliberately covers the backslash form. The lesson was learned
 * in one file and not carried to this one — scripts/test-auth.ts now covers it.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return '/';

  // Drop what the URL parser would remove anyway, so the checks below see the
  // string the browser will actually resolve rather than the one we were given.
  const cleaned = [...raw].filter((ch) => ch !== '\t' && ch !== '\n' && ch !== '\r').join('');

  if (!cleaned.startsWith('/')) return '/';
  // Both slash shapes: to a browser, `//host` and `/\host` are protocol-relative.
  if (/^\/[/\\]/.test(cleaned)) return '/';
  // Any remaining control character has no business in a path.
  if ([...cleaned].some(isControl)) return '/';

  return cleaned;
}

/**
 * Where /auth/logout sends the browser.
 *
 * Signing out of this site does NOT sign you out of Discord, and that is the
 * whole reason `wantsSwitch` exists. Discord keeps its own session in the
 * browser, and /auth/login asks for `prompt=none` so returning members are not
 * made to click through an approval screen every visit. Put those two together
 * and a plain sign-out followed by sign-in silently re-authorises the SAME
 * Discord account — there is no point in the round trip where anyone is asked
 * who they are. Someone with two accounts can never reach the second one.
 *
 * So "use a different account" is a distinct action: drop our session, then
 * start sign-in with `consent=1`, which forces Discord's approval screen — the
 * one screen in the flow that offers to switch accounts.
 *
 * The destination still goes through `safeNext`, because it arrives as a query
 * parameter on a GET and ends up in a Location header either way.
 */
export function signOutTarget(rawNext: string | null | undefined, wantsSwitch: boolean): string {
  const dest = safeNext(rawNext);
  if (!wantsSwitch) return dest;

  const params = new URLSearchParams({ consent: '1' });
  // '/' is /auth/login's own default; sending it explicitly just makes for a
  // uglier URL with no change in behaviour.
  if (dest !== '/') params.set('next', dest);
  return `/auth/login?${params}`;
}
