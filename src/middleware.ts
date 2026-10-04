/**
 * Resolves the session cookie into `Astro.locals.user` for every request, and
 * guards the admin surface.
 *
 * Static assets and the media route skip the database lookup entirely — they
 * are the bulk of requests and none of them care who you are.
 */

import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import {
  canReachAdmin,
  isAdminLoginPath,
  isAdminPath,
  isAdminResetPath,
  isImportPath,
} from '~/lib/auth/admin-path';
import { safeNext } from '~/lib/auth/next';
import {
  maybePruneExpiredSessions,
  renewSession,
  resolveSession,
  SESSION_COOKIE,
  sessionCookie,
  slideDue,
} from '~/lib/auth/session';

const SKIP_PREFIXES = ['/_astro/', '/media/', '/favicon', '/assets/'];

/**
 * Re-issues the session cookie on `res`, or hands `res` back untouched when it
 * is the wrong kind of response to carry one.
 *
 * Copied rather than mutated: the Response a route hands back may have
 * immutable headers (a `fetch` passthrough, a `Response.redirect`), and
 * `new Response(body, res)` keeps the status, the status text and every header
 * while giving us a set we may append to.
 *
 * Left alone:
 *   * a redirect, which is about to be replaced by the next request anyway —
 *     and that one carries the same cookie and will re-issue it if still due;
 *   * a WebSocket upgrade (101), which cannot be rebuilt with `new Response`
 *     at all without dropping the socket;
 *   * anything already setting the session cookie — sign-in minting a new
 *     one, sign-out clearing it. Two `Set-Cookie`s for one name in a single
 *     response is a race the browser settles in whatever order it likes.
 */
function withRenewedCookie(res: Response, token: string, url: URL): Response {
  if (res.status === 101 || (res.status >= 300 && res.status < 400)) return res;
  if (res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))) return res;

  const out = new Response(res.body, res);
  out.headers.append('set-cookie', sessionCookie(token, url));
  return out;
}

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;

  if (SKIP_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return next();
  }

  const token = context.cookies.get(SESSION_COOKIE)?.value;
  let renew = false;
  if (token) {
    const session = await resolveSession(env.DB, token);
    if (session) {
      context.locals.user = session.user;
      /*
       * The rolling fortnight, both halves (admin audit, 2026-10, A-01).
       * Decided here, synchronously, from the expiry the lookup already read:
       * the D1 write goes under `waitUntil` so nobody waits on it, and the
       * cookie is re-issued on the way out, below, so the browser's copy does
       * not die on day fourteen while the row lives on. At most once a day —
       * `slideDue` is the same rule `touchSession` applies. A banned or lapsed
       * session never reaches here, so it is never renewed.
       */
      if (slideDue(session.expiresAt)) {
        renew = true;
        context.locals.cfContext?.waitUntil(renewSession(env.DB, token));
      }
    }

    /*
     * The lapsed-row sweep, riding one cookie-carrying request in
     * `PRUNE_ONE_IN` (admin audit, 2026-10). Any cookie, live or not: a lapsed
     * one is precisely the sign that rows are being left behind. Background,
     * and its failure is nobody's problem — the next roll tries again.
     */
    context.locals.cfContext?.waitUntil(
      maybePruneExpiredSessions(env.DB).then(
        () => undefined,
        () => undefined,
      ),
    );
  }

  // Admin surface. The API routes answer 401/403 so fetch() callers get a
  // usable status; page routes bounce through sign-in and come back. Which paths
  // count, and why the boundary matters, is in ~/lib/auth/admin-path.
  //
  // The sign-in they bounce through is the admin form, `/admin/login`, and not
  // Discord's `/auth/login`. It used to be Discord's, and that stopped being a
  // door into the console some time ago: no `DISCORD_ROLE_*` ids are set and
  // the bootstrap id is gone, so Discord can only ever produce a member, and
  // the only accounts that can pass this check are the standalone admins, who
  // have no Discord account at all. Sending them to Discord was a dead end —
  // and a member already signed in was sent on a round trip through Discord
  // that ended at this same refusal. The admin form shows itself to anyone
  // below `ambassador` and forwards anyone at or above it to `next`, and it
  // links to Discord for everybody else, carrying `next` along.
  //
  // Three predicates skip the role check and nothing else does: the import
  // endpoints, which bring their own bearer token; the admin password form,
  // which would otherwise be gated by the very check it exists to get a caller
  // past; and the two password-reset pages, which exist for the admin who
  // cannot get through that form at all. Every one of them is deliberately
  // narrow — an exact path, an exact path, and an exact path plus one token
  // shape — and every one is argued where it is defined, in
  // ~/lib/auth/admin-path.
  if (isAdminPath(path)) {
    if (
      !isImportPath(path) &&
      !isAdminLoginPath(path) &&
      !isAdminResetPath(path) &&
      // The one statement of who gets in, shared with `/admin/login` and with
      // the account menu's link — see `canReachAdmin`.
      !canReachAdmin(context.locals.user)
    ) {
      if (path.startsWith('/api/')) {
        /*
         * The body still says "Forbidden" to a signed-out caller as well.
         * Admin audit, 2026-10, B-18 asks for "Unauthorized" there, and the
         * decision is taken — but `test/admin/api-matrix.test.ts` and
         * `test/helpers/factories.test.ts` pin this exact string as the
         * middleware's signature, so the word changes together with them, in
         * one commit, rather than here alone. The status already carries the
         * distinction a `fetch()` caller acts on: 401 signed out, 403 not enough.
         */
        return new Response(JSON.stringify({ error: 'Forbidden' }), {
          status: context.locals.user ? 403 : 401,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      /*
       * `next` keeps the query string (admin audit, 2026-10, A-03), so a
       * bounced `/admin/posts?status=draft` comes back filtered. It goes
       * through `safeNext` here as well as on arrival: the path is always
       * `/admin…` so it can only be refused for a control character the URL
       * parser left in the query, and then the bare path is the honest
       * fallback rather than `/`.
       */
      const withQuery = safeNext(`${path}${context.url.search}`);
      const target = withQuery === '/' ? safeNext(path) : withQuery;
      return context.redirect(`/admin/login?next=${encodeURIComponent(target)}`, 302);
    }
  }

  const res = await next();
  return renew && token ? withRenewedCookie(res, token, context.url) : res;
});
