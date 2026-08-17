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

/**
 * The one screen that lets a phone approve with the Discord app it already has.
 *
 * A browser will not hand a *redirect* off to a native app — that is a
 * deliberate anti-hijacking rule, not an oversight — so bouncing straight from
 * `/auth/login` to Discord guarantees the OAuth screen opens in the browser.
 * If that browser has no Discord session, the trainer is asked for a password
 * while being signed in on the very same phone, one app away.
 *
 * A real tap on a real link IS routed to the app. So on a phone we stop and
 * offer the link instead of following it, and the extra tap buys the app
 * handoff. Desktop skips this entirely — there is no app to hand off to, so it
 * would be pure friction.
 */
function appHandoffPage(authorize: string, url: URL): string {
  const escaped = authorize.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const direct = new URL(url);
  direct.searchParams.set('direct', '1');
  const skip = direct.toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Continue with Discord</title>
<style>
 :root{color-scheme:dark}
 body{font:16px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;min-height:100dvh;
      display:flex;align-items:center;justify-content:center;padding:1.5rem;
      background:#0d1622;color:#e8edf4}
 main{width:100%;max-width:26rem;text-align:center}
 h1{font-size:1.3rem;margin:0 0 .6rem}
 p{margin:0 0 1.4rem;color:#9aa8ba;font-size:.95rem}
 .btn{display:flex;align-items:center;justify-content:center;gap:.55rem;min-height:52px;
      padding:0 1.25rem;border-radius:12px;background:#5865f2;color:#fff;font-weight:600;
      text-decoration:none}
 .btn:active{transform:translateY(1px)}
 .alt{display:inline-block;margin-top:1.1rem;color:#7f8ea3;font-size:.85rem}
</style></head><body>
<main>
 <h1>Continue with Discord</h1>
 <p>This opens the Discord app so you can approve with the account you are
    already signed into — no password.</p>
 <a class="btn" href="${escaped}">Approve in Discord</a>
 <a class="alt" href="${skip}">Use the browser instead</a>
</main>
</body></html>`;
}

export async function GET({ url, request }: APIContext): Promise<Response> {
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

  const ua = request.headers.get('user-agent') ?? '';
  /*
   * Our own Android shell already intercepts the authorize URL and hands it to
   * the Discord app itself, so the interstitial there would be an extra tap
   * that buys nothing. It marks itself in the User-Agent precisely so this can
   * tell the difference server-side.
   */
  const inOurApp = ua.includes('PogoTxkApp/');
  const onPhone = /Android|iPhone|iPad|iPod/i.test(ua);
  // `direct=1` is the escape hatch the interstitial itself offers, for anyone
  // whose Discord app is broken, absent, or simply not who they want to be.
  const direct = url.searchParams.get('direct') === '1';

  if (onPhone && !inOurApp && !direct) {
    return new Response(appHandoffPage(authorize, url), {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': stateCookie(payload, url),
        'cache-control': 'no-store',
      },
    });
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: authorize,
      'set-cookie': stateCookie(payload, url),
      'cache-control': 'no-store',
    },
  });
}
