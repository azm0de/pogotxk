/**
 * Checks the client-side gating that mirrors PATCH /api/flares/:id.
 *
 *   npx tsx scripts/test-flare-permissions.ts
 *
 * LiveBoard and QuickActions both decide, before ever making the request,
 * whether a button should even be offered — and that decision has to agree
 * with what the API will actually accept, or a trainer sees a control that
 * fails the moment they press it.
 */

import { flareCarriesBoss, flareCarriesTier, mayAlterFlare } from '../src/lib/db/flares';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`,
  );
  if (!ok) failures++;
}

// --- which kinds carry which field — mirrors the 422 guards in [id].ts -----
console.log('\n== which kinds carry a boss / tier ==');
check('raid carries a boss', flareCarriesBoss('raid'), true);
check('remote_invites carries a boss', flareCarriesBoss('remote_invites'), true);
check('gym_takedown does not carry a boss', flareCarriesBoss('gym_takedown'), false);
check('meetup_here does not carry a boss', flareCarriesBoss('meetup_here'), false);
check('trade does not carry a boss', flareCarriesBoss('trade'), false);
check('help does not carry a boss', flareCarriesBoss('help'), false);

check('raid carries a tier', flareCarriesTier('raid'), true);
console.log('\n  only a raid — the API 422s tier on everything else:');
check('remote_invites does not carry a tier', flareCarriesTier('remote_invites'), false);
check('gym_takedown does not carry a tier', flareCarriesTier('gym_takedown'), false);
check('trade does not carry a tier', flareCarriesTier('trade'), false);
check('help does not carry a tier', flareCarriesTier('help'), false);

// --- who may alter a flare — mirrors assertMayAlter in [id].ts -------------
console.log('\n== who may alter a flare ==');
const owner = { id: 5, name: 'azm.0', team: null };
const someoneElse = { id: 9, name: 'other', team: null };

check('the trainer who raised it', mayAlterFlare(owner, owner.id, false), true);
check('a different signed-in member', mayAlterFlare(owner, someoneElse.id, false), false);
check('an ambassador, even on someone else\'s flare', mayAlterFlare(owner, someoneElse.id, true), true);
check('a guest (no user id) cannot alter', mayAlterFlare(owner, null, false), false);

console.log('\n  the authorless-flare trap — `a?.id === b?.id` is true when');
console.log('  BOTH sides are absent, which would hand everyone the button:');
check('no author, signed-in member — must stay false', mayAlterFlare(null, 5, false), false);
check('no author, guest — must stay false', mayAlterFlare(null, null, false), false);
check('no author, ambassador can still act', mayAlterFlare(null, null, true), true);

console.log(failures ? `\nFAILED (${failures})\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
