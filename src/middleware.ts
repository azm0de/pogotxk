/**
 * Resolves the session cookie into `Astro.locals.user` for every request, and
 * guards the admin surface.
 *
 * Static assets and the media route skip the database lookup entirely — they
 * are the bulk of requests and none of them care who you are.
 */

import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
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
  // status; page routes bounce through sign-in and come back.
  if (path.startsWith('/admin') || path.startsWith('/api/admin/')) {
    // The legacy import endpoints carry their own bearer-token guard, used to
    // seed a fresh deployment before anyone can sign in.
    const isImportRoute = path.startsWith('/api/admin/import-');

    if (!isImportRoute && !hasRole(context.locals.user, 'ambassador')) {
      if (path.startsWith('/api/')) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), {
          status: context.locals.user ? 403 : 401,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      return context.redirect(`/auth/login?next=${encodeURIComponent(path)}`, 302);
    }
  }

  return next();
});
