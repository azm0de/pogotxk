/**
 * The LiveBoard Durable Object and `GET /api/flares/socket`.
 *
 * D1 is the source of truth and this object holds nothing durable, so almost
 * everything worth asserting is about delivery: who gets told, how many times,
 * and what happens when the binding is not there at all.
 *
 * The events arrive after the response that caused them — every route fans out
 * under `waitUntil` — so assertions on the socket poll rather than read once.
 */

import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HEARTBEAT,
  HEARTBEAT_ACK,
  LIVE_BOARD_NAME,
  liveNamespace,
  notifyLiveBoard,
  type LiveBoard,
  type LiveEvent,
} from '~/do/LiveBoard';
import { asUser, seedFlare, seedRsvp, seedUser, type SeededUser } from '../helpers/factories';
import { withoutLiveBinding } from './harness';

const SOCKET = 'https://pogotxk.test/api/flares/socket';

interface Watcher {
  ws: WebSocket;
  events: (LiveEvent | string)[];
  types: () => string[];
}

/**
 * Every socket a test opens, closed again before the next one starts.
 *
 * Not tidiness: `test/setup.ts` calls `evictAllDurableObjects` between tests,
 * and that never returns while this side of a pair is still open — which shows
 * up as a ten-second timeout in a shared `beforeEach` rather than as anything
 * to do with the test that left it behind.
 */
const opened: WebSocket[] = [];

function track(ws: WebSocket): WebSocket {
  opened.push(ws);
  return ws;
}

async function watch(): Promise<Watcher> {
  const res = await SELF.fetch(SOCKET, { headers: { Upgrade: 'websocket' } });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error('no webSocket on the 101');
  track(ws);

  const events: (LiveEvent | string)[] = [];
  ws.accept();
  ws.addEventListener('message', (event) => {
    const data = String(event.data);
    events.push(data.startsWith('{') ? (JSON.parse(data) as LiveEvent) : data);
  });

  const watcher: Watcher = {
    ws,
    events,
    types: () => events.map((e) => (typeof e === 'string' ? e : e.type)),
  };
  // Every connection opens with `welcome`; waiting for it here means a later
  // assertion is about the event under test rather than about connect timing.
  await expect.poll(() => watcher.types(), { timeout: 3000 }).toContain('welcome');
  return watcher;
}

function board() {
  const ns = liveNamespace();
  if (!ns) throw new Error('LIVE binding missing');
  return ns.getByName(LIVE_BOARD_NAME);
}

afterEach(() => {
  for (const ws of opened.splice(0)) {
    try {
      ws.close(1000, 'test over');
    } catch {
      // Already closed by the test, or by the runtime.
    }
  }
  expect(liveNamespace(), 'a test left the LIVE binding removed').not.toBeNull();
});

