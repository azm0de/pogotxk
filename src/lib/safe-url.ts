/**
 * The one test for "may this string become an `href`".
 *
 * Admin-entered links — a meetup's Campfire page, a photo's source article —
 * are rendered as anchors on public pages. `z.string().url()` was the only gate
 * in front of them, and it accepts `javascript:alert(1)`: that is a perfectly
 * valid URL, it just is not a web page. The media PATCH route had its own,
 * stricter check; the meetup routes and the upload did not (admin audit,
 * 2026-10, B-02/B-03). This is that stricter check, written once, used both
 * when a value is accepted and again when it is rendered, so a row that got in
 * before the check existed still cannot become a script.
 *
 * Pure, with no imports, because the map island runs it in the browser too.
 *
 * What it refuses, and why each is its own rule rather than "whatever `new URL`
 * rejects":
 *
 *   * anything not spelled `http://` or `https://` at the very start. A
 *     scheme-relative `//evil.example` resolves against the page and
 *     `/\evil.example` is read by browsers as the same thing, so "absolute"
 *     has to be checked on the text, not on the parse;
 *   * any whitespace or control character *inside* the value. The WHATWG
 *     parser silently deletes tab, CR and LF, which is precisely how
 *     `java\tscript:` gets past a naive prefix test — and a URL that needs
 *     those characters removed to make sense is not one an editor typed;
 *   * a backslash anywhere, which special-scheme parsing treats as a slash;
 *   * credentials (`https://user:pass@host`), which are a phishing shape on a
 *     link a reader is invited to click and never something we need;
 *   * anything longer than `maxLength`, before and after normalisation.
 */

/** Generous for a real link, and a ceiling on what a row can carry. */
export const MAX_URL_LENGTH = 2048;

const ABSOLUTE_HTTP = /^https?:\/\//i;
// C0 controls, space, DEL, C1 controls, and the backslash.
const FORBIDDEN = /[\u0000- \u007f-\u009f\\]/;

/**
 * The normalised `http(s)` URL, or null when `raw` is not one we would link to.
 * Surrounding whitespace is forgiven; whitespace inside is not.
 */
export function httpUrlOrNull(raw: unknown, maxLength: number = MAX_URL_LENGTH): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === '' || value.length > maxLength) return null;
  if (FORBIDDEN.test(value)) return null;
  if (!ABSOLUTE_HTTP.test(value)) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.hostname === '') return null;

  const href = url.href;
  return href.length > maxLength ? null : href;
}

/** The same rule as a predicate, for schema refinements. */
export function isHttpUrl(raw: unknown, maxLength: number = MAX_URL_LENGTH): boolean {
  return httpUrlOrNull(raw, maxLength) !== null;
}
