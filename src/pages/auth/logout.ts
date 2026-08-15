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

export const POST = signOut;
// GET is supported so a plain link works without JavaScript. The session token
// is the only thing being destroyed and the user is the one asking.
export const GET = signOut;
