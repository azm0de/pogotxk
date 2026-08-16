/**
 * Pure shaping for Discord guild scheduled events.
 *
 * Split out from discord-events.ts so it can be tested: that module imports
 * `cloudflare:workers` for the env bindings, which does not resolve under tsx.
 * Everything here is a plain function over plain data — no fetch, no KV, no env.
 *
 * The filtering below is the part worth testing rather than trusting. Showing a
 * cancelled meetup as "next" is the one failure mode with a physical cost:
 * somebody drives to the park.
 */

/** Discord's numeric event status. 1 SCHEDULED, 2 ACTIVE, 3 COMPLETED, 4 CANCELED. */
export const STATUS_SCHEDULED = 1;
export const STATUS_ACTIVE = 2;

/** The subset of Discord's payload this needs. */
export interface RawScheduledEvent {
  id: string;
  name: string;
  description: string | null;
  scheduled_start_time: string;
  scheduled_end_time: string | null;
  status: number;
  entity_metadata: { location?: string | null } | null;
  image: string | null;
}

export interface DiscordMeetup {
  /** Discord's snowflake, stable across edits — safe to key on. */
  id: string;
  title: string;
  descriptionMd: string | null;
  /** ISO-8601 UTC. */
  startsAt: string;
  endsAt: string | null;
  /** Free text as typed in Discord; the guild has no POI concept. */
  locationText: string | null;
  /** Cover art, when the organiser attached one. */
  imageUrl: string | null;
  /** Jump link to the event in Discord. */
  url: string;
}

export function cdnImage(eventId: string, hash: string | null): string | null {
  return hash ? `https://cdn.discordapp.com/guild-events/${eventId}/${hash}.png?size=1024` : null;
}

/**
 * Discord → our shape, dropping anything that cannot be rendered honestly.
 *
 * COMPLETED and CANCELED are filtered here rather than at the call site, so
 * there is exactly one place that decides what counts as a real upcoming event.
 * A start time that does not parse is dropped for the same reason — it would
 * sort unpredictably against real ones and could take the "next" slot.
 */
export function mapEvents(raw: RawScheduledEvent[], guildId: string): DiscordMeetup[] {
  return raw
    .filter((e) => e.status === STATUS_SCHEDULED || e.status === STATUS_ACTIVE)
    .filter((e) => Boolean(e.scheduled_start_time) && Number.isFinite(Date.parse(e.scheduled_start_time)))
    .map((e) => ({
      id: e.id,
      title: e.name,
      descriptionMd: e.description || null,
      startsAt: new Date(e.scheduled_start_time).toISOString(),
      endsAt: e.scheduled_end_time ? new Date(e.scheduled_end_time).toISOString() : null,
      locationText: e.entity_metadata?.location || null,
      imageUrl: cdnImage(e.id, e.image),
      url: `https://discord.com/events/${guildId}/${e.id}`,
    }))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/**
 * The soonest event that has not already finished.
 *
 * Compares against `endsAt` where Discord gave one, so an event that is
 * currently running still counts as "next" rather than vanishing the moment it
 * starts — which is exactly when people look it up to find out where everyone is.
 */
export function nextDiscordMeetup(
  events: DiscordMeetup[],
  now: string = new Date().toISOString(),
): DiscordMeetup | null {
  return events.find((e) => (e.endsAt ?? e.startsAt) >= now) ?? null;
}
