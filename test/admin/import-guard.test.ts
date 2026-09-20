/**
 * `src/lib/admin-auth.ts`, and the hole it is the only thing standing in.
 *
 * ---------------------------------------------------------------------------
 * THE TRAP
 * ---------------------------------------------------------------------------
 *
 * `src/middleware.ts` skips the role check for anything matching
 * `/api/admin/import-`, on a prefix. That exemption is deliberate and must stay
 * — the first import runs on a fresh deployment, before Discord sign-in can
 * produce an admin to authorise it — but it is opt-out security: the two routes
 * that exist call `requireImportAuth` themselves, and nothing whatsoever makes
 * a third one do the same. Add `/api/admin/import-users.ts` tomorrow, forget
 * that line, and it ships open to the internet with no test failing.
 *
 * `every import route refuses a stranger` below is the guard against that, and
 * it needs no one to remember anything: it finds the routes by globbing the
 * directory, so a new file is picked up the moment it exists, and it drives
 * each one anonymously through the real stack and demands the route's own
 * bearer challenge. An unguarded route answers something else and fails.
 *
 * `api-matrix.test.ts` catches the same mistake from the other side, by
 * census against `ADMIN_ROUTES`. Two independent nets, because this one is
 * worth catching.
 */

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { APIContext } from 'astro';
import { requireImportAuth, requireImportToken } from '~/lib/admin-auth';
import type { SessionUser } from '~/lib/auth/types';
import { seedUser } from '../helpers/factories';
import { ORIGIN } from './surface';

/** Fixed in vitest.config.ts, so the guard is deterministic. */
const TOKEN = 'test-import-token';

function withAuth(header?: string): Request {
  const headers = new Headers();
  if (header !== undefined) headers.set('authorization', header);
  return new Request(`${ORIGIN}/api/admin/import-legacy`, { method: 'POST', headers });
}

/**
 * Runs `body` with `IMPORT_TOKEN` set to `value` on the live bindings.
 *
 * The bag `cloudflare:test` hands out is the same object the Worker reads, so
 * this genuinely reconfigures the running app — the only way to reach the
 * "not configured" branch. Asserts the value it is replacing first, so it can
 * never clobber something unexpected, and asserts the restore in `finally`:
 * a file that left this blank would silently disarm every later test here.
 */
async function withImportToken<T>(value: string, body: () => Promise<T>): Promise<T> {
  const bag = env as unknown as Record<string, string>;
  expect(bag.IMPORT_TOKEN, 'IMPORT_TOKEN is not the fixed test value — refusing to touch it').toBe(
    TOKEN,
  );

  bag.IMPORT_TOKEN = value;
  try {
    return await body();
  } finally {
    bag.IMPORT_TOKEN = TOKEN;
    expect(bag.IMPORT_TOKEN).toBe(TOKEN);
  }
}

/** The smallest thing `requireImportAuth` reads: a user and a request. */
function contextFor(user: SessionUser | undefined, request = withAuth()): APIContext {
  return { request, locals: { user } } as unknown as APIContext;
}

/* ------------------------------------------------------- requireImportToken */

