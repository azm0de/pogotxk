/**
 * The admin password reset, end to end.
 *
 * Four surfaces: `/admin/reset` (ask), `POST /api/auth/admin-reset` (issue and
 * mail), `/admin/reset/<token>` (redeem) and `POST
 * /api/auth/admin-reset/confirm` (apply). Driven through `SELF.fetch` rather
 * than by importing handlers, for the reason `admin-login.test.ts` gives: most
 * of what matters here is in the response envelope — the status, the
 * `Location`, whether two different situations are distinguishable from
 * outside — and a direct call would let a test pass while the route leaked
 * which addresses are registered.
 *
 * ---------------------------------------------------------------------------
 * HOW A TEST GETS A TOKEN, AND WHY IT IS DONE THE HARD WAY
 * ---------------------------------------------------------------------------
 *
 * It reads one out of the mail. There is no other supported way: the token
 * exists for the duration of one request, `admin_password_resets.id` holds only
 * its SHA-256, and nothing in the response mentions it. Fishing it out of a
 * stubbed Resend call is therefore not a convenience — it is the only path that
 * proves the link the route actually composes is the link that works.
 *
 * That means these tests **configure the mail sender**, which
 * `vitest.config.ts` deliberately forces empty and `test/00-safety.test.ts`
 * deliberately proves is empty. `withMail` below sets a fake key and a fake
 * From for the duration of one test and restores them in a `finally`, with an
 * `afterEach` behind it as a second belt. Nothing reaches the network at any
 * point: `mockResend` replaces `fetch` entirely and throws on any host but
 * Resend's, and `test/setup.ts` reinstalls the refusing `fetch` before the next
 * test regardless. The default state — no key — is asserted separately, and it
 * is the state in which the request endpoint writes nothing and sends nothing.
 *
 * `redirect: 'manual'` throughout. Following a 303 replaces everything worth
 * asserting with the next page's 200.
 */

import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESET_COOLDOWN_MS, RESET_TTL_MS } from '~/lib/auth/password-reset';
import { SESSION_COOKIE, sha256 } from '~/lib/auth/session';
import { authCookie, iso, jsonRequest, readCredential, seedAdminCredential, seedSession, seedUser } from '../helpers/factories';

const ORIGIN = 'https://pogotxk.test';
const REQUEST_API = `${ORIGIN}/api/auth/admin-reset`;
const CONFIRM_API = `${ORIGIN}/api/auth/admin-reset/confirm`;
const LOGIN_API = `${ORIGIN}/api/auth/admin-login`;
const FORM_TYPE = 'application/x-www-form-urlencoded';

/** A password comfortably over the sixteen-character floor. */
const NEW_PASSWORD = 'quartz-ripple-saddle-timber';

/* ------------------------------------------------------------- the harness */

/** A form-encoded POST carrying the `Origin` a browser would send. */
function formPost(url: string, fields: Record<string, string>): Request {
  return jsonRequest(url, {
    body: new URLSearchParams(fields).toString(),
    headers: { 'content-type': FORM_TYPE },
  });
}

function askFor(fields: Record<string, string>): Promise<Response> {
  return SELF.fetch(formPost(REQUEST_API, fields), { redirect: 'manual' });
}

function confirm(fields: Record<string, string>): Promise<Response> {
  return SELF.fetch(formPost(CONFIRM_API, fields), { redirect: 'manual' });
}

function signIn(fields: Record<string, string>): Promise<Response> {
  return SELF.fetch(formPost(LOGIN_API, fields), { redirect: 'manual' });
}

/** One message as Resend was asked to send it. */
interface SentMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  /** Present iff an HTML part was sent, which must never happen. */
  html?: unknown;
  authorization: string;
}

interface ResendMock {
  readonly mails: readonly SentMail[];
  readonly hosts: readonly string[];
  /** The reset link out of the only mail sent, or a failure naming why not. */
  link(): string;
  /** The token out of that link. */
  token(): string;
}

/**
 * Stands in for `api.resend.com`, and refuses everything else.
 *
 * Built on `vi.stubGlobal` like `mockDiscord`, and for the same reasons: it
 * records every outbound request rather than only the ones it has a route for,
 * so a test can prove a call did *not* happen; and `unstubGlobals` in
 * `vitest.config.ts` takes it away before the next test on its own.
 *
 * Any other host throws rather than being answered. That is the assertion this
 * mock exists to make as much as it is a convenience — if the endpoint constant
 * in `src/lib/notify/email.ts` ever drifts, every test in this file fails
 * loudly instead of quietly sending an admin's reset link somewhere new.
 */
