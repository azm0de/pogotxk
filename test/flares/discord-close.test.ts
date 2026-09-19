/**
 * The Discord close sweep — `src/lib/notify/flare-closures.ts`.
 *
 * The board needs no sweep at all: `listActiveFlares` compares `expires_at` on
 * every read, so a lapsed flare stops being returned. Discord is the opposite
 * kind of surface. The embed is already sitting in the channel and only an edit
 * retires it, and this Worker has no cron, so the edit rides `GET /api/flares`.
 *
 * `discord_closed_at` is doing two jobs at once, and the second is the reason
 * this file is long: it is the marker for "settled", and it is the concurrency
 * claim. The claim is written in the same statement that selects the row, so two
 * overlapping board reads cannot both edit one message — a duplicate edit is the
 * failure users actually see, so the design takes a delayed edit over it. All of
 * that is written out in migrations/0002_flare_discord_close.sql.
 *
 * Read ./harness.ts before this file: it explains why a discord.com URL appears
 * in a test at all, and what keeps it from reaching anybody.
 */

import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { claimFlaresForDiscordClose } from '~/lib/db/flares';
import {
  closeFlareInDiscord,
  SWEEP_LIMIT,
  sweepFlareDiscordClosures,
} from '~/lib/notify/flare-closures';
import { asUser, iso, isoIn, seedFlare, seedUser } from '../helpers/factories';
import { mockWebhook, POSTED_MESSAGE_ID, webhookEnv, withWebhook } from './harness';

const now = (): string => iso();

function sweep(): ReturnType<typeof sweepFlareDiscordClosures> {
  return sweepFlareDiscordClosures(webhookEnv(), env.DB, now());
}

async function claimOf(id: number): Promise<string | null> {
  const row = await env.DB.prepare('SELECT discord_closed_at FROM flares WHERE id = ?1')
    .bind(id)
    .first<{ discord_closed_at: string | null }>();
  return row?.discord_closed_at ?? null;
}

async function messageIdOf(id: number): Promise<string | null> {
  const row = await env.DB.prepare('SELECT discord_message_id FROM flares WHERE id = ?1')
    .bind(id)
    .first<{ discord_message_id: string | null }>();
  return row?.discord_message_id ?? null;
}

async function pendingIds(): Promise<number[]> {
  const { results } = await env.DB.prepare(
    'SELECT id FROM flares WHERE discord_message_id IS NOT NULL AND discord_closed_at IS NULL ORDER BY id',
  ).all<{ id: number }>();
  return results.map((row) => row.id);
}

/** A flare that has ended and still owes Discord an edit. */
function owing(opts: Parameters<typeof seedFlare>[1] = {}) {
  return seedFlare(env.DB, { expired: true, discordMessageId: `msg-${Math.random()}`, ...opts });
}

afterEach(() => {
  // `withWebhook` restores it, but a mistake there would be silent and would
  // undo the one control this whole harness rests on.
  expect((env as unknown as Record<string, unknown>).DISCORD_WEBHOOK_URL).toBe('');
});

describe('what a sweep picks up', () => {
  it('edits an expired flare embed and marks it settled', async () => {
    const webhook = mockWebhook();
    const flare = await owing({ discordMessageId: 'msg-1' });

    const result = await sweep();

    expect(result).toEqual({ claimed: 1, edited: 1, gone: 0, released: 0 });
    expect(webhook.edited()).toEqual(['msg-1']);
    expect(webhook.calls[0]?.method).toBe('PATCH');
    expect(await claimOf(flare.id)).not.toBeNull();
  });

  it('says "expired" for a lapse and "closed" for a stand-down', async () => {
    // The two reasons a flare ends read differently in the channel, and the
    // sweep can only tell them apart by `closed_at` surviving the claim.
    const webhook = mockWebhook();
    await owing({ discordMessageId: 'msg-lapsed', expiresAt: isoIn(-600) });
    await owing({ discordMessageId: 'msg-stood-down', closed: true, expiresAt: isoIn(-300) });

    await sweep();

    const titles = new Map(
      webhook.calls.map((call) => [call.messageId, call.body.embeds?.[0]?.title]),
    );
    expect(titles.get('msg-lapsed')).toBe('⌛ Flare expired');
    expect(titles.get('msg-stood-down')).toBe('✅ Flare closed');
  });

  it('leaves a flare that is still burning alone', async () => {
    const webhook = mockWebhook();
    const live = await seedFlare(env.DB, { discordMessageId: 'msg-live' });

    expect(await sweep()).toEqual({ claimed: 0, edited: 0, gone: 0, released: 0 });
    expect(webhook.calls).toEqual([]);
    expect(await claimOf(live.id)).toBeNull();
  });

  it('ignores an ended flare that Discord never saw', async () => {
    const webhook = mockWebhook();
    await seedFlare(env.DB, { expired: true, discordMessageId: null });

    expect((await sweep()).claimed).toBe(0);
    expect(webhook.calls).toEqual([]);
  });

  it('does not edit a message that is already settled', async () => {
    const webhook = mockWebhook();
    await owing({ discordMessageId: 'msg-done', discordClosedAt: iso() });

    expect((await sweep()).claimed).toBe(0);
    expect(webhook.calls).toEqual([]);
  });

  it('a second sweep straight after the first has nothing to do', async () => {
    const webhook = mockWebhook();
    await owing({ discordMessageId: 'msg-1' });

    await sweep();
    const second = await sweep();

    expect(second.claimed).toBe(0);
    expect(webhook.edited()).toEqual(['msg-1']);
  });
});

