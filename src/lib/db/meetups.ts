/**
 * Read model for community meetups.
 *
 * Times are stored as UTC instants plus the zone they were authored in, so a
 * meetup keeps its wall-clock hour across the CST/CDT switch. Everything this
 * module hands out is UTC; rendering in Central is the caller's job, via
 * ~/lib/time.
 */

import type { CalendarEvent } from '~/lib/ics';

export type MeetupStatus = 'draft' | 'published' | 'cancelled';

export interface Meetup {
  id: number;
  slug: string;
  title: string;
  descriptionMd: string | null;
  /** ISO-8601 UTC. */
  startsAt: string;
  endsAt: string | null;
  tz: string;
  poiId: number | null;
  poiName: string | null;
  poiSlug: string | null;
  poiLat: number | null;
  poiLng: number | null;
  locationText: string | null;
  campfireUrl: string | null;
  recurrenceRule: string | null;
  status: MeetupStatus;
  updatedAt: string;
  heroKey: string | null;
  heroAlt: string | null;
}

interface MeetupRow {
  id: number;
  slug: string;
  title: string;
  description_md: string | null;
  starts_at: string;
  ends_at: string | null;
  tz: string;
  poi_id: number | null;
  poi_name: string | null;
  poi_slug: string | null;
  poi_lat: number | null;
  poi_lng: number | null;
  location_text: string | null;
  campfire_url: string | null;
  recurrence_rule: string | null;
  status: MeetupStatus;
  updated_at: string;
  hero_key: string | null;
  hero_alt: string | null;
}

/** How far back the public page and the ICS feed look. */
export const PAST_WINDOW_DAYS = 90;

/**
 * Every meetup the public is allowed to see, oldest first.
 *
 * `cancelled` rows are included deliberately: a meetup that was announced and
 * then called off has to keep appearing in the feed carrying STATUS:CANCELLED,
 * otherwise a subscriber who already has it on their phone never learns it is
 * off. Only `draft` is withheld.
 */
export async function listPublicMeetups(
  db: D1Database,
  opts: { since?: string } = {},
): Promise<Meetup[]> {
  const since =
    opts.since ?? new Date(Date.now() - PAST_WINDOW_DAYS * 86_400_000).toISOString();

  const rows = await db
    .prepare(
      `SELECT m.id, m.slug, m.title, m.description_md, m.starts_at, m.ends_at, m.tz,
              m.poi_id, m.location_text, m.campfire_url, m.recurrence_rule, m.status,
              m.updated_at,
              p.name AS poi_name, p.slug AS poi_slug, p.lat AS poi_lat, p.lng AS poi_lng,
              med.r2_key AS hero_key, med.alt AS hero_alt
         FROM meetups m
         LEFT JOIN pois p ON p.id = m.poi_id
         LEFT JOIN media med ON med.id = m.hero_media_id
        WHERE m.status IN ('published', 'cancelled')
          AND (m.starts_at >= ?1 OR m.recurrence_rule IS NOT NULL)
        ORDER BY m.starts_at`,
    )
    .bind(since)
    .all<MeetupRow>();

  return rows.results.map(toMeetup);
}

function toMeetup(row: MeetupRow): Meetup {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    descriptionMd: row.description_md,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    tz: row.tz,
    poiId: row.poi_id,
    poiName: row.poi_name,
    poiSlug: row.poi_slug,
    poiLat: row.poi_lat,
    poiLng: row.poi_lng,
    locationText: row.location_text,
    campfireUrl: row.campfire_url,
    recurrenceRule: row.recurrence_rule,
    status: row.status,
    updatedAt: row.updated_at,
    heroKey: row.hero_key,
    heroAlt: row.hero_alt,
  };
}

/** Where the meetup is, in one line: the POI name wins over the free text. */
export function meetupLocation(meetup: Meetup): string | null {
  return meetup.poiName ?? meetup.locationText ?? null;
}

/**
 * Markdown reduced to something readable as plain text.
 *
 * Calendar clients show DESCRIPTION verbatim, and the events page renders it as
 * text rather than HTML — so this strips the syntax instead of rendering it,
 * which also means no user Markdown can ever become markup on the page.
 */