function mockResend(): ResendMock {
  const mails: SentMail[] = [];
  const hosts: string[] = [];

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);
    hosts.push(url.hostname);

    if (url.hostname !== 'api.resend.com') {
      throw new Error(`mockResend: refused an outbound request to ${url.hostname}`);
    }

    const body = JSON.parse(new TextDecoder().decode(await request.arrayBuffer())) as SentMail;
    mails.push({ ...body, authorization: request.headers.get('authorization') ?? '' });

    return new Response(JSON.stringify({ id: 'test-message-id' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const mock: ResendMock = {
    mails,
    hosts,
    link() {
      if (mails.length !== 1) {
        throw new Error(`mockResend: expected exactly one mail, saw ${mails.length}`);
      }
      const found = /https?:\/\/\S+\/admin\/reset\/[0-9a-f]{64}/.exec(mails[0]!.text);
      if (!found) throw new Error(`mockResend: no reset link in:\n${mails[0]!.text}`);
      return found[0];
    },
    token() {
      return new URL(mock.link()).pathname.slice('/admin/reset/'.length);
    },
  };

  return mock;
}

/** The two bindings `vitest.config.ts` forces empty, and their real names. */
const bag = env as unknown as Record<string, string | undefined>;

function clearMailConfig(): void {
  bag.RESEND_API_KEY = '';
  bag.RESEND_FROM = '';
}

// A second belt under `withMail`'s `finally`. A test that threw between setting
// and restoring would otherwise leave the sender live for everything after it
// in this file, and "mail is off by default" would start passing for the wrong
// reason.
afterEach(clearMailConfig);

/**
 * Runs `fn` with the mail sender configured and Resend stubbed.
 *
 * The fake key is not a key shape anybody could mistake for real, and the From
 * is on a `.test` domain that cannot resolve. Restored in a `finally` whatever
 * happens inside.
 */
async function withMail<T>(fn: (mail: ResendMock) => Promise<T>): Promise<T> {
  const mail = mockResend();
  bag.RESEND_API_KEY = 'test-resend-key-not-a-real-one';
  bag.RESEND_FROM = 'admin@pogotxk.test';
  try {
    return await fn(mail);
  } finally {
    clearMailConfig();
  }
}

/* ----------------------------------------------------------- small readers */

async function resetRows(): Promise<
  { id: string; user_id: number; expires_at: string; used_at: string | null; created_at: string }[]
> {
  const { results } = await env.DB.prepare(
    'SELECT id, user_id, expires_at, used_at, created_at FROM admin_password_resets ORDER BY created_at, id',
  ).all<{
    id: string;
    user_id: number;
    expires_at: string;
    used_at: string | null;
    created_at: string;
  }>();
  return results;
}

async function sessionCount(userId?: number): Promise<number> {
  const row = userId
    ? await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1')
        .bind(userId)
        .first<{ n: number }>()
    : await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>();
  return row?.n ?? 0;
}

async function auditActions(): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT action FROM audit_log ORDER BY id').all<{
    action: string;
  }>();
  return results.map((r) => r.action);
}

function sessionTokenOf(res: Response): string | undefined {
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  const value = cookie?.slice(SESSION_COOKIE.length + 1).split(';')[0];
  return value ? value : undefined;
}

/** An admin with an address on file — the only kind a reset can reach. */
async function seedResettableAdmin(email = 'admin@example.test') {
  const user = await seedUser(env.DB, { role: 'admin', roleLocked: true });
  const cred = await seedAdminCredential(env.DB, user, { email });
  return { user, cred };
}

/* --------------------------------------------------------- the happy path */

describe('a reset, from asking to signing in with the new password', () => {
  it('mails a link, the link sets the password, and the old one stops working', async () => {
    const { user, cred } = await seedResettableAdmin();

    await withMail(async (mail) => {
      const asked = await askFor({ email: cred.email! });
      expect(asked.status).toBe(303);
      expect(asked.headers.get('location')).toBe('/admin/reset?sent=1');

      // One mail, to the address on file, from the configured sender, carrying
      // the key in the header — and nothing else was contacted.
      expect(mail.mails).toHaveLength(1);
      expect(mail.hosts).toEqual(['api.resend.com']);
      expect(mail.mails[0]!.to).toBe(cred.email);
      expect(mail.mails[0]!.from).toBe('admin@pogotxk.test');
      expect(mail.mails[0]!.authorization).toBe('Bearer test-resend-key-not-a-real-one');

      const token = mail.token();

      // The link is reachable signed out, and it is the form.
      const page = await SELF.fetch(`${ORIGIN}/admin/reset/${token}`, { redirect: 'manual' });
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('action="/api/auth/admin-reset/confirm"');
      expect(html).toContain(`value="${token}"`);
      // Named, so somebody with two admin accounts sets the right one.
      expect(html).toContain(cred.username);

      const done = await confirm({ token, password: NEW_PASSWORD, confirm: NEW_PASSWORD });
      expect(done.status).toBe(303);
      expect(done.headers.get('location')).toBe('/admin/login?reset=1');
      // A reset link is never itself a way in: it changes what the door
      // accepts, it does not open it.
      expect(done.headers.getSetCookie()).toHaveLength(0);

      return undefined;
    });

    // The new password works...
    const fresh = await signIn({ username: cred.username, password: NEW_PASSWORD });
    expect(fresh.status).toBe(303);
    expect(fresh.headers.get('location')).toBe('/');
    expect(sessionTokenOf(fresh)).toBeDefined();

    // ...and the old one does not, which is the half a "password changed"
    // message would otherwise be taken on trust.
    const stale = await signIn({ username: cred.username, password: cred.password });
    expect(stale.headers.get('location')).toBe('/admin/login?error=bad');
    expect(stale.headers.getSetCookie()).toHaveLength(0);

    expect((await readCredential(env.DB, user))?.user_id).toBe(user.id);
  });

  it('says so on the sign-in page afterwards', async () => {
    // The reset ends at a form rather than at a session, so without this the
    // person who just chose a password is looking at a login box with no
    // indication anything happened.
    const html = await (await SELF.fetch(`${ORIGIN}/admin/login?reset=1`)).text();
    expect(html).toContain('role="status"');
    expect(html).toContain('has been reset');
  });

  it('records the request and the completion, and neither carries the address', async () => {
    const { user, cred } = await seedResettableAdmin('audited@example.test');

    await withMail(async (mail) => {
      await askFor({ email: cred.email! });
      const token = mail.token();
      await confirm({ token, password: NEW_PASSWORD, confirm: NEW_PASSWORD });
      return token;
    });

    expect(await auditActions()).toEqual(['reset-request', 'reset-complete']);

    const { results } = await env.DB.prepare(
      'SELECT actor_id, action, entity, entity_id, diff_json FROM audit_log ORDER BY id',
    ).all<{
      actor_id: number | null;
      action: string;
      entity: string;
      entity_id: string;
      diff_json: string;
    }>();

    const [request, complete] = results;

    // Nobody had proved anything when the link was asked for.
    expect(request!.actor_id).toBeNull();
    expect(request!.entity).toBe('admin_credentials');
    expect(request!.entity_id).toBe(String(user.id));

    // By the completion they had.
    expect(complete!.actor_id).toBe(user.id);
    expect(JSON.parse(complete!.diff_json)).toMatchObject({ method: 'email' });

    // `audit_log` is readable by every ambassador. An admin's mailbox is not
    // theirs to read, and a live reset link is a credential.
    for (const row of results) {
      expect(row.diff_json).not.toContain('audited@example.test');
      expect(row.diff_json).not.toContain('example.test');
      expect(row.diff_json ?? '').not.toMatch(/[0-9a-f]{64}/);
    }
  });
});

