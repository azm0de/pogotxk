/**
 * Discord event cover art, served through our own origin.
 *
 * The two reasons in `game-image.ts` apply here as well — it is someone else's
 * bandwidth, and it is a dependency we do not control — but there is a third
 * that is specific to Discord and is the reason this module exists:
 *
 * **`cdn.discordapp.com` sits behind Cloudflare's bot management, so an `<img>`
 * pointed at it sets a `__cf_bm` cookie in the visitor's browser.** That is a
 * third-party cookie on a site whose `/privacy` page enumerates its third
 * parties and whose pages say there is no tracking on them, and it is a real
 * cookie rather than a theoretical one: Lighthouse flagged exactly one on the
 * home page and it was this. Proxying removes it, because the browser then only
 * ever talks to us. The bytes are re-served from a Response we build ourselves,
 * so upstream `Set-Cookie` never reaches the visitor.
 *
 * The proxy takes a *path*, never a URL, and the path must sit under
 * `guild-events/`. That second rule carries more weight here than the origin
 * check does for Leek Duck: `cdn.discordapp.com/attachments/...` is
 * user-uploaded content, and a proxy willing to fetch that would turn this
 * Worker into a laundering service for anything at all that anyone uploads to
 * Discord — served from our domain, with our reputation on it.
 */

/** Upstream. A constant: there is no user-controlled host in this module. */
export const DISCORD_CDN = 'https://cdn.discordapp.com';

/** Our own route prefix. Must match src/pages/img/discord/[...path].ts. */
const PROXY_PREFIX = '/img/discord/';

/** The only tree on that CDN this proxy will fetch. See the header. */
const ALLOWED_PREFIX = 'guild-events/';

/**
 * The widths Discord's CDN transcodes to. It rejects anything else outright, so
 * an unrecognised value is dropped rather than forwarded — a 400 from upstream
 * would present as a broken image with no explanation.
 */
const SIZES = new Set([16, 32, 64, 128, 256, 512, 1024, 2048, 4096]);

/** The default `?size=`, and the one `cdnImage` has always asked for. */
export const DEFAULT_SIZE = 1024;

/**
 * Build the proxy path for one event's cover art.
 *
 * Both components are validated rather than escaped. They arrive from the
 * Discord API as a snowflake and an icon hash, so anything that does not look
 * like one is a bug or a hostile payload, and in either case the right answer is
 * no image rather than a URL built out of it. Animated hashes are prefixed
 * `a_`, which is why `_` is in the hash charset.
 */
export function discordEventImagePath(
  eventId: string,
  hash: string,
  size: number = DEFAULT_SIZE,
): string | null {
  if (!/^[0-9]{1,32}$/.test(eventId)) return null;
  if (!/^[A-Fa-f0-9_]{1,64}$/.test(hash)) return null;
  const n = SIZES.has(size) ? size : DEFAULT_SIZE;
  return `${PROXY_PREFIX}${ALLOWED_PREFIX}${eventId}/${hash}.webp?size=${n}`;
}

/**
 * Resolve a proxy path back to the upstream URL, or null if it escapes.
 *
 * Origin-based, for the reason `leekduckPath` spells out: `..`, `//host` and the
 * backslash form `/\host` are all folded by the WHATWG parser *before* this
 * comparison, so a path that would leave the CDN fails the check rather than
 * having to be pattern-matched for. The prefix test then runs on the parsed and
 * normalised `pathname`, never on the raw string, so `guild-events/../attachments`
 * cannot slip past it either.
 */
export function discordUpstream(path: string, size: string | null): URL | null {
  if (!path) return null;

  let url: URL;
  try {
    url = new URL(path, `${DISCORD_CDN}/`);
  } catch {
    return null;
  }

  if (url.origin !== DISCORD_CDN) return null;
  if (!url.pathname.startsWith(`/${ALLOWED_PREFIX}`)) return null;

  // Rebuild the query rather than forwarding it: `size` is the only parameter
  // upstream understands, and it is the only one that travels.
  const n = Number(size);
  url.search = '';
  if (size !== null && Number.isInteger(n) && SIZES.has(n)) {
    url.searchParams.set('size', String(n));
  }
  return url;
}
