/**
 * `/admin/login` and `POST /api/auth/admin-login` — the break-glass door.
 *
 * The page is under `/admin` and the route deliberately is not. The page is
 * exempted from the role gate by `isAdminLoginPath`, matched exactly, so a
 * signed-out visitor can reach it; the route stays outside `/api/admin/`
 * because a gated one would answer 401 to that same visitor. Neither path is a
 * secret — the repository is public — so the password and the lockout asserted
 * below are the entirety of what holds this door.
 *
 * Driven through `SELF.fetch` rather than by importing the handler, because
 * most of what matters here lives in the response envelope: the status, the
 * `Location`, whether a `Set-Cookie` exists at all, and whether two different
 * failures are distinguishable from outside. A direct call would let a test
 * pass while the route leaked which username exists.
 *
 * `redirect: 'manual'` throughout. Following the 303 replaces everything worth
 * asserting with the form page's 200.
 *
 * Two things about the harness before reading the assertions:
 *
 * 1. **A non-GET request needs an `Origin` header** or Astro refuses it before
 *    the route runs (403, plain text). `jsonRequest` sets it; a bare `Request`
 *    does not, which is the subject of one deliberate test below.
 * 2. **workerd freezes the clock inside a single invocation.** `Date.now()`
 *    advances only across I/O, so timing anything means bracketing a
 *    `SELF.fetch()` — never a pure call, which would measure zero.
 */

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { upsertUser, type DiscordUser } from '~/lib/auth/discord';
import { DEFAULT_ITERATIONS, pbkdf2Sha256, verifyPassword } from '~/lib/auth/password';
import { getSessionUser, SESSION_COOKIE } from '~/lib/auth/session';
import {
  authCookie,
  jsonRequest,
  readCredential,
  seedAdminCredential,
  seedUser,
} from '../helpers/factories';

const ORIGIN = 'https://pogotxk.test';
const API = `${ORIGIN}/api/auth/admin-login`;
const FORM_TYPE = 'application/x-www-form-urlencoded';

/** A form-encoded POST with the `Origin` a browser would send. */
function signIn(fields: Record<string, string>): Request {
  return jsonRequest(API, {
    body: new URLSearchParams(fields).toString(),
    headers: { 'content-type': FORM_TYPE },
  });
}

function post(fields: Record<string, string>): Promise<Response> {
  return SELF.fetch(signIn(fields), { redirect: 'manual' });
}

/**
 * Runs every path a timing test is about to measure, several times, and then
 * clears what that cost.
 *
 * Not superstition, and one round is not enough. Measured on 2026-09-19: the
 * very first 100,000-round derivation in a fresh isolate took **618 ms** while
 * the settled cost is **56 ms**, so whichever path a test happened to run first
 * looked six times more expensive than the other. The assertion was really
 * about statement order. Three rounds is where it stops moving — Miniflare
 * compiles, V8 JITs the crypto path, and D1 prepares each statement once.
 *
 * With this in place the two failure paths come out at 56 ms and 60 ms, and the
 * 4 ms between them is the two D1 writes the known-row path makes.
 */
async function warmUp(username: string, userId: number): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await post({ username, password: 'warm up' });
    await post({ username: 'nobodyhere', password: 'warm up' });
    await post({ username: '', password: '' });
  }
  await env.DB.prepare(
    `UPDATE admin_credentials
        SET failed_attempts = 0, last_failed_at = NULL, locked_until = NULL
      WHERE user_id = ?1`,
  )
    .bind(userId)
    .run();
}

function sessionTokenOf(res: Response): string | undefined {
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  const value = cookie?.slice(SESSION_COOKIE.length + 1).split(';')[0];
  return value ? value : undefined;
}

async function sessionCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>();
  return row?.n ?? 0;
}

async function auditActions(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    'SELECT action FROM audit_log ORDER BY id',
  ).all<{ action: string }>();
  return results.map((r) => r.action);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------ the vector */

describe('the same bytes on both sides', () => {
  /*
   * `scripts/test-owner-password.ts` asserts this identical vector under plain
   * `tsx`. The duplication is the point and must not be tidied away: the setter
   * script derives its hash in Node and this Worker verifies it in workerd, and
   * nothing except the same vector passing in both runtimes actually proves
   * those two agree. Sharing a module is necessary and not sufficient — two Web
   * Crypto implementations could disagree underneath it.
   */
  it('derives the RFC known-answer vector inside workerd', async () => {
    const out = await pbkdf2Sha256('password', new TextEncoder().encode('salt'), 1, 32);
    expect(hex(out)).toBe('120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b');
  });
});

