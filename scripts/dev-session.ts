/**
 * Mints a local admin session so the admin console can be exercised before
 * Discord OAuth is configured.
 *
 *   npx tsx scripts/dev-session.ts
 *
 * Writes a real `users` + `sessions` row to the LOCAL D1 only, using the same
 * SHA-256-of-token scheme the app uses — no bypass code ships, and this cannot
 * affect production. Prints the cookie to paste into the browser.
 */

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DISCORD_ID = 'dev-local-admin';
const USERNAME = 'devadmin';

const scratch = mkdtempSync(join(tmpdir(), 'pogotxk-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));

/**
 * Runs SQL via a temp file rather than --command: on Windows the shell splits
 * a multi-word --command into separate arguments and wrangler rejects it.
 */
function d1(sql: string): string {
  const file = join(scratch, `q-${randomBytes(4).toString('hex')}.sql`);
  writeFileSync(file, sql, 'utf8');
  return execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'pogotxk-db', '--local', '--file', file, '--json'],
    { encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

const token = randomBytes(32).toString('hex');
const tokenHash = createHash('sha256').update(token).digest('hex');
const expiresAt = new Date(Date.now() + 14 * 864e5).toISOString().replace(/\.\d{3}Z$/, 'Z');

d1(
  `INSERT INTO users (discord_id, username, global_name, role)
   VALUES ('${DISCORD_ID}', '${USERNAME}', 'Dev Admin', 'admin')
   ON CONFLICT (discord_id) DO UPDATE SET role = 'admin'`,
);

const userRaw = d1(`SELECT id FROM users WHERE discord_id = '${DISCORD_ID}'`);
const userId = (JSON.parse(userRaw.slice(userRaw.indexOf('[')))[0].results as { id: number }[])[0]!
  .id;

d1(
  `INSERT INTO sessions (id, user_id, expires_at) VALUES ('${tokenHash}', ${userId}, '${expiresAt}')`,
);

console.log(`
Local admin session created (user id ${userId}, expires ${expiresAt}).

  Cookie value:
    ${token}

  Paste into the browser console at http://localhost:4321 :
    document.cookie = 'pogotxk_session=${token}; path=/'

  Or with curl:
    curl -H 'Cookie: pogotxk_session=${token}' http://localhost:4321/api/admin/pois
`);
