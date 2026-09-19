/**
 * Every `/api/admin/*` route, every method, against every kind of caller.
 *
 * Driven through `SELF.fetch` rather than by calling handlers, because half the
 * answers come from the middleware and a handler called directly never meets
 * it. What is being tested is the boundary as a request actually crosses it.
 *
 * Three things are asserted per cell, and the second and third are the ones
 * that make this more than a status-code table:
 *
 *   1. the status;
 *   2. *which* guard produced it — see `Answerer` in surface.ts. Two guards
 *      answer 401 with different bodies, and a change in which one is doing the
 *      work would not move the number;
 *   3. for a refused write, that nothing in the database moved. A route that
 *      returns 403 after it has already deleted the row is the failure this
 *      whole suite exists to rule out, and it is invisible to a status check.
 *
 * The table itself is checked against the filesystem at the bottom of the file.
 */

import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_ROUTES,
  CALLERS,
  contentSnapshot,
  ORIGIN,
  requestAs,
  seedFixtures,
  type AdminRoute,
  type Caller,
  type Outcome,
} from './surface';

/* ------------------------------------------------------------ assertions */

async function assertAnsweredBy(res: Response, expected: Outcome): Promise<void> {
  switch (expected.by) {
    case 'middleware':
      // `src/middleware.ts` — no challenge, and the word is "Forbidden".
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(res.headers.get('www-authenticate')).toBeNull();
      expect(await res.json()).toEqual({ error: 'Forbidden' });
      break;

    case 'import-guard':
      // `requireImportToken` — sends a challenge, and the word is "Unauthorized".
      expect(res.headers.get('www-authenticate')).toContain('Bearer');
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
      break;

    case 'role-check':
      // `requireRole` inside the handler, surfaced by `handler()`.
      expect(res.headers.get('www-authenticate')).toBeNull();
      expect((await res.json()) as { error: string }).toMatchObject({ error: expected.message });
      break;

    case 'route':
      // Past every guard. What the handler then says is other suites' business.
      break;
  }
}

/* ---------------------------------------------------------------- the grid */

interface Cell {
  route: AdminRoute;
  caller: Caller;
  expected: Outcome;
}

const GRID: [string, Cell][] = ADMIN_ROUTES.flatMap((route) =>
  CALLERS.map(
    (caller): [string, Cell] => [
      `${route.name} — ${caller}`,
      { route, caller, expected: route.expect[caller] },
    ],
  ),
);

describe('the admin API, by route and caller', () => {
  it.each(GRID)('%s', async (_title, { route, caller, expected }) => {
    const fixtures = await seedFixtures();
    const { path, init } = route.build(fixtures);

    const before = expected.by === 'route' ? null : await contentSnapshot();

    const res = await SELF.fetch(await requestAs(caller, `${ORIGIN}${path}`, init), {
      redirect: 'manual',
    });

    expect(res.status).toBe(expected.status);
    await assertAnsweredBy(res, expected);

    if (before !== null) {
      // A refusal that already did the work is not a refusal.
      expect(await contentSnapshot()).toBe(before);
    }
  });

  it('is the size it claims to be', () => {
    // A guard on the guard: the grid is generated, so a bug that silently
    // produced an empty or half-length one would make every assertion above
    // vacuous while the suite still reported green.
    expect(CALLERS).toHaveLength(6);
    expect(ADMIN_ROUTES).toHaveLength(21);
    expect(GRID).toHaveLength(21 * 6);
  });
});

/* ------------------------------------------------------------- the census */

/** Everything Astro will treat as a handler export on a route module. */
const HTTP_METHODS = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'ALL',
]);

const PREFIX = '../../src/pages/api/admin/';

/**
 * Reads the admin API off disk: one entry per exported handler, as
 * `<file> <METHOD>`.
 *
 * `import.meta.glob` is resolved by Vite at transform time, so this is the real
 * directory listing rather than a second hand-maintained copy of it. Eager,
 * because the method names are exports and reading them means loading the
 * module — which is safe here: a route module's top level declares schemas and
 * constants, and the handlers do not run until they are called.
 */
function surfaceOnDisk(): string[] {
  const modules = import.meta.glob('../../src/pages/api/admin/**/*.ts', { eager: true });
  const found: string[] = [];

  for (const [key, module] of Object.entries(modules)) {
    const file = key.slice(PREFIX.length);
    for (const name of Object.keys(module as Record<string, unknown>)) {
      if (HTTP_METHODS.has(name)) found.push(`${file} ${name}`);
    }
  }
  return found.sort();
}

describe('the matrix covers the whole surface', () => {
  /*
   * The point of the file, and the answer to the trap described in
   * `~/lib/auth/admin-path`: `/api/admin/import-*` skips the middleware's role
   * check on a prefix match, so a third import route added tomorrow is
   * unguarded unless its author remembers to call `requireImportAuth`. Nothing
   * in the app makes them remember.
   *
   * This does. A new route — import-prefixed or not — fails here until it has a
   * row in `ADMIN_ROUTES`, and writing that row means stating what all six
   * callers get, at which point an unguarded one cannot be written down as
   * anything but the hole it is. `import-guard.test.ts` then catches the same
   * mistake a second way, without anyone having to touch the table at all.
   */
  it('has a row for every handler exported under src/pages/api/admin', () => {
    const covered = [...new Set(ADMIN_ROUTES.map((route) => `${route.file} ${route.method}`))].sort();

    // Both directions. A missing entry is an untested route; an extra one is a
    // row describing a route that no longer exists, which is worse than none.
    expect(surfaceOnDisk()).toEqual(covered);
  });

  it('found the routes at all', () => {
    // Without this, a glob that matched nothing would make the check above pass
    // against an empty table.
    expect(surfaceOnDisk().length).toBeGreaterThanOrEqual(15);
  });
});
