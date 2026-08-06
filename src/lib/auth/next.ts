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
