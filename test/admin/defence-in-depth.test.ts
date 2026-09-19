/**
 * Every admin handler, called directly, with the middleware taken out of the
 * picture entirely.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT THE MATRIX AGAIN
 * ---------------------------------------------------------------------------
 *
 * `api-matrix.test.ts` proves the boundary holds as a request crosses it. That
 * is the property that matters today, and it has one blind spot: almost every
 * answer in it comes from `src/middleware.ts`, so it would look identical
 * whether the handlers behind the gate defended themselves or not.
 *
 * They all do — `requireRole(ctx, 'ambassador')` is the first statement in each
 * one, and `~/lib/api` says in so many words that it is there for routes
 * needing something stricter than the floor. That is a real second layer, and
 * an untested second layer decays: the day someone writes a route that leans on
 * the middleware alone, nothing notices, and the exemption in front of
 * `/api/admin/import-` is standing proof that the middleware's coverage is not
 * uniform.
 *
 * So this calls the exported handlers as functions, hands them a context whose
 * `locals.user` is under-privileged, and requires a refusal from the route
 * itself. It is the check that would have caught the import routes being
 * unguarded, had they ever been.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { APIContext } from 'astro';
import type { SessionUser } from '~/lib/auth/types';
import { seedUser } from '../helpers/factories';
import { contentSnapshot, ORIGIN, seedFixtures } from './surface';

const PREFIX = '../../src/pages/api/admin/';
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'ALL']);

type Handler = (ctx: APIContext) => Promise<Response> | Response;

/** One exported handler: how to name it, how to call it, and at what URL. */
interface Discovered {
  readonly label: string;
  readonly method: string;
  readonly path: string;
  readonly handler: Handler;
}

/**
 * Reads the handlers off disk through `import.meta.glob`, which Vite resolves
 * at transform time — so a route added tomorrow is in here without anyone
 * listing it, which is the entire point.
 */
function handlers(): Discovered[] {
  const modules = import.meta.glob('../../src/pages/api/admin/**/*.ts', { eager: true });
  const found: Discovered[] = [];

  for (const [key, module] of Object.entries(modules)) {
    const file = key.slice(PREFIX.length);
    const path = `/api/admin/${file}`
      .replace(/\.ts$/, '')
      .replace(/\/index$/, '')
      .replace(/\[[^\]]+\]/g, '1');

    for (const [name, value] of Object.entries(module as Record<string, unknown>)) {
      if (!HTTP_METHODS.has(name) || typeof value !== 'function') continue;
      found.push({ label: `${name} ${path}`, method: name, path, handler: value as Handler });
    }
  }
  return found.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The smallest context a handler reads: the request, the resolved user, and the
 * `[id]` parameter. Deliberately *not* a real Astro context — the point is that
 * nothing ran before the handler, so there is nothing else to supply.
 *
 * The id is arbitrary and stays arbitrary: every handler here authorises before
 * it calls `intParam`, so a refusal never reads it. If one of these tests ever
 * fails with a 400 about an invalid id, that is the finding — it would mean a
 * route had started parsing input for a caller it had not yet identified.
 */
function contextFor(user: SessionUser | undefined, route: Discovered): APIContext {
  const url = `${ORIGIN}${route.path}`;
  return {
    request: new Request(url, { method: route.method, headers: { origin: ORIGIN } }),
    url: new URL(url),
    params: { id: '1' },
    locals: { user },
  } as unknown as APIContext;
}

async function sessionUser(role: 'guest' | 'member'): Promise<SessionUser> {
  const row = await seedUser(env.DB, { role });
  return {
    id: row.id,
    discordId: row.discord_id,
    username: row.username,
    displayName: row.username,
    avatarUrl: null,
    role: row.role,
    team: null,
    trainerName: null,
    trainerLevel: null,
  };
}

const ROUTES = handlers();

describe('every admin handler refuses on its own', () => {
  it('found the handlers', () => {
    // Vacuity guard: an empty list would make every `it.each` below disappear
    // and the file would report green having asserted nothing.
    expect(ROUTES.length).toBeGreaterThanOrEqual(15);
    expect(ROUTES.map((route) => route.label)).toContain('DELETE /api/admin/pois/1');
  });

  it.each(ROUTES.map((route) => [route.label, route] as const))(
    '%s refuses a caller with no session',
    async (_label, route) => {
      await seedFixtures();
      const before = await contentSnapshot();

      const res = await route.handler(contextFor(undefined, route));

      /*
       * 401 from `requireUser`, or 401 from `requireImportToken` on the import
       * endpoints. Never a 2xx, and never a 4xx about the *body* — every route
       * here authorises before it reads anything, and a 400 would mean one had
       * started doing work for a caller it had not yet identified.
       */
      expect([401, 403], `${route.label} answered ${res.status} to a stranger`).toContain(
        res.status,
      );
      expect(await contentSnapshot()).toBe(before);
    },
  );

  it.each(ROUTES.map((route) => [route.label, route] as const))(
    '%s refuses a member',
    async (_label, route) => {
      await seedFixtures();
      const member = await sessionUser('member');
      const before = await contentSnapshot();

      const res = await route.handler(contextFor(member, route));

      // A member is signed in and below the floor, so 403 from `requireRole` —
      // or 401 from the import guard, which does not care about sessions below
      // `admin` and asks for a token instead.
      expect([401, 403], `${route.label} answered ${res.status} to a member`).toContain(res.status);
      expect(await contentSnapshot()).toBe(before);
    },
  );

  it.each(ROUTES.map((route) => [route.label, route] as const))(
    '%s refuses a guest',
    async (_label, route) => {
      await seedFixtures();
      const guest = await sessionUser('guest');
      const before = await contentSnapshot();

      const res = await route.handler(contextFor(guest, route));

      expect([401, 403], `${route.label} answered ${res.status} to a guest`).toContain(res.status);
      expect(await contentSnapshot()).toBe(before);
    },
  );
});
