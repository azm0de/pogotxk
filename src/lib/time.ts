/**
 * Timezone conversion for meetup times.
 *
 * Meetups are stored as UTC instants plus the zone they were authored in. The
 * admin form works in wall-clock time ("6 PM on Wednesday"), so the conversion
 * has to respect the offset *at that date* — Texarkana is CDT for most of the
 * meetup season and CST in winter, and getting it wrong puts every raid hour an
 * hour out for half the year.
 */

export const DEFAULT_TZ = 'America/Chicago';

/**
 * Whether `Intl` knows `tz` as a time zone.
 *
 * The meetup routes accepted any non-empty string as a zone and stored it, and
 * every renderer then handed it to `Intl.DateTimeFormat`, which throws a
 * `RangeError` on a name it does not know — so one typo in the admin form took
 * the home page down with a 500 (admin audit, 2026-10, B-01). Asking the same
 * `Intl` that will later render it is the only check that cannot disagree with
 * the renderer. Remembered per name, because the answer cannot change inside an
 * isolate and the public pages ask on every render.
 */
const zoneValidity = new Map<string, boolean>();

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.trim() === '' || tz.length > 64) return false;
  const known = zoneValidity.get(tz);
  if (known !== undefined) return known;

  let valid: boolean;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    valid = true;
  } catch {
    valid = false;
  }
  zoneValidity.set(tz, valid);
  return valid;
}

/**
 * `tz` if `Intl` knows it, otherwise Texarkana's.
 *
 * For rendering only. A row stored before the routes validated the zone must
 * still show *a* time rather than fail the page; Central is the honest guess,
 * because it is the only zone this community has ever authored a meetup in.
 */
export function safeZone(tz: unknown): string {
  return isValidTimeZone(tz) ? tz : DEFAULT_TZ;
}

const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Whether a datetime-local string names a moment that exists on a calendar.
 *
 * The shape regex in the routes lets `2026-02-30T18:00` through, and `Date`
 * then quietly rolls it into March — so a typo became a meetup on a different
 * day with no error anywhere (admin audit, 2026-10, B-13). Rebuilding the parts
 * from `Date.UTC` and comparing is the round trip that catches every such
 * rollover, the 31st of a short month and hour 24 alike.
 */
export function isRealLocalDateTime(wallClock: unknown): wallClock is string {
  if (typeof wallClock !== 'string') return false;
  const m = LOCAL_DATETIME.exec(wallClock);
  if (!m) return false;

  const [year, month, day, hour, minute, second] = m.slice(1).map((part) => Number(part ?? 0));
  const at = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!));
  return (
    at.getUTCFullYear() === year &&
    at.getUTCMonth() === month! - 1 &&
    at.getUTCDate() === day &&
    at.getUTCHours() === hour &&
    at.getUTCMinutes() === minute &&
    at.getUTCSeconds() === second
  );
}

/** Milliseconds `tz` is ahead of UTC at the given instant. */
function offsetAt(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wallClockAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return wallClockAsUtc - instant.getTime();
}

/**
 * Convert a wall-clock string ("2026-08-05T18:00", as produced by an
 * `<input type="datetime-local">`) in `tz` to a UTC ISO instant.
 *
 * Runs the offset lookup twice: the first pass guesses using the offset at the
 * naive instant, the second corrects it if that guess landed on the other side
 * of a DST transition.
 */
export function zonedToUtc(wallClock: string, tz: string = DEFAULT_TZ): string {
  // Both refusals are errors rather than fallbacks: this is the write path, and
  // a wrong instant stored silently is worse than a 422 the author can fix.
  if (!isValidTimeZone(tz)) throw new Error(`Unknown time zone: ${tz}`);
  if (!isRealLocalDateTime(wallClock)) throw new Error(`Not a real date and time: ${wallClock}`);

  const naive = new Date(`${wallClock.length === 16 ? `${wallClock}:00` : wallClock}Z`);
  if (Number.isNaN(naive.getTime())) throw new Error(`Invalid date-time: ${wallClock}`);

  const firstGuess = new Date(naive.getTime() - offsetAt(naive, tz));
  const corrected = new Date(naive.getTime() - offsetAt(firstGuess, tz));
  return corrected.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Inverse of `zonedToUtc` — a UTC instant back to a datetime-local value. */
export function utcToZoned(utcIso: string, tz: string = DEFAULT_TZ): string {
  const instant = new Date(utcIso);
  if (Number.isNaN(instant.getTime())) return '';
  const shifted = new Date(instant.getTime() + offsetAt(instant, safeZone(tz)));
  return shifted.toISOString().slice(0, 16);
}

/**
 * Human-readable local time, e.g. "Wed, Aug 5, 6:00 PM CDT".
 *
 * Never throws on the zone: this is what the public pages and the Discord
 * announcement render with, and a stored zone `Intl` does not know falls back
 * to Central rather than failing the render (admin audit, 2026-10, B-01).
 */
export function formatInZone(utcIso: string, tz: string = DEFAULT_TZ): string {
  const instant = new Date(utcIso);
  if (Number.isNaN(instant.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: safeZone(tz),
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(instant);
}
