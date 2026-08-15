/**
 * Posts flares and announcements into the community Discord via a webhook.
 *
 * The community already lives on Discord, so this is the delivery path that
 * reaches the most people with zero install friction — more than push will,
 * realistically, for a long while.
 *
 * Every function here is best-effort: a Discord outage or a revoked webhook
 * must never fail the request that triggered it. The flare is already in D1 and
 * on the live board by the time this runs.
 */

import type { FlareKind } from '~/lib/db/flares';

/** Discord embed colours, matching the site's POI palette. */
const KIND_COLOR: Record<FlareKind, number> = {
  raid: 0xe2703a,
  gym_takedown: 0xe8453c,
  meetup_here: 0xf2a33c,
  remote_invites: 0x8257d9,
  trade: 0x2f7fd4,
  help: 0x5a6675,
};

const KIND_TITLE: Record<FlareKind, string> = {
  raid: '🔥 Raid starting',
  gym_takedown: '⚔️ Gym takedown',
  meetup_here: '👋 Trainer checked in',
  remote_invites: '📣 Remote invites going spare',
  trade: '🤝 Looking to trade',
  help: '🙋 Needs a hand',
};

export interface FlareNotification {
  id: number;
  kind: FlareKind;
  boss: string | null;
  /** Raid tier, where the trainer told us one. */
  tier: string | null;
  needed: number | null;
  note: string | null;
  expiresAt: string;
  poi: { name: string; slug: string; lat: number; lng: number } | null;
  author: { name: string } | null;
}

/**
 * The embed body for a live flare.
 *
 * Extracted so that posting one and editing one after a correction cannot drift
 * apart. They did not used to be able to drift, because an embed could never be
 * edited except into a tombstone — now that a trainer can fix the boss on a
 * flare they already fired, "what the embed says" has two callers and exactly
 * one definition.
 */
