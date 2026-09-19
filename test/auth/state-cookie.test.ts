/**
 * `decodeState` (callback.ts:65) and the security claim it stands on.
 *
 * `/auth/login` calls the `pogotxk_oauth` cookie "signed-ish" (login.ts:111).
 * It is not signed at all — it is base64url, which is an encoding and not a
 * signature, and anyone who can write the cookie can write any payload they
 * like into it. What actually holds the flow together is two other things:
 * the cookie is HttpOnly, so page script cannot read or forge it; and the
 * `state` inside it must equal the `state` Discord echoes back, which is what
 * stops a callback the attacker composed from being accepted.
 *
 * So these tests are in two halves, and the second half is the one that matters.
 * First: every malformed payload is rejected outright. Then: for each field an
 * attacker *could* rewrite if they got hold of the cookie, what it buys them —
 * `next` is re-validated on the way out, `consent` costs a retry and nothing
 * more, and `verifier` fails at Discord's PKCE check. None of them produce a
 * session. That is the claim; this file is what holds it up.
 *
 * The last test is a round trip: the cookie /auth/login really mints, fed to
 * /auth/callback unmodified. Hand-written payloads prove the parser rejects
 * rubbish, and only a round trip proves the two halves agree about the good case.
 */

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getSessionUser, OAUTH_STATE_COOKIE, SESSION_COOKIE } from '~/lib/auth/session';
import { mockDiscord } from '../helpers/discord-mock';

const GUILD = 'test-guild-id';
const ORIGIN = 'https://pogotxk.test';
const EXPIRED = 'Sign-in session expired, please try again';

