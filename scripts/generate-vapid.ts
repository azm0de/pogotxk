/**
 * Generates a VAPID keypair for Web Push.
 *
 *   npx tsx scripts/generate-vapid.ts
 *
 * VAPID keys are a plain ECDSA P-256 pair, base64url encoded: the public key is
 * the 65-byte uncompressed point, the private key the raw 32-byte scalar. Push
 * services reject anything else, which is why this does not just dump a PEM.
 *
 * Run once. Rotating the pair invalidates every existing subscription, because
 * browsers bind a subscription to the applicationServerKey it was created with.
 */

import { generateKeyPairSync } from 'node:crypto';

const b64url = (buf: Buffer) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Without encoding options this returns KeyObjects, which export JWK directly.
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

// JWK gives the raw coordinates, avoiding DER parsing.
const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
const privJwk = privateKey.export({ format: 'jwk' }) as { d: string };

const fromB64url = (s: string) => Buffer.from(s, 'base64url');

// Uncompressed point: 0x04 || X || Y
const publicRaw = Buffer.concat([
  Buffer.from([0x04]),
  fromB64url(pubJwk.x),
  fromB64url(pubJwk.y),
]);

const VAPID_PUBLIC_KEY = b64url(publicRaw);
const VAPID_PRIVATE_KEY = b64url(fromB64url(privJwk.d));

if (publicRaw.length !== 65) throw new Error(`Public key is ${publicRaw.length} bytes, expected 65`);

console.log(`
VAPID keypair generated. Run this once and keep the private key secret.

  Public key  (safe to commit — it is sent to every browser):
    ${VAPID_PUBLIC_KEY}

  Private key (SECRET — Cloudflare dashboard only, never in git):
    ${VAPID_PRIVATE_KEY}

Set in Cloudflare > Workers > pogotxk > Settings > Variables and Secrets:

    VAPID_PRIVATE_KEY   (type: Secret)   the private key above
    VAPID_SUBJECT       (type: Secret)   mailto:you@example.com

VAPID_PUBLIC_KEY goes in wrangler.jsonc under "vars" so it survives deploys —
plain-text vars set in the dashboard are wiped by every wrangler deploy.

VAPID_SUBJECT must be a mailto: or https:// URL. Apple's push service returns
403 for anything else, which silently breaks iOS only.
`);
