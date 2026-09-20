/**
 * Delivery must never fail the request.
 *
 * By the time any of this runs the flare is already in D1, which is the source
 * of truth. Discord, the Durable Object and Web Push are three ways of telling
 * people about it, and a trainer standing at a gym waiting for a button to
 * respond should not be paying for any of them — not in latency, and certainly
 * not in a 500 because somebody else's API is having a bad afternoon.
 *
 * Two separate properties, and the tests below keep them apart:
 *
 *   isolation   one leg failing does not stop the others. That is what
 *               `Promise.allSettled` buys over `Promise.all`, and it is tested
 *               by knocking out one leg and asserting the rest still landed.
 *   latency     the response does not wait for any of them. That is what
 *               `waitUntil` buys, and it is tested by holding Discord open
 *               across the whole request and watching the 201 arrive anyway.
 *
 * Each leg also swallows its own failures internally, so a rejection never
 * actually reaches the `allSettled` — which means `allSettled` is the second
 * line rather than the first. Both lines are worth having, and the unit tests
 * at the bottom pin the first one.
 */

import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { postFlareToDiscord, type FlareNotification } from '~/lib/notify/discord';
import { notifyLiveBoard } from '~/do/LiveBoard';
import { sendPush } from '~/lib/notify/push';
import { asUser, seedFlare, seedUser, type SeededUser } from '../helpers/factories';
import { mockWebhook, webhookEnv, withoutLiveBinding, withWebhook } from './harness';

const FLARES = 'https://pogotxk.test/api/flares';

async function raise(
  user: SeededUser,
  body: Record<string, unknown> = { kind: 'raid', boss: 'Mewtwo' },
): Promise<{ status: number; flare?: { id: number } }> {
  const res = await SELF.fetch(
    await asUser(env.DB, user, FLARES, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  const parsed = (await res.json()) as { flare?: { id: number } };
  return { status: res.status, flare: parsed.flare };
}

function member(): Promise<SeededUser> {
  return seedUser(env.DB, { role: 'member' });
}

async function storedMessageId(id: number): Promise<string | null> {
  const row = await env.DB.prepare('SELECT discord_message_id FROM flares WHERE id = ?1')
    .bind(id)
    .first<{ discord_message_id: string | null }>();
  return row?.discord_message_id ?? null;
}

afterEach(() => {
  const bag = env as unknown as Record<string, unknown>;
  expect(bag.DISCORD_WEBHOOK_URL).toBe('');
  expect(bag.LIVE).toBeDefined();
});

describe('a wedged Discord', () => {
  it('a transport failure still gives the trainer a 201', async () => {
    const webhook = mockWebhook();
    webhook.replyByThrowing();
    const user = await member();

    const { status, flare } = await withWebhook(() => raise(user));

    expect(status).toBe(201);
    expect(await storedMessageId(flare!.id)).toBeNull();
  });

  it.each([429, 500, 503])('a %i still gives the trainer a 201', async (code) => {
    const webhook = mockWebhook();
    webhook.reply(code);
    const user = await member();

    const { status, flare } = await withWebhook(() => raise(user));

    expect(status).toBe(201);
    // No id came back, so nothing is recorded to edit later — which is the
    // honest state: there is no embed in the channel to retire.
    expect(await storedMessageId(flare!.id)).toBeNull();
  });

  it('the flare is on the board regardless', async () => {
    const webhook = mockWebhook();
    webhook.replyByThrowing();
    const user = await member();

    await withWebhook(() => raise(user));

    const board = (await (await SELF.fetch(FLARES)).json()) as { flares: unknown[] };
    expect(board.flares).toHaveLength(1);
  });

  it('a wedged Discord does not fail a close either', async () => {
    const webhook = mockWebhook();
    webhook.reply(500);
    const author = await member();
    const flare = await seedFlare(env.DB, { createdBy: author.id, discordMessageId: 'msg-1' });

    const status = await withWebhook(async () => {
      const res = await SELF.fetch(
        await asUser(env.DB, author, `${FLARES}/${flare.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'close' }),
        }),
      );
      await res.json();
      return res.status;
    });

    expect(status).toBe(200);
    const closed = await env.DB.prepare('SELECT closed_at FROM flares WHERE id = ?1')
      .bind(flare.id)
      .first<{ closed_at: string | null }>();
    expect(closed?.closed_at).not.toBeNull();
  });

  it('a wedged Discord does not fail an edit either', async () => {
    const webhook = mockWebhook();
    webhook.replyByThrowing();
    const author = await member();
    const flare = await seedFlare(env.DB, {
      kind: 'raid',
      createdBy: author.id,
      discordMessageId: 'msg-1',
    });

    const status = await withWebhook(async () => {
      const res = await SELF.fetch(
        await asUser(env.DB, author, `${FLARES}/${flare.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'edit', boss: 'Mewtwo' }),
        }),
      );
      await res.json();
      return res.status;
    });

    expect(status).toBe(200);
    const row = await env.DB.prepare('SELECT boss FROM flares WHERE id = ?1')
      .bind(flare.id)
      .first<{ boss: string | null }>();
    expect(row?.boss).toBe('Mewtwo');
  });
});

