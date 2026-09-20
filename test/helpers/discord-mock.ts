/**
 * Canned Discord responses for the sign-in flow, plus a record of everything
 * the code under test tried to send.
 *
 * Built on `vi.stubGlobal('fetch', ...)` rather than the pool's `fetchMock`,
 * which `@cloudflare/vitest-pool-workers` stopped exporting from
 * `cloudflare:test`. A plain stub is a better fit here anyway: it records every
 * outbound request, not only the ones an interceptor was registered for, so
 * `assertNotCalled` can prove a Discord call did *not* happen — which is most
 * of what these tests are for.
 *
 * Any request the mock does not recognise is still recorded and then rejected
 * with an error naming it. Nothing reaches the network. Note that the app
 * swallows Discord failures by design, so a stray call usually shows up as a
 * missing effect rather than a thrown error: assert against `calls`.
 *
 * `vitest.config.ts` sets `unstubGlobals`, so the stub is removed before the
 * next test on its own. `restore()` is there for the odd test that wants the
 * real `fetch` back mid-way.
 */

import { vi } from 'vitest';
import { DEVICE_AUTHORIZE_URL, type DiscordUser } from '~/lib/auth/discord';

/**
 * Derived from the one Discord URL `src/lib/auth/discord.ts` exports, so the
 * API version cannot drift out from under these helpers. The module's other
 * URLs are private to it, and re-typing `v10` here is exactly the kind of copy
 * that goes stale without anyone noticing.
 */
const API = DEVICE_AUTHORIZE_URL.slice(0, DEVICE_AUTHORIZE_URL.indexOf('/oauth2/'));

/** POST, form-encoded — `exchangeCode` and every device-grant poll. */
export const DISCORD_TOKEN_URL = `${API}/oauth2/token`;
/** GET with a bearer token — `fetchUser`. */
export const DISCORD_USER_URL = `${API}/users/@me`;
/** GET with a bearer token — `fetchGuildRoles`. 404 means "not in the guild". */
export function discordMemberUrl(guildId: string): string {
  return `${API}/users/@me/guilds/${guildId}/member`;
}

/**
 * Discord's device-code response, in Discord's own casing. Deliberately not
 * `DeviceAuthorization` — that is the app's shape, on the far side of
 * `parseDeviceAuthorization`, and a mock that spoke it could not express the
 * answers that parser exists to reject.
 */
export interface DeviceAuthorizeBody {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  /** Optional in Discord's answer, which is why the app derives its own. */
  verification_uri_complete?: string;
}

/** One outbound request, flattened so assertions do not have to await a body. */
export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/**
 * A substring, a pattern, or both halves spelled out. A bare string matches any
 * URL containing it, which is usually what you want: `assertNotCalled('/webhooks/')`.
 */
export type CallMatcher = string | RegExp | { url?: string | RegExp; method?: string };

interface Route {
  method: string;
  url: string;
  respond: () => Response;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Every Discord token request is `application/x-www-form-urlencoded`, and
 * workerd warns on `.text()` for any body whose content-type it does not
 * recognise as text — "the result will probably be corrupted", which for
 * percent-encoded ASCII it demonstrably is not. It printed two dozen times a
 * run, which is a lot of terminal for a real failure to hide behind. Decoding
 * the bytes ourselves yields the identical string and says nothing.
 */
async function readBody(request: Request): Promise<string> {
  return new TextDecoder().decode(await request.arrayBuffer());
}

function matches(call: RecordedCall, match: CallMatcher): boolean {
  if (typeof match === 'string') return call.url.includes(match);
  if (match instanceof RegExp) return match.test(call.url);
  if (match.method !== undefined && call.method !== match.method.toUpperCase()) return false;
  if (match.url === undefined) return true;
  return typeof match.url === 'string' ? call.url.includes(match.url) : match.url.test(call.url);
}

function describe(match: CallMatcher | undefined): string {
  if (match === undefined) return 'any request';
  if (typeof match === 'string' || match instanceof RegExp) return String(match);
  return `${match.method ?? 'any'} ${String(match.url ?? 'any')}`;
}

export interface DiscordMock {
  /** Every outbound request, in order, whether or not a route matched it. */
  readonly calls: readonly RecordedCall[];

