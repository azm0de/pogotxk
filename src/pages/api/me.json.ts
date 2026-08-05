/** Current session, for client islands that need to know who is signed in. */

import type { APIContext } from 'astro';

export const prerender = false;

export function GET({ locals }: APIContext): Response {
  return new Response(JSON.stringify({ user: locals.user ?? null }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Per-user, and cheap to recompute — never cache it anywhere.
      'cache-control': 'private, no-store',
    },
  });
}