describe('the upgrade route', () => {
  it('answers 426 to a plain GET', async () => {
    const res = await SELF.fetch(SOCKET);
    expect(res.status).toBe(426);
  });

  it('answers 426 to any other verb', async () => {
    const res = await SELF.fetch(SOCKET, { method: 'POST' });
    // Astro has no POST export for this route, so it never reaches the guard.
    expect(res.status).not.toBe(101);
  });

  it('answers 503, not 500, when the binding is absent', async () => {
    // A degraded board, not a broken one: the client reads this as "no realtime
    // today" and falls back to polling /api/flares.
    await withoutLiveBinding(async () => {
      expect(liveNamespace()).toBeNull();
      const res = await SELF.fetch(SOCKET, { headers: { Upgrade: 'websocket' } });
      expect(res.status).toBe(503);
      await res.json();
    });
  });

  it('upgrades and needs no session — reading the board is public', async () => {
    const res = await SELF.fetch(SOCKET, { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(101);
    expect(res.webSocket).not.toBeNull();
    track(res.webSocket!).accept();
  });

  it('the object itself refuses a non-upgrade, so a caller bug is loud', async () => {
    const res = await board().fetch(new Request('https://live.internal/'));
    expect(res.status).toBe(426);
    // Read it. A response body left unconsumed on a Durable Object stub pins
    // the object, and `evictAllDurableObjects` in test/setup.ts then never
    // returns — which surfaces as every *later* test in the file timing out in
    // a `beforeEach` it has nothing to do with.
    expect(await res.text()).toMatch(/WebSocket/);
  });
});

describe('welcome and presence', () => {
  it('welcome carries the connection count and the server clock', async () => {
    const watcher = await watch();
    const welcome = watcher.events[0] as Extract<LiveEvent, { type: 'welcome' }>;

    expect(welcome.type).toBe('welcome');
    expect(welcome.connections).toBe(1);
    // The client corrects a skewed device clock against this before it starts
    // counting flares down; a phone five minutes fast would otherwise hide
    // flares that are still live for everyone else.
    expect(welcome.serverTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Math.abs(Date.parse(welcome.serverTime) - Date.now())).toBeLessThan(10_000);
  });

  it('a second watcher tells the first, but is not told about itself', async () => {
    const first = await watch();
    const second = await watch();

    await expect.poll(() => first.types(), { timeout: 3000 }).toContain('presence');
    const presence = first.events.find(
      (e): e is Extract<LiveEvent, { type: 'presence' }> =>
        typeof e !== 'string' && e.type === 'presence',
    );
    expect(presence?.connections).toBe(2);

    // The joiner's own count arrived in its welcome; a presence event on top
    // would be a second, contradictory number for the same moment.
    expect(second.types()).toEqual(['welcome']);
    expect((second.events[0] as Extract<LiveEvent, { type: 'welcome' }>).connections).toBe(2);
  });

  it('a watcher leaving is announced, and is not counted in the number', async () => {
    const staying = await watch();
    const leaving = await watch();
    await expect.poll(() => staying.types(), { timeout: 3000 }).toContain('presence');

    leaving.ws.close(1000, 'done');

    // The closing socket can still be in getWebSockets() at that moment, which
    // is why it is excluded by identity rather than trusted to have dropped.
    await expect
      .poll(
        () =>
          staying.events.filter(
            (e): e is Extract<LiveEvent, { type: 'presence' }> =>
              typeof e !== 'string' && e.type === 'presence',
          ).length,
        { timeout: 3000 },
      )
      .toBe(2);
    const last = staying.events.at(-1) as Extract<LiveEvent, { type: 'presence' }>;
    expect(last.connections).toBe(1);
  });

  it('connectionCount agrees with what the watchers were told', async () => {
    await watch();
    await watch();
    expect(await board().connectionCount()).toBe(2);
  });
});

describe('the heartbeat', () => {
  it('a ping is answered with a pong', async () => {
    // Registered as a WebSocket auto-response so the runtime answers it without
    // waking the object — a browser cannot send protocol-level pings from
    // JavaScript, so without this every keepalive would bill a wake-up.
    const watcher = await watch();
    watcher.ws.send(HEARTBEAT);

    await expect.poll(() => watcher.events, { timeout: 3000 }).toContain(HEARTBEAT_ACK);
  });

  it('anything else a client sends up the socket is dropped', async () => {
    // The socket is a one-way feed: every mutation goes through the
    // authenticated HTTP API. Noise is dropped rather than parsed.
    const watcher = await watch();
    watcher.ws.send(JSON.stringify({ type: 'closed', id: 1 }));
    watcher.ws.send('nonsense');

    await expect.poll(() => board().connectionCount(), { timeout: 3000 }).toBe(1);
    expect(watcher.types()).toEqual(['welcome']);
  });
});

describe('the events the routes broadcast', () => {
  async function member(): Promise<SeededUser> {
    return seedUser(env.DB, { role: 'member' });
  }

  it('raising a flare broadcasts the whole flare', async () => {
    const watcher = await watch();
    const user = await member();

    const res = await SELF.fetch(
      await asUser(env.DB, user, 'https://pogotxk.test/api/flares', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'raid', boss: 'Mewtwo', tier: '5' }),
      }),
    );
    const { flare } = (await res.json()) as { flare: { id: number } };

    await expect.poll(() => watcher.types(), { timeout: 3000 }).toContain('flare');
    const event = watcher.events.at(-1) as Extract<LiveEvent, { type: 'flare' }>;
    // The same object the HTTP response carried, so a client that missed the
    // socket and polled instead renders exactly the same card.
    expect(event.flare.id).toBe(flare.id);
    expect(event.flare.boss).toBe('Mewtwo');
    expect(event.flare.rsvps).toEqual({ coming: 0, here: 0, done: 0 });
  });

  it('an rsvp broadcasts an update with the new counts', async () => {
    const user = await member();
    const flare = await seedFlare(env.DB);
    const watcher = await watch();

    await SELF.fetch(
      await asUser(env.DB, user, `https://pogotxk.test/api/flares/${flare.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'rsvp', state: 'here' }),
      }),
    );

    await expect.poll(() => watcher.types(), { timeout: 3000 }).toContain('update');
    const event = watcher.events.at(-1) as Extract<LiveEvent, { type: 'update' }>;
    expect(event.flare.rsvps).toEqual({ coming: 0, here: 1, done: 0 });
  });

  it('the update carries no viewer-specific answer', async () => {
    // Flare rows go verbatim to every connected socket, so anything
    // viewer-specific has to stay out of them or one trainer's board would show
    // another's answers. `mine` lives on the HTTP response only.
    const user = await member();
    const flare = await seedFlare(env.DB);
    await seedRsvp(env.DB, flare, user, 'coming');
    const watcher = await watch();

    await SELF.fetch(
      await asUser(env.DB, user, `https://pogotxk.test/api/flares/${flare.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'rsvp', state: 'done' }),
      }),
    );

    await expect.poll(() => watcher.types(), { timeout: 3000 }).toContain('update');
    const event = watcher.events.at(-1) as Extract<LiveEvent, { type: 'update' }>;
    expect(Object.keys(event.flare)).not.toContain('mine');
  });

  it('an edit broadcasts an update with the corrected field', async () => {
    const author = await member();
    const flare = await seedFlare(env.DB, { kind: 'raid', boss: 'Mewtoo', createdBy: author.id });
    const watcher = await watch();

    await SELF.fetch(
      await asUser(env.DB, author, `https://pogotxk.test/api/flares/${flare.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'edit', boss: 'Mewtwo' }),
      }),
    );

    await expect.poll(() => watcher.types(), { timeout: 3000 }).toContain('update');
    const event = watcher.events.at(-1) as Extract<LiveEvent, { type: 'update' }>;
    expect(event.flare.boss).toBe('Mewtwo');
  });

  it('a close broadcasts the id alone', async () => {
    // Nothing else is needed: the card is being removed, not re-rendered.
    const author = await member();
    const flare = await seedFlare(env.DB, { createdBy: author.id });
    const watcher = await watch();

    await SELF.fetch(
      await asUser(env.DB, author, `https://pogotxk.test/api/flares/${flare.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'close' }),
      }),
    );

    await expect.poll(() => watcher.types(), { timeout: 3000 }).toContain('closed');
    expect(watcher.events.at(-1)).toEqual({ type: 'closed', id: flare.id });
  });

  it('every watcher gets it', async () => {
    const one = await watch();
    const two = await watch();

    await notifyLiveBoard({ type: 'closed', id: 99 });

    await expect.poll(() => one.types(), { timeout: 3000 }).toContain('closed');
    await expect.poll(() => two.types(), { timeout: 3000 }).toContain('closed');
  });

  it('publish reports how many sockets it reached', async () => {
    expect(await board().publish({ type: 'presence', connections: 0 })).toBe(0);
    await watch();
    expect(await board().publish({ type: 'presence', connections: 1 })).toBe(1);
  });
});

describe('the object keeps nothing of its own', () => {
  it('holds no durable storage, so a cold object cannot disagree with D1', async () => {
    await watch();
    await notifyLiveBoard({ type: 'closed', id: 1 });

    const stored = await runInDurableObject(board(), async (_instance: LiveBoard, state) => {
      const entries = await state.storage.list();
      return entries.size;
    });

    expect(stored).toBe(0);
  });

  it('a broadcast with nobody listening is not an error', async () => {
    await expect(notifyLiveBoard({ type: 'closed', id: 1 })).resolves.toBeUndefined();
  });

  it('notifyLiveBoard is a no-op when the binding is absent', async () => {
    await withoutLiveBinding(async () => {
      await expect(notifyLiveBoard({ type: 'closed', id: 1 })).resolves.toBeUndefined();
    });
  });
});
