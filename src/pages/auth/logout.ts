import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { clearedSessionCookie, destroySession, SESSION_COOKIE } from '~/lib/auth/session';

export const prerender = false;

async function signOut(ctx: APIContext): Promise<Response> {
  await destroySession(env.DB, ctx.cookies.get(SESSION_COOKIE)?.value);
  return new Response(null, {
    status: 302,
    headers: {
      location: '/',
      'set-cookie': clearedSessionCookie(ctx.url),
      'cache-control': 'no-store',
    },
  });
}

export const POST = signOut;
// GET is supported so a plain link works without JavaScript. The session token
// is the only thing being destroyed and the user is the one asking.
export const GET = signOut;