describe('with no webhook configured', () => {
  it('claims nothing, so the hottest endpoint on the site costs no writes', async () => {
    // The early exit is not an optimisation. Claiming rows only to release them
    // would put two writes on every board read of every deployment that has
    // not set DISCORD_WEBHOOK_URL — which is the normal state.
    const webhook = mockWebhook();
    const flare = await owing();

    const result = await sweepFlareDiscordClosures(env, env.DB, now());

    expect(result).toEqual({ claimed: 0, edited: 0, gone: 0, released: 0 });
    expect(webhook.calls).toEqual([]);
    expect(await claimOf(flare.id)).toBeNull();
  });

  it('a close settles nothing either, so the edit survives for later', async () => {
    // `disabled` must not mark a row settled: the embed was never posted by
    // this deployment, and marking it would lose the edit forever if the
    // webhook were configured a minute later.
    const webhook = mockWebhook();
    const flare = await owing();

    expect(await closeFlareInDiscord(env, env.DB, flare.id, now())).toEqual({
      claimed: 0,
      edited: 0,
      gone: 0,
      released: 0,
    });
    expect(webhook.calls).toEqual([]);
    expect(await claimOf(flare.id)).toBeNull();
  });
});

describe('failures decide whether the claim is kept', () => {
  it.each([429, 500, 502, 503])('%i hands the claim back for a later pass', async (status) => {
    const webhook = mockWebhook();
    webhook.reply(status);
    const flare = await owing({ discordMessageId: 'msg-1' });

    const result = await sweep();

    expect(result).toEqual({ claimed: 1, edited: 0, gone: 0, released: 1 });
    expect(await claimOf(flare.id)).toBeNull();

    // And the next pass genuinely retries it, which is the whole point of
    // handing it back.
    webhook.reply(204);
    expect((await sweep()).edited).toBe(1);
    expect(webhook.edited()).toEqual(['msg-1', 'msg-1']);
  });

  it('a transport failure is retryable too', async () => {
    // A timeout says nothing about whether the message is still there.
    const webhook = mockWebhook();
    webhook.replyByThrowing();
    const flare = await owing();

    expect((await sweep()).released).toBe(1);
    expect(await claimOf(flare.id)).toBeNull();
  });

  it.each([401, 403, 404])('%i is treated as gone and never retried', async (status) => {
    /*
     * A manually deleted message, or a rotated webhook. No number of retries
     * fixes either, and re-attempting it on every board read for the life of
     * the deployment is the failure mode this classification exists to avoid.
     */
    const webhook = mockWebhook();
    webhook.reply(status);
    const flare = await owing({ discordMessageId: 'msg-gone' });

    const result = await sweep();

    expect(result).toEqual({ claimed: 1, edited: 0, gone: 1, released: 0 });
    expect(await claimOf(flare.id)).not.toBeNull();

    webhook.reply(204);
    expect((await sweep()).claimed).toBe(0);
    expect(webhook.edited()).toEqual(['msg-gone']);
  });

  it('one failure does not abandon the rest of the pass', async () => {
    const webhook = mockWebhook();
    webhook.replyEach(429, 204, 404);
    await owing({ expiresAt: isoIn(-300) });
    await owing({ expiresAt: isoIn(-200) });
    await owing({ expiresAt: isoIn(-100) });

    expect(await sweep()).toEqual({ claimed: 3, edited: 1, gone: 1, released: 1 });
  });
});