/* -------------------------------------------------------- what is mailed */

describe('the message itself', () => {
  it('is plain text with no HTML part, and carries the link and the expiry', async () => {
    const { cred } = await seedResettableAdmin('plain@example.test');

    await withMail(async (mail) => {
      await askFor({ email: cred.email! });
      const sent = mail.mails[0]!;

      // No HTML means no remote images, which means no tracking pixel
      // reporting when an admin opened a password-reset mail and from where.
      expect(sent.html).toBeUndefined();
      expect(sent.subject).toContain('admin password');
      expect(sent.text).toContain(`${ORIGIN}/admin/reset/`);
      expect(sent.text).toContain('30 minutes');
      // The instruction for the far commoner case: somebody typed the wrong
      // address and this arrived at a stranger.
      expect(sent.text).toContain('did not ask for this');
      return undefined;
    });
  });

  it('does not name the account, because the mailbox may not be the admin’s alone', async () => {
    const { cred } = await seedResettableAdmin('shared@example.test');

    await withMail(async (mail) => {
      await askFor({ email: cred.email! });
      // The address is unique across admins, so the link already identifies
      // exactly one account. The page behind the token names it — to somebody
      // who has proved they hold the link.
      expect(mail.mails[0]!.text).not.toContain(cred.username);
      return undefined;
    });
  });
});

/* ----------------------------------------------------------- the token */

