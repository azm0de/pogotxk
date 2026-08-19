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
import { interactionTarget, safeNext } from '~/lib/auth/next';
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
  /** True when this attempt is already the `prompt=consent` retry. */
  consent?: boolean;
}

/**
 * Errors that mean "I cannot finish without putting something in front of the
 * user" — precisely what `prompt=none` forbids. These are the OIDC names;
 * Discord's own behaviour here is undocumented, so the set is deliberately
 * wider than any one of them.
 *
 * `access_denied` is NOT in here, and must not be. That is the user pressing
 * Cancel, and retrying would shove the approval screen back in the face of
 * someone who just declined it.
 */
const NEEDS_INTERACTION = new Set([
  'interaction_required',
  'login_required',
  'consent_required',
  'account_selection_required',
]);

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

  // Read the state before handling errors: it carries the retry flag and the
  // `next` destination, both of which are needed to recover rather than fail.
  const stored = decodeState(cookies.get(OAUTH_STATE_COOKIE)?.value);

  // Discord reports user-facing failures (e.g. "access_denied") this way.
  const oauthError = url.searchParams.get('error');
  if (oauthError) {
    // `prompt=none` could not complete silently. Where next depends on which
    // screen Discord would show a human: `login_required` means this browser
    // holds no Discord session, so the next screen is the email-and-password
    // form — and members never type Discord credentials into our flow, so that
    // case goes to /auth/device and gets approved from a surface that already
    // has a session. Everything else in the family (`consent_required`,
    // `account_selection_required`…) renders approval or picker screens, which
    // are wanted; those keep the plain no-prompt retry. Either way only once —
    // `stored.consent` is the loop guard it has always been. The split lives
    // in `interactionTarget`, where a plain test can reach it; `next` is
    // re-validated there by `safeNext`, so a tampered cookie cannot smuggle a
    // destination through this hop.
    if (NEEDS_INTERACTION.has(oauthError) && stored) {
      const target = interactionTarget(oauthError, stored.next, stored.consent === true);
      if (target) {
        return new Response(null, {
          status: 302,
          headers: { location: target, 'cache-control': 'no-store' },
        });
      }
    }
    return fail(oauthError, url);
  }

  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  if (!code || !returnedState) return fail('Missing code or state', url);

  if (!stored) return fail('Sign-in session expired, please try again', url);
  if (stored.state !== returnedState) return fail('State mismatch', url);

  try {
    const accessToken = await exchangeCode(cfg, url, code, stored.verifier);
    const discordUser = await fetchUser(accessToken);
    const guild = await fetchGuildRoles(accessToken, cfg.guildId);
    const role = resolveRole(cfg, discordUser.id, guild.known ? guild.roles : null);

    // Discord only gets to set the role when it actually knows something: a
    // configured guild it answered for, or an explicit bootstrap admin.
    // Otherwise the stored role stands, so a hand-promoted admin is not demoted
    // on their next sign-in.
    //
    // `guild.known` is true even when Discord says "not a member" — that is an
    // answer, and it must be authoritative, or leaving the server would never
    // cost anyone their role.
    const authoritative = guild.known || discordUser.id === cfg.bootstrapAdminId;

    const record = await upsertUser(env.DB, discordUser, role, authoritative);
    if (record.isBanned) return fail('This account is banned', url, 403);

    const token = await createSession(env.DB, record.id, request.headers.get('user-agent'));

    const headers = new Headers({ 'cache-control': 'no-store' });
    headers.append('set-cookie', sessionCookie(token, url));
    headers.append('set-cookie', clearedStateCookie(url));
    // Re-validated on the way out, not trusted from the cookie. The cookie is
    // ours and HttpOnly, but a redirect target is exactly the kind of value
    // that should be checked at the point it becomes a Location header rather
    // than only where it was minted.
    headers.set('location', safeNext(stored.next));

    return new Response(null, { status: 302, headers });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Sign-in failed', url, 500);
  }
}