describe('the sweep is bounded', () => {
  it('claims at most SWEEP_LIMIT in one pass, oldest first', async () => {
    // Discord rate-limits webhooks per channel and a busy evening can lapse a
    // dozen flares inside a minute. The remainder is picked up by the next
    // read; the work is idempotent, so spreading it costs nothing.
    const webhook = mockWebhook();
    const total = SWEEP_LIMIT + 2;
    for (let i = 0; i < total; i++) {
      await owing({ discordMessageId: `msg-${i}`, expiresAt: isoIn(-(total - i) * 60) });
    }

    const first = await sweep();

    expect(first.claimed).toBe(SWEEP_LIMIT);
    expect(webhook.calls).toHaveLength(SWEEP_LIMIT);
    // ORDER BY expires_at: the embed that has been wrong longest is corrected
    // first.
    expect(webhook.edited()).toEqual(
      Array.from({ length: SWEEP_LIMIT }, (_, i) => `msg-${i}`),
    );

    const second = await sweep();
    expect(second.claimed).toBe(2);
    expect(await pendingIds()).toEqual([]);
  });
});

describe('the claim is a claim, not a marker', () => {
  it('two overlapping sweeps split the work and edit nothing twice', async () => {
    /*
     * The race the column exists for. Both sweeps issue their claiming UPDATE
     * before either resolves, so this is the real interleaving rather than a
     * simulation of it: whichever statement lands first takes the rows, and the
     * other sees none. A select-then-update would let both read the same rows
     * and strike the same message through twice.
     */
    const webhook = mockWebhook();
    for (let i = 0; i < 4; i++) await owing({ discordMessageId: `msg-${i}` });

    const [a, b] = await Promise.all([sweep(), sweep()]);

    expect(a.claimed + b.claimed).toBe(4);
    expect(a.edited + b.edited).toBe(4);
    expect(webhook.edited()).toHaveLength(4);
    expect(new Set(webhook.edited()).size).toBe(4);
    expect(await pendingIds()).toEqual([]);
  });

  it('a sweep already talking to Discord blocks a second one from the same row', async () => {
    // Holds the first request open across the second sweep's entire claim, so
    // the second is asking the database precisely while the first is in flight
    // — the window a marker written after the call would leave open.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let second: Awaited<ReturnType<typeof sweep>> | undefined;

    const webhook = mockWebhook({
      onCall: async () => {
        if (!second) {
          second = await sweep();
          release();
        }
        await held;
      },
    });

    await owing({ discordMessageId: 'msg-1' });

    const first = await sweep();

    expect(first).toEqual({ claimed: 1, edited: 1, gone: 0, released: 0 });
    expect(second).toEqual({ claimed: 0, edited: 0, gone: 0, released: 0 });
    expect(webhook.edited()).toEqual(['msg-1']);
  });

  it('a close racing the sweep produces one edit, not two', async () => {
    const webhook = mockWebhook();
    const flare = await owing({ discordMessageId: 'msg-1', closed: true });

    const [closed, swept] = await Promise.all([
      closeFlareInDiscord(webhookEnv(), env.DB, flare.id, now()),
      sweep(),
    ]);

    expect(closed.claimed + swept.claimed).toBe(1);
    expect(webhook.edited()).toEqual(['msg-1']);
  });

  it('a claim is taken before Discord is called, not after', async () => {
    // Stated directly rather than inferred from the races above: while the
    // PATCH is in flight the row already reads as settled.
    let claimDuringCall: string | null = null;
    mockWebhook({
      onCall: async () => {
        claimDuringCall = await claimOf(flare.id);
      },
    });
    const flare = await owing();

    await sweep();

    expect(claimDuringCall).not.toBeNull();
  });

  it('claimFlaresForDiscordClose returns each row to exactly one caller', async () => {
    // The statement on its own, with no Discord in the way at all.
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) ids.push((await owing()).id);

    const [a, b, c] = await Promise.all([
      claimFlaresForDiscordClose(env.DB, now(), 6),
      claimFlaresForDiscordClose(env.DB, now(), 6),
      claimFlaresForDiscordClose(env.DB, now(), 6),
    ]);

    const claimed = [...a, ...b, ...c].map((row) => row.id).sort((x, y) => x - y);
    expect(claimed).toEqual(ids.sort((x, y) => x - y));
  });
});

