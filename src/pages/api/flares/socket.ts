/**
 * WebSocket upgrade for the live board.
 *
 *   GET /api/flares/socket   (Upgrade: websocket)
 *
 * Reading the board is public — the flares themselves are public — so this
 * route does no auth. Every *write* goes through the JSON API, which is where
 * the session cookie and the `member` role check live; the socket is a one-way
 * feed and the Durable Object ignores anything a client sends up it.
 *
 * The request is handed to the Durable Object untouched so the Upgrade header,
 * Sec-WebSocket-Key and friends survive the hop.
 */

import type { APIContext } from 'astro';
import { ApiError, handler } from '~/lib/api';
import { liveNamespace, LIVE_BOARD_NAME } from '~/do/LiveBoard';

export const prerender = false;

export const GET = handler(async (ctx: APIContext) => {
  if (ctx.request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    throw new ApiError(426, 'This endpoint speaks WebSocket only');
  }

  const ns = liveNamespace();
  if (!ns) {
    // The LIVE binding is not configured. 503 rather than 500: the client
    // treats it as "no realtime today" and falls back to polling /api/flares,
    // which is a degraded board rather than a broken one.
    throw new ApiError(503, 'Live updates are unavailable');
  }

  return ns.getByName(LIVE_BOARD_NAME).fetch(ctx.request);
});