  /** `exchangeCode` / `pollDeviceToken` succeed and hand back this access token. */
  tokenOk(accessToken?: string): DiscordMock;
  /** 404 — the shape Discord gives for an endpoint that is not there at all. */
  tokenNotFound(): DiscordMock;
  /**
   * A non-OK answer. The body doubles as the device-grant error envelope, so
   * `tokenFails(400, { error: 'authorization_pending' })` drives `mapDevicePoll`.
   */
  tokenFails(status?: number, body?: unknown): DiscordMock;

  /**
   * `deviceAuthorize` succeeds — the step before the polls `tokenOk` covers.
   * The override is Discord's own snake_case shape, because that is what
   * `parseDeviceAuthorization` reads and translating it here would hide the
   * one field the app derives rather than trusts.
   */
  deviceAuthorizeOk(grant?: Partial<DeviceAuthorizeBody>): DiscordMock;
  /**
   * An answer `parseDeviceAuthorization` must refuse, so the caller falls back
   * to the browser flow. The default is what a client without "Public Client"
   * enabled sends. A 200 is legitimate here too — `deviceAuthorizeFails(200,
   * { device_code: 'x' })` is the well-formed-HTTP, wrong-shape case.
   */
  deviceAuthorizeFails(status?: number, body?: unknown): DiscordMock;

  userOk(user?: Partial<DiscordUser>): DiscordMock;
  userNotFound(): DiscordMock;
  userFails(status?: number): DiscordMock;

  /** In the guild, holding `roles`. An empty array is a member with no roles. */
  memberOk(guildId: string, roles?: string[]): DiscordMock;
  /** Discord's answer for "not a member" — an answer, not a failure. */
  memberNotFound(guildId: string): DiscordMock;
  memberFails(guildId: string, status?: number): DiscordMock;

  /** The first matching call, or undefined. */
  called(match: CallMatcher): RecordedCall | undefined;
  /** The first matching call, throwing with the full call list when there is none. */
  assertCalled(match: CallMatcher): RecordedCall;
  /** Throws if anything matched — with no argument, if anything was sent at all. */
  assertNotCalled(match?: CallMatcher): void;

