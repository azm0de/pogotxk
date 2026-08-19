/**
 * Proves whether Discord's device authorization grant is open to our app,
 * before any UI gets built on the assumption that it is.
 *
 * The endpoints are live (console linking runs on them) but absent from the
 * official developer docs, so "it exists" and "our client may use it" are
 * different claims. This settles the second one with a single POST whose only
 * side effect is a pending device code that expires in ~300 seconds, seen by
 * nobody.
 *
 * Prints response SHAPE only. Credentials are read from .dev.vars and never
 * printed; the device_code in a success response is itself a credential and
 * is reported as a length.
 *
 *   npx tsx scripts/preflight-device-grant.ts
 */

import { readFileSync } from 'node:fs';

const DEVICE_AUTHORIZE_URL = 'https://discord.com/api/v10/oauth2/device/authorize';
const TOKEN_URL = 'https://discord.com/api/v10/oauth2/token';
const SCOPES = 'identify guilds.members.read';

function readDevVars(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync('.dev.vars', 'utf8').split('\n')) {
    const m = line.trim().match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

async function main(): Promise<void> {
  const vars = readDevVars();
  const clientId = vars.DISCORD_CLIENT_ID;
  const clientSecret = vars.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET missing from .dev.vars');
    process.exit(2);
  }
  console.log(`client_id: ${clientId} (public — it appears in every OAuth URL)`);
  console.log(`scope requested: ${SCOPES}\n`);

  const res = await fetch(DEVICE_AUTHORIZE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: SCOPES }),
  });

  console.log(`POST /oauth2/device/authorize -> HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;

  if (res.ok && body && typeof body.device_code === 'string') {
    console.log('\nDEVICE GRANT AVAILABLE. Response shape:');
    console.log(`  device_code:               present, length ${body.device_code.length}`);
    console.log(`  user_code:                 ${body.user_code}`);
    console.log(`  verification_uri:          ${body.verification_uri}`);
    console.log(`  verification_uri_complete: ${body.verification_uri_complete}`);
    console.log(`  expires_in:                ${body.expires_in}`);
    console.log(`  interval:                  ${body.interval}`);
    console.log('\nThe pending code above will expire on its own; nothing was shown to anyone.');
    return;
  }

  console.log(`\nDevice authorize refused. Body keys: ${body ? Object.keys(body).join(', ') : '(unparseable)'}`);
  if (body) console.log(`  error: ${String(body.error ?? '')} — ${String(body.error_description ?? body.message ?? '')}`);

  /*
   * `invalid_client` is ambiguous: a wrong secret in .dev.vars and a gated
   * grant produce the same error. Disambiguate with the ordinary token
   * endpoint and a garbage code — a good secret answers `invalid_grant`
   * (credentials fine, code nonsense), a bad one answers `invalid_client`.
   */
  const probe = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code: 'preflight-disambiguation',
      redirect_uri: 'https://pogotxk.gnomelabz.workers.dev/auth/callback',
    }),
  });
  const probeBody = (await probe.json().catch(() => null)) as Record<string, unknown> | null;
  const probeError = String(probeBody?.error ?? '');
  console.log(`\nDisambiguation via ordinary token endpoint: HTTP ${probe.status}, error=${probeError}`);
  if (probeError === 'invalid_grant') {
    console.log('  -> credentials in .dev.vars are VALID; the refusal above means the device grant is gated for this app.');
  } else if (probeError === 'invalid_client') {
    console.log('  -> the secret in .dev.vars is stale; re-run after updating it before concluding anything about gating.');
  } else {
    console.log('  -> inconclusive; inspect manually.');
  }
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
