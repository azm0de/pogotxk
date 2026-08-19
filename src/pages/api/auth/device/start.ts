/**
 * Begins a device-grant sign-in: asks Discord for a code pair, parks the
 * polling credential in an HttpOnly cookie, and hands the page only what a
 * human needs — the short code and the discord.com/activate link.
 *
 * The `device_code` never reaches the browser. It is the credential the token
 * endpoint redeems, which makes it exactly the kind of value the OAuth state
 * cookie already exists to hold; this reuses that pattern, with the lifetime
 * Discord assigned rather than a constant of ours.
 *
 * Re-POSTing while a healthy code is still pending returns the same pending
 * code instead of minting another — a page refresh should not spend Discord
 * requests, and the member may already be mid-approval on their phone.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { deviceAuthorize, discordConfig } from '~/lib/auth/discord';
import { safeNext } from '~/lib/auth/next';
import { DEVICE_GRANT_COOKIE, deviceGrantCookie } from '~/lib/auth/session';
import { decodeDevicePayload, encodeDevicePayload } from '~/lib/auth/device-payload';

export const prerender = false;

function json(body: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set('content-type', 'application/json');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers });
}

export async function POST({ url, request, cookies }: APIContext): Promise<Response> {
  const cfg = discordConfig(env);
  if (!cfg) return json({ error: 'Discord sign-in is not configured' }, 503);

  let next = '/';
  try {
    const parsed = (await request.json()) as { next?: unknown };
    next = safeNext(typeof parsed.next === 'string' ? parsed.next : null);
  } catch {
    // No body is fine; '/' stands.
  }

  // A healthy pending code survives a refresh. Sixty seconds of margin keeps
  // the page from adopting a code about to expire under the member's thumb.
  const existing = decodeDevicePayload(cookies.get(DEVICE_GRANT_COOKIE)?.value);
  if (existing && existing.exp - Date.now() / 1000 > 60) {
    return json({
      userCode: existing.userCode,
      verificationUriComplete: existing.uri,
      expiresIn: Math.floor(existing.exp - Date.now() / 1000),
      interval: existing.interval,
    });
  }

  const grant = await deviceAuthorize(cfg);
  if (!grant) {
    // Gated client, Discord outage — either way the page's job is to offer
    // the ordinary browser sign-in instead, so this is a signal, not a crash.
    return json({ error: 'Device sign-in is not available right now' }, 503);
  }

  const payload = encodeDevicePayload({
    deviceCode: grant.deviceCode,
    userCode: grant.userCode,
    uri: grant.verificationUriComplete,
    next,
    exp: Math.floor(Date.now() / 1000) + grant.expiresIn,
    interval: grant.interval,
  });

  return json(
    {
      userCode: grant.userCode,
      verificationUriComplete: grant.verificationUriComplete,
      expiresIn: grant.expiresIn,
      interval: grant.interval,
    },
    200,
    { 'set-cookie': deviceGrantCookie(payload, url, grant.expiresIn) },
  );
}
