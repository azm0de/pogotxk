/**
 * `/auth/callback` — the hop every member's sign-in lands on, and the one route
 * in the flow that had no coverage at all.
 *
 * Driven through `SELF.fetch` rather than by importing the handler, because
 * half of what is being asserted lives in the response envelope: two
 * `Set-Cookie` headers on the happy path, a cleared state cookie on every
 * failure, and a `Location` that a browser will resolve. `redirect: 'manual'`
 * throughout — following the 302 would replace all of that with the error
 * page's 200.
 *
 * Note what `fail()` does before reading the assertions: it answers **302** and
 * puts the HTTP status it was given into the error page's query string. So
 * "banned is 403" reads as `status=403` on the Location, not as a 403 response.
 * That is deliberate — this route is only ever reached by a top-level
 * navigation, where a bare 403 body is a dead end — and the tests assert the
 * shape that actually ships.
 */

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getSessionUser, OAUTH_STATE_COOKIE, SESSION_COOKIE } from '~/lib/auth/session';
import { mockDiscord } from '../helpers/discord-mock';
import { seedUser } from '../helpers/factories';

/** The guild the test bindings configure. See vitest.config.ts. */
const GUILD = 'test-guild-id';
/** The id `mockDiscord().userOk()` answers with. */
const DISCORD_ID = '100000000000000001';

const ORIGIN = 'https://pogotxk.test';

interface StatePayload {
  state?: string;
  verifier?: string;
  next?: string;
  consent?: boolean;
}

