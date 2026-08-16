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
import { handler, json, requireUser } from '~/lib/api';
import { deleteAccount } from '~/lib/auth/deletion';
import { clearedSessionCookie } from '~/lib/auth/session';

export const prerender = false;

export const DELETE = handler(async (ctx: APIContext) => {
  const user = requireUser(ctx);
  await deleteAccount(env.DB, user.id);

  return json(
    { ok: true },
    200,
    // The session this request came in on is one of the rows just deleted.
    { 'set-cookie': clearedSessionCookie(ctx.url) },
  );
});
