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
import { interactionTarget, phoneSignInTarget } from '../src/lib/auth/next';
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

console.log('\n== phones start at the approval page ==');
/*
 * `interactionTarget` below can only fire if Discord reports `login_required`,
 * and measurement against production on 2026-09-05 says it never does: with no
 * Discord cookie it answers 200 and renders its own password form. So the phone
 * decision is made up front instead, and these are the cases that decide it.
 */
const FIREFOX_ANDROID = 'Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0';
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID_TABLET =
  'Mozilla/5.0 (Linux; Android 14; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

check(
  'Firefox on Android — the reported case — goes to the approval page',
  phoneSignInTarget(FIREFOX_ANDROID, '/go', false),
  '/auth/device?next=%2Fgo',
);
check('Chrome on Android too', phoneSignInTarget(CHROME_ANDROID, '/', false), '/auth/device');
check('iPhone too', phoneSignInTarget(IPHONE, '/', false), '/auth/device');
check('desktop keeps the redirect', phoneSignInTarget(DESKTOP, '/go', false), null);
// An Android tablet sends `Android` without `Mobile`, and has room for the
// ordinary flow. iPad says iPad, never iPhone.
check('an Android tablet keeps the redirect', phoneSignInTarget(ANDROID_TABLET, '/', false), null);
check(
  'an iPad keeps the redirect',
  phoneSignInTarget(IPHONE.replace('iPhone; CPU iPhone', 'iPad; CPU'), '/', false),
  null,
);
// The shell intercepts /auth/login natively; its UA marker exists so the server
// can tell it apart from a phone browser, and this must not rely on that luck.
check(
  'the Android shell keeps the plain href',
  phoneSignInTarget(`${CHROME_ANDROID} PogoTxkApp/1`, '/', false),
  null,
);
// THE LOOP GUARD. device.astro's escape link is /auth/login?retry=1, so without
// this a phone bounces between the two pages forever.
check('the device page’s own ?retry=1 escape is not sent back', phoneSignInTarget(FIREFOX_ANDROID, '/', true), null);
check('a consent flow is not diverted either', phoneSignInTarget(IPHONE, '/', true), null);
// The header's sign-in control builds its href from the page it sits on, so on
// the device page it reads next=/auth/device. "Approve, then go to the approval
// page" helps nobody; the bare page sends them home.
check(
  'a next pointing back into /auth/ is dropped',
  phoneSignInTarget(FIREFOX_ANDROID, '/auth/device', false),
  '/auth/device',
);
check('a real destination is still carried', phoneSignInTarget(FIREFOX_ANDROID, '/map?poi=x', false), '/auth/device?next=%2Fmap%3Fpoi%3Dx');
check('no user-agent, no diversion', phoneSignInTarget(null, '/', false), null);
// safeNext folds a foreign destination back to / before it reaches the URL.
check(
  'a tampered next cannot smuggle a destination through the hop',
  phoneSignInTarget(IPHONE, 'https://evil.example/x', false),
  '/auth/device',
);

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
