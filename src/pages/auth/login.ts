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
import { safeNext } from '~/lib/auth/next';
import { randomToken, stateCookie } from '~/lib/auth/session';

export const prerender = false;


/**
 * Names which specific variable is absent rather than saying "not configured".
 *
 * Safe to show publicly — it reveals no values, and the page is already
 * announcing that sign-in is unconfigured. It exists because diagnosing this
 * from outside otherwise needs a terminal, and a missing variable looks
 * identical to a mistyped one.
 */
function configHelp(url: URL): Response {
  const bag = env as unknown as Record<string, unknown>;
  const has = (k: string) => typeof bag[k] === 'string' && (bag[k] as string).length > 0;

  const rows = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'].map(
    (k) =>
      `<tr><td><code>${k}</code></td><td class="${has(k) ? 'ok' : 'no'}">${
        has(k) ? 'present' : 'MISSING'
      }</td></tr>`,
  );

  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Sign-in not configured</title>
<style>
 body{font:16px/1.6 system-ui,sans-serif;max-width:44rem;margin:0 auto;padding:2.5rem 1.25rem;
      background:#0d1622;color:#e8edf4}
 h1{font-size:1.5rem;margin:0 0 .5rem} code{background:#16212f;padding:2px 6px;border-radius:4px}
 table{border-collapse:collapse;margin:1.25rem 0;width:100%}
 td{padding:.5rem .75rem;border-bottom:1px solid #26344a}
 .ok{color:#5fd08a;font-weight:600} .no{color:#ff6b6b;font-weight:700}
 li{margin-bottom:.4rem} .note{color:#9aa8ba;font-size:.9rem}
</style></head><body>
<h1>Discord sign-in is not configured</h1>
<p>The Worker cannot see everything it needs:</p>
<table><tbody>${rows.join('')}</tbody></table>
<p>If something says MISSING but you already added it in the dashboard, the usual cause is:</p>
<ul>
 <li>It was added as <strong>Text</strong> rather than <strong>Secret</strong>. Every deploy
     deletes plain-text variables that are not declared in <code>wrangler.jsonc</code>, and a
     push triggers a deploy.</li>
 <li>The name has a trailing space, or is wrapped in quotes.</li>
 <li>It was saved without pressing <strong>Deploy</strong> in the Variables panel.</li>
</ul>
<p class="note">Redirect URI this deployment will use:<br><code>${new URL('/auth/callback', url.origin)}</code></p>
</body></html>`;

  return new Response(body, {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function GET({ url }: APIContext): Promise<Response> {
  const cfg = discordConfig(env);
  if (!cfg) return configHelp(url);

  const state = randomToken(16);
  const verifier = randomToken(32);
  const next = safeNext(url.searchParams.get('next'));

  /*
   * Set only by the callback, after Discord has said it cannot proceed without
   * showing the user something. It is carried in the signed-ish state payload
   * as well as the URL so the callback can tell "this attempt was already the
   * retry" and fail properly instead of bouncing forever.
   */
  const consent = url.searchParams.get('consent') === '1';

  /*
   * Set by the callback when `prompt=none` came back needing interaction. It
   * means "send them to Discord with no prompt at all", which is different
   * from `consent` — see AuthPrompt. Both count as "this attempt already
   * involved a round trip", which is what stops the callback bouncing forever.
   */
  const retried = url.searchParams.get('retry') === '1';

  const payload = btoa(JSON.stringify({ state, verifier, next, consent: consent || retried }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const authorize = authorizeUrl(
    cfg,
    url,
    state,
    await pkceChallenge(verifier),
    consent ? 'consent' : retried ? 'default' : 'none',
  );

  /*
   * Straight to Discord, on every device.
   *
   * There was briefly a phone-only interstitial here, on the theory that a real
   * tap on a real link would let Android route the authorize URL to the Discord
   * app — a browser will not hand a *redirect* to a native app, so the 302 was
   * a genuine obstacle and the extra tap was meant to clear it.
   *
   * It cannot work, and the obstacle was never the redirect. Discord
   * deliberately does not deep-link its standard OAuth2 authorize endpoint to
   * the mobile app, because once the user is inside the app there is no way to
   * return them to the browser tab holding the rest of the flow. The supported
   * route is a custom scheme redirect (`discord-<app id>:/authorize/callback`)
   * belonging to a native app — something a website has nowhere to receive.
   *
   * So the interstitial cost a tap and promised a handoff that was never going
   * to happen. A screen that lies is worse than one more redirect.
   */
  return new Response(null, {
    status: 302,
    headers: {
      location: authorize,
      'set-cookie': stateCookie(payload, url),
      'cache-control': 'no-store',
    },
  });
}
