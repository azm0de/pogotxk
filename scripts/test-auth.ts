/**
 * Checks the auth logic that cannot be exercised without live Discord
 * credentials: role resolution, PKCE, and the role hierarchy.
 *
 *   npx tsx scripts/test-auth.ts
 */

import {
  authorizeUrl,
  pkceChallenge,
  resolveRole,
  type DiscordConfig,
} from '../src/lib/auth/discord';
import { safeNext, signOutTarget } from '../src/lib/auth/next';
import { hasRole, type Role, type SessionUser } from '../src/lib/auth/types';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
  if (!ok) failures++;
}

const base: DiscordConfig = {
  clientId: 'x',
  clientSecret: 'y',
  guildId: '111',
  roleAdmin: 'ROLE_ADMIN',
  roleAmbassador: 'ROLE_AMB',
  bootstrapAdminId: 'BOOT123',
};

console.log('\n== role resolution ==');
// null guildRoles means "not in the guild" — a 404 from Discord, not an error.
check('not in guild -> guest', resolveRole(base, 'u1', null), 'guest');
check('in guild, no roles -> member', resolveRole(base, 'u1', []), 'member');
check('ambassador role -> ambassador', resolveRole(base, 'u1', ['ROLE_AMB']), 'ambassador');
check('admin role -> admin', resolveRole(base, 'u1', ['ROLE_ADMIN']), 'admin');
check('admin wins over ambassador', resolveRole(base, 'u1', ['ROLE_AMB', 'ROLE_ADMIN']), 'admin');
check('unrelated roles ignored', resolveRole(base, 'u1', ['SOMETHING_ELSE']), 'member');

console.log('\n== bootstrap admin ==');
check('bootstrap id -> admin even with no roles', resolveRole(base, 'BOOT123', []), 'admin');
check('bootstrap id -> admin even outside guild', resolveRole(base, 'BOOT123', null), 'admin');
check(
  'bootstrap unset does not promote',
  resolveRole({ ...base, bootstrapAdminId: undefined }, 'BOOT123', []),
  'member',
);

console.log('\n== optional member-role gate ==');
const gated: DiscordConfig = { ...base, roleMember: 'ROLE_VERIFIED' };
check('gated, unverified -> guest', resolveRole(gated, 'u1', ['SOMETHING']), 'guest');
check('gated, verified -> member', resolveRole(gated, 'u1', ['ROLE_VERIFIED']), 'member');
check('gated, ambassador still wins', resolveRole(gated, 'u1', ['ROLE_AMB']), 'ambassador');

console.log('\n== guild not configured yet ==');
// Without a guild id the lookup is skipped and everyone is a guest — except the
// bootstrap admin, which is what lets a fresh deployment reach the console.
const noGuild: DiscordConfig = { clientId: 'x', clientSecret: 'y', bootstrapAdminId: 'BOOT123' };
check('stranger -> guest', resolveRole(noGuild, 'u1', null), 'guest');
check('bootstrap admin still gets in', resolveRole(noGuild, 'BOOT123', null), 'admin');

console.log('\n== role hierarchy ==');
const asUser = (role: Role): SessionUser => ({
  id: 1,
  discordId: 'd',
  username: 'u',
  displayName: 'u',
  avatarUrl: null,
  role,
  team: null,
  trainerName: null,
  trainerLevel: null,
});
check('undefined user has no role', hasRole(undefined, 'member'), false);
check('guest is not a member', hasRole(asUser('guest'), 'member'), false);
check('member is not an ambassador', hasRole(asUser('member'), 'ambassador'), false);
check('ambassador satisfies ambassador', hasRole(asUser('ambassador'), 'ambassador'), true);
check('admin satisfies ambassador', hasRole(asUser('admin'), 'ambassador'), true);
check('admin satisfies admin', hasRole(asUser('admin'), 'admin'), true);
check('ambassador is not admin', hasRole(asUser('ambassador'), 'admin'), false);

console.log('\n== PKCE (RFC 7636 S256) ==');
// Test vector from RFC 7636 appendix B.
const rfcVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const rfcExpected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
check('matches the RFC test vector', await pkceChallenge(rfcVerifier), rfcExpected);
const challenge = await pkceChallenge('a'.repeat(43));
check('challenge is base64url, unpadded', /^[A-Za-z0-9\-_]+$/.test(challenge), true);

console.log('\n== safeNext (open-redirect guard) ==');
// Every hostile case below was captured against production before the fix.
// `/auth/login?next=%2F%5Cevil.example` minted a cookie holding "/\evil.example",
// which the callback then wrote straight into its Location header.
const TAB = String.fromCharCode(9);
const CR = String.fromCharCode(13);
const NUL = String.fromCharCode(0);
const BS = String.fromCharCode(92); // backslash, spelled out to survive tooling

check('plain path passes through', safeNext('/map'), '/map');
check('hyphens are not rejected', safeNext('/blog/some-post-slug'), '/blog/some-post-slug');
check('query and hash survive', safeNext('/map?poi=x#y'), '/map?poi=x#y');
check('null becomes root', safeNext(null), '/');
check('empty becomes root', safeNext(''), '/');

