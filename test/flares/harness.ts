/**
 * Local helpers for the flare suites: a webhook the close sweep will actually
 * use, a stub for what it talks to, and two ways of reconfiguring the running
 * Worker so the degraded paths can be exercised.
 *
 * Nothing here belongs in test/helpers/ — these exist to drive one feature's
 * delivery paths, and two of them deliberately mutate bindings, which is not a
 * thing a shared factory should offer.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A discord.com URL IN A TEST FILE
 * ---------------------------------------------------------------------------
 *
 * The sweep is gated by `webhookUrl(env)`, which deliberately accepts nothing
 * but a Discord host — that allowlist is itself a security control
 * (scripts/test-notify.ts covers it), so a test cannot point the sweep at
 * `https://webhook.test` without first weakening the thing being tested. The
 * only honest way to exercise the code past that gate is a URL that satisfies
 * it.
 *
 * What makes that safe is that nothing here can leave the isolate:
 *
 *   * `test/setup.ts` replaces `fetch` with a throwing stub before EVERY test,
 *     so a suite that forgets `mockWebhook()` fails loudly rather than dialling
 *     out. `markFlareClosedInDiscord` swallows the throw and returns 'retry',
 *     so the visible symptom is a failed assertion, not a sent message;
 *   * `mockWebhook()` stubs `fetch` again, records everything, and rejects any
 *     URL that is not this one;
 *   * the id and token below are obviously fake and authenticate as nobody. The
 *     real credential lives in `.dev.vars`, is blanked by vitest.config.ts, and
 *     is never read by this module.
 *
 * `WEBHOOK` is never assigned to a binding except by `withWebhook`, which
 * restores the blank immediately and asserts that it did.
 */

import { env } from 'cloudflare:test';
import { expect, vi } from 'vitest';

/** Structurally a Discord webhook, functionally nothing. */
export const WEBHOOK =
  'https://discord.com/api/webhooks/000000000000000000/test-token-authenticates-as-nobody';

/**
 * An `Env` carrying nothing but the webhook and, where a caller needs it, the
 * real D1. Deliberately not a copy of the live `env`: the sweep only ever reads
 * `DISCORD_WEBHOOK_URL` off it, and handing it a bag with one key in makes that
 * impossible to get wrong. Mirrors the `vars as unknown as Env` cast that
 * scripts/test-notify.ts already uses.
 */
export function webhookEnv(): Env {
  return { DISCORD_WEBHOOK_URL: WEBHOOK } as unknown as Env;
}

/** One PATCH the sweep sent, with the embed already parsed. */
export interface WebhookCall {
  url: string;
  method: string;
  /** The `{id}` out of `.../messages/{id}`, which is what assertions care about. */
  messageId: string;
  body: { embeds?: { title?: string; fields?: { name: string; value: string }[] }[] };
}

/** The id Discord hands back for a newly posted embed, under `?wait=true`. */
export const POSTED_MESSAGE_ID = 'posted-message';

export interface WebhookMock {
  readonly calls: readonly WebhookCall[];
  /** Message ids that were PATCHed, in order. Duplicates here are the bug. */
  edited(): string[];
  /** Status for every call from now on. */
  reply(status: number): void;
  /** Statuses for the next calls in order; the last one repeats. */
  replyEach(...statuses: number[]): void;
  /** Transport failure — a timeout or a dropped connection, not an HTTP answer. */
  replyByThrowing(): void;
}

export interface WebhookMockOptions {
  /**
   * Called before each reply. Use it to hold a request open while something
   * else runs, which is how the concurrency tests get two sweeps to overlap
   * inside the window the claim is supposed to protect.
   */
  onCall?: (call: WebhookCall) => Promise<void> | void;
}

export function mockWebhook(options: WebhookMockOptions = {}): WebhookMock {
  const calls: WebhookCall[] = [];
  let statuses: number[] = [204];
  let shouldThrow = false;

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as RequestInfo, init);
    if (!request.url.startsWith(WEBHOOK)) {
      throw new Error(
        `webhook mock: unexpected outbound request ${request.method} ${request.url.split('?')[0]}`,
      );
    }

    const text = await request.text();
    const call: WebhookCall = {
      url: request.url,
      method: request.method,
      messageId: request.url.slice(request.url.lastIndexOf('/') + 1),
      body: text ? JSON.parse(text) : {},
    };
    calls.push(call);

    await options.onCall?.(call);

    if (shouldThrow) throw new Error('webhook mock: simulated transport failure');
    // The last status repeats, so `reply(204)` covers a whole sweep and
    // `replyEach(429, 204)` means "the first one is rate limited".
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)]!;

    // A POST is a new embed, and `?wait=true` makes Discord answer with the
    // created message rather than 204 — which is the only way the app ever
    // learns an id to edit later. A PATCH is an edit and answers with nothing.
    if (call.method === 'POST' && status >= 200 && status < 300) {
      return new Response(JSON.stringify({ id: POSTED_MESSAGE_ID }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(null, { status });
  });

  return {
    calls,
    // PATCHes only. A POST is a new embed, not an edit, and counting one as an
    // edit would make "this message was struck through twice" unreadable.
    edited: () => calls.filter((call) => call.method === 'PATCH').map((call) => call.messageId),
    reply(status) {
      statuses = [status];
      shouldThrow = false;
    },
    replyEach(...next) {
      statuses = next.length > 0 ? next : [204];
      shouldThrow = false;
    },
    replyByThrowing() {
      shouldThrow = true;
    },
  };
}