describe('requireImportToken', () => {
  it('answers 503 when IMPORT_TOKEN is not configured', async () => {
    await withImportToken('', async () => {
      const res = requireImportToken(withAuth(`Bearer ${TOKEN}`), env);

      // Not 401. The caller did nothing wrong and retrying with a different
      // token will not help — the server is the thing that is misconfigured.
      expect(res?.status).toBe(503);
      expect(((await res?.json()) as { error: string }).error).toMatch(/not configured/);
    });
  });

  it('refuses a request with no Authorization header at all', async () => {
    const res = requireImportToken(withAuth(), env);

    expect(res?.status).toBe(401);
    expect(res?.headers.get('www-authenticate')).toBe('Bearer realm="pogotxk-admin"');
    expect(await res?.json()).toEqual({ error: 'Unauthorized' });
  });

  it.each([
    ['an empty header', ''],
    ['Basic auth', 'Basic dXNlcjpwYXNz'],
    ['a bare token with no scheme', TOKEN],
    ['the scheme with no token', 'Bearer '],
    ['the scheme and only spaces', 'Bearer    '],
    /*
     * RFC 7235 says the auth scheme is case-insensitive, and `startsWith`
     * makes this one case-sensitive, so a caller who types `bearer` is refused
     * a token that is correct. It is strict rather than permissive — the safe
     * direction — and pinning it here means a future relaxation has to be
     * deliberate. Reported as a finding rather than changed.
     */
    ['a lower-cased scheme, which this guard does not accept', `bearer ${TOKEN}`],
  ])('refuses %s', (_label, header) => {
    expect(requireImportToken(withAuth(header), env)?.status).toBe(401);
  });

  it('refuses a token of the right length that is wrong', () => {
    // The interesting input for a constant-time compare: it gets all the way
    // through the byte loop rather than failing on the length XOR.
    const wrong = `${TOKEN.slice(0, -1)}X`;
    expect(wrong).toHaveLength(TOKEN.length);
    expect(wrong).not.toBe(TOKEN);

    expect(requireImportToken(withAuth(`Bearer ${wrong}`), env)?.status).toBe(401);
  });

  it('refuses a token that differs only in its first byte', () => {
    const wrong = `X${TOKEN.slice(1)}`;
    expect(requireImportToken(withAuth(`Bearer ${wrong}`), env)?.status).toBe(401);
  });

  it.each([
    ['shorter', TOKEN.slice(0, -1)],
    ['longer', `${TOKEN}x`],
    ['a prefix of the real one', TOKEN.slice(0, 4)],
    ['the real one with the real one appended', `${TOKEN}${TOKEN}`],
  ])('refuses a %s token', (_label, supplied) => {
    // The length XOR seeds `diff` before the loop, so these never compare equal
    // however the bytes line up. `?? 0` padding past the shorter input is what
    // makes the loop safe to run to `max(len)`.
    expect(requireImportToken(withAuth(`Bearer ${supplied}`), env)?.status).toBe(401);
  });

  it('accepts the correct token, and says so by returning nothing', () => {
    // null is the contract: a guard returns a Response only to refuse.
    expect(requireImportToken(withAuth(`Bearer ${TOKEN}`), env)).toBeNull();
  });

  it('is not fooled by a token that merely contains the right one', () => {
    expect(requireImportToken(withAuth(`Bearer x${TOKEN}`), env)?.status).toBe(401);
  });
});

/* -------------------------------------------------------- requireImportAuth */

describe('requireImportAuth', () => {
  async function sessionUser(role: 'guest' | 'member' | 'ambassador' | 'admin') {
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
    } satisfies SessionUser;
  }

  it('lets a signed-in admin through with no token at all', async () => {
    // The whole reason the session branch exists: seeding a site from a button
    // must not require generating and pasting a secret first.
    expect(requireImportAuth(contextFor(await sessionUser('admin')), env)).toBeNull();
  });

  it('still lets an admin through when IMPORT_TOKEN is not configured', async () => {
    const admin = await sessionUser('admin');
    await withImportToken('', async () => {
      // The session is checked first, so the 503 is never reached. If the order
      // were reversed, a fresh deployment's first admin could not import.
      expect(requireImportAuth(contextFor(admin), env)).toBeNull();
    });
  });

  it('does NOT short-circuit for an ambassador', async () => {
    const res = requireImportAuth(contextFor(await sessionUser('ambassador')), env);

    // The one asymmetry in the whole admin surface: every other route treats
    // ambassador as sufficient. These endpoints rewrite the database wholesale.
    expect(res?.status).toBe(401);
    expect(res?.headers.get('www-authenticate')).toContain('Bearer');
  });

  it.each(['guest', 'member', 'ambassador'] as const)(
    'falls through to the token for a %s, who may still use one',
    async (role) => {
      const ctx = contextFor(await sessionUser(role), withAuth(`Bearer ${TOKEN}`));

      // Not a privilege escalation: holding IMPORT_TOKEN is the credential, and
      // whoever has it could have sent the same request signed out.
      expect(requireImportAuth(ctx, env)).toBeNull();
    },
  );

  it('falls through to the token for a caller with no session', () => {
    expect(requireImportAuth(contextFor(undefined, withAuth(`Bearer ${TOKEN}`)), env)).toBeNull();
    expect(requireImportAuth(contextFor(undefined), env)?.status).toBe(401);
  });
});