check('protocol-relative //host blocked', safeNext('//evil.example'), '/');
check('backslash /\\host blocked', safeNext('/' + BS + 'evil.example'), '/');
check('tab-smuggled //host blocked', safeNext('/' + TAB + '//evil.example'), '/');
check('CR-smuggled //host blocked', safeNext('/' + CR + '//evil.example'), '/');
check('tab-smuggled backslash blocked', safeNext('/' + TAB + BS + 'evil.example'), '/');
check('NUL in path blocked', safeNext('/map' + NUL + 'x'), '/');
check('absolute URL blocked', safeNext('https://evil.example'), '/');
check('scheme-only blocked', safeNext('javascript:alert(1)'), '/');

// The invariant that actually matters, asserted the way the browser sees it:
// whatever safeNext returns must resolve back to our own origin. This is the
// same style of check that replaced the weaker markdown URL test.
const ORIGIN = 'https://pogotxk.gnomelabz.workers.dev';
const hostile = [
  '//evil.example',
  '/' + BS + 'evil.example',
  '/' + TAB + '//evil.example',
  '/' + TAB + BS + 'evil.example',
  '/' + CR + '//evil.example',
  '/' + NUL + '//evil.example',
  'https://evil.example/x',
  'javascript:alert(1)',
];
for (const raw of hostile) {
  const resolved = new URL(safeNext(raw), ORIGIN);
  check(`resolves to our origin: ${JSON.stringify(raw)}`, resolved.origin, ORIGIN);
}

console.log('\n== authorize prompt ==');
/*
 * `prompt=none` signs a returning member in without a click, but Discord does
 * not document what it does when the user has never authorised the app — it may
 * show the screen, it may bounce back an error. The callback recovers by
 * retrying once with `consent`, so both halves have to be reachable.
 */
const promptOf = (u: string) => new URL(u).searchParams.get('prompt');
const authUrl = (p?: 'none' | 'consent') =>
  authorizeUrl(base, new URL('https://pogotxk.gnomelabz.workers.dev/auth/login'), 's', 'c', p);

check('defaults to prompt=none', promptOf(authUrl()), 'none');
check('retry asks for consent', promptOf(authUrl('consent')), 'consent');
check(
  'redirect_uri tracks the request origin',
  new URL(authUrl()).searchParams.get('redirect_uri'),
  'https://pogotxk.gnomelabz.workers.dev/auth/callback',
);
check('PKCE method is S256', new URL(authUrl()).searchParams.get('code_challenge_method'), 'S256');

console.log('\n== which OAuth errors may be retried ==');
/*
 * The retry exists for "Discord needs to show the user something", which is
 * exactly what prompt=none forbids. `access_denied` is the user pressing
 * Cancel: retrying would put the approval screen straight back in front of
 * someone who just declined it, which is why it must stay out of this set.
 */
const NEEDS_INTERACTION = new Set([
  'interaction_required',
  'login_required',
  'consent_required',
  'account_selection_required',
]);
for (const e of ['interaction_required', 'login_required', 'consent_required']) {
  check(`retries on ${e}`, NEEDS_INTERACTION.has(e), true);
}
check('never retries on access_denied', NEEDS_INTERACTION.has('access_denied'), false);
check('never retries on invalid_scope', NEEDS_INTERACTION.has('invalid_scope'), false);
check('never retries on server_error', NEEDS_INTERACTION.has('server_error'), false);

/*
 * Sign-out, and the reason "switch account" is a separate action.
 *
 * Our session and Discord's are independent. /auth/login asks for prompt=none
 * so returning members are not made to click an approval screen every visit —
 * which means a plain sign-out then sign-in silently re-authorises the SAME
 * Discord account, with no point in the round trip where anyone is asked who
 * they are. Only consent=1 reaches the screen that can switch accounts.
 */
console.log('\n== signOutTarget ==');
check('plain sign-out goes home', signOutTarget(null, false), '/');
check('plain sign-out honours next', signOutTarget('/live', false), '/live');
check('switch forces the consent screen', signOutTarget(null, true), '/auth/login?consent=1');
check(
  'switch carries the destination through',
  signOutTarget('/go', true),
  '/auth/login?consent=1&next=%2Fgo',
);
// '/' is /auth/login's own default; sending it explicitly is just noise.
check('switch omits a redundant next=/', signOutTarget('/', true), '/auth/login?consent=1');

// `next` arrives as a query parameter on a GET and ends up in a Location
// header, so it is the same open-redirect surface safeNext exists for — and it
// must stay guarded on BOTH branches, not just the plain one.
console.log('\n  the destination stays same-origin on both branches:');
check('plain: //host blocked', signOutTarget('//evil.example', false), '/');
check('plain: backslash blocked', signOutTarget('/' + BS + 'evil.example', false), '/');
check('plain: absolute URL blocked', signOutTarget('https://evil.example', false), '/');
check('switch: //host blocked', signOutTarget('//evil.example', true), '/auth/login?consent=1');
check(
  'switch: tab-smuggled //host blocked',
  signOutTarget('/' + TAB + '//evil.example', true),
  '/auth/login?consent=1',
);
check(
  'switch: absolute URL blocked',
  signOutTarget('https://evil.example', true),
  '/auth/login?consent=1',
);
// A hostile value must not survive as an encoded payload either: the whole
// point is that it never reaches the Location header in any form.
check(
  'switch: hostile value is dropped, not merely escaped',
  signOutTarget('//evil.example', true).includes('evil.example'),
  false,
);

console.log(failures ? `\nFAILED (${failures})\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