/** The same base64url encoding /auth/login uses to mint the cookie. */
function encodeState(payload: StatePayload): string {
  return btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const VALID_STATE = 'state-abc';
const VALID: StatePayload = { state: VALID_STATE, verifier: 'verifier-xyz', next: '/' };

interface CallbackOptions {
  /** A ready-made cookie value — for the payloads `encodeState` cannot express. */
  rawCookie?: string;
  state?: StatePayload;
}

async function callback(query: string, opts: CallbackOptions = {}): Promise<Response> {
  const headers = new Headers();
  const value = opts.rawCookie ?? (opts.state ? encodeState(opts.state) : undefined);
  if (value !== undefined) headers.set('cookie', `${OAUTH_STATE_COOKIE}=${value}`);

  return SELF.fetch(`${ORIGIN}/auth/callback${query}`, { headers, redirect: 'manual' });
}

/** The `reason` the error page was handed, decoded. */
function reasonOf(res: Response): string | null {
  const location = res.headers.get('location');
  if (!location) return null;
  return new URL(location, ORIGIN).searchParams.get('reason');
}

function errorStatusOf(res: Response): string | null {
  const location = res.headers.get('location');
  if (!location) return null;
  return new URL(location, ORIGIN).searchParams.get('status');
}

function sessionTokenOf(res: Response): string | undefined {
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  const value = cookie?.slice(SESSION_COOKIE.length + 1).split(';')[0];
  return value ? value : undefined;
}

function clearsStateCookie(res: Response): boolean {
  return res.headers
    .getSetCookie()
    .some((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=;`) && c.includes('Max-Age=0'));
}

async function sessionCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>();
  return row?.n ?? 0;
}

/** The whole sign-in chain answering happily. */
function discordSaysYes(roles: string[] = []) {
  return mockDiscord().tokenOk().userOk().memberOk(GUILD, roles);
}

describe('before anything else', () => {
  it('refuses to start when Discord is not configured', async () => {
    const discord = mockDiscord();
    const bag = env as unknown as Record<string, string>;
    const saved = bag.DISCORD_CLIENT_ID;
    bag.DISCORD_CLIENT_ID = '';

    try {
      // A complete, valid-looking callback: the point is that it gets nowhere
      // near Discord, not that it fails some later check.
      const res = await callback(`?code=c&state=${VALID_STATE}`, { state: VALID });

      expect(res.status).toBe(302);
      expect(reasonOf(res)).toBe('Discord sign-in is not configured');
      expect(errorStatusOf(res)).toBe('503');
      discord.assertNotCalled();
    } finally {
      bag.DISCORD_CLIENT_ID = saved!;
    }
  });
});

describe('errors Discord reports back', () => {
  it('does not retry access_denied', async () => {
    // The user pressed Cancel. Retrying would put the approval screen back in
    // front of somebody who just declined it, so `access_denied` is deliberately
    // absent from NEEDS_INTERACTION and must stay that way.
    const res = await callback('?error=access_denied', { state: VALID });

    expect(res.status).toBe(302);
    expect(reasonOf(res)).toBe('access_denied');
    expect(res.headers.get('location')).not.toContain('/auth/login');
    expect(res.headers.get('location')).not.toContain('/auth/device');
  });

  it('sends login_required to the device page', async () => {
    // No Discord session in this browser, so the next screen would be the
    // password form — and members never type Discord credentials into our flow.
    const res = await callback('?error=login_required', { state: VALID });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/auth/device');
  });

  it('carries a destination across the device hand-off', async () => {
    const res = await callback('?error=login_required', {
      state: { ...VALID, next: '/go' },
    });

    expect(res.headers.get('location')).toBe('/auth/device?next=%2Fgo');
  });

  it.each(['consent_required', 'interaction_required', 'account_selection_required'])(
    'retries %s once with no prompt at all',
    async (oauthError) => {
      // These render approval or picker screens on a session that already
      // exists, which is wanted. `retry=1` makes /auth/login send no `prompt`.
      const res = await callback(`?error=${oauthError}`, { state: VALID });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/auth/login?retry=1');
    },
  );

  it('re-validates the stored next before making it a retry parameter', async () => {
    // The cookie is not signed, so a `next` arriving from it is no more trusted
    // here than one off a query string.
    const res = await callback('?error=login_required', {
      state: { ...VALID, next: '//evil.example/phish' },
    });

    expect(res.headers.get('location')).toBe('/auth/device');
  });

  it('fails plainly when there is no stored state to recover from', async () => {
    // Nothing to read the retry flag or the destination out of, so there is no
    // safe way to bounce: the only honest answer is the error page.
    const res = await callback('?error=login_required');

    expect(reasonOf(res)).toBe('login_required');
    expect(res.headers.get('location')).not.toContain('/auth/device');
  });

  it('does not loop when this attempt was already the retry', async () => {
    // `stored.consent` is the loop guard. Without it a browser Discord will
    // never satisfy bounces between /auth/login and here forever.
    const res = await callback('?error=consent_required', {
      state: { ...VALID, consent: true },
    });

    expect(reasonOf(res)).toBe('consent_required');
    expect(res.headers.get('location')).not.toContain('/auth/login');
  });

  it('fails plainly for an error outside the needs-interaction family', async () => {
    const res = await callback('?error=server_error', { state: VALID });

    expect(reasonOf(res)).toBe('server_error');
    expect(errorStatusOf(res)).toBe('400');
  });

  it('clears the state cookie on the way to the error page', async () => {
    const res = await callback('?error=access_denied', { state: VALID });

    expect(clearsStateCookie(res)).toBe(true);
  });
});

describe('the CSRF check', () => {
  it('rejects a callback with no code', async () => {
    const res = await callback(`?state=${VALID_STATE}`, { state: VALID });

    expect(reasonOf(res)).toBe('Missing code or state');
  });

  it('rejects a callback with no state', async () => {
    const res = await callback('?code=c', { state: VALID });

    expect(reasonOf(res)).toBe('Missing code or state');
  });

  it('rejects an empty code', async () => {
    const res = await callback(`?code=&state=${VALID_STATE}`, { state: VALID });

    expect(reasonOf(res)).toBe('Missing code or state');
  });

  it('rejects a callback with no state cookie', async () => {
    const res = await callback(`?code=c&state=${VALID_STATE}`);

    expect(reasonOf(res)).toBe('Sign-in session expired, please try again');
  });

  it('rejects a state that does not match the cookie', async () => {
    // The whole point of the pair. An attacker can put anything in the query
    // string; they cannot read or write the HttpOnly cookie it is compared to.
    const discord = mockDiscord();
    const res = await callback('?code=c&state=not-the-stored-one', { state: VALID });

    expect(reasonOf(res)).toBe('State mismatch');
    // And it is refused before the code is ever spent.
    discord.assertNotCalled();
  });

  it('rejects an empty returned state even against an empty stored one', async () => {
    // `decodeState` rejects a payload with a falsy `state`, so this cannot
    // become a pair of empty strings that compare equal.
    const res = await callback('?code=c&state=', { rawCookie: encodeState({ ...VALID, state: '' }) });

    expect(reasonOf(res)).toBe('Missing code or state');
  });

  it('spends no Discord call and mints no session on any of these', async () => {
    const discord = mockDiscord();

    await callback('?code=c&state=wrong', { state: VALID });
    await callback(`?code=c&state=${VALID_STATE}`);
    await callback('?code=c', { state: VALID });

    discord.assertNotCalled();
    expect(await sessionCount()).toBe(0);
  });
});

describe('when Discord answers badly', () => {
  it('surfaces a failed token exchange', async () => {
    mockDiscord().tokenFails(400, { error: 'invalid_grant' });

    const res = await callback(`?code=c&state=${VALID_STATE}`, { state: VALID });

    expect(reasonOf(res)).toBe('Discord token exchange failed (400)');
    expect(errorStatusOf(res)).toBe('500');
    expect(await sessionCount()).toBe(0);
  });

  it('surfaces a token response with no access_token', async () => {
    // 200 and well-formed JSON, and still unusable — the one failure shape a
    // status-code check alone would wave through.
    mockDiscord().tokenFails(200, { token_type: 'Bearer' });

    const res = await callback(`?code=c&state=${VALID_STATE}`, { state: VALID });

    expect(reasonOf(res)).toBe('Discord token response had no access_token');
  });

  it('surfaces a failed profile fetch', async () => {
    mockDiscord().tokenOk().userFails(401);

    const res = await callback(`?code=c&state=${VALID_STATE}`, { state: VALID });

    expect(reasonOf(res)).toBe('Discord /users/@me failed (401)');
    expect(await sessionCount()).toBe(0);
  });

  it('surfaces a failed guild lookup rather than guessing the role', async () => {
    // A 500 from the member endpoint is not "not a member". Treating it as one
    // would demote everybody in the guild for the length of a Discord outage.
    mockDiscord().tokenOk().userOk().memberFails(GUILD, 500);

    const res = await callback(`?code=c&state=${VALID_STATE}`, { state: VALID });

    expect(reasonOf(res)).toBe('Discord guild member lookup failed (500)');
    expect(await sessionCount()).toBe(0);
    // Nothing was written, either — the user row is not created on a half-done
    // sign-in.
    const users = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    expect(users?.n).toBe(0);
  });

  it('clears the state cookie when the exchange fails', async () => {
    mockDiscord().tokenFails();

    const res = await callback(`?code=c&state=${VALID_STATE}`, { state: VALID });

    expect(clearsStateCookie(res)).toBe(true);
  });
});

describe('a banned account', () => {
  it('is refused, with no session issued', async () => {
    discordSaysYes();
    await seedUser(env.DB, { discordId: DISCORD_ID, isBanned: true, banReason: 'spoofing' });

    const res = await callback(`?code=c&state=${VALID_STATE}`, { state: VALID });

    expect(reasonOf(res)).toBe('This account is banned');
    expect(errorStatusOf(res)).toBe('403');
    expect(sessionTokenOf(res)).toBeUndefined();
    expect(await sessionCount()).toBe(0);
  });
});

describe('the happy path', () => {
  it('sets the session and clears the state, in two headers', async () => {
    discordSaysYes();

    const res = await callback(`?code=c&state=${VALID_STATE}`, { state: VALID });

    const cookies = res.headers.getSetCookie();
    // Two, not one: `Headers.set` on the second would have silently replaced
    // the first and the state cookie would outlive the sign-in.
    expect(cookies).toHaveLength(2);
    expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
    expect(clearsStateCookie(res)).toBe(true);
  });

  it('issues a session that resolves to the Discord account', async () => {
    discordSaysYes();

    const res = await callback(`?code=c&state=${VALID_STATE}`, { state: VALID });
    const user = await getSessionUser(env.DB, sessionTokenOf(res)!);

    expect(user?.discordId).toBe(DISCORD_ID);
    expect(user?.username).toBe('testtrainer');
    // In the guild, and no role ids are configured, so membership alone is the
    // baseline.
    expect(user?.role).toBe('member');
  });

  it('makes a non-member a guest', async () => {
    mockDiscord().tokenOk().userOk().memberNotFound(GUILD);

    const res = await callback(`?code=c&state=${VALID_STATE}`, { state: VALID });
    const user = await getSessionUser(env.DB, sessionTokenOf(res)!);

    expect(user?.role).toBe('guest');
  });

  it('lands where the stored next asked', async () => {
    discordSaysYes();

    const res = await callback(`?code=c&state=${VALID_STATE}`, {
      state: { ...VALID, next: '/go' },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/go');
  });

  it.each([
    ['a protocol-relative host', '//evil.example/phish'],
    ['the backslash form a browser folds to a slash', '/\\evil.example/phish'],
    ['an absolute URL', 'https://evil.example/phish'],
    ['a tab-smuggled host', '/\t//evil.example/phish'],
  ])('sends %s home instead', async (_label, next) => {
    // `safeNext` runs at the point the value becomes a `Location`, not only
    // where it was minted — because the cookie carrying it is not signed.
    discordSaysYes();

    const res = await callback(`?code=c&state=${VALID_STATE}`, { state: { ...VALID, next } });

    expect(res.headers.get('location')).toBe('/');
  });

  it('presents the PKCE verifier and this deployment’s redirect_uri', async () => {
    const discord = discordSaysYes();

    await callback(`?code=the-code&state=${VALID_STATE}`, { state: VALID });

    const body = new URLSearchParams(discord.assertCalled('/oauth2/token').body ?? '');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toBe('verifier-xyz');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback`);
  });

  it('records the user agent hash on the session it mints', async () => {
    discordSaysYes();

    const res = await SELF.fetch(`${ORIGIN}/auth/callback?code=c&state=${VALID_STATE}`, {
      headers: { cookie: `${OAUTH_STATE_COOKIE}=${encodeState(VALID)}`, 'user-agent': 'Probe/1.0' },
      redirect: 'manual',
    });

    expect(res.status).toBe(302);
    const row = await env.DB.prepare('SELECT user_agent_hash FROM sessions').first<{
      user_agent_hash: string | null;
    }>();
    expect(row?.user_agent_hash).toHaveLength(32);
  });
});