function base64url(json: string): string {
  return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function callbackWith(cookieValue: string | undefined, query: string): Promise<Response> {
  const headers = new Headers();
  if (cookieValue !== undefined) headers.set('cookie', `${OAUTH_STATE_COOKIE}=${cookieValue}`);
  return SELF.fetch(`${ORIGIN}/auth/callback${query}`, { headers, redirect: 'manual' });
}

function reasonOf(res: Response): string | null {
  const location = res.headers.get('location');
  return location ? new URL(location, ORIGIN).searchParams.get('reason') : null;
}

function sessionTokenOf(res: Response): string | undefined {
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  const value = cookie?.slice(SESSION_COOKIE.length + 1).split(';')[0];
  return value ? value : undefined;
}

describe('a payload decodeState will not accept', () => {
  /**
   * Each of these reaches the same answer as "no cookie at all", which is the
   * right shape: a payload that cannot be parsed tells us nothing, so it is
   * worth exactly as much as an absent one. The test proves they are not
   * accidentally distinguishable, because a difference here would leak to an
   * attacker which of their guesses parsed.
   */
  const rejected: Array<[string, string | undefined]> = [
    ['no cookie', undefined],
    ['an empty value', ''],
    ['characters outside the base64 alphabet', 'not.base64.at.all'],
    ['valid base64 that is not JSON', base64url('this is not json')],
    ['JSON that is not an object', base64url('[1,2,3]')],
    ['the JSON literal null', base64url('null')],
    ['an object with no state', base64url(JSON.stringify({ verifier: 'v', next: '/' }))],
    ['an object with no verifier', base64url(JSON.stringify({ state: 's', next: '/' }))],
    ['an empty state', base64url(JSON.stringify({ state: '', verifier: 'v', next: '/' }))],
    ['an empty verifier', base64url(JSON.stringify({ state: 's', verifier: '', next: '/' }))],
    ['an empty object', base64url('{}')],
  ];

  it.each(rejected)('rejects %s', async (_label, cookieValue) => {
    const discord = mockDiscord();

    const res = await callbackWith(cookieValue, '?code=c&state=s');

    expect(reasonOf(res)).toBe(EXPIRED);
    // Refused before the authorization code is spent.
    discord.assertNotCalled();
  });
});

describe('what rewriting the cookie actually buys an attacker', () => {
  it('nothing, through next: the destination is re-validated on the way out', async () => {
    mockDiscord().tokenOk().userOk().memberOk(GUILD);

    const res = await callbackWith(
      base64url(JSON.stringify({ state: 's', verifier: 'v', next: '//evil.example/phish' })),
      '?code=c&state=s',
    );

    expect(res.headers.get('location')).toBe('/');
  });

  it('nothing, through verifier: Discord refuses a PKCE mismatch', async () => {
    // Our side cannot detect a swapped verifier — it never stored the
    // challenge. Discord can, because it holds the one from authorize time, and
    // its refusal is what this surfaces.
    mockDiscord().tokenFails(400, { error: 'invalid_grant' });

    const res = await callbackWith(
      base64url(JSON.stringify({ state: 's', verifier: 'swapped', next: '/' })),
      '?code=c&state=s',
    );

    expect(reasonOf(res)).toBe('Discord token exchange failed (400)');
    expect(sessionTokenOf(res)).toBeUndefined();
  });

  it('one lost retry, through consent: a recoverable error becomes an error page', async () => {
    // The honest cost of the cookie being unsigned, written down. Flipping
    // `consent` to true makes the callback treat this attempt as the retry it
    // was not, so a `consent_required` that should have bounced to
    // /auth/login?retry=1 ends at the error page instead. Annoying, not unsafe
    // — and the same guard is what stops a genuine retry looping forever.
    const looped = await callbackWith(
      base64url(JSON.stringify({ state: 's', verifier: 'v', next: '/', consent: false })),
      '?error=consent_required',
    );
    expect(looped.headers.get('location')).toBe('/auth/login?retry=1');

    const tampered = await callbackWith(
      base64url(JSON.stringify({ state: 's', verifier: 'v', next: '/', consent: true })),
      '?error=consent_required',
    );
    expect(reasonOf(tampered)).toBe('consent_required');
  });

  it('nothing at all without the matching state, which is the point', async () => {
    // A cookie the attacker composed is worthless unless Discord echoes the
    // same `state` back — and Discord only echoes what was sent to it at
    // authorize time, from a request they could not make on the victim's behalf.
    const discord = mockDiscord();

    const res = await callbackWith(
      base64url(JSON.stringify({ state: 'attacker-chosen', verifier: 'v', next: '/' })),
      '?code=stolen&state=something-else',
    );

    expect(reasonOf(res)).toBe('State mismatch');
    discord.assertNotCalled();
  });
});

describe('the cookie /auth/login mints is the cookie /auth/callback reads', () => {
  it('round-trips through both halves of the flow', async () => {
    // The pair is only correct together, and each half is tested alone
    // everywhere else. This is the one test that would catch the encodings
    // drifting apart — a padding change, a different alphabet, a renamed field.
    const start = await SELF.fetch(`${ORIGIN}/auth/login?next=%2Fgo`, { redirect: 'manual' });
    expect(start.status).toBe(302);

    const setCookie = start.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`));
    expect(setCookie).toBeDefined();
    const value = setCookie!.slice(OAUTH_STATE_COOKIE.length + 1).split(';')[0]!;

    // Standing in for Discord: read the `state` it was handed and echo it back.
    const authorize = new URL(start.headers.get('location')!);
    const echoed = authorize.searchParams.get('state');
    expect(echoed).toBeTruthy();

    mockDiscord().tokenOk().userOk().memberOk(GUILD);
    const res = await callbackWith(value, `?code=c&state=${encodeURIComponent(echoed!)}`);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/go');
    expect(await getSessionUser(env.DB, sessionTokenOf(res)!)).toBeDefined();
  });

  it('carries the verifier that matches the challenge login sent to Discord', async () => {
    // PKCE is the whole reason the verifier is in the cookie. If these two ever
    // stop matching, every sign-in fails at Discord with `invalid_grant` and
    // nothing on our side can tell why.
    const start = await SELF.fetch(`${ORIGIN}/auth/login`, { redirect: 'manual' });
    const value = start.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`))!
      .slice(OAUTH_STATE_COOKIE.length + 1)
      .split(';')[0]!;

    const stored = JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/'))) as {
      verifier: string;
      state: string;
    };
    const challenge = new URL(start.headers.get('location')!).searchParams.get('code_challenge');

    const { pkceChallenge } = await import('~/lib/auth/discord');
    expect(await pkceChallenge(stored.verifier)).toBe(challenge);
  });
});
