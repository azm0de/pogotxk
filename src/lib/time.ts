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
  const shifted = new Date(instant.getTime() + offsetAt(instant, tz));
  return shifted.toISOString().slice(0, 16);
}

/** Human-readable local time, e.g. "Wed, Aug 5, 6:00 PM CDT". */
export function formatInZone(utcIso: string, tz: string = DEFAULT_TZ): string {
  const instant = new Date(utcIso);
  if (Number.isNaN(instant.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(instant);
}
