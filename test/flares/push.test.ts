/**
 * Web Push for a flare: the copy, and who it reaches.
 *
 * The copy is the whole of what a trainer sees on a locked phone, so it is
 * asserted literally rather than by shape. The reach is the part with a rule in
 * it — the author is excluded from their own flare's notification, which is a
 * decision made in the route rather than in `sendPush`, so it is tested through
 * the route.
 *
 * Getting past `vapidKeys` needs a real keypair; `withPush` in ./harness.ts
 * generates one per call and explains why that is safe. Every push endpoint
 * here is a seeded row, and `test/setup.ts` empties `push_subs` before every
 * test, so there is nothing real to reach even before `fetch` is stubbed.
 */

import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLARE_KINDS, type FlareKind } from '~/lib/db/flares';
import type { FlareNotification } from '~/lib/notify/discord';
import { sendPush } from '~/lib/notify/push';
import { pushBody, pushTitle } from '~/pages/api/flares/index';
import { asUser, seedUser, type SeededUser } from '../helpers/factories';
import { generateSubscriptionKeys, withPush } from './harness';

/* ------------------------------------------------------------------- copy */

function notification(over: Partial<FlareNotification> = {}): FlareNotification {
  return {
    id: 1,
    kind: 'raid',
    boss: null,
    tier: null,
    needed: null,
    note: null,
    expiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
    poi: null,
    author: null,
    ...over,
  };
}

describe('the title a trainer sees', () => {
  it('a raid leads with the boss when there is one', async () => {
    expect(pushTitle(notification({ kind: 'raid', boss: 'Mewtwo' }))).toBe('🔥 Mewtwo raid');
  });

  it('a raid without a boss says a raid is starting', async () => {
    expect(pushTitle(notification({ kind: 'raid' }))).toBe('🔥 Raid starting');
  });

  it('remote invites lead with the count when there is one', async () => {
    expect(pushTitle(notification({ kind: 'remote_invites', needed: 3 }))).toBe(
      '📣 3 remote invites',
    );
  });

  it('remote invites without a count still say what they are', async () => {
    expect(pushTitle(notification({ kind: 'remote_invites' }))).toBe('📣 Remote invites');
    // Zero is not a count worth printing, and the schema will not store it.
    expect(pushTitle(notification({ kind: 'remote_invites', needed: 0 }))).toBe('📣 Remote invites');
  });

  it.each([
    ['gym_takedown', 'Gym takedown at the park'],
    ['meetup_here', 'Meet me here at the park'],
    ['trade', 'Trade at the park'],
    ['help', 'Need a hand at the park'],
  ] as const)('a %s falls back to its label', async (kind, expected) => {
    expect(pushTitle(notification({ kind }))).toBe(expected);
  });

  it('every kind produces a title, so no flare notifies with nothing on it', async () => {
    for (const kind of FLARE_KINDS) {
      expect(pushTitle(notification({ kind })).length).toBeGreaterThan(0);
    }
  });

  it('the boss on a raid is not truncated or escaped', async () => {
    // The names come from the ScrapedDuck list and carry punctuation.
    expect(pushTitle(notification({ kind: 'raid', boss: "Farfetch'd (Galarian)" }))).toBe(
      "🔥 Farfetch'd (Galarian) raid",
    );
  });
});

describe('the body a trainer sees', () => {
  const poi = { name: 'Bramlett Field', slug: 'bramlett', lat: 0, lng: 0 };

  it('names the place and the trainer when there is no note', async () => {
    expect(pushBody(notification({ poi, author: { name: 'azm.0' } }))).toBe(
      'Bramlett Field — azm.0',
    );
  });

  it('prefers the note over the trainer, because the note is what they chose to say', async () => {
    expect(pushBody(notification({ poi, author: { name: 'azm.0' }, note: 'level 40s only' }))).toBe(
      'Bramlett Field: level 40s only',
    );
  });

  it('falls back to the park when the flare has no location', async () => {
    // A flare with no POI is still somewhere; the park is where this community
    // plays, and "undefined" on a lock screen is worse than a good guess.
    expect(pushBody(notification({ author: { name: 'azm.0' } }))).toBe('Spring Lake Park — azm.0');
  });

  it('says only the place when there is neither note nor author', async () => {
    expect(pushBody(notification({ poi }))).toBe('Bramlett Field');
  });
});