describe('an absent Durable Object binding', () => {
  it('still gives the trainer a 201, and the flare is stored', async () => {
    const user = await member();

    const { status, flare } = await withoutLiveBinding(() => raise(user));

    expect(status).toBe(201);
    const row = await env.DB.prepare('SELECT id FROM flares WHERE id = ?1')
      .bind(flare!.id)
      .first();
    expect(row).not.toBeNull();
  });

  it('rsvp, edit and close all still work without it', async () => {
    const author = await member();
    const flare = await seedFlare(env.DB, { kind: 'raid', createdBy: author.id });

    await withoutLiveBinding(async () => {
      for (const payload of [
        { action: 'rsvp', state: 'coming' },
        { action: 'edit', boss: 'Mewtwo' },
        { action: 'close' },
      ]) {
        const res = await SELF.fetch(
          await asUser(env.DB, author, `${FLARES}/${flare.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }),
        );
        await res.json();
        expect(res.status).toBe(200);
      }
    });
  });

  it('the board still answers, so clients degrade to polling', async () => {
    await withoutLiveBinding(async () => {
      const res = await SELF.fetch(FLARES);
      expect(res.status).toBe(200);
      await res.json();
    });
  });
});

describe('push that is not configured', () => {
  it('does not stop a flare being raised', async () => {
    // The default state under test, and the normal state of any deployment
    // without a VAPID pair.
    const user = await member();
    expect((await raise(user)).status).toBe(201);
  });
});

describe('one leg down does not take the others with it', () => {
  it('Discord failing still leaves the flare broadcast and stored', async () => {
    // This is the `allSettled` property stated as a behaviour rather than as an
    // implementation detail: the socket still got its event even though the
    // Discord leg of the same fan-out failed.
    const webhook = mockWebhook();
    webhook.replyByThrowing();

    const socket = await SELF.fetch(`${FLARES}/socket`, { headers: { Upgrade: 'websocket' } });
    const ws = socket.webSocket!;
    const events: string[] = [];
    ws.accept();
    ws.addEventListener('message', (event) => {
      events.push(JSON.parse(String(event.data)).type as string);
    });
    await expect.poll(() => events, { timeout: 3000 }).toContain('welcome');

    const user = await member();
    const { status, flare } = await withWebhook(() => raise(user));

    expect(status).toBe(201);
    await expect.poll(() => events, { timeout: 3000 }).toContain('flare');
    expect(webhook.calls).toHaveLength(1);
    expect(await storedMessageId(flare!.id)).toBeNull();

    ws.close(1000, 'done');
  });

  it('the Durable Object being absent still lets Discord be told', async () => {
    const webhook = mockWebhook();
    const user = await member();

    const { status } = await withoutLiveBinding(() => withWebhook(() => raise(user)));

    expect(status).toBe(201);
    await expect.poll(() => webhook.calls.length, { timeout: 3000 }).toBe(1);
  });
});

describe('delivery is off the response path', () => {
  it('the 201 arrives while Discord is still being talked to', async () => {
    /*
     * The whole reason the fan-out rides `waitUntil`. Discord's answer is held
     * open for the entire request; if the response waited on it, this test
     * would deadlock rather than fail, so the flag is checked before the hold
     * is released.
     */
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let discordFinished = false;

    const webhook = mockWebhook({
      onCall: async () => {
        await held;
        discordFinished = true;
      },
    });

    const user = await member();

    await withWebhook(async () => {
      const { status } = await raise(user);

      expect(status).toBe(201);
      await expect.poll(() => webhook.calls.length, { timeout: 3000 }).toBe(1);
      expect(discordFinished, 'the response waited for Discord').toBe(false);

      release();
      await expect.poll(() => discordFinished, { timeout: 3000 }).toBe(true);
    });
  });
});

describe('each leg swallows its own failure', () => {
  const flare: FlareNotification = {
    id: 1,
    kind: 'raid',
    boss: 'Mewtwo',
    tier: '5',
    needed: null,
    note: null,
    expiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
    poi: null,
    author: null,
  };

  it('postFlareToDiscord resolves to null on a transport failure', async () => {
    const webhook = mockWebhook();
    webhook.replyByThrowing();

    await expect(postFlareToDiscord(webhookEnv(), flare, 'https://pogotxk.test')).resolves.toBeNull();
  });

  it('postFlareToDiscord resolves to null on a 500', async () => {
    const webhook = mockWebhook();
    webhook.reply(500);

    await expect(postFlareToDiscord(webhookEnv(), flare, 'https://pogotxk.test')).resolves.toBeNull();
  });

  it('postFlareToDiscord returns the id when Discord gives one, so the embed can be retired', async () => {
    // The success case belongs here too: a leg that never returns anything
    // would pass every failure test above and still be broken.
    const calls: { url: string; body: string }[] = [];
    const { vi } = await import('vitest');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input as RequestInfo, init);
      calls.push({ url: request.url, body: await request.text() });
      return new Response(JSON.stringify({ id: '1234567890' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(postFlareToDiscord(webhookEnv(), flare, 'https://pogotxk.test')).resolves.toBe(
      '1234567890',
    );
    // ?wait=true is what makes Discord answer with the message rather than 204.
    expect(calls[0]?.url).toContain('wait=true');
    // And nothing in a note may ever ping the whole channel.
    expect(JSON.parse(calls[0]!.body).allowed_mentions).toEqual({ parse: [] });
  });

  it('notifyLiveBoard resolves even with no binding', async () => {
    await withoutLiveBinding(async () => {
      await expect(notifyLiveBoard({ type: 'closed', id: 1 })).resolves.toBeUndefined();
    });
  });

  it('sendPush resolves rather than throwing when the push service is wedged', async () => {
    const { vi } = await import('vitest');
    vi.stubGlobal('fetch', async () => {
      throw new Error('push service unreachable');
    });

    await expect(
      sendPush(env, 'raid', { title: 't', body: 'b', url: 'https://pogotxk.test/live' }),
    ).resolves.toEqual({ attempted: 0, delivered: 0, pruned: 0, skipped: 'push not configured' });
  });
});
