/**
 * iCalendar (RFC 5545) output, and the event model the calendar surfaces share.
 *
 * Subscribing to a calendar is a one-time act of trust: people paste the URL
 * into Google Calendar or iOS once and then never look at it again, so this has
 * to keep being correct for years without anyone watching. Everything fussy in
 * here serves that — CRLF endings, folding measured in octets rather than
 * characters, TEXT escaping, and UIDs derived from immutable ids so a refresh
 * *updates* an event in place instead of leaving a second copy next to it.
 *
 * `CalendarEvent` is the shape both the events page and the .ics routes render.
 * Community meetups (D1, via ~/lib/db/meetups) and the global Pokémon GO events
 * (/api/game/events.json, owned by another module) both normalise into it, so
 * neither surface has to know where a given event came from.
 */

import { DEFAULT_TZ, zonedToUtc } from './time';

export const ICS_CONTENT_TYPE = 'text/calendar; charset=utf-8';

/** Product id per RFC 5545 §3.7.3. Bump the version when the output changes. */
const PRODID = '-//PoGo TXK//Events Calendar 1.0//EN';

/** RFC 5545 caps a content line at 75 octets before the CRLF. */
const MAX_LINE_OCTETS = 75;

/**
 * Meetups are often stored with no end time. A VEVENT with no DTEND "takes up
 * no time" per the spec, which Google Calendar renders as a hairline sliver, so
 * we give the untimed ones the length of a raid hour instead.
 */
export const DEFAULT_EVENT_MINUTES = 60;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

export type CalendarSource = 'meetup' | 'global';

export interface CalendarEvent {
  /** Stable across refreshes — this is what stops duplicates. */
  uid: string;
  summary: string;
  /** ISO-8601 UTC instant. */
  start: string;
  /** ISO-8601 UTC instant; null falls back to `DEFAULT_EVENT_MINUTES`. */
  end?: string | null;
  /** Date-only event — serialised as DTSTART;VALUE=DATE. */
  allDay?: boolean;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  geo?: { lat: number; lng: number } | null;
  categories?: string[];
  status?: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
  /** Drives DTSTAMP/LAST-MODIFIED/SEQUENCE. See `sequenceFor` below. */
  updatedAt?: string | null;
  /** RFC 5545 RRULE, passed straight through for the client to expand. */
  rrule?: string | null;
  source: CalendarSource;
  /** Display-only fields. The serialiser ignores these. */
  heading?: string | null;
  imageUrl?: string | null;
  /** Where `location` points — the map deep link for a POI-backed meetup. */
  locationUrl?: string | null;
}

export interface CalendarMeta {
  /** X-WR-CALNAME / NAME — what the subscriber sees in their calendar list. */
  name: string;
  description?: string;
  /** RFC 5545 duration, e.g. PT1H. */
  refreshInterval?: string;
  /** IANA zone advertised to clients that group by "calendar timezone". */
  timezone?: string;
  /** Absolute URL this feed is served from, for SOURCE (RFC 7986 §5.8). */
  source?: string;
}

/* ------------------------------------------------------------------ text -- */

/**
 * Escape a TEXT value (RFC 5545 §3.3.11).
 *
 * Backslash goes first — escaping it after the others would double-escape the
 * backslashes this function just introduced.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold a content line to 75 octets.
 *
 * The limit is in octets, not characters, and a fold may not land inside a
 * multi-byte UTF-8 sequence — an emoji in a meetup title would otherwise be cut
 * in half and arrive as mojibake. Continuation lines start with a single space,
 * which itself counts toward the 75, leaving them 74 octets of payload.
 */