describe('the token', () => {
  it('is never stored in plaintext — the row holds its SHA-256', async () => {
    const { user, cred } = await seedResettableAdmin();

    const token = await withMail(async (mail) => {
      await askFor({ email: cred.email! });
      return mail.token();
    });

    const rows = await resetRows();
    expect(rows).toHaveLength(1);

    // The headline. A leaked dump of this table must not yield working links.
    expect(rows[0]!.id).not.toBe(token);
    expect(rows[0]!.id).toBe(await sha256(token));
    expect(rows[0]!.user_id).toBe(user.id);
    expect(rows[0]!.used_at).toBeNull();

    // And the whole table, not merely the id column: nothing anywhere holds it.
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(token);
  });

  it('is 32 random bytes, in the same shape a session cookie carries', async () => {
    const { cred } = await seedResettableAdmin();
    const token = await withMail(async (mail) => {
      await askFor({ email: cred.email! });
      return mail.token();
    });

    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('expires thirty minutes out', async () => {
    const { cred } = await seedResettableAdmin();
    await withMail(async (mail) => {
      await askFor({ email: cred.email! });
      return mail.token();
    });

    const [row] = await resetRows();
    const life = Date.parse(row!.expires_at) - Date.parse(row!.created_at);
    expect(life).toBe(RESET_TTL_MS);
  });
});

/* --------------------------------------------------------- the refusals */

describe('what a link will not do', () => {
  it('refuses an expired token, and says which', async () => {
    const { cred } = await seedResettableAdmin();
    const token = await withMail(async (mail) => {
      await askFor({ email: cred.email! });
      return mail.token();
    });

    // Back-dated rather than waited for. `expires_at` is the only thing that
    // decides this, so moving it is the whole of "half an hour passed".
    await env.DB.prepare('UPDATE admin_password_resets SET expires_at = ?1')
      .bind(iso(Date.now() - 1000))
      .run();

    const page = await SELF.fetch(`${ORIGIN}/admin/reset/${token}`, { redirect: 'manual' });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('has expired');
    expect(html).not.toContain('action="/api/auth/admin-reset/confirm"');

    const done = await confirm({ token, password: NEW_PASSWORD, confirm: NEW_PASSWORD });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe(`/admin/reset/${token}`);

    // Nothing moved: the password is unchanged and still signs in.
    const still = await signIn({ username: cred.username, password: cred.password });
    expect(still.headers.get('location')).toBe('/');
  });

  it('refuses a token that has already been used', async () => {
    const { cred } = await seedResettableAdmin();
    const token = await withMail(async (mail) => {
      await askFor({ email: cred.email! });
      return mail.token();
    });

    const first = await confirm({ token, password: NEW_PASSWORD, confirm: NEW_PASSWORD });
    expect(first.headers.get('location')).toBe('/admin/login?reset=1');

    const second = await confirm({
      token,
      password: 'a-completely-different-one-entirely',
      confirm: 'a-completely-different-one-entirely',
    });
    expect(second.status).toBe(303);
    expect(second.headers.get('location')).toBe(`/admin/reset/${token}`);

    // The second password was never set — the first one still works.
    expect((await signIn({ username: cred.username, password: NEW_PASSWORD })).headers.get('location')).toBe('/');

    const html = await (await SELF.fetch(`${ORIGIN}/admin/reset/${token}`)).text();
    expect(html).toContain('already been used');

    // The row is stamped rather than removed, which is what lets the page say
    // "already used" instead of the indistinguishable "not valid".
    const [row] = await resetRows();
    expect(row!.used_at).not.toBeNull();
  });

  it('kills an older link the moment a newer one is issued', async () => {
    const { cred } = await seedResettableAdmin();

    const first = await withMail(async (mail) => {
      await askFor({ email: cred.email! });
      return mail.token();
    });

    // Past the cooldown, so the second request is allowed to issue. Back-dated
    // rather than waited for, exactly as the expiry case above.
    await env.DB.prepare('UPDATE admin_password_resets SET created_at = ?1')
      .bind(iso(Date.now() - RESET_COOLDOWN_MS - 60_000))
      .run();

    const second = await withMail(async (mail) => {
      await askFor({ email: cred.email! });
      return mail.token();
    });

    expect(second).not.toBe(first);
    // One row, not two. Two live links for one account has no legitimate use
    // and one obvious abuse: a link kept warm by never being spent.
    expect(await resetRows()).toHaveLength(1);

    const stale = await confirm({ token: first, password: NEW_PASSWORD, confirm: NEW_PASSWORD });
    expect(stale.headers.get('location')).toBe(`/admin/reset/${first}`);
    expect(await (await SELF.fetch(`${ORIGIN}/admin/reset/${first}`)).text()).toContain(
      'not valid',
    );

    // The newer one still works.
    const done = await confirm({ token: second, password: NEW_PASSWORD, confirm: NEW_PASSWORD });
    expect(done.headers.get('location')).toBe('/admin/login?reset=1');
  });

  it.each([
    ['a token of the wrong shape', 'not-a-token'],
    ['an uppercase one', 'A'.repeat(64)],
    ['one character short', 'a'.repeat(63)],
    ['empty', ''],
  ])('refuses %s without touching the database', async (_label, token) => {
    const { cred } = await seedResettableAdmin();

    const res = await confirm({ token, password: NEW_PASSWORD, confirm: NEW_PASSWORD });
    expect(res.status).toBe(303);
    // Never interpolated into a `Location` — the same open-redirect class
    // `safeNext` exists for on the other routes.
    expect(res.headers.get('location')).toBe('/admin/reset?error=link');

    expect((await signIn({ username: cred.username, password: cred.password })).headers.get('location')).toBe('/');
  });

  it('refuses a well-formed token nobody ever issued', async () => {
    const token = 'b'.repeat(64);
    const res = await confirm({ token, password: NEW_PASSWORD, confirm: NEW_PASSWORD });
    expect(res.headers.get('location')).toBe(`/admin/reset/${token}`);
    expect(await (await SELF.fetch(`${ORIGIN}/admin/reset/${token}`)).text()).toContain('not valid');
  });
});

/* ------------------------------------------------- the password it accepts */

describe('the new password', () => {
  it('has the same sixteen-character floor the setter script enforces', async () => {
    const { cred } = await seedResettableAdmin();
    const token = await withMail(async (mail) => {
      await askFor({ email: cred.email! });
      return mail.token();
    });

    const short = 'fifteenchars123';
    expect(short).toHaveLength(15);

    const res = await confirm({ token, password: short, confirm: short });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/admin/reset/${token}?error=short`);

    // AND THE TOKEN IS NOT BURNED. Everything decidable from the submitted
    // bytes is checked before the link is spent, because a link destroyed by a
    // typo is another round trip through a mailbox behind a cooldown.
    const [row] = await resetRows();
    expect(row!.used_at).toBeNull();

    const retry = await confirm({ token, password: NEW_PASSWORD, confirm: NEW_PASSWORD });
    expect(retry.headers.get('location')).toBe('/admin/login?reset=1');
  });

  it('must be typed the same way twice, and a mismatch does not burn the link', async () => {
    const { cred } = await seedResettableAdmin();
    const token = await withMail(async (mail) => {
      await askFor({ email: cred.email! });
      return mail.token();
    });

    const res = await confirm({ token, password: NEW_PASSWORD, confirm: `${NEW_PASSWORD}x` });
    expect(res.headers.get('location')).toBe(`/admin/reset/${token}?error=mismatch`);
    expect((await resetRows())[0]!.used_at).toBeNull();
  });

  it('never appears in a Location, a cookie or an audit row', async () => {
    const { cred } = await seedResettableAdmin();
    const token = await withMail(async (mail) => {
      await askFor({ email: cred.email! });
      return mail.token();
    });

    const res = await confirm({ token, password: NEW_PASSWORD, confirm: NEW_PASSWORD });

    expect(res.headers.get('location')).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(res.headers.getSetCookie())).not.toContain(NEW_PASSWORD);
    expect(await res.text()).toBe('');

    const { results } = await env.DB.prepare('SELECT diff_json FROM audit_log').all<{
      diff_json: string;
    }>();
    for (const row of results) expect(row.diff_json ?? '').not.toContain(NEW_PASSWORD);
  });
});

/* ------------------------------------------------ what a reset tears down */

describe('what a completed reset destroys', () => {
  it('DELETES EVERY SESSION FOR THAT ADMIN', async () => {
    /*
     * The headline, and the reason this feature is worth its dependency on a
     * mailbox. A reset is what somebody does after a compromise; an attacker's
     * session outliving the password change would mean the reset accomplished
     * nothing at all — they would simply keep browsing.
     */
    const { user, cred } = await seedResettableAdmin();
    const bystander = await seedUser(env.DB, { role: 'ambassador' });

    const attacker = await seedSession(env.DB, user);
    await seedSession(env.DB, user);
    const untouched = await seedSession(env.DB, bystander);
    expect(await sessionCount(user.id)).toBe(2);

    // The attacker's session works before the reset.
    const before = await SELF.fetch(`${ORIGIN}/admin/posts`, {
      headers: { cookie: authCookie(attacker) },
      redirect: 'manual',
    });
    expect(before.status).toBe(200);

    const token = await withMail(async (mail) => {
      await askFor({ email: cred.email! });
      return mail.token();
    });
    await confirm({ token, password: NEW_PASSWORD, confirm: NEW_PASSWORD });

    expect(await sessionCount(user.id)).toBe(0);

    // And it does not work after it.
    const after = await SELF.fetch(`${ORIGIN}/admin/posts`, {
      headers: { cookie: authCookie(attacker) },
      redirect: 'manual',
    });
    expect(after.status).toBe(302);

    // Somebody else's session is none of this reset's business.
    expect(await sessionCount(bystander.id)).toBe(1);
    const other = await SELF.fetch(`${ORIGIN}/admin/posts`, {
      headers: { cookie: authCookie(untouched) },
      redirect: 'manual',
    });
    expect(other.status).toBe(200);
  });

  it('CLEARS THE LOCKOUT, because a mailbox is better evidence than the counter', async () => {
    /*
     * An admin who was locked out and reset their password must be able to use
     * it immediately. Leaving the lock in force would mean the recovery path
     * ends in "now wait an hour" — and the lock exists to stop guessing, which
     * is not what happened.
     */
    const user = await seedUser(env.DB, { role: 'admin' });
    const cred = await seedAdminCredential(env.DB, user, {
      email: 'locked@example.test',
      failedAttempts: 5,
      lockedUntil: iso(Date.now() + 45 * 60_000),
      lastFailedAt: iso(),
    });

    // Locked before: even the right password is refused.
    const shut = await signIn({ username: cred.username, password: cred.password });
    expect(shut.headers.get('location')).toBe('/admin/login?error=locked');

    const token = await withMail(async (mail) => {
      await askFor({ email: cred.email! });
      return mail.token();
    });
    await confirm({ token, password: NEW_PASSWORD, confirm: NEW_PASSWORD });

    const row = await readCredential(env.DB, user);
    expect(row?.failed_attempts).toBe(0);
    expect(row?.locked_until).toBeNull();
    expect(row?.last_failed_at).toBeNull();

    // Open again, straight away.
    const open = await signIn({ username: cred.username, password: NEW_PASSWORD });
    expect(open.status).toBe(303);
    expect(open.headers.get('location')).toBe('/');
  });

  it('is still possible to ask for a link while locked out', async () => {
    // The case this whole feature is for. If the lockout suppressed reset
    // requests, an attacker could lock an admin out and then keep them out by
    // holding the lock, which is the denial of service the hour cap exists to
    // prevent.
    const user = await seedUser(env.DB, { role: 'admin' });
    const cred = await seedAdminCredential(env.DB, user, {
      email: 'stilllocked@example.test',
      failedAttempts: 8,
      lockedUntil: iso(Date.now() + 60 * 60_000),
    });

    await withMail(async (mail) => {
      await askFor({ email: cred.email! });
      expect(mail.mails).toHaveLength(1);
      return undefined;
    });
  });

  it('will not mail a banned account', async () => {
    // A banned account cannot sign in through any door, so a link to it is a
    // key to a welded door. Filtered inside the lookup, so it is simply not
    // found — the same answer every other refusal gives.
    const user = await seedUser(env.DB, { role: 'admin', isBanned: true });
    const cred = await seedAdminCredential(env.DB, user, { email: 'banned@example.test' });

    await withMail(async (mail) => {
      const res = await askFor({ email: cred.email! });
      expect(res.headers.get('location')).toBe('/admin/reset?sent=1');
      expect(mail.mails).toHaveLength(0);
      return undefined;
    });

    expect(await resetRows()).toHaveLength(0);
    expect(await auditActions()).toEqual([]);
  });
});

/* -------------------------------------------------------- no enumeration */

describe('what the request endpoint refuses to say', () => {
  it('answers an unknown address byte-for-byte as it answers a known one', async () => {
    /*
     * The assertion that keeps address enumeration off the table. If these two
     * ever diverge — a different status, a stray header, a different body — an
     * attacker can ask "is this address an admin's" for free, and the reset
     * mail becomes a way to find out who the admins are and where they read
     * their mail.
     */
    const { cred } = await seedResettableAdmin('known@example.test');

    await withMail(async () => {
      const known = await askFor({ email: cred.email! });
      const unknown = await askFor({ email: 'nobody-at-all@example.test' });

      expect(unknown.status).toBe(known.status);
      expect(unknown.headers.get('location')).toBe(known.headers.get('location'));
      expect(unknown.headers.get('cache-control')).toBe(known.headers.get('cache-control'));
      expect(unknown.headers.get('referrer-policy')).toBe(known.headers.get('referrer-policy'));
      expect([...unknown.headers.keys()].sort()).toEqual([...known.headers.keys()].sort());
      expect(await unknown.text()).toBe(await known.text());
      expect(unknown.headers.getSetCookie()).toHaveLength(0);
      return undefined;
    });
  });

  it('answers an address with no admin behind it the same way again', async () => {
    // A credential with no address on file. Production is in exactly this
    // state for both accounts until somebody sets one, so it is the default
    // case rather than an edge one.
    const user = await seedUser(env.DB, { role: 'admin' });
    await seedAdminCredential(env.DB, user);

    await withMail(async (mail) => {
      const res = await askFor({ email: 'someone@example.test' });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/admin/reset?sent=1');
      expect(mail.mails).toHaveLength(0);
      return undefined;
    });

    expect(await resetRows()).toHaveLength(0);
  });

  it('writes no audit row for an address it does not know', async () => {
    // The same argument `admin-login.ts` makes for not logging a failure
    // against an unknown username: a row nobody's counter bounds is a row
    // anyone can append at will, and `audit_log` is readable by every
    // ambassador.
    await withMail(async () => {
      for (let i = 0; i < 5; i++) await askFor({ email: `stranger${i}@example.test` });
      return undefined;
    });

    expect(await auditActions()).toEqual([]);
  });

  it('says so plainly when the submitted value is not an address at all', async () => {
    // Not a leak: decidable from the characters with no database involved, so
    // anybody can compute it themselves. The alternative is telling somebody
    // who fat-fingered their own address that a mail is on the way.
    for (const value of ['notanemail', '@example.test', 'two words@example.test', '']) {
      const res = await askFor({ email: value });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/admin/reset?error=bad');
    }
    expect(await resetRows()).toHaveLength(0);
  });

  it('folds case and trims, so a capitalised address still finds the account', async () => {
    await seedResettableAdmin('mixed@example.test');

    await withMail(async (mail) => {
      await askFor({ email: '  MiXeD@Example.TEST  ' });
      expect(mail.mails).toHaveLength(1);
      expect(mail.mails[0]!.to).toBe('mixed@example.test');
      return undefined;
    });
  });
});

/* ----------------------------------------------------------- the rate limit */

describe('the per-account cooldown', () => {
  it('will not send a second link while the first is still live', async () => {
    /*
     * The rate limit, and per-account is the right axis: the harm here is not
     * guessing — the token is 256 bits — it is mailing a real person over and
     * over, which anyone who knows an admin's address could otherwise do for
     * free. Binding it to the account holds however the requests arrive, where
     * an IP limit would have held against none of them.
     */
    const { cred } = await seedResettableAdmin();

    await withMail(async (mail) => {
      await askFor({ email: cred.email! });
      expect(mail.mails).toHaveLength(1);

      for (let i = 0; i < 4; i++) {
        const again = await askFor({ email: cred.email! });
        // Identical answer, so the cooldown is not itself an oracle.
        expect(again.headers.get('location')).toBe('/admin/reset?sent=1');
      }

      expect(mail.mails, 'the cooldown let a second mail through').toHaveLength(1);
      return undefined;
    });

    // And no extra rows were written either.
    expect(await resetRows()).toHaveLength(1);
  });

  it('lets the next one through once the cooldown has passed', async () => {
    const { cred } = await seedResettableAdmin();

    await withMail(async (mail) => {
      await askFor({ email: cred.email! });

      await env.DB.prepare('UPDATE admin_password_resets SET created_at = ?1')
        .bind(iso(Date.now() - RESET_COOLDOWN_MS - 1000))
        .run();

      await askFor({ email: cred.email! });
      expect(mail.mails).toHaveLength(2);
      return undefined;
    });
  });

  it('does not suppress a link when the outstanding one has already been used', async () => {
    // A spent token must not stand between an admin and a second attempt —
    // that is the case where somebody reset, mistyped the new password into
    // their manager, and needs to go round again.
    const { cred } = await seedResettableAdmin();

    await withMail(async (mail) => {
      await askFor({ email: cred.email! });
      const token = mail.token();
      await confirm({ token, password: NEW_PASSWORD, confirm: NEW_PASSWORD });

      await askFor({ email: cred.email! });
      expect(mail.mails).toHaveLength(2);
      return undefined;
    });
  });

  it('does not suppress a link when the outstanding one has expired', async () => {
    const { cred } = await seedResettableAdmin();

    await withMail(async (mail) => {
      await askFor({ email: cred.email! });

      await env.DB.prepare('UPDATE admin_password_resets SET expires_at = ?1')
        .bind(iso(Date.now() - 1000))
        .run();

      await askFor({ email: cred.email! });
      expect(mail.mails).toHaveLength(2);
      return undefined;
    });
  });
});

/* ------------------------------------------------ the sender, when it is off */

describe('with no mail configured, which is how this ships', () => {
  it('writes nothing and sends nothing, and still answers identically', async () => {
    /*
     * The default state of this repository and the state `vitest.config.ts`
     * forces. The endpoint has to be inert here rather than merely quiet: a
     * token minted for a message that can never arrive is a row that burns the
     * cooldown for an admin who did nothing wrong.
     *
     * No `withMail`, and no stub either — `test/setup.ts` installs a `fetch`
     * that throws on any outbound request, so if this route tried to send,
     * the attempt would be an error rather than a silence.
     */
    const { cred } = await seedResettableAdmin();

    const res = await askFor({ email: cred.email! });

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/reset?sent=1');
    expect(await resetRows()).toHaveLength(0);
    expect(await auditActions()).toEqual([]);
  });

  it('is disabled by either half being missing, not only the key', async () => {
    const { cred } = await seedResettableAdmin();

    bag.RESEND_API_KEY = 'test-resend-key-not-a-real-one';
    bag.RESEND_FROM = '';
    try {
      await askFor({ email: cred.email! });
      expect(await resetRows()).toHaveLength(0);
    } finally {
      clearMailConfig();
    }
  });
});

/* ------------------------------------------------------- the request shape */

describe('what shapes of request the routes accept', () => {
  it.each([
    ['the request endpoint', REQUEST_API],
    ['the confirm endpoint', CONFIRM_API],
  ])('%s is refused by Astro when the POST carries no Origin', async (_label, url) => {
    /*
     * Built with a bare `Request` on purpose: `jsonRequest` always sets
     * `origin`, so it cannot express this. The refusal comes from Astro's own
     * origin check, before the route runs at all, and that is precisely the
     * CSRF protection the form encoding buys — see the 415 case below.
     */
    const res = await SELF.fetch(
      new Request(url, {
        method: 'POST',
        headers: { 'content-type': FORM_TYPE },
        body: new URLSearchParams({ email: 'a@example.test' }).toString(),
      }),
      { redirect: 'manual' },
    );

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('forbidden');
  });

  it.each([
    ['the request endpoint', REQUEST_API],
    ['the confirm endpoint', CONFIRM_API],
  ])('%s refuses a JSON body with 415', async (_label, url) => {
    /*
     * The reason both routes are narrow. Astro's origin check is content-type
     * dependent: it polices form-like types and skips `application/json`
     * entirely. Accepting JSON would therefore let a cross-site page drive
     * either of these on a visiting admin's behalf, with no CSRF check
     * anywhere in the path.
     */
    const res = await SELF.fetch(
      jsonRequest(url, { json: { email: 'a@example.test', token: 'x', password: 'y' } }),
      { redirect: 'manual' },
    );

    expect(res.status).toBe(415);
    expect(await resetRows()).toHaveLength(0);
  });

  it.each([
    ['the request endpoint', REQUEST_API],
    ['the confirm endpoint', CONFIRM_API],
  ])('%s refuses multipart and text/plain too', async (_label, url) => {
    for (const contentType of ['multipart/form-data; boundary=x', 'text/plain']) {
      const res = await SELF.fetch(
        jsonRequest(url, { body: 'email=a%40example.test', headers: { 'content-type': contentType } }),
        { redirect: 'manual' },
      );
      expect(res.status).toBe(415);
    }
  });
});

/* ---------------------------------------------------------------- the pages */

describe('GET /admin/reset', () => {
  it('renders to a signed-out visitor, carries noindex, and posts to the API', async () => {
    /*
     * THE POINT OF THE EXEMPTION. This page is under `/admin`, so the
     * middleware's role gate covers it by default and would answer a
     * signed-out visitor with a 302 to `/auth/login` — the Discord door their
     * account does not exist behind, which is the exact predicament they are
     * here to get out of.
     */
    const res = await SELF.fetch(`${ORIGIN}/admin/reset`, { redirect: 'manual' });

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();

    const html = await res.text();
    expect(html).toContain('name="robots"');
    expect(html).toContain('noindex');
    expect(html).toContain('method="post"');
    expect(html).toContain('action="/api/auth/admin-reset"');
    expect(html).toContain('name="email"');
  });

  it('carries no script of its own', async () => {
    // It is part of the break-glass door, reached exactly when other things
    // are broken, so it must not need a bundle to have loaded and run.
    const html = await (await SELF.fetch(`${ORIGIN}/admin/reset`)).text();
    expect(html.slice(html.indexOf('<main'))).not.toContain('<script');
  });

  it('says the one thing it is allowed to say, after a request', async () => {
    const html = await (await SELF.fetch(`${ORIGIN}/admin/reset?sent=1`)).text();
    expect(html).toContain('role="status"');
    expect(html).toContain('If that address is on file');
    // Never "check your inbox", which implies one was sent.
    expect(html).not.toContain('no account');
  });

  it('ignores an error value it did not emit', async () => {
    const html = await (
      await SELF.fetch(`${ORIGIN}/admin/reset?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E`)
    ).text();

    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('alert(1)');
  });

  it('is linked from the sign-in form, or nobody would ever find it', async () => {
    // The page is unlinked from everywhere else and the path is not a secret;
    // this link is the only thing that makes the recovery path discoverable to
    // an admin who did not already know it exists.
    const html = await (await SELF.fetch(`${ORIGIN}/admin/login`)).text();
    expect(html).toContain('href="/admin/reset"');
  });
});

describe('GET /admin/reset/<token>', () => {
  it('sends Referrer-Policy: no-referrer, because the token is in the URL', async () => {
    /*
     * The one header on this page that is load-bearing. A `Referer` goes out
     * with any outbound request the page makes and with any link the person
     * clicks, so without this a single click would hand a live reset link to
     * whoever is on the other end.
     */
    const { cred } = await seedResettableAdmin();
    const token = await withMail(async (mail) => {
      await askFor({ email: cred.email! });
      return mail.token();
    });

    const res = await SELF.fetch(`${ORIGIN}/admin/reset/${token}`, { redirect: 'manual' });

    expect(res.status).toBe(200);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');

    const html = await res.text();
    expect(html).toContain('noindex');
    // Nothing to leak to even if the header were ignored.
    expect(html.slice(html.indexOf('<main'))).not.toContain('<script');
  });

  it('carries the header on a refusal too, not only on the form', async () => {
    // The refusing paths have the token in the URL just as much as the working
    // one does, and they are the ones a person is most likely to wander off
    // from.
    const res = await SELF.fetch(`${ORIGIN}/admin/reset/${'c'.repeat(64)}`, {
      redirect: 'manual',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('and so does every redirect in the flow', async () => {
    const asked = await askFor({ email: 'someone@example.test' });
    expect(asked.headers.get('referrer-policy')).toBe('no-referrer');

    const confirmed = await confirm({ token: 'nope', password: 'x', confirm: 'x' });
    expect(confirmed.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

/* ------------------------------------------- before the migration has run */

/**
 * Hides everything `0005_admin_password_reset.sql` added, runs `fn`, and puts
 * it back.
 *
 * **Renamed rather than dropped, and that is the whole trick.** `test/setup.ts`
 * applies the migrations once in `beforeAll` and only empties tables between
 * tests, so a `DROP` here would take the schema out from under every test after
 * this one in the file. SQLite's `RENAME COLUMN` carries the CHECK constraint
 * and the partial index along with it, so renaming back is exact — there is no
 * second copy of the migration's DDL in this file to drift from the real one.
 *
 * The `finally` is not optional. If this failed to restore, the failure would
 * land on some unrelated test further down and look like that test's bug.
 */
async function withoutMigration0005(fn: () => Promise<void>): Promise<void> {
  await env.DB.exec('ALTER TABLE admin_password_resets RENAME TO admin_password_resets_hidden');
  await env.DB.exec('ALTER TABLE admin_credentials RENAME COLUMN email TO email_hidden');
  try {
    await fn();
  } finally {
    await env.DB.exec('ALTER TABLE admin_credentials RENAME COLUMN email_hidden TO email');
    await env.DB.exec('ALTER TABLE admin_password_resets_hidden RENAME TO admin_password_resets');
  }
}

describe('with the migration not yet applied, which happens on every deploy', () => {
  /*
   * WHY THIS WINDOW EXISTS AND IS NOT A MISCONFIGURATION.
   *
   * Every push to this repository deploys to production through Workers Builds
   * — including a push to a branch (vault/Deploying.md). Migrations are applied
   * by hand afterwards. So there is always a stretch, measured in minutes or in
   * however long somebody takes to run one command, where this code is live and
   * `admin_password_resets` does not exist and `admin_credentials.email` does
   * not exist. D1 answers both with a thrown error rather than an empty result.
   *
   * What must survive that stretch is, in order of how much it would matter:
   * the existing sign-in, which is the only way into the console and has
   * nothing to do with this feature; and then the new routes, which must refuse
   * rather than 500 — a 500 on one input and not another is an oracle, and a
   * stack trace on a recovery page is how somebody concludes the site is
   * broken.
   */
  it('THE EXISTING SIGN-IN IS COMPLETELY UNAFFECTED', async () => {
    /*
     * The assertion that matters most in this file, and the cheapest to get
     * wrong: `admin-login.ts` names its columns explicitly and none of them is
     * new, so it never touches either object `0005` adds. A `SELECT c.*` there
     * would have been fine too — but a later change that started reading
     * `email` on the login path would break the door for the whole window, and
     * this is what would notice.
     */
    const { cred } = await seedResettableAdmin();

    await withoutMigration0005(async () => {
      const res = await signIn({ username: cred.username, password: cred.password });

      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/');
      expect(sessionTokenOf(res)).toBeDefined();

      // And the refusals still refuse, rather than erroring their way to the
      // same-looking place.
      const wrong = await signIn({ username: cred.username, password: 'not it at all' });
      expect(wrong.headers.get('location')).toBe('/admin/login?error=bad');
    });
  });

  it('the request endpoint answers exactly as it does for an unknown address', async () => {
    const { cred } = await seedResettableAdmin();

    await withoutMigration0005(async () => {
      await withMail(async (mail) => {
        const res = await askFor({ email: cred.email ?? 'someone@example.test' });

        expect(res.status).toBe(303);
        expect(res.headers.get('location')).toBe('/admin/reset?sent=1');
        expect(mail.mails).toHaveLength(0);
        return undefined;
      });
    });
  });

  it('the redemption page renders "not valid" rather than a stack trace', async () => {
    await withoutMigration0005(async () => {
      const res = await SELF.fetch(`${ORIGIN}/admin/reset/${'d'.repeat(64)}`, {
        redirect: 'manual',
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toContain('not valid');
    });
  });

  it('the confirm endpoint refuses instead of erroring', async () => {
    const token = 'e'.repeat(64);

    await withoutMigration0005(async () => {
      const res = await confirm({ token, password: NEW_PASSWORD, confirm: NEW_PASSWORD });

      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`/admin/reset/${token}`);
    });
  });

  it('the request form still renders', async () => {
    await withoutMigration0005(async () => {
      const res = await SELF.fetch(`${ORIGIN}/admin/reset`, { redirect: 'manual' });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('action="/api/auth/admin-reset"');
    });
  });

  it('account deletion still works, which a batched cleanup would have broken', async () => {
    /*
     * `deleteAccount` clears outstanding reset links, and it does it *outside*
     * the batch that does everything else. Inside, one missing table would have
     * failed the whole statement list — turning a schema that is merely behind
     * into an account deletion that cannot be honoured, on a route a person
     * reached by asking to be forgotten.
     */
    const { deleteAccount } = await import('~/lib/auth/deletion');
    const { cred, user } = await seedResettableAdmin();
    await seedSession(env.DB, user);

    await withoutMigration0005(async () => {
      await expect(deleteAccount(env.DB, user.id)).resolves.toBeUndefined();
    });

    expect(await readCredential(env.DB, user)).toBeNull();
    expect(await sessionCount(user.id)).toBe(0);
    // And the old password is no way back in, which is the point of dropping
    // the credential at all.
    const res = await signIn({ username: cred.username, password: cred.password });
    expect(res.headers.get('location')).toBe('/admin/login?error=bad');
  });

  it('and everything works again once it is applied', async () => {
    // The control. Without it the block above could pass against a schema that
    // `withoutMigration0005` never restored, and the failures would surface
    // somewhere else entirely.
    const { cred } = await seedResettableAdmin();

    await withoutMigration0005(async () => {
      await askFor({ email: cred.email! });
    });

    await withMail(async (mail) => {
      await askFor({ email: cred.email! });
      expect(mail.mails).toHaveLength(1);
      const token = mail.token();
      const done = await confirm({ token, password: NEW_PASSWORD, confirm: NEW_PASSWORD });
      expect(done.headers.get('location')).toBe('/admin/login?reset=1');
      return undefined;
    });
  });
});

/* ------------------------------------------------------------ the exemption */

describe('the hole these pages sit in is exactly two shapes wide', () => {
  /*
   * `admin-path.test.ts` pins `isAdminResetPath` exhaustively as a function.
   * This is the other half — that the predicate is what the request actually
   * meets — and it is the one worth having here, because the redemption page's
   * exemption is a *pattern* rather than an equality check and a pattern is the
   * kind of thing that quietly widens.
   */
  it.each([
    // The trailing slash first, because it is the one a reader doubts: Astro's
    // `trailingSlash` defaults to `ignore`, so it is fair to wonder whether the
    // request is normalised before the middleware sees it. It is not.
    ['the trailing-slash form', '/admin/reset/'],
    ['a name that merely starts the same', '/admin/resets'],
    ['and another', '/admin/reset-notes'],
    ['a path below a well-formed token', `/admin/reset/${'a'.repeat(64)}/extra`],
    ['an uppercase token', `/admin/reset/${'A'.repeat(64)}`],
    ['a token of the wrong length', `/admin/reset/${'a'.repeat(63)}`],
    ['something that is not a token at all', '/admin/reset/abc'],
  ])('%s is still gated: %s', async (_label, path) => {
    // Every one of these passes `startsWith('/admin/reset')`, which is the
    // implementation a hurried reader would reach for. None of them is exempt.
    expect(path.startsWith('/admin/reset')).toBe(true);

    const res = await SELF.fetch(`${ORIGIN}${path}`, { redirect: 'manual' });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/auth/login?next=${encodeURIComponent(path)}`);
  });

  it('and the ordinary console pages are untouched by it', async () => {
    // The control. Without this the tests above could pass against a gate that
    // had stopped working altogether, since a 302 to sign-in is also what a
    // broken exemption would produce for everything.
    const res = await SELF.fetch(`${ORIGIN}/admin/posts`, { redirect: 'manual' });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/auth/login?next=%2Fadmin%2Fposts');
  });

  it('and the login form is still exempt on its own terms', async () => {
    // Two exemptions now exist. This is the assertion that would catch one of
    // them being written in a way that swallowed the other.
    const res = await SELF.fetch(`${ORIGIN}/admin/login`, { redirect: 'manual' });
    expect(res.status).toBe(200);
  });
});
