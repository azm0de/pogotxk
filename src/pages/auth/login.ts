/**
 * Kicks off Discord OAuth.
 *
 * Generates a CSRF `state` and a PKCE verifier, parks both in a short-lived
 * HttpOnly cookie, and bounces to Discord. The callback will not proceed unless
 * the returned state matches what that cookie holds.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { authorizeUrl, discordConfig, pkceChallenge } from '~/lib/auth/discord';
import { randomToken, stateCookie } from '~/lib/auth/session';

export const prerender = false;

/** Only same-origin paths, so `next` can never become an open redirect. */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

export async function GET({ url }: APIContext): Promise<Response> {
  const cfg = discordConfig(env);
  if (!cfg) {
    return new Response(
      'Discord sign-in is not configured yet. Set DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET and DISCORD_GUILD_ID.',
      { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  const state = randomToken(16);
  const verifier = randomToken(32);
  const next = safeNext(url.searchParams.get('next'));

  const payload = btoa(JSON.stringify({ state, verifier, next }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return new Response(null, {
    status: 302,
    headers: {
      location: authorizeUrl(cfg, url, state, await pkceChallenge(verifier)),
      'set-cookie': stateCookie(payload, url),
      'cache-control': 'no-store',
    },
  });
}
