/**
 * The event model the `/events` page and the home page share.
 *
 * `CalendarEvent` is the shape both surfaces render. Community meetups (D1, via
 * ~/lib/db/meetups) and the global Pokémon GO events (/api/game/events.json,
 * owned by another module) both normalise into it, so neither surface has to
 * know where a given event came from.
 */

import { DEFAULT_TZ, zonedToUtc } from './time';

/**
 * Meetups are often stored with no end time. Treating a zero-length event as
 * "happening for an instant" reads wrong on the page, so the untimed ones get
 * the length of a raid hour instead.
 */
export const DEFAULT_EVENT_MINUTES = 60;

export type CalendarSource = 'meetup' | 'global';

export interface CalendarEvent {
  /** Stable across refreshes — doubles as the card's anchor id. */
  uid: string;
  summary: string;
  /** ISO-8601 UTC instant. */
  start: string;
  /** ISO-8601 UTC instant; null falls back to `DEFAULT_EVENT_MINUTES`. */
  end?: string | null;
  /** Date-only event. */
  allDay?: boolean;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  geo?: { lat: number; lng: number } | null;
  categories?: string[];
  status?: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
  updatedAt?: string | null;
  /** RRULE, for the recurrence badge. */
  rrule?: string | null;
  source: CalendarSource;
  heading?: string | null;
  imageUrl?: string | null;
  /** Where `location` points — the map deep link for a POI-backed meetup. */
  locationUrl?: string | null;
}

/* ------------------------------------------------------------------ time -- */

/**
 * Exclusive end of an all-day event, in milliseconds.
 *
 * Upstream feeds tend to express the same thing inclusively ("...T23:59:59"),
 * hence the round up to the following midnight.
 */
export function allDayEndExclusive(event: CalendarEvent): number {
  const DAY = 86_400_000;
  const start = Date.parse(event.start);
  const end = event.end ? Date.parse(event.end) : NaN;

  // A single day when there is no usable end.
  if (!Number.isFinite(end) || end <= start) return start + DAY;

  // `event.end` is EXCLUSIVE. So an end already sitting on a midnight boundary
  // is the answer; anything mid-day rounds up to the next boundary.
  return Math.ceil(end / DAY) * DAY;
}

/** Milliseconds at which `event` stops being "happening now". */
export function effectiveEnd(event: CalendarEvent): number {
  const start = Date.parse(event.start);
  if (event.end) {
    const end = Date.parse(event.end);
    if (Number.isFinite(end) && end > start) return end;
  }
  return start + DEFAULT_EVENT_MINUTES * 60_000;
}

/**
 * Longest an in-progress event can run and still count as "live now".
 *
 * A raid hour, a spotlight hour and a Community Day are things you stop what you
 * are doing for. A three-month season and a six-week promo are also technically
 * "happening now", and putting them in the same list buries the raid hour under
 * a dozen cards nobody can act on. Anything longer than a day is `ongoing`.
 */
export const LIVE_MAX_HOURS = 24;

export interface GroupedEvents {
  /** Running now and short enough to go and do. */
  live: CalendarEvent[];
  /** Running now, but measured in days or months. */
  ongoing: CalendarEvent[];
  upcoming: CalendarEvent[];
  past: CalendarEvent[];
}

/** Split events into the buckets the events page renders. */
export function groupEvents(events: CalendarEvent[], now: Date = new Date()): GroupedEvents {
  const at = now.getTime();
  const grouped: GroupedEvents = { live: [], ongoing: [], upcoming: [], past: [] };

  for (const event of events) {
    const start = Date.parse(event.start);
    if (!Number.isFinite(start)) continue;

    const end = effectiveEnd(event);
    if (start > at) grouped.upcoming.push(event);
    else if (end <= at) grouped.past.push(event);
    else if (end - start > LIVE_MAX_HOURS * 3_600_000) grouped.ongoing.push(event);
    else grouped.live.push(event);
  }

  const byStart = (a: CalendarEvent, b: CalendarEvent) => Date.parse(a.start) - Date.parse(b.start);
  grouped.live.sort(byStart);
  grouped.upcoming.sort(byStart);
  // Ending soonest first: the thing about to expire is the useful one.
  grouped.ongoing.sort((a, b) => effectiveEnd(a) - effectiveEnd(b));
  // Most recently finished first — nobody scrolls back to last spring.
  grouped.past.sort((a, b) => byStart(b, a));

  return grouped;
}

