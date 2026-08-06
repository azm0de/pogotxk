/**
 * Web Push subscription management.
 *
 *   GET    → the VAPID public key, so the client can call subscribe()
 *   POST   → store or update a subscription
 *   DELETE → remove one
 *
 * The public key is served rather than baked into the bundle so that neither
 * half of the keypair has to be committed: both live as Worker secrets, and
 * rotating them needs no rebuild.
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { handler, json, readJson, requireUser } from '~/lib/api';
import { pushPublicKey } from '~/lib/notify/push';

export const prerender = false;

const TOPICS = ['raid', 'meetup', 'post'] as const;

const subscribeInput = z.object({
  endpoint: z.string().url().max(600),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(100),
  }),
  topics: z.array(z.enum(TOPICS)).min(1).optional(),
});

export const GET = handler(async () => {
  const key = pushPublicKey(env);
  return json(
    { publicKey: key, enabled: key !== null },
    200,
    // The key is public but rotating it must take effect promptly.
    { 'cache-control': 'public, max-age=300' },
  );
});

export const POST = handler(async (ctx: APIContext) => {
  // Tied to an account so a flare can skip notifying its own author, and so
  // members can be unsubscribed if they leave the community.
  const user = requireUser(ctx);
  const input = await readJson(ctx, subscribeInput);

  const topics = JSON.stringify(input.topics ?? TOPICS);

  await env.DB.prepare(
    `INSERT INTO push_subs (user_id, endpoint, p256dh, auth, topics_json, user_agent)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (endpoint) DO UPDATE SET
       user_id     = excluded.user_id,
       p256dh      = excluded.p256dh,
       auth        = excluded.auth,
       topics_json = excluded.topics_json,
       -- Re-subscribing is how a browser recovers a subscription the push
       -- service had expired, so clear any previous failure.
       failed_at   = NULL`,
  )
    .bind(
      user.id,
      input.endpoint,
      input.keys.p256dh,
      input.keys.auth,
      topics,
      (ctx.request.headers.get('user-agent') ?? '').slice(0, 200),
    )
    .run();

  return json({ ok: true, topics: JSON.parse(topics) as string[] }, 201);
});

export const DELETE = handler(async (ctx: APIContext) => {
  requireUser(ctx);
  const { endpoint } = await readJson(ctx, z.object({ endpoint: z.string().url().max(600) }));

  await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?1').bind(endpoint).run();
  return json({ ok: true });
});
