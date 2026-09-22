/**
 * The lockout schedule for the admin password login.
 *
 * Pure: no imports, no bindings, no clock of its own beyond the `now` it is
 * handed. The route does the reading and writing; this module only decides how
 * long a lock lasts and whether one is still in force, so both answers can be
 * pinned by a plain `tsx` test over a table of inputs.
 */

/** Failures before the door shuts. The fifth failure is the one that locks. */
export const MAX_ATTEMPTS = 5;

/**
 * How long a failure counts for.
 *
 * There is no cron in this Worker (vault/Why there is no cron.md), so nothing
 * sweeps a stale counter. Decay rides the next attempt instead: a failure whose
 * predecessor is older than this window resets the count to 1 rather than
 * incrementing it. That is the same shape the announcement and flare-closure
 * sweeps use — the work happens on the next read, not on a schedule.
 *
 * Twenty-four hours rather than something short, because the attack this
 * defends against is slow guessing, and a fifteen-minute window would let a
 * patient attacker run forever at four tries a window.
 */
export const ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Escalating, and **capped at an hour**.
 *
 * The cap is the whole design, not a rounding-off. Everyone else who gets
 * locked out of something can mail support; the person locked out here is an
 * admin, whose account is a standalone identity with no Discord sign-in behind
 * it — there is no second door for them to try and nobody above them to ask.
 * An unbounded schedule — doubling, or a day after enough tries — is a denial
 * of service aimed at the few people who cannot route around it, and it would
 * be triggerable by anyone who knows the username.
 *
 * An hour is still enough to make online guessing hopeless. Five tries an hour
 * against a 16-character passphrase is not an attack, it is a hobby.
 *
 *   failures 1-4  no lock
 *   failure  5    1 minute
 *   failure  6    5 minutes
 *   failure  7    30 minutes
 *   failure  8+   60 minutes
 */
const SCHEDULE_MINUTES = [1, 5, 30, 60];

function isoSeconds(ms: number): string {
  // Seconds precision, matching `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')` and
  // therefore every other timestamp in this schema. Comparisons here are
  // lexicographic on TEXT, so a stray `.000` sorts wrong.
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The exact shape this module writes, and the only shape it will read back. */
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Parses a stored timestamp, or null for anything that is not one.
 *
 * The shape check is not decoration, and it is not belt-and-braces either —
 * `Date.parse` is far looser than it looks. `Date.parse('12345')` succeeds and
 * yields **the year 12345**, so a `locked_until` of `'12345'` — a plausible
 * result of a fat-fingered `UPDATE` — would read as a lock ten thousand years
 * long. Found by the test table, not by reasoning about it.
 *
 * So: only the format this module emits is accepted. Nothing else writes these
 * two columns, so there is no looser shape to be compatible with.
 */
function parseStamp(value: string | null | undefined): number | null {
  if (!value || !STAMP.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * When the account is locked until, given how many failures it has now
 * accumulated — or null when that count does not lock it yet.
 */
export function lockoutUntil(failedAttempts: number, now: number = Date.now()): string | null {
  if (!Number.isFinite(failedAttempts) || failedAttempts < MAX_ATTEMPTS) return null;

  const step = Math.min(failedAttempts - MAX_ATTEMPTS, SCHEDULE_MINUTES.length - 1);
  const minutes = SCHEDULE_MINUTES[step] ?? SCHEDULE_MINUTES[SCHEDULE_MINUTES.length - 1]!;
  return isoSeconds(now + minutes * 60_000);
}

/**
 * Whether a stored `locked_until` is still in force.
 *
 * Tolerates null (never locked, or the lock was cleared) and garbage. Garbage
 * reads as **not locked**, deliberately: an unparseable value can only arrive
 * by a hand-written `UPDATE`, and treating it as a lock would strand an admin
 * behind a door with no expiry and no reset path — which is the failure this
 * whole feature exists to avoid. The counter is unaffected, so the next wrong
 * password locks the account again on a value the code did write.
 */
export function isLocked(lockedUntil: string | null | undefined, now: number = Date.now()): boolean {
  const until = parseStamp(lockedUntil);
  if (until === null) return false;
  return until > now;
}

/**
 * The next failure count, given the previous failure's timestamp.
 *
 * Split out from the route so the decay rule is stated once and tested once —
 * the route writes the same rule as a single SQL `CASE` (so two simultaneous
 * attempts cannot read-then-write the same value), and these two must agree.
 */
export function nextFailureCount(
  failedAttempts: number,
  lastFailedAt: string | null | undefined,
  now: number = Date.now(),
): number {
  const last = parseStamp(lastFailedAt);
  if (last === null) return 1;
  if (now - last > ATTEMPT_WINDOW_MS) return 1;
  return failedAttempts + 1;
}

/** The cutoff a failure's `last_failed_at` must beat to still count. */
export function windowStart(now: number = Date.now()): string {
  return isoSeconds(now - ATTEMPT_WINDOW_MS);
}
