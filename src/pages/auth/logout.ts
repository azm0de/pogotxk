/**
 * Sign out.
 *
 *   /auth/logout                 drop the session, go home (or to ?next=)
 *   /auth/logout?switch=1        drop the session, then re-run sign-in asking
 *                                Discord for consent, so a different account
 *                                can be chosen
 *
 * See `signOutTarget` for why the second one has to exist: our session and
 * Discord's are separate, so signing out here alone can never get you into a
 * different Discord account.
 *
 * POST is the canonical shape (admin audit, 2026-10, A-09): the account menu
 * in `Base.astro` signs out with a one-button form. GET stays, because a
 * bookmarked or hand-typed `/auth/logout` and any link not yet converted
 * should keep working — but a GET that a browser marks as coming from another
 * site does not end the session. That is the shape of the finding: with
 * `SameSite=Lax` the cookie rides along on a cross-site top-level navigation,
 * so any page could sign a visitor out with a link. POST is safe from that by
 * construction: Astro's origin check refuses a cross-site form post.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { signOutTarget } from '~/lib/auth/next';
import { clearedSessionCookie, destroySession, SESSION_COOKIE } from '~/lib/auth/session';

export const prerender = false;

async function signOut(ctx: APIContext): Promise<Response> {
  await destroySession(env.DB, ctx.cookies.get(SESSION_COOKIE)?.value);

  return new Response(null, {
    status: 302,
    headers: {
      location: signOutTarget(
        ctx.url.searchParams.get('next'),
        ctx.url.searchParams.get('switch') === '1',
      ),
      'set-cookie': clearedSessionCookie(ctx.url),
      'cache-control': 'no-store',
    },
  });
}

/**
 * Whether a GET may sign out.
 *
 * `Sec-Fetch-Site` is set by the browser and cannot be set by page script.
 * `same-origin` is our own link; `none` is a typed URL or a bookmark; both
 * sign out. `cross-site` is the finding, and `same-site` — a sibling
 * subdomain — is refused with it, since nothing of ours lives on one. An
 * absent header is allowed: only browsers old enough not to send it lack it,
 * and refusing them would strand their users signed in.
 */
function getMaySignOut(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  return site === null || site === 'same-origin' || site === 'none';
}

export const POST = signOut;

export async function GET(ctx: APIContext): Promise<Response> {
  if (getMaySignOut(ctx.request)) return signOut(ctx);

  // Refused, quietly: no session change, no cookie, and off to where a plain
  // sign-out would have gone — minus `switch`, which would start a Discord
  // round trip nobody on this site asked for. Never cached either way.
  return new Response(null, {
    status: 302,
    headers: {
      location: signOutTarget(ctx.url.searchParams.get('next'), false),
      'cache-control': 'no-store',
    },
  });
}
