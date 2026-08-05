/**
 * Discord OAuth callback.
 *
 * Validates the CSRF state against the cookie set at /auth/login, exchanges the
 * code using the PKCE verifier, then syncs the profile and role into D1 and
 * issues a session.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import {
  discordConfig,
  exchangeCode,
  fetchGuildRoles,
  fetchUser,
  resolveRole,
  upsertUser,
} from '~/lib/auth/discord';
import {
  clearedStateCookie,
  createSession,
  OAUTH_STATE_COOKIE,
  sessionCookie,
} from '~/lib/auth/session';

export const prerender = false;

function fail(message: string, url: URL, status = 400): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: `/auth/error?reason=${encodeURIComponent(message)}&status=${status}`,
      'set-cookie': clearedStateCookie(url),
      'cache-control': 'no-store',
    },
  });
}

interface StatePayload {
  state: string;
  verifier: string;
  next: string;
}

function decodeState(raw: string | undefined): StatePayload | null {
  if (!raw) return null;
  try {
    const json = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    const parsed = JSON.parse(json) as StatePayload;
    if (!parsed.state || !parsed.verifier) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function GET(ctx: APIContext): Promise<Response> {
  const { url, cookies, request } = ctx;

  const cfg = discordConfig(env);
  if (!cfg) return fail('Discord sign-in is not configured', url, 503);

  // Discord reports user-facing failures (e.g. "access_denied") this way.
  const oauthError = url.searchParams.get('error');
  if (oauthError) return fail(oauthError, url);

  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  if (!code || !returnedState) return fail('Missing code or state', url);

  const stored = decodeState(cookies.get(OAUTH_STATE_COOKIE)?.value);
  if (!stored) return fail('Sign-in session expired, please try again', url);
  if (stored.state !== returnedState) return fail('State mismatch', url);

  try {
    const accessToken = await exchangeCode(cfg, url, code, stored.verifier);
    const discordUser = await fetchUser(accessToken);
    const guildRoles = await fetchGuildRoles(accessToken, cfg.guildId);
    const role = resolveRole(cfg, discordUser.id, guildRoles);

    // Discord only gets to set the role when it actually knows something: a
    // configured guild we could read, or an explicit bootstrap admin. Otherwise
    // the stored role stands, so a hand-promoted admin is not demoted on their
    // next sign-in.
    const authoritative =
      guildRoles !== null || discordUser.id === cfg.bootstrapAdminId;

    const record = await upsertUser(env.DB, discordUser, role, authoritative);
    if (record.isBanned) return fail('This account is banned', url, 403);

    const token = await createSession(env.DB, record.id, request.headers.get('user-agent'));

    const headers = new Headers({ 'cache-control': 'no-store' });
    headers.append('set-cookie', sessionCookie(token, url));
    headers.append('set-cookie', clearedStateCookie(url));
    headers.set('location', stored.next || '/');

    return new Response(null, { status: 302, headers });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Sign-in failed', url, 500);
  }
}
