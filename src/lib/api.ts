/**
 * Shared helpers for the JSON API routes.
 *
 * Role checks live in middleware for the whole `/api/admin/*` prefix; the
 * `requireRole` here is for routes that need something stricter than the
 * `ambassador` floor the middleware applies.
 */

import type { APIContext } from 'astro';
import type { z } from 'zod';
import { hasRole, type Role, type SessionUser } from '~/lib/auth/types';

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

/** One field-level refusal, in the same shape `readJson` reports zod issues. */
export function validationFailed(path: string, message: string): ApiError {
  return new ApiError(422, 'Validation failed', [{ path, message }]);
}

/**
 * Admin answers carry draft posts, unpublished POIs and the audit trail, and
 * none of it may be kept by a shared cache or the browser's back-forward
 * store (admin audit, 2026-10, B-20). Set here rather than per route so a new
 * route cannot forget it; a route that sets its own policy keeps it.
 */
const ADMIN_CACHE_CONTROL = 'private, no-store';

function isAdminApi(ctx: APIContext): boolean {
  try {
    return new URL(ctx.request.url).pathname.startsWith('/api/admin/');
  } catch {
    return false;
  }
}

function withAdminCaching(res: Response): Response {
  if (res.headers.has('cache-control')) return res;
  try {
    res.headers.set('cache-control', ADMIN_CACHE_CONTROL);
    return res;
  } catch {
    // Immutable headers (a response passed through from `fetch`): copy it.
    const copy = new Response(res.body, res);
    copy.headers.set('cache-control', ADMIN_CACHE_CONTROL);
    return copy;
  }
}

/**
 * SQLite's wording when a REFERENCES clause refuses a write. The routes check
 * every id they are handed before writing (`requireRowExists`), so reaching
 * this means a check is missing — but the caller still sent an id that does
 * not exist, which is a 422 about their input and not a 500 about our server
 * (admin audit, 2026-10, B-05).
 */
const FOREIGN_KEY_FAILURE = /FOREIGN KEY constraint failed/i;

/** Wraps a handler so thrown ApiErrors become responses instead of 500s. */
export function handler(fn: (ctx: APIContext) => Promise<Response>) {
  return async (ctx: APIContext): Promise<Response> => {
    const res = await answer(fn, ctx);
    return isAdminApi(ctx) ? withAdminCaching(res) : res;
  };
}

async function answer(
  fn: (ctx: APIContext) => Promise<Response>,
  ctx: APIContext,
): Promise<Response> {
  try {
    return await fn(ctx);
  } catch (err) {
    if (err instanceof ApiError) {
      return json({ error: err.message, detail: err.detail }, err.status);
    }
    if (err instanceof Error && FOREIGN_KEY_FAILURE.test(err.message)) {
      return json(
        {
          error: 'Validation failed',
          detail: [{ path: '', message: 'A referenced record does not exist' }],
        },
        422,
      );
    }
    console.error('Unhandled API error', err);
    return json({ error: 'Internal error' }, 500);
  }
}

/** The tables an admin body may point into by id. A closed list, so no injection. */
export type ReferencedTable = 'zones' | 'media' | 'pois';

/**
 * Refuses an id that names no row, before anything is written.
 *
 * Without it the write reached D1, the foreign key refused it, and the editor
 * saw "Internal error" for what was a stale dropdown (admin audit, 2026-10,
 * B-05). `null` and `undefined` pass: they mean "none" and "unchanged".
 */
export async function requireRowExists(
  db: D1Database,
  table: ReferencedTable,
  id: number | null | undefined,
  field: string,
): Promise<void> {
  if (id === null || id === undefined) return;
  const row = await db.prepare(`SELECT 1 AS found FROM ${table} WHERE id = ?1`).bind(id).first();
  if (!row) throw validationFailed(field, 'does not exist');
}

export function requireUser(ctx: APIContext): SessionUser {
  const user = ctx.locals.user;
  if (!user) throw new ApiError(401, 'Sign in required');
  return user;
}

export function requireRole(ctx: APIContext, role: Role): SessionUser {
  const user = requireUser(ctx);
  if (!hasRole(user, role)) throw new ApiError(403, `Requires ${role}`);
  return user;
}

/** Parse and validate a JSON body, surfacing field errors to the client. */
export async function readJson<T extends z.ZodTypeAny>(
  ctx: APIContext,
  schema: T,
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await ctx.request.json();
  } catch {
    throw new ApiError(400, 'Body must be valid JSON');
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      422,
      'Validation failed',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return parsed.data;
}

/** Numeric route params, rejected rather than silently coerced to NaN. */
export function intParam(ctx: APIContext, name: string): number {
  const raw = ctx.params[name];
  const value = Number(raw);
  if (!raw || !Number.isInteger(value) || value <= 0) {
    throw new ApiError(400, `Invalid ${name}`);
  }
  return value;
}