export function markdownToText(md: string | null): string | null {
  if (!md) return null;
  const text = md
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

/**
 * A rough English gloss of an RRULE, for the card badge.
 *
 * Deliberately shallow — the authoritative expansion happens in the subscriber's
 * calendar app, which understands the whole grammar. This only has to be honest
 * enough to say "there will be more of these".
 */
const FREQ_LABELS: Record<string, { once: string; plural: string }> = {
  DAILY: { once: 'Daily', plural: 'days' },
  WEEKLY: { once: 'Weekly', plural: 'weeks' },
  MONTHLY: { once: 'Monthly', plural: 'months' },
  YEARLY: { once: 'Yearly', plural: 'years' },
};

const DAY_LABELS: Record<string, string> = {
  MO: 'Mon',
  TU: 'Tue',
  WE: 'Wed',
  TH: 'Thu',
  FR: 'Fri',
  SA: 'Sat',
  SU: 'Sun',
};

export function describeRecurrence(rule: string | null): string | null {
  if (!rule) return null;

  const parts = new Map<string, string>();
  for (const chunk of rule.replace(/^RRULE:/i, '').split(';')) {
    const eq = chunk.indexOf('=');
    if (eq > 0) parts.set(chunk.slice(0, eq).toUpperCase(), chunk.slice(eq + 1).toUpperCase());
  }

  const label = FREQ_LABELS[parts.get('FREQ') ?? ''];
  if (!label) return 'Repeats';

  const interval = Number(parts.get('INTERVAL') ?? '1');
  const every =
    Number.isFinite(interval) && interval > 1
      ? `Every ${interval} ${label.plural}`
      : label.once;

  const byDay = parts.get('BYDAY');
  if (!byDay) return every;

  const days = byDay
    .split(',')
    // Strip any ordinal prefix ("2WE" = the second Wednesday); the weekday alone
    // is as much nuance as a badge can carry.
    .map((day) => DAY_LABELS[day.replace(/^[+-]?\d+/, '')])
    .filter((day): day is string => Boolean(day));

  return days.length ? `${every} on ${days.join(', ')}` : every;
}

/**
 * A meetup as a calendar event.
 *
 * The UID is built from the row id, not the slug: slugs are derived from the
 * title and would change if someone fixed a typo, which would make every
 * subscriber's calendar sprout a duplicate.
 */
export function meetupToCalendarEvent(meetup: Meetup, base: URL): CalendarEvent {
  const location = meetupLocation(meetup);
  const description = buildDescription(meetup, base);

  return {
    uid: `meetup-${meetup.id}@pokemontxk.com`,
    summary: meetup.status === 'cancelled' ? `CANCELLED: ${meetup.title}` : meetup.title,
    start: meetup.startsAt,
    end: meetup.endsAt,
    description,
    location,
    // The anchor is the UID's local part, so the link a subscriber saved years
    // ago still lands on the right card after the meetup is renamed.
    url: meetup.campfireUrl ?? new URL(`/events#meetup-${meetup.id}`, base).toString(),
    geo:
      meetup.poiLat !== null && meetup.poiLng !== null
        ? { lat: meetup.poiLat, lng: meetup.poiLng }
        : null,
    categories: ['PoGo TXK', 'Community Meetup'],
    status: meetup.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED',
    updatedAt: meetup.updatedAt,
    rrule: meetup.recurrenceRule,
    source: 'meetup',
    heading: 'Community meetup',
    imageUrl: meetup.heroKey ? `/media/${meetup.heroKey}` : null,
    locationUrl: meetup.poiSlug ? `/map?poi=${meetup.poiSlug}` : null,
  };
}

function buildDescription(meetup: Meetup, base: URL): string {
  const lines: string[] = [];
  const body = markdownToText(meetup.descriptionMd);
  if (body) lines.push(body);
  if (meetup.campfireUrl) lines.push(`Campfire: ${meetup.campfireUrl}`);
  if (meetup.poiSlug) lines.push(new URL(`/map?poi=${meetup.poiSlug}`, base).toString());
  lines.push(new URL('/events', base).toString());
  return lines.join('\n\n');
}
