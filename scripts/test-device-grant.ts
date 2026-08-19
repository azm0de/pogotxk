/**
 * Checks the device-grant plumbing that never touches the network: request
 * bodies, response mapping, the cookie payload, and the routing split that
 * decides who gets sent to /auth/device at all.
 *
 * The routing split matters most. `login_required` → device page is the whole
 * feature — send `consent_required` there too and members with a session get
 * a code ceremony instead of their one-tap approval screen; send
 * `login_required` to the plain retry and they get the password form the
 * feature exists to remove.
 *
 *   npx tsx scripts/test-device-grant.ts
 */

import {
  deviceAuthorizeBody,
  devicePollBody,
  DEVICE_GRANT_TYPE,
  mapDevicePoll,
  parseDeviceAuthorization,
  type DiscordConfig,
} from '../src/lib/auth/discord';
import { decodeDevicePayload, encodeDevicePayload } from '../src/lib/auth/device-payload';
import { interactionTarget } from '../src/lib/auth/next';
import { deviceLoginHref } from '../src/lib/auth/signin-surface';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`,
  );
  if (!ok) failures++;
}

const cfg: DiscordConfig = { clientId: 'CID', clientSecret: 'SECRET' };

console.log('\n== request bodies ==');
const auth = deviceAuthorizeBody(cfg);
check('authorize carries client_id', auth.get('client_id'), 'CID');
check('authorize carries client_secret', auth.get('client_secret'), 'SECRET');
check('authorize asks for both scopes', auth.get('scope'), 'identify guilds.members.read');

const poll = devicePollBody(cfg, 'DEV123');
check('poll uses the RFC 8628 grant type', poll.get('grant_type'), DEVICE_GRANT_TYPE);
check('poll carries the device code', poll.get('device_code'), 'DEV123');

console.log('\n== authorize response parsing ==');
const full = parseDeviceAuthorization({
  device_code: 'D',
  user_code: 'ZAW6C586',
  verification_uri: 'https://discord.com/activate',
  verification_uri_complete: 'https://discord.com/activate?user_code=ZAW6C586',
  expires_in: 300,
  interval: 5,
});
check('happy path parses', full?.userCode, 'ZAW6C586');
check(
  'complete uri preferred when present',
  full?.verificationUriComplete,
  'https://discord.com/activate?user_code=ZAW6C586',
);
check(
  'complete uri derived when absent',
  parseDeviceAuthorization({
    device_code: 'D',
    user_code: 'AB CD',
    verification_uri: 'https://discord.com/activate',
    expires_in: 300,
    interval: 5,
  })?.verificationUriComplete,
  'https://discord.com/activate?user_code=AB%20CD',
);
check('missing device_code rejected', parseDeviceAuthorization({ user_code: 'X' }), null);
check('a gated-client API error rejected', parseDeviceAuthorization({ message: 'Invalid client id', code: 50023 }), null);
check('null rejected', parseDeviceAuthorization(null), null);

console.log('\n== poll response mapping ==');
check('token → ok', mapDevicePoll({ access_token: 'T' }), { status: 'ok', accessToken: 'T' });
check('authorization_pending → pending', mapDevicePoll({ error: 'authorization_pending' }), {
  status: 'pending',
  slowDown: false,
});
check('slow_down → pending, stretched', mapDevicePoll({ error: 'slow_down' }), {
  status: 'pending',
  slowDown: true,
});
check('expired_token → expired', mapDevicePoll({ error: 'expired_token' }), { status: 'expired' });
check('access_denied → denied', mapDevicePoll({ error: 'access_denied' }), { status: 'denied' });
check('unknown error carried as message', mapDevicePoll({ error: 'invalid_client' }), {
  status: 'error',
  message: 'invalid_client',
});
check('garbage → error', mapDevicePoll(null).status, 'error');

console.log('\n== cookie payload ==');
const payload = {
  deviceCode: 'D',
  userCode: 'ZAW6C586',
  uri: 'https://discord.com/activate?user_code=ZAW6C586',
  next: '/go',
  exp: 1_900_000_000,
  interval: 5,
};
check('round trip survives', decodeDevicePayload(encodeDevicePayload(payload)), payload);
check('tampered blob rejected', decodeDevicePayload('not-base64!!'), null);
check(
  'missing deviceCode rejected',
  decodeDevicePayload(encodeDevicePayload({ ...payload, deviceCode: '' })),
  null,
);
check('undefined rejected', decodeDevicePayload(undefined), null);

console.log('\n== the routing split ==');
check(
  'login_required → device page, next carried',
  interactionTarget('login_required', '/go', false),
  '/auth/device?next=%2Fgo',
);
check('login_required with no next → bare device page', interactionTarget('login_required', '/', false), '/auth/device');
check(
  'consent_required keeps the plain retry',
  interactionTarget('consent_required', '/go', false),
  '/auth/login?next=%2Fgo&retry=1',
);
check(
  'account picker keeps the plain retry',
  interactionTarget('account_selection_required', null, false),
  '/auth/login?retry=1',
);
check('an already-interactive attempt does not bounce again', interactionTarget('login_required', '/go', true), null);
check(
  'open-redirect hardening still applies on this hop',
  interactionTarget('login_required', '//evil.example', false),
  '/auth/device',
);

console.log('\n== installed-app href rewrite ==');
check('next survives the rewrite', deviceLoginHref('/auth/login?next=%2Fgo'), '/auth/device?next=%2Fgo');
check('no next stays bare', deviceLoginHref('/auth/login'), '/auth/device');
check('a root next stays bare', deviceLoginHref('/auth/login?next=%2F'), '/auth/device');

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