export function foldLine(line: string): string {
  const bytes = ENCODER.encode(line);
  if (bytes.length <= MAX_LINE_OCTETS) return line;

  const parts: string[] = [];
  let start = 0;
  let budget = MAX_LINE_OCTETS;

  while (start < bytes.length) {
    let end = Math.min(start + budget, bytes.length);
    // 0b10xxxxxx marks a UTF-8 continuation byte; back up off one.
    while (end > start + 1 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    parts.push((start === 0 ? '' : ' ') + DECODER.decode(bytes.subarray(start, end)));
    start = end;
    budget = MAX_LINE_OCTETS - 1;
  }

  return parts.join('\r\n');
}

/** Reverse of `foldLine` — used by the tests and by nothing else. */
export function unfold(ics: string): string {
  return ics.replace(/\r\n[ \t]/g, '');
}

/* ------------------------------------------------------------------ time -- */

/** An instant as `YYYYMMDDTHHMMSSZ`. */
export function toIcsUtc(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ICS date-time: ${String(value)}`);
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** A date as `YYYYMMDD`, in UTC. */
export function toIcsDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ICS date: ${String(value)}`);
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Exclusive end of an all-day event, in milliseconds.
 *
 * DTEND is exclusive for DATE values, so a one-day event ends the *next* day.
 * Upstream feeds tend to express the same thing inclusively ("...T23:59:59"),
 * hence the round up to the following midnight.
 */
export function allDayEndExclusive(event: CalendarEvent): number {
  const start = Date.parse(event.start);
  const end = event.end ? Date.parse(event.end) : NaN;
  if (!Number.isFinite(end) || end <= start) return start + 86_400_000;
  return Math.ceil(end / 86_400_000) * 86_400_000;
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

/* -------------------------------------------------------------- serialise -- */

/**
 * SEQUENCE has to increase every time an event is revised, and must stay a
 * plain integer. Minutes since 2020 satisfies both without needing a revision
 * counter in the database, and stays comfortably inside 32 bits for ~4000 years.
 */
function sequenceFor(updatedAt: string | null | undefined): number {
  if (!updatedAt) return 0;
  const at = Date.parse(updatedAt);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.floor((at - Date.UTC(2020, 0, 1)) / 60_000));
}

/**
 * Strip anything that would end a content line early.
 *
 * `raw` values (URL, RRULE, GEO) are not TEXT and so are not escaped — but they
 * still reach the wire verbatim, and several of them come from the admin meetup
 * form. A CR or LF in one of those fields would close the property and let the
 * rest of the string be parsed as its own line, injecting an arbitrary property
 * (ATTENDEE, a nested VALARM) into every subscriber's calendar. Worse, one
 * malformed line is enough for a client to reject the *whole* feed, so a single
 * bad meetup would silently unsubscribe everybody.
 *
 * TEXT values do not need this — `escapeText` already turns newlines into `\n`.
 */
function sanitizeRaw(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]/g, '');
}

class Lines {
  private readonly out: string[] = [];

  /** A property whose value is already in ICS wire form (dates, numbers, URIs). */
  raw(name: string, value: string | null | undefined): void {
    if (value === null || value === undefined || value === '') return;
    const safe = sanitizeRaw(value);
    if (safe === '') return;
    this.out.push(foldLine(`${name}:${safe}`));
  }

  /** A property whose value is TEXT and therefore needs escaping. */
  text(name: string, value: string | null | undefined): void {
    if (value === null || value === undefined || value === '') return;
    this.out.push(foldLine(`${name}:${escapeText(value)}`));
  }

  toString(): string {
    // Trailing CRLF included: every content line ends with one, the last too.
    return `${this.out.join('\r\n')}\r\n`;
  }
}

function writeEvent(lines: Lines, event: CalendarEvent, stamp: string): void {
  lines.raw('BEGIN', 'VEVENT');
  lines.raw('UID', event.uid);
  lines.raw('DTSTAMP', event.updatedAt ? toIcsUtc(event.updatedAt) : stamp);

  if (event.allDay) {
    // DTSTART and DTEND must share a value type, so a date-only start forces the
    // end to a date too.
    lines.raw('DTSTART;VALUE=DATE', toIcsDate(event.start));
    lines.raw('DTEND;VALUE=DATE', toIcsDate(new Date(allDayEndExclusive(event))));
  } else {
    lines.raw('DTSTART', toIcsUtc(event.start));
    lines.raw('DTEND', toIcsUtc(new Date(effectiveEnd(event))));
  }

  lines.raw('RRULE', event.rrule ?? null);
  lines.text('SUMMARY', event.summary);
  lines.text('DESCRIPTION', event.description ?? null);
  lines.text('LOCATION', event.location ?? null);
  lines.raw('URL', event.url ?? null);

  if (event.geo && Number.isFinite(event.geo.lat) && Number.isFinite(event.geo.lng)) {
    // GEO is `float ";" float` — the semicolon is a separator, not TEXT.
    lines.raw('GEO', `${event.geo.lat};${event.geo.lng}`);
  }

  if (event.categories?.length) {
    // CATEGORIES is a comma-separated list of TEXT: escape each item, then join
    // on a comma that must itself stay unescaped.
    lines.raw('CATEGORIES', event.categories.map(escapeText).join(','));
  }

  lines.raw('STATUS', event.status ?? 'CONFIRMED');
  lines.raw('TRANSP', 'OPAQUE');
  lines.raw('SEQUENCE', String(sequenceFor(event.updatedAt)));
  lines.raw('LAST-MODIFIED', event.updatedAt ? toIcsUtc(event.updatedAt) : stamp);
  lines.raw('END', 'VEVENT');
}

