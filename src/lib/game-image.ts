/**
 * Event artwork from Leek Duck, served through our own origin.
 *
 * Two reasons not to put `cdn.leekduck.com` straight into `<img src>`:
 *
 * 1. It is their bandwidth. We already take their data for free on the single
 *    condition that we credit it; making every visitor pull images off their
 *    CDN as well is not a good way to hold up our end. Proxying lets Cloudflare
 *    cache at our edge, so repeat views cost them nothing.
 * 2. It is a dependency we do not control. Hotlink protection, a path change,
 *    or an outage would put broken images across the site with no fallback.
 *
 * The proxy takes only a *path*, never a URL. There is no user-controlled host
 * anywhere in this module — the origin is a constant — which is what makes it
 * structurally impossible to turn into an open proxy. See `leekduckPath`.
 */

export const LEEKDUCK_CDN = 'https://cdn.leekduck.com';

/** Our own route prefix. Must match src/pages/img/leekduck/[...path].ts. */
const PROXY_PREFIX = '/img/leekduck/';

/**
 * Rewrite a Leek Duck CDN URL to our proxy path.
 *
 * Anything else is returned unchanged: meetup heroes are already local
 * (`/media/...`), and an unrecognised host should not be silently rehosted.
 * Returns null for input we will not render at all.
 */
export function proxiedImageUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;

  // Local paths are already ours.
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.origin !== LEEKDUCK_CDN) return null;

  // `pathname` is already normalised and percent-encoded by the URL parser,
  // and always begins with "/".
  return PROXY_PREFIX + url.pathname.slice(1) + url.search;
}

/**
 * Resolve a proxy path back to the upstream URL, or null if it escapes.
 *
 * The check is deliberately origin-based rather than a string test. `..`,
 * a leading `//host`, and the backslash form `/\host` all get folded by the
 * WHATWG parser *before* this comparison, so anything that would leave the CDN
 * fails here rather than being pattern-matched for. This codebase has shipped
 * that exact bypass twice — once in the markdown allowlist and once in the
 * sign-in `next` parameter — so it is checked the way the parser sees it.
 */
export function leekduckPath(path: string): URL | null {
  if (!path) return null;

  let url: URL;
  try {
    url = new URL(path, `${LEEKDUCK_CDN}/`);
  } catch {
    return null;
  }

  if (url.origin !== LEEKDUCK_CDN) return null;
  return url;
}

/** Content types we will pass through. An HTML error page is not an image. */
export function isRenderableImage(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(';')[0].trim().toLowerCase();
  return (
    type === 'image/jpeg' ||
    type === 'image/png' ||
    type === 'image/webp' ||
    type === 'image/gif' ||
    type === 'image/avif'
  );
}