/* -------------------------------------------------- global event adapter -- */

/**
 * Normalise the payload of /api/game/events.json into `CalendarEvent`s.
 *
 * That route is owned by the ScrapedDuck module, so this reads defensively: it
 * accepts a bare array or an object with an `events`/`data` key, and tolerates
 * several spellings of each field. Anything unparseable is dropped rather than
 * thrown, so a malformed upstream row degrades to "fewer events" rather than a
 * broken page.
 */
export function normalizeGameEvents(payload: unknown): CalendarEvent[] {
  const rows = extractRows(payload);
  const events: CalendarEvent[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const summary = pickString(row, ['name', 'title', 'summary']);
    const start = pickInstant(row, ['start', 'startsAt', 'starts_at', 'startDate', 'begin']);
    if (!summary || !start) continue;

    const end = pickInstant(row, ['end', 'endsAt', 'ends_at', 'endDate', 'finish']);
    const heading = pickString(row, ['heading', 'eventType', 'type', 'category']);
    const rawId = pickString(row, ['eventID', 'eventId', 'id', 'slug']);

    // Falling back to name+start keeps the UID stable for as long as those two
    // are, which is the best available guarantee when upstream has no id.
    const uid = `game-${slugForUid(rawId ?? `${summary}-${start.iso}`)}@pokemontxk.com`;
    if (seen.has(uid)) continue;
    seen.add(uid);

    events.push({
      uid,
      summary,
      start: start.iso,
      end: end?.iso ?? null,
      allDay: start.dateOnly,
      description: pickString(row, ['description', 'summaryText', 'blurb']),
      url: pickString(row, ['link', 'url', 'href']),
      categories: ['Pokémon GO', ...(heading ? [heading] : [])],
      status: 'CONFIRMED',
      updatedAt: start.iso,
      source: 'global',
      heading,
      imageUrl: pickString(row, ['image', 'imageUrl', 'image_url']),
    });
  }

  return events;
}

/**
 * Credit of last resort.
 *
 * The licence obligation attaches to the *data*, so the credit cannot be
 * contingent on the transport still carrying an `attribution` block. That block
 * is set by /api/game/events.json, which this module does not own; if its
 * envelope is ever reshaped, `readAttribution` would return null while the
 * events kept flowing, and the page would quietly render Leek Duck's data with
 * no credit at all. Falling back to these constants makes that impossible.
 *
 * Mirrors LEEKDUCK_URL / SCRAPEDDUCK_URL in ~/lib/scrapedduck, duplicated rather
 * than imported because that module pulls in `cloudflare:workers` and this one
 * must stay runnable under plain node for scripts/test-events.ts.
 */
const FALLBACK_ATTRIBUTION: GameAttribution = {
  source: 'Leek Duck',
  sourceUrl: 'https://leekduck.com',
  scraper: 'ScrapedDuck',
  scraperUrl: 'https://github.com/bigfoott/ScrapedDuck',
};

/** Credit the upstream data requires wherever its events are shown. */
export interface GameAttribution {
  source: string | null;
  sourceUrl: string | null;
  scraper: string | null;
  scraperUrl: string | null;
}

export interface GameEventFeed {
  events: CalendarEvent[];
  attribution: GameAttribution | null;
}

/**
 * The attribution block, if the payload carries one.
 *
 * The upstream data is Leek Duck's, republished by ScrapedDuck, and both ask to
 * be credited visibly wherever it appears — so this rides along with the events
 * rather than being something a caller has to remember to add.
 */