/* ------------------------------------------------------------ the happy path */

describe('a correct password', () => {
  it('answers 303 and the cookie reaches the admin console', async () => {
    const owner = await seedUser(env.DB, { role: 'admin', roleLocked: true });
    const cred = await seedAdminCredential(env.DB, owner);

    const res = await post({ username: cred.username, password: cred.password });

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.get('cache-control')).toBe('no-store');

    const token = sessionTokenOf(res)!;
    const page = await SELF.fetch(`${ORIGIN}/admin/posts`, {
      headers: { cookie: authCookie(token) },
      redirect: 'manual',
    });
    expect(page.status).toBe(200);
    expect(page.headers.get('location')).toBeNull();
  });

  it('mints the app’s own cookie, and exactly one of it', async () => {
    const owner = await seedUser(env.DB, { role: 'admin' });
    const cred = await seedAdminCredential(env.DB, owner);

    const res = await post({ username: cred.username, password: cred.password });

    // One, not two: this route has no state cookie to clear, unlike /auth/callback.
    expect(res.headers.getSetCookie()).toHaveLength(1);

    const cookie = res.headers.getSetCookie()[0]!;
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=1209600');
    // The test ORIGIN is https, so the Secure attribute must be present.
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
  });

  it('resolves to the seeded user, still an admin', async () => {
    const owner = await seedUser(env.DB, { role: 'admin', username: 'theowner' });
    const cred = await seedAdminCredential(env.DB, owner);

    const res = await post({ username: cred.username, password: cred.password });
    const user = await getSessionUser(env.DB, sessionTokenOf(res)!);

    expect(user?.id).toBe(owner.id);
    expect(user?.username).toBe('theowner');
    expect(user?.role).toBe('admin');
  });

  it('is case-insensitive about the username, and tolerates spaces', async () => {
    const owner = await seedUser(env.DB, { role: 'admin' });
    const cred = await seedAdminCredential(env.DB, owner, { username: 'theowner' });

    const res = await post({ username: '  THEOwner  ', password: cred.password });

    expect(res.status).toBe(303);
    expect(sessionTokenOf(res)).toBeDefined();
  });

  it('records the login, naming the method and nothing else', async () => {
    const owner = await seedUser(env.DB, { role: 'admin' });
    const cred = await seedAdminCredential(env.DB, owner);

    await post({ username: cred.username, password: cred.password });

    const row = await env.DB.prepare(
      'SELECT actor_id, action, entity, entity_id, diff_json FROM audit_log',
    ).first<{
      actor_id: number;
      action: string;
      entity: string;
      entity_id: string;
      diff_json: string;
    }>();

    expect(row?.action).toBe('login');
    expect(row?.actor_id).toBe(owner.id);
    expect(row?.entity).toBe('admin_credentials');
    expect(JSON.parse(row!.diff_json)).toEqual({ method: 'password' });
    // `audit_log` is readable by every ambassador, and one day the owner will
    // type their password into the username field.
    expect(row?.diff_json).not.toContain(cred.username);
  });

  it('lands where next asked', async () => {
    const owner = await seedUser(env.DB, { role: 'admin' });
    const cred = await seedAdminCredential(env.DB, owner);

    const res = await post({
      username: cred.username,
      password: cred.password,
      next: '/admin/posts',
    });

    expect(res.headers.get('location')).toBe('/admin/posts');
  });

  it.each([
    ['a protocol-relative host', '//evil.example/phish'],
    ['the backslash form a browser folds to a slash', '/\\evil.example/phish'],
    ['an absolute URL', 'https://evil.example/phish'],
    ['a tab-smuggled host', '/\t//evil.example/phish'],
  ])('sends %s home instead', async (_label, next) => {
    // The same hostile table `callback.test.ts` runs, and the argument is
    // stronger here: there the value came out of a cookie we minted, and here
    // it arrives from a form field the submitter controls entirely.
    const owner = await seedUser(env.DB, { role: 'admin' });
    const cred = await seedAdminCredential(env.DB, owner);

    const res = await post({ username: cred.username, password: cred.password, next });

    expect(res.headers.get('location')).toBe('/');
  });
});

