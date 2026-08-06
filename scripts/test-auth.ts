/**
 * Checks the auth logic that cannot be exercised without live Discord
 * credentials: role resolution, PKCE, and the role hierarchy.
 *
 *   npx tsx scripts/test-auth.ts
 */

import { pkceChallenge, resolveRole, type DiscordConfig } from '../src/lib/auth/discord';
import { safeNext } from '../src/lib/auth/next';
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

console.log(failures ? `\nFAILED (${failures})\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
