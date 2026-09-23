/**
 * Resolves the session cookie into `Astro.locals.user` for every request, and
 * guards the admin surface.
 *
 * Static assets and the media route skip the database lookup entirely — they
 * are the bulk of requests and none of them care who you are.
 */

import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import {
  isAdminLoginPath,
  isAdminPath,
  isAdminResetPath,
  isImportPath,
} from '~/lib/auth/admin-path';
import { getSessionUser, SESSION_COOKIE, touchSession } from '~/lib/auth/session';
import { hasRole } from '~/lib/auth/types';

const SKIP_PREFIXES = ['/_astro/', '/media/', '/favicon', '/assets/'];

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;

  if (SKIP_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return next();
  }

  const token = context.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    const user = await getSessionUser(env.DB, token);
    if (user) {
      context.locals.user = user;
      // Keep active sessions alive without writing on every request, and
      // without making the user wait on it.
      context.locals.cfContext?.waitUntil(touchSession(env.DB, token));
    }
  }

  // Admin surface. The API routes answer 403 so fetch() callers get a usable
  // status; page routes bounce through sign-in and come back. Which paths
  // count, and why the boundary matters, is in ~/lib/auth/admin-path.
  //
  // The sign-in they bounce through is the admin form, `/admin/login`, and not
  // Discord's `/auth/login`. It used to be Discord's, and that stopped being a
  // door into the console some time ago: no `DISCORD_ROLE_*` ids are set and
  // the bootstrap id is gone, so Discord can only ever produce a member, and
  // the only accounts that can pass this check are the standalone admins, who
  // have no Discord account at all. Sending them to Discord was a dead end —
  // and a member already signed in was sent on a round trip through Discord
  // that ended at this same refusal. The admin form shows itself to anyone
  // below `ambassador` and forwards anyone at or above it to `next`, and it
  // links to Discord for everybody else, carrying `next` along.
  //
  // Three predicates skip the role check and nothing else does: the import
  // endpoints, which bring their own bearer token; the admin password form,
  // which would otherwise be gated by the very check it exists to get a caller
  // past; and the two password-reset pages, which exist for the admin who
  // cannot get through that form at all. Every one of them is deliberately
  // narrow — an exact path, an exact path, and an exact path plus one token
  // shape — and every one is argued where it is defined, in
  // ~/lib/auth/admin-path.
  if (isAdminPath(path)) {
    if (
      !isImportPath(path) &&
      !isAdminLoginPath(path) &&
      !isAdminResetPath(path) &&
      !hasRole(context.locals.user, 'ambassador')
    ) {
      if (path.startsWith('/api/')) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), {
          status: context.locals.user ? 403 : 401,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      return context.redirect(`/admin/login?next=${encodeURIComponent(path)}`, 302);
    }
  }

  return next();
});