/* --------------------------------------------------------- the refusals */

describe('what it refuses, and how little it says', () => {
  it('sends a wrong password back with error=bad and no cookie', async () => {
    const owner = await seedUser(env.DB, { role: 'admin' });
    const cred = await seedAdminCredential(env.DB, owner);

    const res = await post({ username: cred.username, password: 'not the password at all' });

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/login?error=bad');
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(await sessionCount()).toBe(0);
  });

  it('answers an unknown username byte-for-byte as it answers a wrong password', async () => {
    /*
     * The assertion that keeps username enumeration off the table. If these two
     * ever diverge — a different status, a stray header, a different body — an
     * attacker can ask "does this username exist" for free and then spend every
     * remaining guess on the one that does.
     */
    const owner = await seedUser(env.DB, { role: 'admin' });
    const cred = await seedAdminCredential(env.DB, owner);

    const wrong = await post({ username: cred.username, password: 'wrong wrong wrong' });
    const unknown = await post({ username: 'nobodyhere', password: 'wrong wrong wrong' });

    expect(unknown.status).toBe(wrong.status);
    expect(unknown.headers.get('location')).toBe(wrong.headers.get('location'));
    expect(unknown.headers.get('cache-control')).toBe(wrong.headers.get('cache-control'));
    expect([...unknown.headers.keys()].sort()).toEqual([...wrong.headers.keys()].sort());
    expect(await unknown.text()).toBe(await wrong.text());
    expect(unknown.headers.getSetCookie()).toHaveLength(0);
  });

  it('spends real time on an unknown username, rather than answering instantly', async () => {
    /*
     * A FLOOR ONLY, never a two-sided window.
     *
     * The claim worth making is "an unknown username is not obviously cheaper",
     * and a floor states it. A window ("within 30% of each other") states
     * something stronger that a shared CI box cannot deliver, and would fail
     * for reasons that have nothing to do with this route.
     *
     * The clock is bracketed around `SELF.fetch` and not around a pure call,
     * because workerd freezes `Date.now()` within an invocation and only
     * advances it across I/O. Timing `verifyPassword()` directly would measure
     * exactly zero and pass forever.
     */
    const owner = await seedUser(env.DB, { role: 'admin' });
    const cred = await seedAdminCredential(env.DB, owner, { iterations: DEFAULT_ITERATIONS });

    await warmUp(cred.username, owner.id);

    const t0 = Date.now();
    await post({ username: cred.username, password: 'wrong wrong wrong' });
    const wrongMs = Date.now() - t0;

    const t1 = Date.now();
    await post({ username: 'nobodyhere', password: 'wrong wrong wrong' });
    const unknownMs = Date.now() - t1;

    expect(unknownMs).toBeGreaterThanOrEqual(0.4 * wrongMs);
  });

  it('answers bad, not 500, when no credential exists at all', async () => {
    // What a scanner finds on a fresh deploy, before anyone has run
    // `npm run set:password`. There is no row, no user, nothing.
    const res = await post({ username: 'admin', password: 'hunter2hunter2hunter2' });

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/login?error=bad');
    expect(await sessionCount()).toBe(0);
    // No credential means no counter to bound the writes, so nothing is logged.
    expect(await auditActions()).toEqual([]);
  });

  it.each([
    ['a salt that is not base64url', { salt: 'not base64url!!' }],
    ['a truncated hash', { hash: 'AAAA' }],
    ['an empty salt', { salt: '' }],
    ['a hash of the wrong width', { hash: 'AAAAAAAAAAAAAAAAAAAAAA' }],
  ])('answers bad, not 500, for %s', async (_label, corruption) => {
    const owner = await seedUser(env.DB, { role: 'admin' });
    const cred = await seedAdminCredential(env.DB, owner, corruption);

    const res = await post({ username: cred.username, password: cred.password });

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/login?error=bad');
    expect(await sessionCount()).toBe(0);
  });

  it('cannot be handed a row cheap enough or strange enough to matter', async () => {
    /*
     * The other two corruptions the route defends against — `iterations: 0` and
     * an unknown algorithm — turn out to be unreachable through D1, because the
     * CHECK constraints in `0004_owner_password.sql` refuse them on INSERT and
     * on UPDATE alike. `verifyPassword` still rejects both (asserted in
     * `scripts/test-owner-password.ts`); this pins the outer wall, so nobody
     * later removes a constraint believing the code alone covers it.
     */
    const owner = await seedUser(env.DB, { role: 'admin' });

    await expect(
      env.DB.prepare(
        `INSERT INTO admin_credentials (user_id, username, iterations, salt, hash)
         VALUES (?1, 'cheaprow', 0, 'AAAA', 'AAAA')`,
      )
        .bind(owner.id)
        .run(),
    ).rejects.toThrow();

    await expect(
      env.DB.prepare(
        `INSERT INTO admin_credentials (user_id, username, algorithm, iterations, salt, hash)
         VALUES (?1, 'bcryptrow', 'bcrypt', 100000, 'AAAA', 'AAAA')`,
      )
        .bind(owner.id)
        .run(),
    ).rejects.toThrow();
  });

  it('refuses an empty username or password without touching the database', async () => {
    const owner = await seedUser(env.DB, { role: 'admin' });
    await seedAdminCredential(env.DB, owner);

    for (const fields of [
      { username: '', password: 'something long enough' },
      { username: 'owner', password: '' },
      {},
    ]) {
      const res = await post(fields as Record<string, string>);
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/admin/login?error=bad');
    }

    // Nothing was counted: there was no credential to check, so there is no
    // failure to record against one.
    expect((await readCredential(env.DB, owner))?.failed_attempts).toBe(0);
  });
});

