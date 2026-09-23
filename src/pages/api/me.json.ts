/**
 * Current session, for client islands that need to know who is signed in.
 *
 * Two booleans ride beside the user, and they exist so that no client script
 * ever has to reason about roles or identities itself:
 *
 *   canAdmin         Whether the `/admin` gate would let this caller through —
 *                    `canReachAdmin`, the gate's own predicate, not a copy of
 *                    it. The account menu shows its "Admin" link on this and
 *                    nothing else, so the link never leads to a refusal. It is
 *                    a convenience: the gate still decides every request.
 *   standaloneAdmin  Whether this is a password-only admin identity with no
 *                    Discord account behind it (`isStandaloneAdmin`). The menu
 *                    leaves out "Use a different Discord account" and "Delete
 *                    my account" for one: the first has nothing to act on, and
 *                    the second would delete the credential that is the
 *                    account's only way in.
 *
 * Both are `false` when nobody is signed in, and both are computed here, on the
 * server, because the menu is built by an inline script that cannot import
 * anything — reimplementing the role order there is how the two would drift.
 */

import type { APIContext } from 'astro';
import { canReachAdmin } from '~/lib/auth/admin-path';
import { isStandaloneAdmin } from '~/lib/auth/types';

export const prerender = false;

export function GET({ locals }: APIContext): Response {
  const body = {
    user: locals.user ?? null,
    canAdmin: canReachAdmin(locals.user),
    standaloneAdmin: isStandaloneAdmin(locals.user),
  };

  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Per-user, and cheap to recompute — never cache it anywhere.
      'cache-control': 'private, no-store',
    },
  });
}