export function flareEmbed(flare: FlareNotification, siteOrigin: string): Record<string, unknown> {
  const fields: { name: string; value: string; inline?: boolean }[] = [];
  if (flare.boss) fields.push({ name: 'Boss', value: flare.boss, inline: true });
  if (flare.tier) fields.push({ name: 'Tier', value: flare.tier, inline: true });
  if (flare.needed) fields.push({ name: 'Needs', value: `${flare.needed} more`, inline: true });
  if (flare.poi) fields.push({ name: 'Where', value: flare.poi.name, inline: true });

  const minutes = Math.max(0, Math.round((Date.parse(flare.expiresAt) - Date.now()) / 60000));
  fields.push({ name: 'Expires', value: `in ${minutes} min`, inline: true });

  return {
    title: KIND_TITLE[flare.kind],
    color: KIND_COLOR[flare.kind],
    description: flare.note ?? undefined,
    fields,
    url: flare.poi ? `${siteOrigin}/map?poi=${flare.poi.slug}` : `${siteOrigin}/live`,
    footer: { text: flare.author ? `Flared by ${flare.author.name}` : 'PoGo TXK' },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Exported for testing. Returns null unless the configured value is genuinely a
 * Discord webhook — see the note inside about why the host is checked.
 */
export function webhookUrl(env: Env): string | null {
  const url = (env as unknown as Record<string, string | undefined>).DISCORD_WEBHOOK_URL;
  if (!url) return null;
  // Refuse anything that is not a Discord webhook: this value comes from
  // configuration, and posting flares to an arbitrary host would be a
  // data-exfiltration bug rather than a feature.
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host !== 'discord.com' && host !== 'discordapp.com' && !host.endsWith('.discord.com')) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Fire a flare into Discord. Returns the message id when Discord gives one
 * back, so the embed can be edited later when the flare closes.
 */
export async function postFlareToDiscord(
  env: Env,
  flare: FlareNotification,
  siteOrigin: string,
): Promise<string | null> {
  const url = webhookUrl(env);
  if (!url) return null;

  const embed = flareEmbed(flare, siteOrigin);

  try {
    // ?wait=true makes Discord return the created message rather than 204, so
    // we get an id to edit when the flare closes.
    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'PoGo TXK',
        embeds: [embed],
        // Nothing here should ever ping @everyone, no matter what a note says.
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { id?: string } | null;
    return body?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * What happened when we tried to close an embed, and — the part that matters —
 * whether it is worth trying again.
 *
 * The caller marks a flare settled on `edited` and on `gone`, and only retries
 * on `retry`. Collapsing those three into a bare success/failure is what makes
 * this kind of sweep either lose edits or hammer Discord forever:
 *
 *   edited  the embed now reads as closed. Done.
 *   gone    the message or the webhook no longer exists (404/401/403). No
 *           number of retries will fix that, so stop — otherwise one manually
 *           deleted message is re-attempted on every sweep, forever.
 *   retry   rate limit, 5xx, timeout, network error. Nothing is wrong with the
 *           request; try again on the next sweep.
 *   disabled  no webhook configured, so there is nothing to close and no flare
 *           should be marked settled — the embed was never posted.
 */
export type FlareCloseOutcome = 'edited' | 'gone' | 'retry' | 'disabled';

/**
 * Exported for testing: classifying an HTTP status is the whole decision, and
 * it should not require a network to verify.
 *
 * 429 is deliberately `retry` rather than `gone` — Discord rate-limits webhooks
 * per channel, and a burst of expiring flares is exactly when this runs.
 */
export function closeOutcomeForStatus(status: number): FlareCloseOutcome {
  if (status >= 200 && status < 300) return 'edited';
  if (status === 401 || status === 403 || status === 404) return 'gone';
  return 'retry';
}

/** Strike through a flare's embed once it is closed or expired. */
export async function markFlareClosedInDiscord(
  env: Env,
  messageId: string,
  reason: 'closed' | 'expired',
): Promise<FlareCloseOutcome> {
  const url = webhookUrl(env);
  if (!url) return 'disabled';

  try {
    const res = await fetch(`${url}/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        embeds: [
          {
            title: reason === 'closed' ? '✅ Flare closed' : '⌛ Flare expired',
            color: 0x5a6675,
          },
        ],
      }),
      signal: AbortSignal.timeout(5000),
    });
    return closeOutcomeForStatus(res.status);
  } catch {
    // Timeout or transport failure — the message is probably still there.
    return 'retry';
  }
}

/**
 * Rewrite a live flare's embed after the trainer corrected it.
 *
 * The same PATCH that retires an embed, pointed at the current details rather
 * than a tombstone. It matters that this exists: an embed is delivered once and
 * then sits in the channel indefinitely, so a flare fired for the wrong boss
 * goes on telling the community to come and fight the wrong boss long after the
 * site itself has been corrected. Reuses closeOutcomeForStatus because the
 * decision is identical — 404/401/403 means stop, everything else means the
 * next correction can try again.
 *
 * Best-effort like everything else here: the flare is already right in D1 and on
 * the live board before this runs.
 */
export async function updateFlareEmbedInDiscord(
  env: Env,
  messageId: string,
  flare: FlareNotification,
  siteOrigin: string,
): Promise<FlareCloseOutcome> {
  const url = webhookUrl(env);
  if (!url) return 'disabled';

  try {
    const res = await fetch(`${url}/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        embeds: [flareEmbed(flare, siteOrigin)],
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(5000),
    });
    return closeOutcomeForStatus(res.status);
  } catch {
    return 'retry';
  }
}

/** Announce a published blog post or meetup. */
export async function announceToDiscord(
  env: Env,
  announcement: { title: string; description?: string; url: string; imageUrl?: string },
): Promise<void> {
  const url = webhookUrl(env);
  if (!url) return;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'PoGo TXK',
        embeds: [
          {
            title: announcement.title,
            description: announcement.description,
            url: announcement.url,
            color: 0xc8071c,
            image: announcement.imageUrl ? { url: announcement.imageUrl } : undefined,
            timestamp: new Date().toISOString(),
          },
        ],
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* Best effort. */
  }
}