describe('closing one flare goes through the same claim', () => {
  it('settles only the flare named', async () => {
    const webhook = mockWebhook();
    const mine = await owing({ discordMessageId: 'msg-mine' });
    const other = await owing({ discordMessageId: 'msg-other' });

    const result = await closeFlareInDiscord(webhookEnv(), env.DB, mine.id, now());

    expect(result).toEqual({ claimed: 1, edited: 1, gone: 0, released: 0 });
    expect(webhook.edited()).toEqual(['msg-mine']);
    expect(await claimOf(other.id)).toBeNull();
  });

  it('does nothing for a flare that has not ended', async () => {
    const webhook = mockWebhook();
    const live = await seedFlare(env.DB, { discordMessageId: 'msg-live' });

    expect((await closeFlareInDiscord(webhookEnv(), env.DB, live.id, now())).claimed).toBe(0);
    expect(webhook.calls).toEqual([]);
  });
});

describe('the board read is what drives the sweep', () => {
  it('GET /api/flares settles a lapsed embed', async () => {
    // There is no cron on this Worker. If this ever stops being true, every
    // expired flare keeps advertising itself in the channel indefinitely —
    // which is the bug migration 0002 was written to fix.
    const webhook = mockWebhook();
    const flare = await owing({ discordMessageId: 'msg-1' });

    await withWebhook(async () => {
      const res = await SELF.fetch('https://pogotxk.test/api/flares');
      expect(res.status).toBe(200);
      await res.json();
      // The sweep rides waitUntil, so the edit lands after the response.
      await expect
        .poll(() => webhook.edited(), { timeout: 3000 })
        .toEqual(['msg-1']);
    });

    expect(await claimOf(flare.id)).not.toBeNull();
  });

  it('PATCH close settles the embed for the flare just closed', async () => {
    const webhook = mockWebhook();
    const author = await seedUser(env.DB, { role: 'member' });
    const flare = await seedFlare(env.DB, { createdBy: author.id, discordMessageId: 'msg-1' });

    await withWebhook(async () => {
      const res = await SELF.fetch(
        await asUser(env.DB, author, `https://pogotxk.test/api/flares/${flare.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'close' }),
        }),
      );
      expect(res.status).toBe(200);
      await res.json();
      await expect.poll(() => webhook.edited(), { timeout: 3000 }).toEqual(['msg-1']);
    });

    expect(webhook.calls[0]?.body.embeds?.[0]?.title).toBe('✅ Flare closed');
  });

  it('the whole life of an embed: posted, its id kept, then struck through', async () => {
    // The loop the `discord_message_id` column exists for. It has been stored
    // since migration 0001 and nothing read it until 0002, which is how every
    // embed ever posted stayed looking live — so the link between the two
    // halves is worth asserting end to end rather than one half at a time.
    const webhook = mockWebhook();
    const author = await seedUser(env.DB, { role: 'member' });

    const flareId = await withWebhook(async () => {
      const created = await SELF.fetch(
        await asUser(env.DB, author, 'https://pogotxk.test/api/flares', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'raid', boss: 'Mewtwo' }),
        }),
      );
      expect(created.status).toBe(201);
      const { flare } = (await created.json()) as { flare: { id: number } };

      await expect
        .poll(() => messageIdOf(flare.id), { timeout: 3000 })
        .toBe(POSTED_MESSAGE_ID);

      const closed = await SELF.fetch(
        await asUser(env.DB, author, `https://pogotxk.test/api/flares/${flare.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'close' }),
        }),
      );
      expect(closed.status).toBe(200);
      await closed.json();

      await expect
        .poll(() => webhook.edited(), { timeout: 3000 })
        .toEqual([POSTED_MESSAGE_ID]);

      return flare.id;
    });

    expect(await claimOf(flareId)).not.toBeNull();
  });

  it('with the webhook blank, a board read sends nothing and claims nothing', async () => {
    // The state every test in the rest of the harness runs in, asserted rather
    // than assumed: the hot path is silent.
    const webhook = mockWebhook();
    const flare = await owing();

    const res = await SELF.fetch('https://pogotxk.test/api/flares');
    await res.json();

    expect(webhook.calls).toEqual([]);
    expect(await claimOf(flare.id)).toBeNull();
  });
});
