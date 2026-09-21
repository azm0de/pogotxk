/**
 * Reading rows out of `wrangler d1 execute --json`.
 *
 * Its own module so a test can reach it. `set-admin-password.ts` is a top-level
 * script — it parses argv, makes a temp directory and exits with usage when
 * called with no arguments — so importing it to test one function would run all
 * of that first.
 *
 * ---------------------------------------------------------------------------
 * THE ASYMMETRY THIS EXISTS TO SURVIVE
 * ---------------------------------------------------------------------------
 *
 * `wrangler d1 execute --file` does not return query rows when it is pointed at
 * `--remote`. It answers with a summary object instead:
 *
 *     { "Total queries executed": 1, "Rows read": 72,
 *       "Rows written": 0, "Database size (MB)": "0.30" }
 *
 * The same `--file` against `--local` returns the rows. `--command` returns rows
 * against both, which is why every read in `set-admin-password.ts` goes through
 * `--command` and only its writes use `--file`.
 *
 * Measured against wrangler 4.119.0 on 2026-09-21, after the shape cost a real
 * production run: every column came back `undefined`, so the script offered to
 * pin `id undefined / role undefined` to admin, and its existence check read the
 * summary as a user row and announced it was "reusing" a break-glass row that
 * did not exist. It then died on `user.username.toLowerCase()`. Nothing was
 * written, but only because the crash landed in front of the write.
 */

/** A key that appears only in the summary object, never in a query result. */
export const SUMMARY_KEY = 'Total queries executed';

export class D1ShapeError extends Error {
  constructor() {
    super(
      'wrangler returned a summary instead of rows — the query result cannot be read. ' +
        'Reads must use --command; --file returns no rows against --remote.',
    );
    this.name = 'D1ShapeError';
  }
}

/**
 * Parses the rows, and refuses to guess.
 *
 * Throwing on the summary shape is the point, and it is deliberately not a
 * `return []`. "No such row" and "I could not read the answer" lead to opposite
 * actions: the caller's next move after "no such row" is to offer to create one,
 * in production. An empty array would have it mint a duplicate identity rather
 * than stop.
 *
 * A genuinely empty result set is still `[]` — a SELECT that matched nothing
 * has no summary key in it, because it has no rows at all.
 */
export function rows<T>(raw: string): T[] {
  const start = raw.indexOf('[');
  if (start === -1) return [];

  const parsed = JSON.parse(raw.slice(start)) as { results?: T[] }[];
  const results = parsed[0]?.results ?? [];

  const first = results[0] as Record<string, unknown> | undefined;
  if (first && SUMMARY_KEY in first) throw new D1ShapeError();

  return results;
}