  restore(): void;
}

export function mockDiscord(): DiscordMock {
  const calls: RecordedCall[] = [];
  const routes: Route[] = [];
  const realFetch = globalThis.fetch;

  function route(method: string, url: string, respond: () => Response): void {
    // Last registration wins, so a test may override a default from a helper
    // it called earlier without the two fighting.
    const existing = routes.findIndex((r) => r.method === method && r.url === url);
    if (existing !== -1) routes.splice(existing, 1);
    routes.push({ method, url, respond });
  }

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as RequestInfo, init);
    const call: RecordedCall = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      // Read here rather than lazily: the body is a stream and can only be
      // consumed once, and a test asserting on it runs long after this returns.
      body: request.method === 'GET' || request.method === 'HEAD' ? null : await readBody(request),
    };
    calls.push(call);

    // Query strings are the app's (`?wait=true`), never the route's, so match on
    // the path and let them through.
    const withoutQuery = call.url.split('?')[0];
    const hit = routes.find((r) => r.method === call.method && r.url === withoutQuery);
    if (hit) return hit.respond();

    throw new Error(
      `discord-mock: unmocked outbound request ${call.method} ${redact(call.url)}. ` +
        'Nothing in a test may reach the network — add a route, or assert it is not called.',
    );
  });

  const mock: DiscordMock = {
    calls,

    tokenOk(accessToken = 'test-access-token') {
      route('POST', DISCORD_TOKEN_URL, () =>
        jsonResponse(200, { access_token: accessToken, token_type: 'Bearer', expires_in: 604800 }),
      );
      return mock;
    },
    tokenNotFound() {
      route('POST', DISCORD_TOKEN_URL, () => jsonResponse(404, { message: '404: Not Found' }));
      return mock;
    },
    tokenFails(status = 400, body: unknown = { error: 'invalid_grant' }) {
      route('POST', DISCORD_TOKEN_URL, () => jsonResponse(status, body));
      return mock;
    },

    deviceAuthorizeOk(grant = {}) {
      const body: DeviceAuthorizeBody = {
        device_code: 'test-device-code',
        user_code: 'WXYZ-1234',
        verification_uri: 'https://discord.com/activate',
        expires_in: 900,
        interval: 5,
        ...grant,
      };
      route('POST', DEVICE_AUTHORIZE_URL, () => jsonResponse(200, body));
      return mock;
    },
    deviceAuthorizeFails(status = 401, body: unknown = { message: '401: Unauthorized', code: 0 }) {
      route('POST', DEVICE_AUTHORIZE_URL, () => jsonResponse(status, body));
      return mock;
    },

    userOk(user = {}) {
      const body: DiscordUser = {
        id: '100000000000000001',
        username: 'testtrainer',
        global_name: null,
        avatar: null,
        ...user,
      };
      route('GET', DISCORD_USER_URL, () => jsonResponse(200, body));
      return mock;
    },
    userNotFound() {
      route('GET', DISCORD_USER_URL, () => jsonResponse(404, { message: '404: Not Found' }));
      return mock;
    },
    userFails(status = 401) {
      route('GET', DISCORD_USER_URL, () => jsonResponse(status, { message: '401: Unauthorized' }));
      return mock;
    },

    memberOk(guildId, roles = []) {
      route('GET', discordMemberUrl(guildId), () => jsonResponse(200, { roles }));
      return mock;
    },
    memberNotFound(guildId) {
      route('GET', discordMemberUrl(guildId), () =>
        jsonResponse(404, { message: 'Unknown Guild', code: 10004 }),
      );
      return mock;
    },
    memberFails(guildId, status = 500) {
      route('GET', discordMemberUrl(guildId), () =>
        jsonResponse(status, { message: 'Internal Server Error' }),
      );
      return mock;
    },

    called(match) {
      return calls.find((call) => matches(call, match));
    },
    assertCalled(match) {
      const call = mock.called(match);
      if (!call) {
        throw new Error(
          `discord-mock: expected a call matching ${describe(match)}, saw:\n` + formatCalls(calls),
        );
      }
      return call;
    },
    assertNotCalled(match) {
      const offenders = match === undefined ? calls : calls.filter((call) => matches(call, match));
      if (offenders.length > 0) {
        throw new Error(
          `discord-mock: expected no call matching ${describe(match)}, saw:\n` +
            formatCalls(offenders),
        );
      }
    },

    restore() {
      globalThis.fetch = realFetch;
    },
  };

  return mock;
}

/**
 * A webhook URL is `.../webhooks/{id}/{token}` and the token half is the whole
 * credential — anyone holding it can post to that channel. These messages are
 * printed precisely when something went wrong with a real one loaded, which is
 * the worst moment to put it in a terminal and a CI log, so it never appears.
 * Query strings go too: they are the app's, never the route's.
 */
export function redact(url: string): string {
  return url
    .split('?')[0]!
    .replace(/(\/webhooks\/\d+\/)[^/]+/, '$1<token>')
    .replace(/(\/api\/v\d+\/[^/]*token[^/]*\/)[^/]+/i, '$1<redacted>');
}

function formatCalls(calls: readonly RecordedCall[]): string {
  if (calls.length === 0) return '  (nothing was sent)';
  return calls.map((call) => `  ${call.method} ${redact(call.url)}`).join('\n');
}
