/**
 * Guards for the maintenance endpoints.
 *
 * Two ways in, because they serve different moments:
 *
 *   * A signed-in admin. This is the normal path now that Discord OAuth works —
 *     it means the import can be run from a button rather than a terminal.
 *   * A bearer token. Still needed for the very first run on a fresh
 *     deployment, before anyone can sign in, and for scripting.
 */

import type { APIContext } from 'astro';
import { hasRole } from '~/lib/auth/types';

/** Constant-time comparison so a wrong token cannot be recovered by timing. */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  // Compare lengths without early return, then bytes.
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export function requireImportToken(request: Request, env: Env): Response | null {
  const expected = (env as unknown as { IMPORT_TOKEN?: string }).IMPORT_TOKEN;

  if (!expected) {
    return json(
      { error: 'IMPORT_TOKEN is not configured. Set it in .dev.vars or as a Worker secret.' },
      503,
    );
  }

  const header = request.headers.get('authorization') ?? '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!supplied || !timingSafeEqual(supplied, expected)) {
    return json({ error: 'Unauthorized' }, 401, {
      'WWW-Authenticate': 'Bearer realm="pogotxk-admin"',
    });
  }

  return null;
}

/**
 * Accepts either a signed-in admin or a valid bearer token.
 *
 * The session is checked first so an admin never needs IMPORT_TOKEN configured
 * at all — which matters, because the whole point of the button is to avoid
 * making someone generate and paste a secret to seed their own site.
 */
export function requireImportAuth(ctx: APIContext, env: Env): Response | null {
  if (hasRole(ctx.locals.user, 'admin')) return null;
  return requireImportToken(ctx.request, env);
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
