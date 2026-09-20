/**
 * Runs before every test, in every file.
 *
 * Read this before writing a suite, because the isolation model is not the one
 * the older Cloudflare docs describe. `@cloudflare/vitest-pool-workers` used to
 * roll storage back around each test on its own (`isolatedStorage`); that
 * option is gone. What it offers instead is `reset()`, and `reset()` is a bad
 * fit for this app: it is `deleteAllDurableObjects()` under the skin, D1, KV
 * and R2 are all Durable Objects inside Miniflare, and this Worker leaves
 * background writes in flight on purpose — the middleware slides the session
 * forward under `waitUntil`, and the flare routes fan out the same way. Pulling
 * the storage out from under one of those produces a dozen lines of workerd
 * stderr ("Application called deleteAllDurableObjects()") between you and your
 * actual failure, on every authenticated request a suite makes.
 *
 * So each test starts from an empty database built by emptying the tables
 * rather than by deleting the store. A straggling write then lands on a table
 * that is already empty, which is a no-op, and says nothing.
 *
 * What a test may assume: no rows anywhere, no KV keys, no R2 objects, and no
 * Durable Object holding in-memory state from the test before. Row ids restart
 * from 1, because every primary key here is a plain rowid alias.
 *
 * The migrations arrive as a binding rather than being read here.
 * `readD1Migrations` is a Node function and this code runs inside workerd,
 * where there is no filesystem to read `migrations/` from. See vitest.config.ts.
 */

// Import order matters and is load-bearing. `cloudflare:test` drags in the
// built Worker entry, which trips over a WebAssembly call on the way in; the
// shim has to be in place before that happens, and ES modules evaluate
// dependencies in the order they are declared. Read test/wasm-shim.ts.
import { restoreWebAssemblyCompile } from './wasm-shim';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { applyD1Migrations, env, evictAllDurableObjects } from 'cloudflare:test';
import { beforeAll, beforeEach } from 'vitest';
import { redact } from './helpers/discord-mock';

restoreWebAssemblyCompile();

/**
 * `TEST_MIGRATIONS` is a test-only binding, so it is not in the generated
 * `Cloudflare.Env`. Cast rather than augmenting that interface globally — the
 * app must not be able to see a binding it will never be deployed with.
 */
const testEnv = env as unknown as { TEST_MIGRATIONS: D1Migration[] };

/**
 * Derived from the live schema rather than listed, so a new migration's table
 * is cleared without anyone remembering to add it here. `d1_migrations` is the
 * one application-visible table that must survive — it is the record of the
 * schema we just built.
 */
async function appTables(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '_cf_%'
        AND name <> 'd1_migrations'`,
  ).all<{ name: string }>();
  return results.map((row) => row.name);
}

async function emptyTables(tables: string[]): Promise<void> {
  // One batch, so it is one transaction. Every foreign key in this schema
  // carries an explicit ON DELETE action, so the order does not matter.
  await env.DB.batch(tables.map((name) => env.DB.prepare(`DELETE FROM "${name}"`)));
}

async function emptyKv(): Promise<void> {
  const { keys } = await env.CACHE.list();
  await Promise.all(keys.map((key) => env.CACHE.delete(key.name)));
}

async function emptyR2(): Promise<void> {
  const { objects } = await env.MEDIA.list();
  if (objects.length > 0) await env.MEDIA.delete(objects.map((object) => object.key));
}

/**
 * The last rail: no test reaches the network, ever, for any host.
 *
 * Blanking the credentials stops the Discord paths, but that is one class of
 * outbound call out of several — `getFeed` fetches ScrapedDuck from
 * raw.githubusercontent.com on any page that shows raids or research, and it
 * does it from inside the route, so a test that only meant to check a status
 * code makes a real request to a third party. That is the same bug `npm test`
 * had until the dry-run importer was taken out of it: offline runs fail, and
 * somebody else's uptime becomes ours.
 *
 * A global stub does reach code running under `SELF.fetch()` — verified, they
 * share an isolate — so this covers routes as well as direct calls. A test that
 * wants outbound behaviour installs its own on top: `mockDiscord()`, or
 * `vi.stubGlobal` for anything else. Reinstalling here every time is what
 * bounds that to the one test which asked for it.
 */
function forbidNetwork(): void {
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const request = new Request(input as RequestInfo);
    throw new Error(
      `Test made a real outbound request: ${request.method} ${redact(request.url)}. ` +
        'Stub it — mockDiscord() for Discord, vi.stubGlobal("fetch", ...) otherwise.',
    );
  };
}

let tables: string[] = [];

beforeAll(async () => {
  await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);
  tables = await appTables();
});

beforeEach(async () => {
  forbidNetwork();
  await emptyTables(tables);
  await emptyKv();
  await emptyR2();
  // Drops in-memory state — open sockets, connection counts — without touching
  // durable storage. LiveBoard keeps nothing durable, so this is the whole job.
  await evictAllDurableObjects({ webSockets: 'close' });
});