export function readAttribution(payload: unknown): GameAttribution | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = (payload as Record<string, unknown>).attribution;
  if (typeof raw !== 'object' || raw === null) return null;

  const row = raw as Record<string, unknown>;
  const attribution: GameAttribution = {
    source: pickString(row, ['source']),
    sourceUrl: pickString(row, ['sourceUrl']),
    scraper: pickString(row, ['scraper']),
    scraperUrl: pickString(row, ['scraperUrl']),
  };
  return attribution.source || attribution.scraper ? attribution : null;
}

/** One-line credit, e.g. "Event data from Leek Duck via ScrapedDuck." */
export function attributionText(attribution: GameAttribution | null): string | null {
  if (!attribution) return null;
  if (attribution.source && attribution.scraper) {
    return `Event data from ${attribution.source} via ${attribution.scraper}.`;
  }
  return `Event data from ${attribution.source ?? attribution.scraper}.`;
}

/**
 * Turn an already-fetched payload into calendar events.
 *
 * Pure on purpose: this module must stay importable under plain node so
 * scripts/test-events.ts can run, which rules out importing ~/lib/scrapedduck
 * (it reads `cloudflare:workers` at module scope). Callers running inside the
 * Worker fetch the data themselves and hand the result in here.
 *
 * Accepts the raw `getFeed` result, the API route's envelope, or a bare array —
 * `extractRows` finds the first key that actually holds an array.
 */
export function gameEventsFromPayload(payload: unknown): GameEventFeed {
  const events = normalizeGameEvents(payload);
  // Never hand back events without the credit that licences them.
  const attribution = readAttribution(payload) ?? (events.length ? FALLBACK_ATTRIBUTION : null);
  return { events, attribution };
}

function extractRows(payload: unknown): Record<string, unknown>[] {
  let candidate: unknown = null;

  if (Array.isArray(payload)) {
    candidate = payload;
  } else if (typeof payload === 'object' && payload !== null) {
    const row = payload as Record<string, unknown>;
    // First key that actually holds an array wins, rather than the first key
    // that merely exists: `??` would stop at an `events: 39` count field and
    // silently serve an empty calendar instead of falling through to `data`.
    candidate = ['events', 'data', 'results'].map((key) => row[key]).find(Array.isArray) ?? null;
  }

  if (!Array.isArray(candidate)) return [];
  return candidate.filter(
    (row): row is Record<string, unknown> => typeof row === 'object' && row !== null,
  );
}

function pickString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function pickInstant(
  row: Record<string, unknown>,
  keys: string[],
): { iso: string; dateOnly: boolean } | null {
  for (const key of keys) {
    const parsed = parseInstant(row[key]);
    if (parsed) return parsed;
  }
  return null;
}

const OFFSET_SUFFIX = /(?:Z|[+-]\d{2}:?\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const NAIVE_DATETIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)/;

function parseInstant(value: unknown): { iso: string; dateOnly: boolean } | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Ten-digit values are seconds; anything longer is already milliseconds.
    const ms = value < 1e11 ? value * 1000 : value;
    return { iso: new Date(ms).toISOString(), dateOnly: false };
  }

  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  if (DATE_ONLY.test(raw)) return { iso: `${raw}T00:00:00.000Z`, dateOnly: true };

  if (OFFSET_SUFFIX.test(raw)) {
    const at = Date.parse(raw);
    return Number.isFinite(at) ? { iso: new Date(at).toISOString(), dateOnly: false } : null;
  }

  // ScrapedDuck publishes "local time" events as a naive wall clock — the same
  // 10:00 start happens at 10:00 wherever you are. Our whole audience is in
  // Texarkana, so resolving it against Central is the reading that puts the
  // event on their calendar at the hour they will actually play it.
  const naive = NAIVE_DATETIME.exec(raw);
  if (naive) {
    try {
      return { iso: new Date(zonedToUtc(naive[1]!, DEFAULT_TZ)).toISOString(), dateOnly: false };
    } catch {
      return null;
    }
  }

  const at = Date.parse(raw);
  return Number.isFinite(at) ? { iso: new Date(at).toISOString(), dateOnly: false } : null;
}

/** UID-safe token: no spaces, no control characters, stable for a given input. */
function slugForUid(input: string): string {
  const cleaned = input
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return cleaned || 'event';
}
