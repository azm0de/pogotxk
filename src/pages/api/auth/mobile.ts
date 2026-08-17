/**
 * Finishes a Discord sign-in that started in the Android app.
 *
 * The app authorises against a custom scheme (`discord-<app id>:/authorize/callback`)
 * so Discord can hand the approval to the Discord app instead of demanding a
 * password in a browser that has never seen the trainer. The consequence is
 * that the authorization code lands in the *app*, not in a browser — and the
 * app cannot finish the exchange itself, because that needs the client secret
 * and a secret shipped inside an APK is not a secret.
 *
 * So the app posts the code here and gets back a session cookie to install in
 * its WebView. From that point everything downstream is identical to a browser
 * sign-in: the same session table, the same cookie, the same role resolution.
 *
 * ON THE ABSENCE OF A CSRF STATE CHECK. `/auth/callback` validates `state`
 * against an HttpOnly cookie, which works because a browser carries one. There
 * is no such cookie here — the flow began in a native app. PKCE is what
 * replaces it, and Discord makes it mandatory for exactly this reason: the code
 * is single-use and bound to a verifier that never left the device. Anyone able
 * to present a valid code *and* its verifier has already completed an
 * authorization for our client, so there is nothing here for them to gain that
 * they did not already have.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import {
  discordConfig,
  exchangeCode,
  fetchGuildRoles,
  fetchUser,
  mobileRedirectUri,
  resolveRole,
  upsertUser,
} from '~/lib/auth/discord';
import { createSession, sessionCookie } from '~/lib/auth/session';

export const prerender = false;

function json(body: unknown, status: number, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set('content-type', 'application/json');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers });
}

export async function POST({ url, request }: APIContext): Promise<Response> {
  const cfg = discordConfig(env);
  if (!cfg) return json({ error: 'Discord sign-in is not configured' }, 503);

  let code: unknown;
  let verifier: unknown;
  try {
    const parsed = (await request.json()) as { code?: unknown; verifier?: unknown };
    code = parsed.code;
    verifier = parsed.verifier;
  } catch {
    return json({ error: 'Expected a JSON body' }, 400);
  }

  if (typeof code !== 'string' || typeof verifier !== 'string' || !code || !verifier) {
    return json({ error: 'Both code and verifier are required' }, 400);
  }

  try {
    // The redirect must repeat what the app sent at authorize time, byte for
    // byte, or Discord rejects the exchange.
    const accessToken = await exchangeCode(cfg, url, code, verifier, mobileRedirectUri(cfg));
    const discordUser = await fetchUser(accessToken);
    const guild = await fetchGuildRoles(accessToken, cfg.guildId);
    const role = resolveRole(cfg, discordUser.id, guild.known ? guild.roles : null);

    // Same rule as the browser callback: Discord only sets the role when it
    // actually knew something, so a hand-promoted admin is not demoted by
    // signing in on a phone.
    const authoritative = guild.known || discordUser.id === cfg.bootstrapAdminId;

    const record = await upsertUser(env.DB, discordUser, role, authoritative);
    if (record.isBanned) return json({ error: 'This account is banned' }, 403);

    const token = await createSession(env.DB, record.id, request.headers.get('user-agent'));

    // Sent as a real Set-Cookie so the app can hand the header straight to its
    // WebView cookie store without knowing the cookie's name, flags or expiry —
    // one fewer thing to keep in sync between the APK and the server.
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(token, url) });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Sign-in failed' }, 500);
  }
}
