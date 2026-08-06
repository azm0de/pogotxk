/**
 * Web Push fan-out.
 *
 * Subscriptions live in `push_subs`. A push service answering 404 or 410 means
 * the subscription is permanently dead — the browser was uninstalled, or the
 * user revoked permission — so those rows are marked failed and skipped from
 * then on. Anything else (a 5xx, a timeout) is transient and left alone.
 *
 * Nothing here throws into the caller. A flare that reached the database and
 * the live board has succeeded; notification is a bonus delivery path.
 */

import { buildPushPayload, type PushSubscription } from '@block65/webcrypto-web-push';

export type PushTopic = 'raid' | 'meetup' | 'post';

/**
 * The JSON body the service worker's `push` handler receives.
 *
 * Declared as a type with an index signature rather than an interface so it
 * satisfies the library's `Jsonifiable` constraint — an interface has no
 * implicit index signature, which is the one thing that constraint requires.
 */
export type PushPayload = {
  title: string;
  body: string;
  url: string;
  /** Collapses repeat notifications about the same thing. */
  tag?: string;
  [key: string]: string | undefined;
};

interface SubRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  topics_json: string;
}

interface Vapid {
  subject: string;
  publicKey: string;
  privateKey: string;
}

/** Null when push is not configured — every caller treats that as "skip". */
export function vapidKeys(env: Env): Vapid | null {
  const e = env as unknown as Record<string, string | undefined>;
  if (!e.VAPID_PUBLIC_KEY || !e.VAPID_PRIVATE_KEY) return null;

  // Apple returns 403 for a subject that is not mailto: or https://, and only
  // for iOS — so a bad value here looks like "push works, except on iPhones".
  const subject = e.VAPID_SUBJECT ?? '';
  if (!/^(mailto:|https:\/\/)/i.test(subject)) return null;

  return { subject, publicKey: e.VAPID_PUBLIC_KEY, privateKey: e.VAPID_PRIVATE_KEY };
}

export function pushPublicKey(env: Env): string | null {
  return vapidKeys(env)?.publicKey ?? null;
}

export interface PushResult {
  attempted: number;
  delivered: number;
  pruned: number;
  skipped: string | null;
}

/**
 * Send to everyone subscribed to `topic`, except `excludeUserId` — the person
 * who fired the flare does not need telling about it.
 */
export async function sendPush(
  env: Env,
  topic: PushTopic,
  payload: PushPayload,
  excludeUserId?: number | null,
): Promise<PushResult> {
  const vapid = vapidKeys(env);
  if (!vapid) return { attempted: 0, delivered: 0, pruned: 0, skipped: 'push not configured' };

  const { results } = await env.DB.prepare(
    `SELECT id, endpoint, p256dh, auth, topics_json
       FROM push_subs
      WHERE failed_at IS NULL AND (?1 IS NULL OR user_id IS NULL OR user_id != ?1)`,
  )
    .bind(excludeUserId ?? null)
    .all<SubRow>();

  const targets = results.filter((row) => {
    try {
      const topics = JSON.parse(row.topics_json) as string[];
      return Array.isArray(topics) && topics.includes(topic);
    } catch {
      // A row with unparseable topics is a bug, not a subscription preference;
      // default to sending rather than silently dropping someone.
      return true;
    }
  });

  let delivered = 0;
  const dead: number[] = [];

  // Sequential rather than parallel: a Worker's subrequest budget is finite and
  // this community is small. Revisit with Queues if the list ever gets long.
  for (const row of targets) {
    const subscription: PushSubscription = {
      endpoint: row.endpoint,
      expirationTime: null,
      keys: { p256dh: row.p256dh, auth: row.auth },
    };

    try {
      const request = await buildPushPayload(
        { data: payload, options: { ttl: 1800, topic: payload.tag, urgency: 'high' } },
        subscription,
        vapid,
      );

      // The library hands back a Uint8Array, which the Workers `fetch` types do
      // not accept as BodyInit even though the runtime does. Take the exact
      // backing bytes rather than casting, so a pooled buffer can never leak
      // adjacent memory into the request.
      const body = request.body.buffer.slice(
        request.body.byteOffset,
        request.body.byteOffset + request.body.byteLength,
      ) as ArrayBuffer;

      const res = await fetch(row.endpoint, {
        method: request.method,
        headers: request.headers,
        body,
        signal: AbortSignal.timeout(6000),
      });

      if (res.ok) delivered++;
      else if (res.status === 404 || res.status === 410) dead.push(row.id);
    } catch {
      /* Transient. Leave the row alone and try again next time. */
    }
  }

  if (dead.length > 0) {
    await env.DB.batch(
      dead.map((id) =>
        env.DB.prepare(
          "UPDATE push_subs SET failed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?1",
        ).bind(id),
      ),
    );
  }

  return { attempted: targets.length, delivered, pruned: dead.length, skipped: null };
}