/* ------------------------------------------------------------- the trap */

const PREFIX = '../../src/pages/api/admin/';
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'ALL']);

/**
 * Every route reachable under the `/api/admin/import-` exemption, found by
 * globbing rather than by being listed, with the URL Astro will serve it at.
 *
 * `index.ts` is the directory itself and `[param]` gets a plausible value, so a
 * future `import-users/[id].ts` is still driven at a real URL.
 */
function exemptRoutes(): [string, string][] {
  const modules = import.meta.glob('../../src/pages/api/admin/**/*.ts', { eager: true });
  const routes: [string, string][] = [];

  for (const [key, module] of Object.entries(modules)) {
    const file = key.slice(PREFIX.length);
    if (!file.startsWith('import-')) continue;

    const path = `/api/admin/${file}`
      .replace(/\.ts$/, '')
      .replace(/\/index$/, '')
      .replace(/\[[^\]]+\]/g, '1');

    for (const method of Object.keys(module as Record<string, unknown>)) {
      if (HTTP_METHODS.has(method)) routes.push([`${method} ${path}`, method]);
    }
  }
  return routes;
}

describe('the import exemption', () => {
  it('found the import routes', () => {
    // The glob is the whole mechanism. If it matched nothing, every assertion
    // below would pass by vacuity — which is precisely the failure this file
    // exists to prevent, so it is worth one explicit test.
    expect(exemptRoutes().map(([name]) => name).sort()).toEqual([
      'POST /api/admin/import-legacy',
      'POST /api/admin/import-media',
    ]);
  });

  it.each(exemptRoutes())('%s refuses a stranger with its own guard', async (name, method) => {
    const path = name.slice(method.length + 1);

    const res = await SELF.fetch(`${ORIGIN}${path}`, {
      method,
      headers: { origin: ORIGIN },
      redirect: 'manual',
    });

    /*
     * The middleware did not answer this — it waved the request through on the
     * `import-` prefix. Everything below is the route's own `requireImportAuth`
     * doing its job, and a route that forgot to call it cannot produce any of
     * it: a challenge header, and the word "Unauthorized" rather than the
     * middleware's "Forbidden".
     */
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="pogotxk-admin"');
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it.each(exemptRoutes())('%s answers a valid token', async (name, method) => {
    const path = name.slice(method.length + 1);

    const res = await SELF.fetch(`${ORIGIN}${path}`, {
      method,
      headers: { origin: ORIGIN, authorization: `Bearer ${TOKEN}` },
      redirect: 'manual',
    });

    // Past the guard, so no longer a 401 and no longer a challenge. What the
    // handler then does needs the legacy site, which no test may reach.
    expect(res.status).not.toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('is the `import-` prefix and not the word "import"', async () => {
    // `/api/admin/imports` shares four letters and none of the exemption. The
    // middleware answers it, which is visible in the body: "Forbidden", and no
    // challenge.
    const res = await SELF.fetch(`${ORIGIN}/api/admin/imports`, { redirect: 'manual' });

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('really does hand an unrouted import- path past the role gate', async () => {
    /*
     * The trap, made visible. `/api/admin/import-nonexistent` has no route, so
     * it 404s — but the 404 is the point: an unrouted path that was *not*
     * exempt answers 401 from the middleware, as `/api/admin/nonexistent` does
     * one line below. Reaching routing at all means the role check was skipped,
     * which is exactly what a future unguarded `import-` route would inherit.
     */
    const exempt = await SELF.fetch(`${ORIGIN}/api/admin/import-nonexistent`, {
      redirect: 'manual',
    });
    expect(exempt.status).toBe(404);

    const guarded = await SELF.fetch(`${ORIGIN}/api/admin/nonexistent`, { redirect: 'manual' });
    expect(guarded.status).toBe(401);
    expect(await guarded.json()).toEqual({ error: 'Forbidden' });
  });
});
