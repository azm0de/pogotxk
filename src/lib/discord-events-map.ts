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

/**
 * Cover art URL.
 *
 * `.webp` rather than `.png`: Discord's CDN transcodes on request, and for the
 * one real event this was built against the same 512px image is 26 KB as WebP
 * against 260 KB as PNG. A tenfold saving on a card most visitors scroll past
 * is not a micro-optimisation, and the CDN does the work, not us.
 */
export function cdnImage(eventId: string, hash: string | null, size = 1024): string | null {
  return hash
    ? `https://cdn.discordapp.com/guild-events/${eventId}/${hash}.webp?size=${size}`
    : null;
}

/**
 * A srcset for a URL this module built, by rewriting its `size` parameter.
 *
 * Returns null for anything else — the hand-entered meetups store an R2 key and
 * are served from /media, which has no size parameter to rewrite. Better to
 * emit no srcset than a broken one.
 */
export function cdnSrcset(url: string | null, sizes: number[] = [512, 1024]): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!parsed.searchParams.has('size')) return null;
  return sizes
    .map((n) => {
      parsed.searchParams.set('size', String(n));
      return `${parsed.toString()} ${n}w`;
    })
    .join(', ');
}

/* ------------------------------------------------------------- the RSVP link --
 *
 * Discord descriptions end in a bare URL far more often than they use Markdown
 * link syntax, because the Discord client autolinks and the author never has to
 * think about it. Rendered as text on our card that URL is dead — you cannot
 * click it, and "Click here to see details and RSVP:" followed by an unclickable
 * address is worse than saying nothing.
 *
 * So the URL is lifted out and rendered as a real link, and the line that only
 * existed to introduce it is dropped with it. Deliberately conservative: only a
 * line that is *nothing but* a URL is removed. A URL inside a sentence stays
 * where the author put it rather than having the sentence butchered around it —
 * it will appear twice, which is untidy but never wrong.
 */
const URL_ANYWHERE = /https?:\/\/[^\s<>"'`]+/;
const URL_ONLY_LINE = /^<?https?:\/\/[^\s<>"'`]+>?$/;
/* Matched after trailing emphasis is stripped: the line that introduces the
 * link is very often bolded, so "**Click here to see details and RSVP:**" ends
 * in asterisks rather than the colon. */
const LEAD_IN = /:$/;
const TRAILING_EMPHASIS = /[*_~\s]+$/;
/** Long enough for "Click here to see details and RSVP:", short enough to be a lead-in. */
const LEAD_IN_MAX = 80;

/** Trailing sentence punctuation is almost never part of the address. */
function tidyUrl(raw: string): string {
  return raw.replace(/[.,!?;:'")\]}>]+$/, '');
}

export function firstUrl(md: string | null): string | null {
  const match = md?.match(URL_ANYWHERE);
  return match ? tidyUrl(match[0]) : null;
}

export function splitDescription(md: string | null): {
  text: string | null;
  url: string | null;
} {
  if (!md) return { text: null, url: null };
  const url = firstUrl(md);

  const kept: string[] = [];
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    if (!URL_ONLY_LINE.test(line.trim())) {
      kept.push(line);
      continue;
    }
    let i = kept.length - 1;
    while (i >= 0 && !kept[i].trim()) i--; // step back over blank lines
    const lead = i >= 0 ? kept[i].trim().replace(TRAILING_EMPHASIS, '') : '';
    if (lead && LEAD_IN.test(lead) && lead.length <= LEAD_IN_MAX) {
      kept.splice(i, kept.length - i);
    }
  }

  const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: text || null, url };
}

/**
 * What the link should say. Naming the destination beats "click here": people
 * decide whether to leave the page based on where it goes.
 */
export function rsvpLabel(url: string | null): string {
  if (!url) return 'Details and RSVP';
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return 'Details and RSVP';
  }
  if (host === 'cmpf.re' || host.includes('campfire')) return 'RSVP on Campfire';
  if (host === 'discord.com' || host === 'discord.gg') return 'Open in Discord';
  return 'Details and RSVP';
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
