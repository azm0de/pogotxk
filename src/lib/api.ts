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

/** Wraps a handler so thrown ApiErrors become responses instead of 500s. */
export function handler(fn: (ctx: APIContext) => Promise<Response>) {
  return async (ctx: APIContext): Promise<Response> => {
    try {
      return await fn(ctx);
    } catch (err) {
      if (err instanceof ApiError) {
        return json({ error: err.message, detail: err.detail }, err.status);
      }
      console.error('Unhandled API error', err);
      return json({ error: 'Internal error' }, 500);
    }
  };
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
