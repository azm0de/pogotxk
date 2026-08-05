/**
 * LiveBoard — the fan-out hub behind /live.
 *
 * Shape of the system: D1 is the source of truth for flares. An API route
 * writes there first, then tells this object what happened; the object's only
 * job is to push that to whoever is watching. It stores no flares of its own,
 * which means a cold object, a redeploy, or an eviction can never disagree with
 * the database — a reconnecting client re-reads /api/flares and is instantly
 * correct again.
 *
 * Two decisions worth spelling out:
 *
 * 1. WebSocket *hibernation* (`ctx.acceptWebSocket` + the `webSocketMessage` /
 *    `webSocketClose` handlers), not `addEventListener`. A community board sits
 *    idle for most of the day. With hibernation the object is evicted from
 *    memory while the sockets stay open, and no billable duration accrues until
 *    a message actually arrives. The `addEventListener` API pins the object in
 *    memory for as long as one client has the tab open, which on this traffic
 *    profile is the difference between free and not.
 *
 * 2. No alarm and no stored expiry schedule. Every flare carries `expiresAt`,
 *    every reader filters on it, and the client prunes against a server-
 *    corrected clock, so expiry needs neither a cron nor a timer here. Adding
 *    one would mean this object holding a second copy of D1's state, which is
 *    exactly what point 1 avoids.
 */

import { DurableObject, env } from 'cloudflare:workers';
import type { Flare } from '~/lib/db/flares';

/**
 * One board for the whole community today. Named rather than unique-id'd so any
 * request can reach it without storing an id anywhere; if zones ever need their
 * own boards, the zone slug becomes the name and nothing else changes.
 */
export const LIVE_BOARD_NAME = 'texarkana';

/**
 * Client heartbeat. Registered as a WebSocket auto-response, which the runtime
 * answers *without* waking the object — a browser cannot send protocol-level
 * pings from JavaScript, so without this every keepalive would bill a wake-up.
 */
export const HEARTBEAT = 'ping';
export const HEARTBEAT_ACK = 'pong';

/** Everything the server pushes down the socket. Nothing here is per-viewer. */
export type LiveEvent =
  | { type: 'welcome'; connections: number; serverTime: string }
  | { type: 'flare'; flare: Flare }
  | { type: 'update'; flare: Flare }
  | { type: 'closed'; id: number }
  | { type: 'presence'; connections: number };

export class LiveBoard extends DurableObject {
  constructor(ctx: DurableObjectState, environment: Cloudflare.Env) {
    super(ctx, environment);

    // The constructor runs again every time the object wakes from hibernation,
    // so it has to stay cheap and idempotent. Re-registering the auto-response
    // pair is both.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT, HEARTBEAT_ACK));
  }

  /** WebSocket upgrade. Anything else here is a caller bug. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernatable accept. `server.accept()` would work but would keep this
    // object resident for the life of the connection.
    this.ctx.acceptWebSocket(server);

    const connections = this.openSockets().length;

    // `serverTime` lets the client correct for a skewed device clock before it
    // starts counting flares down — a phone five minutes fast would otherwise
    // hide flares that are still live for everyone else.
    this.send(server, {
      type: 'welcome',
      connections,
      serverTime: new Date().toISOString(),
    });
    this.broadcast({ type: 'presence', connections }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Publish an event to every watcher. Called over RPC from the API routes
   * after the write to D1 has committed.
   */
  async publish(event: LiveEvent): Promise<number> {
    return this.broadcast(event);
  }

  /** Watcher count, for diagnostics. */
  async connectionCount(): Promise<number> {
    return this.openSockets().length;
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // The socket is a one-way feed: every mutation goes through the
    // authenticated HTTP API, where the session cookie and role check live.
    // Anything arriving here is either the heartbeat (normally swallowed by the
    // auto-response, handled again in case an older client predates it) or
    // noise, and noise is dropped rather than parsed.
    if (typeof message === 'string' && message === HEARTBEAT) {
      this.send(ws, HEARTBEAT_ACK);
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    // The closing socket can still be in getWebSockets() at this point, so it is
    // excluded explicitly rather than trusted to have dropped out already.
    this.broadcast({ type: 'presence', connections: this.openSockets(ws).length }, ws);
  }

  override async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.error('LiveBoard socket error', error);
  }

  /** Open sockets, optionally excluding one that is on its way out. */
  private openSockets(except?: WebSocket): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws !== except && ws.readyState === WebSocket.OPEN);
  }

  private send(ws: WebSocket, event: LiveEvent | string): void {
    try {
      ws.send(typeof event === 'string' ? event : JSON.stringify(event));
    } catch {
      // A socket that died between the readyState check and the send is not an
      // error worth logging — webSocketClose will tidy up.
    }
  }

  private broadcast(event: LiveEvent, except?: WebSocket): number {
    const payload = JSON.stringify(event);
    let delivered = 0;
    for (const ws of this.openSockets(except)) {
      try {
        ws.send(payload);
        delivered += 1;
      } catch {
        // As above.
      }
    }
    return delivered;
  }
}

/**
 * The LIVE binding, or null when it is not configured.
 *
 * `LIVE` is absent from the generated `Cloudflare.Env` until the binding is
 * uncommented in wrangler.jsonc and `wrangler types` is re-run, hence the cast.
 * Returning null instead of throwing is deliberate: the flare API must keep
 * working with the Durable Object switched off — writes still land in D1 and
 * clients fall back to polling — so a missing binding degrades the board rather
 * than breaking it.
 */
export function liveNamespace(): DurableObjectNamespace<LiveBoard> | null {
  return (env as unknown as { LIVE?: DurableObjectNamespace<LiveBoard> }).LIVE ?? null;
}

/**
 * Best-effort fan-out. Never throws: the write to D1 has already succeeded by
 * the time this runs, and failing the caller's request because a broadcast
 * missed would turn a cosmetic problem into a lost flare.
 */
export async function notifyLiveBoard(event: LiveEvent): Promise<void> {
  const ns = liveNamespace();
  if (!ns) return;

  try {
    await ns.getByName(LIVE_BOARD_NAME).publish(event);
  } catch (err) {
    console.error('LiveBoard publish failed', err);
  }
}