/* ------------------------------------------------------------------ reach */

interface Sub {
  userId: number | null;
  endpoint: string;
  topics?: string[];
}

async function seedSub({ userId, endpoint, topics }: Sub): Promise<void> {
  const keys = await generateSubscriptionKeys();
  await env.DB.prepare(
    `INSERT INTO push_subs (user_id, endpoint, p256dh, auth, topics_json)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(
      userId,
      endpoint,
      keys.p256dh,
      keys.auth,
      JSON.stringify(topics ?? ['raid', 'meetup', 'post']),
    )
    .run();
}

/** Records which endpoints were actually pushed to. */
function capturePush(status = 201): { hit: () => string[] } {
  const hit: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    hit.push(request.url);
    return new Response(null, { status });
  });
  return { hit: () => hit.slice().sort() };
}

function member(): Promise<SeededUser> {
  return seedUser(env.DB, { role: 'member' });
}

async function raise(user: SeededUser, kind: FlareKind = 'raid'): Promise<number> {
  const res = await SELF.fetch(
    await asUser(env.DB, user, 'https://pogotxk.test/api/flares', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, boss: kind === 'raid' ? 'Mewtwo' : undefined }),
    }),
  );
  const body = (await res.json()) as { flare: { id: number } };
  expect(res.status).toBe(201);
  return body.flare.id;
}

afterEach(() => {
  const bag = env as unknown as Record<string, unknown>;
  for (const key of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) {
    expect(bag[key], `${key} was left configured`).toBe('');
  }
});

describe('the trainer who raised it is not told about it', () => {
  it('everyone else is', async () => {
    const author = await member();
    const other = await member();
    await seedSub({ userId: author.id, endpoint: 'https://push.invalid/author' });
    await seedSub({ userId: other.id, endpoint: 'https://push.invalid/other' });

    const push = capturePush();
    await withPush(async () => {
      await raise(author);
      await expect.poll(() => push.hit().length, { timeout: 3000 }).toBe(1);
    });

    expect(push.hit()).toEqual(['https://push.invalid/other']);
  });

  it('the author is skipped on every one of their own subscriptions', async () => {
    // One trainer, a phone and a tablet. Excluding by user, not by endpoint.
    const author = await member();
    const other = await member();
    await seedSub({ userId: author.id, endpoint: 'https://push.invalid/author-phone' });
    await seedSub({ userId: author.id, endpoint: 'https://push.invalid/author-tablet' });
    await seedSub({ userId: other.id, endpoint: 'https://push.invalid/other' });

    const push = capturePush();
    await withPush(async () => {
      await raise(author);
      await expect.poll(() => push.hit().length, { timeout: 3000 }).toBe(1);
    });

    expect(push.hit()).toEqual(['https://push.invalid/other']);
  });

  it('a subscription with no user attached is still told', async () => {
    // We cannot know it is not the author, and going silent on everyone
    // anonymous to spare one person a buzz is the wrong trade.
    const author = await member();
    await seedSub({ userId: null, endpoint: 'https://push.invalid/anonymous' });

    const push = capturePush();
    await withPush(async () => {
      await raise(author);
      await expect.poll(() => push.hit().length, { timeout: 3000 }).toBe(1);
    });

    expect(push.hit()).toEqual(['https://push.invalid/anonymous']);
  });

  it('a flare with nobody else subscribed sends nothing and still answers 201', async () => {
    const author = await member();
    await seedSub({ userId: author.id, endpoint: 'https://push.invalid/author' });

    const push = capturePush();
    await withPush(async () => {
      await raise(author);
    });

    expect(push.hit()).toEqual([]);
  });
});

describe('who sendPush selects', () => {
  it('skips a subscription already marked dead', async () => {
    const other = await member();
    await seedSub({ userId: other.id, endpoint: 'https://push.invalid/live' });
    await seedSub({ userId: other.id, endpoint: 'https://push.invalid/dead' });
    await env.DB.prepare(
      "UPDATE push_subs SET failed_at = '2026-01-01T00:00:00Z' WHERE endpoint LIKE '%dead'",
    ).run();

    const push = capturePush();
    const result = await withPush((vapid) =>
      sendPush(
        { ...env, ...vapidEnv(vapid) } as unknown as Env,
        'raid',
        { title: 't', body: 'b', url: 'https://pogotxk.test/live' },
        null,
      ),
    );

    expect(result.attempted).toBe(1);
    expect(push.hit()).toEqual(['https://push.invalid/live']);
  });

  it('honours the topic list on the subscription', async () => {
    const other = await member();
    await seedSub({ userId: other.id, endpoint: 'https://push.invalid/raids', topics: ['raid'] });
    await seedSub({ userId: other.id, endpoint: 'https://push.invalid/posts', topics: ['post'] });

    const push = capturePush();
    await withPush((vapid) =>
      sendPush(
        { ...env, ...vapidEnv(vapid) } as unknown as Env,
        'raid',
        { title: 't', body: 'b', url: 'https://pogotxk.test/live' },
        null,
      ),
    );

    expect(push.hit()).toEqual(['https://push.invalid/raids']);
  });

  it('sends to a row whose topics are unreadable rather than dropping somebody', async () => {
    const other = await member();
    await seedSub({ userId: other.id, endpoint: 'https://push.invalid/broken' });
    await env.DB.prepare("UPDATE push_subs SET topics_json = 'not json'").run();

    const push = capturePush();
    await withPush((vapid) =>
      sendPush(
        { ...env, ...vapidEnv(vapid) } as unknown as Env,
        'raid',
        { title: 't', body: 'b', url: 'https://pogotxk.test/live' },
        null,
      ),
    );

    expect(push.hit()).toEqual(['https://push.invalid/broken']);
  });

  it.each([404, 410])('%i marks the subscription permanently dead', async (status) => {
    const other = await member();
    await seedSub({ userId: other.id, endpoint: 'https://push.invalid/gone' });

    capturePush(status);
    const result = await withPush((vapid) =>
      sendPush(
        { ...env, ...vapidEnv(vapid) } as unknown as Env,
        'raid',
        { title: 't', body: 'b', url: 'https://pogotxk.test/live' },
        null,
      ),
    );

    expect(result.pruned).toBe(1);
    const row = await env.DB.prepare('SELECT failed_at FROM push_subs').first<{
      failed_at: string | null;
    }>();
    expect(row?.failed_at).not.toBeNull();
  });

  it.each([429, 500, 503])('%i leaves the subscription alone', async (status) => {
    // Dropping a subscriber over a blip means they never hear about a raid
    // again. Only 404 and 410 mean permanently gone.
    const other = await member();
    await seedSub({ userId: other.id, endpoint: 'https://push.invalid/wobbly' });

    capturePush(status);
    const result = await withPush((vapid) =>
      sendPush(
        { ...env, ...vapidEnv(vapid) } as unknown as Env,
        'raid',
        { title: 't', body: 'b', url: 'https://pogotxk.test/live' },
        null,
      ),
    );

    expect(result).toMatchObject({ attempted: 1, delivered: 0, pruned: 0 });
    const row = await env.DB.prepare('SELECT failed_at FROM push_subs').first<{
      failed_at: string | null;
    }>();
    expect(row?.failed_at).toBeNull();
  });
});

describe('the topic every flare is sent under', () => {
  it("is 'raid', whatever the kind", async () => {
    /*
     * Pinned rather than endorsed. `push_subs.topics_json` can hold any of
     * raid/meetup/post and POST /api/push/subscribe accepts a partial list,
     * but the flare route sends every kind — meetups and trades included —
     * under 'raid'. Nothing in the UI produces a partial list today, so every
     * subscription carries all three and nobody misses anything. The day a
     * per-topic control appears, a trainer who unticks raids stops being told
     * about "meet me here" as well. Flagged to the humans; changing it is a
     * product decision, not a tidy-up.
     */
    const author = await member();
    const other = await member();
    await seedSub({ userId: other.id, endpoint: 'https://push.invalid/meetups', topics: ['meetup'] });

    const push = capturePush();
    await withPush(async () => {
      await raise(author, 'meetup_here');
      // Nothing to wait for; assert after the fan-out has had a turn.
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    expect(push.hit()).toEqual([]);
  });
});

function vapidEnv(vapid: { publicKey: string; privateKey: string }): Record<string, string> {
  return {
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: 'mailto:tests@pogotxk.invalid',
  };
}