/* ------------------------------------------------------------- the lockout */

describe('the lockout', () => {
  it('counts failures, and a success clears them', async () => {
    const owner = await seedUser(env.DB, { role: 'admin' });
    const cred = await seedAdminCredential(env.DB, owner);

    await post({ username: cred.username, password: 'wrong one' });
    expect((await readCredential(env.DB, owner))?.failed_attempts).toBe(1);

    await post({ username: cred.username, password: 'wrong two' });
    expect((await readCredential(env.DB, owner))?.failed_attempts).toBe(2);

    await post({ username: cred.username, password: cred.password });
    const after = await readCredential(env.DB, owner);
    expect(after?.failed_attempts).toBe(0);
    expect(after?.locked_until).toBeNull();
    expect(after?.last_success_at).not.toBeNull();
  });

  it('shuts the door on the sixth attempt after five failures', async () => {
    const owner = await seedUser(env.DB, { role: 'admin' });
    const cred = await seedAdminCredential(env.DB, owner);

    for (let i = 0; i < 5; i++) {
      const res = await post({ username: cred.username, password: `wrong ${i}` });
      expect(res.headers.get('location')).toBe('/admin/login?error=bad');
    }

    const row = await readCredential(env.DB, owner);
    expect(row?.failed_attempts).toBe(5);
    expect(row?.locked_until).not.toBeNull();

    const sixth = await post({ username: cred.username, password: 'wrong again' });
    expect(sixth.headers.get('location')).toBe('/admin/login?error=locked');
  });

  it('REFUSES A CORRECT PASSWORD WHILE LOCKED', async () => {
    /*
     * The headline. A lockout that a correct password walks through is not a
     * lockout — it is a delay on the one guess that was going to work anyway,
     * and it would make the whole counter theatre.
     *
     * `failed_attempts` staying put is the second half: the locked path must
     * not write, or an attacker could hold the account locked forever by
     * pushing the counter up on every attempt while it was already shut.
     */
    const owner = await seedUser(env.DB, { role: 'admin' });
    const cred = await seedAdminCredential(env.DB, owner, {
      failedAttempts: 5,
      lockedUntil: new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      lastFailedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });

    const res = await post({ username: cred.username, password: cred.password });

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/login?error=locked');
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(await sessionCount()).toBe(0);
    expect((await readCredential(env.DB, owner))?.failed_attempts).toBe(5);
  });

  it('says the same thing whether the password was right or wrong while locked', async () => {
    const owner = await seedUser(env.DB, { role: 'admin' });
    const cred = await seedAdminCredential(env.DB, owner, {
      failedAttempts: 5,
      lockedUntil: new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });

    const right = await post({ username: cred.username, password: cred.password });
    const wrong = await post({ username: cred.username, password: 'definitely not it' });

    expect(right.status).toBe(wrong.status);
    expect(right.headers.get('location')).toBe(wrong.headers.get('location'));
    expect(await right.text()).toBe(await wrong.text());
  });

  it('opens again when the lock expires, and resets the counter', async () => {
    const owner = await seedUser(env.DB, { role: 'admin' });
    const cred = await seedAdminCredential(env.DB, owner, {
      failedAttempts: 5,
      // Back-dated: the lock is over.
      lockedUntil: new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      lastFailedAt: new Date(Date.now() - 120_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });

    const res = await post({ username: cred.username, password: cred.password });

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    expect(sessionTokenOf(res)).toBeDefined();

    const after = await readCredential(env.DB, owner);
    expect(after?.failed_attempts).toBe(0);
    expect(after?.locked_until).toBeNull();
  });

  it('writes one lockout row when the lock trips, not one per attempt', async () => {
    const owner = await seedUser(env.DB, { role: 'admin' });
    const cred = await seedAdminCredential(env.DB, owner);

    for (let i = 0; i < 8; i++) await post({ username: cred.username, password: `wrong ${i}` });

    const actions = await auditActions();
    // Five failures reach the counter and then the door shuts; attempts six,
    // seven and eight return on the locked path without writing anything. So a
    // sustained attack cannot turn `audit_log` into its own amplifier.
    expect(actions.filter((a) => a === 'lockout')).toHaveLength(1);
    expect(actions.filter((a) => a === 'login')).toHaveLength(5);
  });

  it('never writes the attempted username into the audit log', async () => {
    const owner = await seedUser(env.DB, { role: 'admin' });
    const cred = await seedAdminCredential(env.DB, owner, { username: 'secretowner' });

    await post({ username: cred.username, password: 'a wrong password' });

    const row = await env.DB.prepare(
      'SELECT actor_id, entity_id, diff_json FROM audit_log',
    ).first<{ actor_id: number | null; entity_id: string | null; diff_json: string }>();

    expect(row?.actor_id).toBeNull();
    expect(row?.entity_id).toBeNull();
    expect(JSON.parse(row!.diff_json)).toEqual({ outcome: 'bad-credentials' });
    expect(row?.diff_json).not.toContain('secretowner');
    expect(row?.diff_json).not.toContain('a wrong password');
  });
});

/* --------------------------------------------------------------- rehashing */

/*
 * The RAISE itself cannot be exercised end to end right now, and that is a
 * property of the configuration rather than a gap in the code.
 *
 * `DEFAULT_ITERATIONS` currently sits at 10,000, which is also the floor the
 * schema enforces (`CHECK (iterations >= 10000)` in 0004). So no row can
 * legally exist that is cheaper than the constant, and there is nothing for a
 * login to raise. The moment the constant goes up — which is what happens if
 * this account ever moves to Workers Paid — a cheap row becomes expressible and
 * this suite should grow the raise case back.
 *
 * Until then the branch is covered where it can be: `needsRehash` is tested
 * directly over counts above, at and below the target in
 * scripts/test-owner-password.ts, which builds a `StoredHash` in memory and is
 * not bound by the CHECK constraint.
 *
 * What IS testable here, and worth pinning, is the no-op half — because getting
 * that wrong would rewrite the credential on every single sign-in, burning a D1
 * write and a fresh salt each time for nothing.
 */
describe('rehashing on a successful login', () => {
  it('leaves a row that is already at the constant untouched', async () => {
    const owner = await seedUser(env.DB, { role: 'admin' });
    const cred = await seedAdminCredential(env.DB, owner, {
      iterations: DEFAULT_ITERATIONS,
    });

    const before = await readCredential(env.DB, owner);
    expect(before?.iterations).toBe(DEFAULT_ITERATIONS);

    const res = await post({ username: cred.username, password: cred.password });
    expect(res.status).toBe(303);

    const after = await readCredential(env.DB, owner);
    expect(after?.iterations).toBe(DEFAULT_ITERATIONS);
    expect(after?.salt).toBe(before?.salt);
    expect(after?.hash).toBe(before?.hash);
    expect(await verifyPassword(cred.password, after!)).toBe(true);
  });

  it('does not downgrade a row that is more expensive than the constant', async () => {
    // A credential set while the account was on a larger CPU budget must not be
    // quietly weakened by a later sign-in. `needsRehash` is a floor, not an
    // equality check, and this is the test that says so.
    const owner = await seedUser(env.DB, { role: 'admin' });
    const cred = await seedAdminCredential(env.DB, owner, { iterations: 20_000 });

    const before = await readCredential(env.DB, owner);
    expect(before?.iterations).toBe(20_000);

    const res = await post({ username: cred.username, password: cred.password });
    expect(res.status).toBe(303);

    const after = await readCredential(env.DB, owner);
    expect(after?.iterations).toBe(20_000);
    expect(after?.hash).toBe(before?.hash);
  });
});

/* ------------------------------------------------------------ role_locked */

describe('role_locked, against Discord', () => {
  const discordUser: DiscordUser = {
    id: '100000000000000042',
    username: 'theowner',
    global_name: 'The Owner',
    avatar: null,
  };

  it('keeps an admin an admin when Discord says member', async () => {
    await seedUser(env.DB, {
      discordId: discordUser.id,
      role: 'admin',
      roleLocked: true,
    });

    // Exactly what this deployment does on every sign-in: a guild is
    // configured, no DISCORD_ROLE_* ids are, so `resolveRole` answers `member`
    // and `authoritative` is 1.
    const record = await upsertUser(env.DB, discordUser, 'member', true);

    expect(record.role).toBe('admin');
  });

  it('and the control: without the lock, the same call DOES demote', async () => {
    /*
     * Without this pair, the test above passes against a CASE that never fires
     * — including the `excluded.role_locked` spelling, which always reads 0
     * because the INSERT column list does not mention the column.
     */
    await seedUser(env.DB, {
      discordId: discordUser.id,
      role: 'admin',
      roleLocked: false,
    });

    const record = await upsertUser(env.DB, discordUser, 'member', true);

    expect(record.role).toBe('member');
  });

  it('still lets Discord promote a locked row it agrees with', async () => {
    // The lock pins, it does not freeze the row: profile fields still sync.
    await seedUser(env.DB, {
      discordId: discordUser.id,
      username: 'oldname',
      role: 'admin',
      roleLocked: true,
    });

    await upsertUser(env.DB, discordUser, 'member', true);

    const row = await env.DB.prepare('SELECT username, role FROM users WHERE discord_id = ?1')
      .bind(discordUser.id)
      .first<{ username: string; role: string }>();

    expect(row?.username).toBe('theowner');
    expect(row?.role).toBe('admin');
  });

  it('does not defeat a ban', async () => {
    /*
     * Deliberate, and stated in the migration: the lock covers `role` and
     * nothing else, so banning stays the emergency off-switch. A flag that also
     * survived a ban would be a permanent un-revocable admin, which is the
     * single point of failure this whole feature exists to remove rather than
     * to duplicate.
     */
    const owner = await seedUser(env.DB, {
      role: 'admin',
      roleLocked: true,
      isBanned: true,
    });
    const cred = await seedAdminCredential(env.DB, owner);

    // Even with the correct password, nothing is minted.
    const res = await post({ username: cred.username, password: cred.password });
    expect(res.headers.get('location')).toBe('/admin/login?error=bad');
    expect(res.headers.getSetCookie()).toHaveLength(0);

    // And a session that somehow existed would still resolve to nobody.
    const { seedSession } = await import('../helpers/factories');
    const token = await seedSession(env.DB, owner);
    expect(await getSessionUser(env.DB, token)).toBeUndefined();
  });
});

/* ------------------------------------------------------- the request shape */

describe('what shapes of request it accepts', () => {
  it('is refused by Astro when the POST carries no Origin', async () => {
    /*
     * Built with a bare `Request` on purpose: `jsonRequest` always sets
     * `origin`, so it cannot express this. The refusal comes from Astro's own
     * origin check, before the route runs at all, and that is precisely the
     * CSRF protection the form encoding buys — see the 415 test below for the
     * hole that accepting JSON would open.
     */
    const res = await SELF.fetch(
      new Request(API, {
        method: 'POST',
        headers: { 'content-type': FORM_TYPE },
        body: new URLSearchParams({ username: 'owner', password: 'whatever' }).toString(),
      }),
      { redirect: 'manual' },
    );

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('forbidden');
  });

  it('refuses a JSON body with 415', async () => {
    /*
     * The reason this route is narrow. Astro's origin check is content-type
     * dependent: it polices form-like types and skips `application/json`
     * entirely (`node_modules/astro/dist/core/app/origin-check.js`). Accepting
     * JSON here would therefore let a cross-site page submit a guess on a
     * visiting owner's behalf, with no CSRF check anywhere in the path.
     */
    const res = await SELF.fetch(
      jsonRequest(API, { json: { username: 'owner', password: 'whatever' } }),
      { redirect: 'manual' },
    );

    expect(res.status).toBe(415);
    expect(await sessionCount()).toBe(0);
  });

  it('refuses multipart and a bodyless POST too', async () => {
    for (const contentType of ['multipart/form-data; boundary=x', 'text/plain']) {
      const res = await SELF.fetch(
        jsonRequest(API, { body: 'username=owner&password=x', headers: { 'content-type': contentType } }),
        { redirect: 'manual' },
      );
      expect(res.status).toBe(415);
    }
  });
});

/* ---------------------------------------------------------------- the page */

describe('GET /admin/login', () => {
  it('renders the form to a signed-out visitor, carries noindex, and posts to the API', async () => {
    /*
     * THE POINT OF THE EXEMPTION, AND THE ONLY TEST THAT WOULD NOTICE ITS LOSS.
     *
     * This page sits under `/admin`, so the middleware's role gate covers it by
     * default and would answer a signed-out visitor with a 302 to `/auth/login`
     * — the Discord door they are here because they cannot use.
     * `isAdminLoginPath` is what stops that, and if it were dropped or the wire
     * in `src/middleware.ts` removed, nothing else in this suite would fail:
     * every other assertion here drives the API route, which is not under
     * `/admin` at all. So the status is checked, and then the form itself,
     * because a 200 that rendered an error shell would also be a dead door.
     */
    const res = await SELF.fetch(`${ORIGIN}/admin/login`, { redirect: 'manual' });

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    const html = await res.text();

    // The only thing keeping a password form out of a search index: the page
    // is publicly reachable by design and there is no public/robots.txt.
    expect(html).toContain('name="robots"');
    expect(html).toContain('noindex');

    expect(html).toContain('method="post"');
    expect(html).toContain('action="/api/auth/admin-login"');
    expect(html).toContain('name="username"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autocomplete="username"');
    expect(html).toContain('autocomplete="current-password"');
  });

  it('is reachable enough to actually sign in through, end to end', async () => {
    /*
     * The two halves joined. The assertions above prove the page renders and
     * the ones at the top of this file prove the route accepts a password; this
     * is the one that fails if the `action` on the form and the path of the
     * route ever stop agreeing — a rename on one side only, which is exactly
     * the mistake a move like this invites.
     */
    const owner = await seedUser(env.DB, { role: 'admin' });
    const cred = await seedAdminCredential(env.DB, owner);

    const html = await (await SELF.fetch(`${ORIGIN}/admin/login`)).text();
    const action = /action="([^"]+)"/.exec(html)?.[1];
    expect(action).toBeDefined();

    const res = await SELF.fetch(
      jsonRequest(`${ORIGIN}${action}`, {
        body: new URLSearchParams({
          username: cred.username,
          password: cred.password,
          next: '/admin/posts',
        }).toString(),
        headers: { 'content-type': FORM_TYPE },
      }),
      { redirect: 'manual' },
    );

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/posts');
    expect(sessionTokenOf(res)).toBeDefined();
  });

  it('carries no script of its own', async () => {
    /*
     * It is the break-glass door, reached exactly when other things are broken,
     * so it must not need a bundle to have loaded and run. Asserted rather than
     * merely intended, because an island is one `client:load` away.
     */
    const res = await SELF.fetch(`${ORIGIN}/admin/login`, { redirect: 'manual' });
    const html = await res.text();

    const body = html.slice(html.indexOf('<main'));
    expect(body).not.toContain('<script');
  });

  it('shows a real explanation for locked, and one flat sentence for bad', async () => {
    const locked = await (await SELF.fetch(`${ORIGIN}/admin/login?error=locked`)).text();
    expect(locked).toContain('role="alert"');
    expect(locked).toContain('locked');

    const bad = await (await SELF.fetch(`${ORIGIN}/admin/login?error=bad`)).text();
    expect(bad).toContain('role="alert"');
    expect(bad).toContain('did not match');
  });

  it('ignores an error value it did not emit', async () => {
    const html = await (
      await SELF.fetch(`${ORIGIN}/admin/login?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E`)
    ).text();

    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('alert(1)');
  });

  it('redirects someone who can already reach the console', async () => {
    const admin = await seedUser(env.DB, { role: 'admin' });
    const { seedSession } = await import('../helpers/factories');
    const token = await seedSession(env.DB, admin);

    const res = await SELF.fetch(`${ORIGIN}/admin/login?next=/admin/posts`, {
      headers: { cookie: authCookie(token) },
      redirect: 'manual',
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/posts');
  });
});

/* ----------------------------------------------------------- the exemption */

describe('the hole the page sits in is exactly one path wide', () => {
  /*
   * `admin-path.test.ts` pins `isAdminLoginPath` exhaustively as a function.
   * This is the other half — that the predicate is what the request actually
   * meets — and it is the one worth having here, because the whole reason this
   * page moved under `/admin` was to be a fixed, ordinary path rather than a
   * secret one. A fixed path is only safe if the gate around it is intact.
   */
  it.each([
    // The trailing slash first, because it is the one a reader doubts: Astro's
    // `trailingSlash` defaults to `ignore`, so it is fair to wonder whether the
    // request is normalised before the middleware sees it. It is not — the
    // middleware reads `/admin/login/` verbatim and the equality check says no.
    ['the trailing-slash form', '/admin/login/'],
    ['a path nested below it', '/admin/login/extra'],
    ['a deeper one still', '/admin/login/extra/deeper'],
    ['a name that merely starts the same', '/admin/logins'],
    ['and another', '/admin/login-notes'],
  ])('%s is still gated: %s', async (_label, path) => {
    // Every one of these passes `startsWith('/admin/login')`, which is the
    // implementation a hurried reader would reach for. None of them is exempt.
    expect(path.startsWith('/admin/login')).toBe(true);

    const res = await SELF.fetch(`${ORIGIN}${path}`, { redirect: 'manual' });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/auth/login?next=${encodeURIComponent(path)}`);
  });

  it('and the ordinary console pages are untouched by it', async () => {
    // The control. Without this the test above could pass against a gate that
    // had stopped working altogether, since a 302 to sign-in is also what a
    // broken exemption would produce for everything.
    const res = await SELF.fetch(`${ORIGIN}/admin/posts`, { redirect: 'manual' });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/auth/login?next=%2Fadmin%2Fposts');
  });
});

/* --------------------------------------------------------- the CPU budget */

describe('the CPU a derivation costs', () => {
  /*
   * A REGRESSION GUARD, NOT A PROOF THAT PRODUCTION FITS.
   *
   * Read that twice before trusting this test. It measures wall-clock time on
   * a developer machine or a CI runner, inside Miniflare, with no enforced CPU
   * limit of any kind. The production Worker runs with **10 ms of CPU per
   * request** on the free plan (there is no `limits` block in
   * `wrangler.jsonc`, so the plan default applies), and nothing here simulates
   * that ceiling or would fail if it were exceeded.
   *
   * What it does catch is the thing worth catching automatically: somebody
   * raising `DEFAULT_ITERATIONS` by an order of magnitude, or adding a second
   * derivation to the happy path, and not noticing. The ceiling is generous on
   * purpose — a tight one would flake on a shared runner and get deleted.
   *
   * Whether 100,000 iterations actually fits in 10 ms of production CPU is a
   * question this file cannot answer. It has to be measured against a deployed
   * Worker.
   */
  it('costs less than a quarter second more than a request that does not hash', async () => {
    const owner = await seedUser(env.DB, { role: 'admin' });
    const cred = await seedAdminCredential(env.DB, owner, { iterations: DEFAULT_ITERATIONS });

    // An unwarmed isolate charges the first derivation about ten times over,
    // which would make this measure the JIT rather than PBKDF2.
    await warmUp(cred.username, owner.id);

    // No username, so: no database read and no derivation. The floor.
    const t0 = Date.now();
    await post({ username: '', password: '' });
    const baselineMs = Date.now() - t0;

    // One full derivation at the production constant.
    const t1 = Date.now();
    await post({ username: cred.username, password: 'wrong, so exactly one derivation' });
    const hashingMs = Date.now() - t1;

    expect(hashingMs - baselineMs).toBeLessThan(250);
  });
});
