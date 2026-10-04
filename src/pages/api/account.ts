/**
 * DELETE /api/account — self-service account deletion.
 *
 * The Play Store data-deletion requirement this exists for needs both an
 * in-app route and a web-accessible one reachable without the app installed
 * (see /account/delete). Both funnel here: Discord sign-in already works from
 * a plain browser, so someone who has uninstalled the app can still reach
 * this by signing back in on the website.
 *
 * See ~/lib/auth/deletion.ts for what "delete" actually does — the row is
 * anonymised in place, not removed, so community history it is attached to
 * (flares, RSVPs, the change log) survives with no name on it.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { ApiError, handler, json, requireUser } from '~/lib/api';
import { deleteAccount } from '~/lib/auth/deletion';
import { clearedSessionCookie } from '~/lib/auth/session';
import { isStandaloneAdmin } from '~/lib/auth/types';
import { recordAudit } from '~/lib/db/audit';

export const prerender = false;

export const DELETE = handler(async (ctx: APIContext) => {
  const user = requireUser(ctx);

  /*
   * A standalone admin (`admin:<name>`, no Discord account behind it) has
   * exactly one way in — its password credential — and deletion removes that
   * credential on purpose. The account menu already hides the button for these
   * identities; the route did not, so one request locked an owner out of
   * their own site with nothing to sign back in with (admin audit, 2026-10,
   * B-16). Those accounts are managed from a terminal with `npm run
   * set:password`, where the person doing it can see what they are doing.
   */
  if (isStandaloneAdmin(user)) {
    throw new ApiError(403, 'Admin accounts are managed with set:password');
  }

  await deleteAccount(env.DB, user.id);

  // The row is anonymised in place, so the id still resolves — to "Deleted
  // user" — and the entry says that a deletion happened and when, not who.
  // Nothing identifying goes in the diff, which is the point of the request.
  // After the deletion rather than inside its batch, and best-effort: a log
  // that cannot be written must never stand between someone and the deletion
  // they asked for.
  await recordAudit(env.DB, {
    actorId: user.id,
    action: 'delete',
    entity: 'account',
    entityId: user.id,
  }).catch((err) => console.error('Account deletion audit failed', err));

  return json(
    { ok: true },
    200,
    // The session this request came in on is one of the rows just deleted.
    { 'set-cookie': clearedSessionCookie(ctx.url) },
  );
});