/**
 * Run `body` with the Worker's own `DISCORD_WEBHOOK_URL` set to the fake, so a
 * route can be exercised past the `webhookUrl` gate.
 *
 * The binding bag `cloudflare:test` hands out is the same object the app reads
 * through `cloudflare:workers`, so this genuinely reconfigures the running
 * Worker — which is the only way to prove that a route drives the sweep at all.
 * It asserts the configured value is blank first, so it can never overwrite a
 * real webhook that has leaked in, and restores it in `finally` and asserts
 * that too: a test file that left this set would be a file that reintroduced
 * the exact hazard test/00-safety.test.ts exists to prevent.
 */
export async function withWebhook<T>(body: () => Promise<T>): Promise<T> {
  const bag = env as unknown as Record<string, unknown>;
  expect(
    bag.DISCORD_WEBHOOK_URL,
    'the configured webhook is not blank — refusing to touch it',
  ).toBe('');

  bag.DISCORD_WEBHOOK_URL = WEBHOOK;
  try {
    return await body();
  } finally {
    bag.DISCORD_WEBHOOK_URL = '';
    expect(bag.DISCORD_WEBHOOK_URL).toBe('');
  }
}

/**
 * Run `body` with the `LIVE` binding removed.
 *
 * The flare API is explicitly meant to survive the Durable Object being
 * switched off — writes still land in D1 and clients fall back to polling — and
 * `liveNamespace()` returning null rather than throwing is what buys that. This
 * is the only way to reach that branch, since the binding is configured in
 * wrangler.jsonc for every other test.
 */
export async function withoutLiveBinding<T>(body: () => Promise<T>): Promise<T> {
  const bag = env as unknown as Record<string, unknown>;
  const binding = bag.LIVE;
  expect(binding, 'the LIVE binding is already missing').toBeDefined();
  delete bag.LIVE;
  try {
    return await body();
  } finally {
    bag.LIVE = binding;
  }
}

/* ------------------------------------------------------------------ push */

/**
 * A VAPID pair generated here and now, so `sendPush` gets past `vapidKeys` and
 * actually signs something.
 *
 * Generated rather than hard-coded because a committed private key — even a
 * worthless one — is the kind of thing that gets copied somewhere it matters.
 * The format is the one push services accept and the one
 * scripts/generate-vapid.ts produces: the public key is the 65-byte
 * uncompressed point, the private key the raw 32-byte scalar, both base64url.
 */
export interface VapidPair {
  publicKey: string;
  privateKey: string;
}

function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function generateVapid(): Promise<VapidPair> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as {
    x: string;
    y: string;
  };
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as { d: string };

  const point = new Uint8Array(65);
  point[0] = 0x04;
  point.set(fromB64url(publicJwk.x), 1);
  point.set(fromB64url(publicJwk.y), 33);

  return { publicKey: b64url(point), privateKey: b64url(fromB64url(privateJwk.d)) };
}

/** A subscription's own ECDH pair, which is what the payload is encrypted to. */
export async function generateSubscriptionKeys(): Promise<{ p256dh: string; auth: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { p256dh: b64url(raw), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) };
}

/**
 * Run `body` with push configured on the running Worker.
 *
 * Same discipline as `withWebhook`, and the same reason: the route decides who
 * to exclude from a notification, and that decision is unreachable while
 * `vapidKeys` returns null. Safer than the webhook case, in that the keys are
 * generated per call and belong to nobody, and the endpoints reached are
 * whatever `push_subs` holds — a table test/setup.ts empties before every test.
 */
export async function withPush<T>(body: (vapid: VapidPair) => Promise<T>): Promise<T> {
  const bag = env as unknown as Record<string, unknown>;
  for (const key of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) {
    expect(bag[key], `${key} is not blank — refusing to touch it`).toBe('');
  }

  const vapid = await generateVapid();
  bag.VAPID_PUBLIC_KEY = vapid.publicKey;
  bag.VAPID_PRIVATE_KEY = vapid.privateKey;
  bag.VAPID_SUBJECT = 'mailto:tests@pogotxk.invalid';
  try {
    return await body(vapid);
  } finally {
    bag.VAPID_PUBLIC_KEY = '';
    bag.VAPID_PRIVATE_KEY = '';
    bag.VAPID_SUBJECT = '';
  }
}
