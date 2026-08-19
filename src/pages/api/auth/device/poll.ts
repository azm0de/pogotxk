/**
 * One poll of a pending device-grant sign-in.
 *
 * The page calls this on Discord's stated interval; each call forwards exactly
 * one poll to Discord's token endpoint. When the approval lands, this runs the
 * same pipeline as every other way into the site — the browser callback and
 * /api/auth/mobile — so the device grant is an additional door, not a second
 * identity system: same profile fetch, same role resolution, same
 * only-overwrite-when-authoritative rule, same ban check, same session.
 *
 * CSRF posture: the only credential is the HttpOnly SameSite=Lax cookie, which
 * browsers do not attach to cross-site POSTs — and all a successful forgery
 * could do is finish the victim's own sign-in.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import {
  discordConfig,
  fetchGuildRoles,
  fetchUser,
  pollDeviceToken,
  resolveRole,
  upsertUser,
} from '~/lib/auth/discord';
import { safeNext } from '~/lib/auth/next';
import {
  clearedDeviceGrantCookie,
  createSession,
  DEVICE_GRANT_COOKIE,
  sessionCookie,
} from '~/lib/auth/session';
import { decodeDevicePayload } from '~/lib/auth/device-payload';

export const prerender = false;

function json(body: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set('content-type', 'application/json');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers });
}

export async function POST({ url, request, cookies }: APIContext): Promise<Response> {
  const cfg = discordConfig(env);
  if (!cfg) return json({ status: 'error', message: 'Discord sign-in is not configured' }, 503);

  const pending = decodeDevicePayload(cookies.get(DEVICE_GRANT_COOKIE)?.value);
  if (!pending || pending.exp <= Date.now() / 1000) {
    return json({ status: 'expired' }, 200, { 'set-cookie': clearedDeviceGrantCookie(url) });
  }

  const poll = await pollDeviceToken(cfg, pending.deviceCode);

  switch (poll.status) {
    case 'pending':
      return json({ status: 'pending', slowDown: poll.slowDown });

    case 'denied':
    case 'expired':
      // Terminal either way; the code is spent and the cookie goes with it.
      return json({ status: poll.status }, 200, { 'set-cookie': clearedDeviceGrantCookie(url) });

    case 'error':
      // Possibly transient on Discord's side. The cookie stays so the next
      // tick can try again; it expires on its own if the trouble persists.
      return json({ status: 'error', message: poll.message }, 502);

    case 'ok':
      break;
  }

  try {
    const discordUser = await fetchUser(poll.accessToken);
    const guild = await fetchGuildRoles(poll.accessToken, cfg.guildId);
    const role = resolveRole(cfg, discordUser.id, guild.known ? guild.roles : null);

    // Same rule as the browser callback and the Android exchange: Discord only
    // sets the role when it actually knew something, so a hand-promoted admin
    // is not demoted by signing in through a device code.
    const authoritative = guild.known || discordUser.id === cfg.bootstrapAdminId;

    const record = await upsertUser(env.DB, discordUser, role, authoritative);
    if (record.isBanned) {
      return json({ status: 'error', message: 'This account is banned' }, 403, {
        'set-cookie': clearedDeviceGrantCookie(url),
      });
    }

    const token = await createSession(env.DB, record.id, request.headers.get('user-agent'));

    const headers = new Headers();
    headers.append('set-cookie', sessionCookie(token, url));
    headers.append('set-cookie', clearedDeviceGrantCookie(url));
    // Validated again at the moment it becomes a navigation target, same as
    // the callback does — the cookie is ours, and checked anyway.
    return json({ status: 'ok', next: safeNext(pending.next) }, 200, headers);
  } catch (err) {
    return json(
      { status: 'error', message: err instanceof Error ? err.message : 'Sign-in failed' },
      500,
    );
  }
}