/**
 * Serialise a whole calendar.
 *
 * `now` is injectable so the tests get deterministic bytes; in production it
 * only supplies DTSTAMP for events with no `updatedAt`, which keeps the body
 * byte-stable between requests and lets the ETag actually do its job.
 */
export function buildIcs(
  meta: CalendarMeta,
  events: CalendarEvent[],
  now: Date = new Date(),
): string {
  const stamp = toIcsUtc(now);
  const lines = new Lines();

  lines.raw('BEGIN', 'VCALENDAR');
  lines.raw('VERSION', '2.0');
  lines.raw('PRODID', PRODID);
  lines.raw('CALSCALE', 'GREGORIAN');
  lines.raw('METHOD', 'PUBLISH');

  // NAME/DESCRIPTION are RFC 7986; the X-WR-* twins are what Google, Apple and
  // Outlook actually read. Emitting both costs four lines and covers everyone.
  lines.text('X-WR-CALNAME', meta.name);
  lines.text('NAME', meta.name);
  lines.text('X-WR-CALDESC', meta.description ?? null);
  lines.text('DESCRIPTION', meta.description ?? null);
  lines.raw('X-WR-TIMEZONE', meta.timezone ?? DEFAULT_TZ);

  // REFRESH-INTERVAL is the RFC 7986 spelling; X-PUBLISHED-TTL is Outlook's.
  const refresh = meta.refreshInterval ?? 'PT1H';
  lines.raw('REFRESH-INTERVAL;VALUE=DURATION', refresh);
  lines.raw('X-PUBLISHED-TTL', refresh);
  if (meta.source) lines.raw('SOURCE;VALUE=URI', meta.source);

  for (const event of events) writeEvent(lines, event, stamp);

  lines.raw('END', 'VCALENDAR');
  return lines.toString();
}

/* ----------------------------------------------------------------- serve -- */

/**
 * FNV-1a over the body. Not cryptographic — it only has to change when the feed
 * changes, so subscribers polling hourly get a 304 instead of the whole file.
 */
export function icsEtag(body: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `"${(hash >>> 0).toString(16)}-${body.length.toString(16)}"`;
}

export function icsResponse(
  body: string,
  opts: { filename: string; etag?: string; maxAge?: number },
): Response {
  return new Response(body, {
    headers: {
      'content-type': ICS_CONTENT_TYPE,
      // `inline` so clicking the https:// link in a browser hands the file to
      // the OS calendar handler rather than dropping it in ~/Downloads.
      'content-disposition': `inline; filename="${opts.filename}"`,
      'cache-control': `public, max-age=${opts.maxAge ?? 900}, stale-while-revalidate=3600`,
      ...(opts.etag ? { etag: opts.etag } : {}),
    },
  });
}

/* -------------------------------------------------- global event adapter -- */

/**
 * Normalise the payload of /api/game/events.json into `CalendarEvent`s.
 *
 * That route is owned by the ScrapedDuck module, so this reads defensively: it
 * accepts a bare array or an object with an `events`/`data` key, and tolerates
 * several spellings of each field. A feed people have subscribed to should
 * degrade to "fewer events" rather than "500", so anything unparseable is
 * dropped rather than thrown.
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
      // Upstream has no revision timestamp; anchoring DTSTAMP to the start keeps
      // the body byte-stable so the ETag does not churn on every poll.
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
 * must stay runnable under plain node for scripts/test-ics.ts.
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
 * Fetch the global events from the sibling API route.
 *
 * Returns `null` — not an empty feed — when the route is missing, erroring or
 * slow, so callers can say "unavailable" instead of silently claiming there is
 * nothing on. The timeout matters: the events page must still render if the
 * upstream scrape is wedged.
 */
export async function fetchGameEvents(base: URL): Promise<GameEventFeed | null> {
  try {
    const res = await fetch(new URL('/api/game/events.json', base), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const payload = await res.json();
    const events = normalizeGameEvents(payload);
    // Never hand back events without the credit that licences them.
    const attribution = readAttribution(payload) ?? (events.length ? FALLBACK_ATTRIBUTION : null);
    return { events, attribution };
  } catch {
    return null;
  }
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
