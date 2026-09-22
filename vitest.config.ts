/**
 * Worker-runtime tests: Vitest running inside workerd, with the real D1, R2, KV
 * and Durable Object bindings this Worker ships with.
 *
 * ---------------------------------------------------------------------------
 * `.dev.vars` REACHES THIS CONFIG, AND IT HOLDS LIVE CREDENTIALS
 * ---------------------------------------------------------------------------
 *
 * `wrangler.configPath` does not merely read `wrangler.jsonc`. The pool hands
 * the parsed config to wrangler's `unstable_getMiniflareWorkerOptions`, which
 * calls `getVarsForDev` — and that resolves `.dev.vars` next to the config file
 * and folds every key in it into the bindings as a secret. Verified by reading
 * wrangler 4.124's own bundle, and then empirically, because the cost of being
 * wrong is high: `DISCORD_WEBHOOK_URL` in `.dev.vars` points at the community's
 * real Discord channel, and raising a flare posts an embed to whatever that
 * value resolves to. It has happened once already from `wrangler dev` — see
 * `vault/Bugs Worth Remembering.md`, "`.dev.vars` holds real credentials".
 *
 * So the `bindings` below are not belt-and-braces, they are the belt. Miniflare
 * merges worker options with `Object.assign` for plain-object fields, and the
 * pool passes ours second, so every key here wins over the `.dev.vars` value of
 * the same name. `test/00-safety.test.ts` asserts that it actually did.
 *
 * Anything reached over `fetch` is a real server, local D1 notwithstanding.
 * Neutralise the credential and the outbound call cannot be made: `webhookUrl`
 * rejects an empty string, `sendPush` has no VAPID pair to sign with, and the
 * bot-token reader throws rather than authenticating as the live bot.
 *
 * ---------------------------------------------------------------------------
 * WHY `main` POINTS AT A BUILD ARTEFACT
 * ---------------------------------------------------------------------------
 *
 * Two things need it. Cloudflare resolves a Durable Object binding by looking
 * for a named export on the script, so `LIVE` -> `LiveBoard` only binds if the
 * entry exports that class; and `SELF.fetch()` dispatches to `main`'s default
 * export, which is the only way to exercise a route end to end through the
 * middleware that sets `locals.user`.
 *
 * In production the class is appended to the Astro adapter's virtual entry by
 * the `exportDurableObjects` Vite plugin (astro.config.mjs) — the adapter's own
 * entry exports `default` and nothing else. That plugin runs during `astro
 * build` and nowhere else, so the built entry is the only module in the repo
 * that exports both halves. Re-exporting `LiveBoard` from source into a
 * hand-written test entry would work for the binding but would leave `SELF`
 * with no app behind it, so we use the built entry as-is.
 *
 * The cost is that the tests read a build artefact: run `npm run build` first,
 * which `npm run test:worker` does for you. A stale `dist/` silently tests old
 * code, so prefer the script over bare `vitest run` when the app has changed.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

const workerEntry = here('./dist/server/entry.mjs');
if (!existsSync(workerEntry)) {
  throw new Error(
    'dist/server/entry.mjs is missing — the Worker tests run against the built app.\n' +
      'Run `npm run build` (or `npm run test:worker`, which builds first) and try again.',
  );
}

/**
 * Read in Node and passed through as a binding, because `applyD1Migrations`
 * runs inside the isolate where there is no filesystem to read them from.
 *
 * `readD1Migrations` orders by `parseInt` of the filename prefix, so the two
 * files both numbered `0002` compare equal and keep their directory order —
 * which is fine, as they touch different tables. See `migrations/README.md` for
 * why the duplicate number is deliberate and must not be "fixed".
 */
const migrations = await readD1Migrations(here('./migrations'));

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: workerEntry,
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,

          // Every credential that reaches somebody else's server, blanked.
          DISCORD_WEBHOOK_URL: '',
          DISCORD_BOT_TOKEN: '',
          VAPID_PUBLIC_KEY: '',
          VAPID_PRIVATE_KEY: '',
          VAPID_SUBJECT: '',

          // The second outbound sender, added with the admin password reset.
          // Resend delivers to a real mailbox and a sent mail cannot be
          // unsent, so it gets the identical treatment the webhook got after
          // the incident in vault/Bugs Worth Remembering.md — and it gets it
          // for a sharper reason: the reset mail carries a working link to
          // change an admin's password. `RESEND_FROM` is blanked alongside the
          // key because `sendEmail` refuses to send without both, so two
          // independent things have to go wrong before anything leaves.
          RESEND_API_KEY: '',
          RESEND_FROM: '',

          // Not outbound credentials, but real values all the same: the
          // bootstrap id silently makes one Discord account permanently admin,
          // and the import token is a bearer secret on a live endpoint. Fixed,
          // fake values keep role resolution and the import guard deterministic
          // rather than dependent on whatever happens to be in `.dev.vars`.
          DISCORD_CLIENT_ID: 'test-client-id',
          DISCORD_CLIENT_SECRET: 'test-client-secret',
          DISCORD_GUILD_ID: 'test-guild-id',
          DISCORD_BOOTSTRAP_ADMIN_ID: '',
          IMPORT_TOKEN: 'test-import-token',
        },

        /**
         * A path the app does not route reaches `fallbackToAssets` in the
         * adapter's entry, which asks `env.ASSETS` for a file and renders the
         * not-found page when that misses. Nothing binds `ASSETS` here —
         * `wrangler.jsonc` declares no assets and the pool invents none — so
         * the miss threw `Cannot read properties of undefined (reading
         * 'fetch')` instead of answering. That cost two things: a 404 could not
         * be observed through `SELF.fetch` at all, and the stack printed over
         * every run, which is exactly the noise a real failure hides in.
         *
         * The miss *is* the behaviour worth having. In production the built
         * files under `dist/client` are Cloudflare's to serve and never this
         * Worker's, so every request that gets this far has already failed to
         * be an asset. Answering 404 is therefore not a simplification of
         * production — it is the only case the Worker's own code sees.
         *
         * The one thing it does not give you: the four prerendered pages
         * (`/conduct`, `/privacy`, `/terms`, `/offline`) and the static files
         * are real entries in `dist/client`, and they come back 404 here too.
         * Asserting on their HTML through `SELF.fetch` would need this pointed
         * at the directory; nothing does yet, and a prerendered page has no
         * server behaviour to test.
         *
         * `serviceBindings` is how Miniflare takes a binding backed by a plain
         * handler rather than by another Worker; the pool merges its own two
         * entries into this object rather than replacing it. The alternative,
         * Miniflare's real `assets` option pointed at `dist/client`, would put
         * an asset router in front of the Worker and change what `SELF.fetch`
         * even means, which is a much larger claim than this needs.
         */
        serviceBindings: {
          ASSETS: () => new Response('Not Found', { status: 404 }),
        },
      },
    }),
  ],
  resolve: {
    // Mirrors the `~/*` -> `src/*` alias in tsconfig.json, which Vite does not
    // read on its own.
    alias: [{ find: /^~\//, replacement: `${here('./src')}/` }],
  },
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // Restores anything a test stubbed with `vi.stubGlobal` before the next
    // one, so `mockDiscord()` needs no teardown and a forgotten one cannot
    // leak a fetch stub into another test.
    unstubGlobals: true,
  },
});
