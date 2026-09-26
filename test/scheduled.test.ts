/**
 * The cron that deleting from config did not delete.
 *
 * A thirty-minute cron trigger was declared on 2026-08-05 and later removed from
 * `wrangler.jsonc`. Removing it there did nothing: `wrangler deploy` only
 * touches schedules when `triggers.crons` is present, so an absent key leaves
 * Cloudflare's copy in place. It fired every thirty minutes until 2026-09-26 —
 * 48 `scriptThrewException` a day, which on quiet days was nearly every
 * invocation the Worker saw, and read as "the site is down" in analytics.
 *
 * The first test is the cause: the built Worker has nothing for a timer to
 * call. The second is the fix: the config that actually ships says, in so many
 * words, that there are no schedules. See vault/Why there is no cron.md.
 *
 * Why the first test inspects the export rather than firing the event: the
 * pool's `SELF` proxy cannot forward `scheduled()` (it throws DataCloneError
 * binding the stub), and the underlying `exports.default.scheduled()` reports
 * the missing handler as an uncaught exception and then hangs the request.
 * Neither is a failure a test can assert on. Both confirmed 2026-09-26.
 */

import { describe, expect, it } from 'vitest';
// The built entry — the same module `vitest.config.ts` runs as `main`, and the
// one Cloudflare invokes.
import * as entry from '../dist/server/entry.mjs';
// The file `wrangler deploy` reads, not the source it was generated from — the
// adapter rewrites `wrangler.jsonc` during `astro build`, and the generated
// copy is what reaches Cloudflare.
import deployed from '../dist/server/wrangler.json';

describe('cron triggers', () => {
  it('the built Worker has no scheduled() handler, so any timer run throws', () => {
    // Cloudflare's error for a timer fired at this Worker is "Handler does not
    // export a scheduled() function". The Astro adapter's entry exports
    // `fetch` and nothing else; `LiveBoard` rides alongside as a named export.
    const worker = entry.default as Record<string, unknown>;
    expect(Object.keys(worker)).toEqual(['fetch']);
    expect(worker.scheduled).toBeUndefined();
  });

  it('the deployed config clears every schedule with an explicit empty list', () => {
    // `[]`, not absent. Given the test above, any cron here is a guaranteed
    // exception on every run; and no key at all would leave an old one alive.
    expect(deployed.triggers).toEqual({ crons: [] });
  });
});
