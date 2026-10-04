/**
 * Mints a standalone admin into the LOCAL database, with no prompt, so the
 * admin console and the password door can be exercised in development and in
 * browser testing.
 *
 *   npx tsx scripts/dev-admin.ts --create <name> [--email <addr>] [--password <pw>]
 *
 * It writes the same shape `npm run set:password -- --create <name>` writes in
 * production: a `users` row under the synthetic `admin:<name>` id with
 * `role = 'admin'` and `role_locked = 1`, and an `admin_credentials` row holding
 * a PBKDF2 hash made by the app's own `hashPassword`. Sign in at
 * http://localhost:4321/admin/login with the name (or the address, if given).
 *
 * LOCAL ONLY, and on purpose, three ways:
 *   - `--local` is written into the wrangler call below; there is no switch that
 *     changes it.
 *   - Any argument containing "remote" stops the script before it does anything.
 *   - This is not the production tool. Real admins are made with
 *     `npm run set:password`, which prompts for the password without echoing it.
 *     This script accepts `--password` on the command line, which is exactly what
 *     that script refuses to do - fine for a throwaway local credential, and the
 *     reason this must never be pointed at a real database.
 *
 * With no `--password` one is generated and printed once. It is a local
 * development credential; do not reuse it anywhere.
 *
 * Re-running for the same name replaces the credential, clears any lockout,
 * and deletes that user's pending reset links and sessions (so a stale cookie
 * from the last run stops working). Leaving `--email` off leaves an existing
 * address alone, as the real setter does.
 */

import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_ITERATIONS, hashPassword } from '../src/lib/auth/password';
import { normalizeEmail } from '../src/lib/notify/email';

/* The hard stop. Checked before anything else is read or written. */
if (process.argv.some((a) => a.toLowerCase().includes('remote'))) {
  console.error(
    '\ndev-admin.ts only ever writes to the LOCAL database and refuses anything\n' +
      'that mentions "remote". Production admins are made with `npm run set:password`.\n',
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
function flag(name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return null;
  return argv[at + 1] ?? '';
}
function die(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/* Same rule as the setter's SAFE_NAME. It refuses `@` on purpose: the sign-in
   route decides username-versus-address by whether the value contains one. */
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{1,62}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
/** `--file` has no parameter binding, so values are interpolated; double quotes. */
const q = (value: string): string => value.replace(/'/g, "''");

const rawName = flag('create');
if (!rawName) {
  die(
    `Usage: npx tsx scripts/dev-admin.ts --create <name> [--email <addr>] [--password <pw>]

  --create    Login name, 2-63 characters of a-z 0-9 . _ - (lowercase, no @).
  --email     Recovery address (optional). Sign-in works with it too.
  --password  At least 16 characters. Omit it and one is generated and printed once.

Writes to the LOCAL database only.`,
  );
}
const name = rawName.toLowerCase();
if (!SAFE_NAME.test(name) || name.includes('@')) {
  die('--create must be 2-63 characters of a-z, 0-9, dot, dash or underscore (lowercase), with no @.');
}

const emailFlag = flag('email');
let email: string | null = null;
if (emailFlag !== null) {
  email = normalizeEmail(emailFlag);
  if (!email) {
    die(`--email must be an ordinary address like someone@example.com. Got: ${JSON.stringify(emailFlag)}`);
  }
}

const passwordFlag = flag('password');
let password = passwordFlag ?? '';
let generated = false;
if (passwordFlag === null || passwordFlag === '') {
  password = randomBytes(18).toString('base64url');
  generated = true;
} else if (password.length < 16) {
  die(`--password must be at least 16 characters. Got ${password.length}.`);
}

const discordId = `admin:${name}`;
const displayName = name.charAt(0).toUpperCase() + name.slice(1);

const stored = await hashPassword(password, DEFAULT_ITERATIONS);
if (!B64URL.test(stored.salt) || !B64URL.test(stored.hash) || !Number.isInteger(stored.iterations)) {
  die('Refusing to build SQL: the derived hash is not in the expected shape.');
}

const emailColumn = email ? ', email' : '';
const emailValue = email ? `, '${q(email)}'` : '';
const emailUpdate = email ? 'email = excluded.email,' : '';

const sql = `
INSERT INTO users (discord_id, username, global_name, role, role_locked)
VALUES ('${q(discordId)}', '${q(name)}', '${q(displayName)}', 'admin', 1)
ON CONFLICT (discord_id) DO UPDATE SET
  role = 'admin',
  role_locked = 1,
  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now');

INSERT INTO admin_credentials (user_id, username, algorithm, iterations, salt, hash${emailColumn})
VALUES (
  (SELECT id FROM users WHERE discord_id = '${q(discordId)}'),
  '${q(name)}', 'pbkdf2-sha256', ${stored.iterations}, '${stored.salt}', '${stored.hash}'${emailValue}
)
ON CONFLICT (user_id) DO UPDATE SET
  username        = excluded.username,
  algorithm       = excluded.algorithm,
  iterations      = excluded.iterations,
  salt            = excluded.salt,
  hash            = excluded.hash,
  ${emailUpdate}
  failed_attempts = 0,
  locked_until    = NULL,
  updated_at      = strftime('%Y-%m-%dT%H:%M:%SZ', 'now');

DELETE FROM admin_password_resets WHERE user_id = (SELECT id FROM users WHERE discord_id = '${q(discordId)}');
DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE discord_id = '${q(discordId)}');
`;

/* A temp file, as dev-session.ts does: on Windows the shell splits a multi-word
   --command into separate arguments and wrangler rejects it. */
const scratch = mkdtempSync(join(tmpdir(), 'pogotxk-devadmin-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
const file = join(scratch, `q-${randomBytes(4).toString('hex')}.sql`);
writeFileSync(file, sql, { encoding: 'utf8', mode: 0o600 });

try {
  execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'pogotxk-db', '--local', '--file', file, '--json'],
    { encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] },
  );
} catch (err) {
  const e = err as { stdout?: string; stderr?: string };
  const text = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  const hint = text.match(/"text":\s*"([^"]+)"/)?.[1];
  die(
    `The local database refused the write${hint ? `: ${hint}` : '.'}\n` +
      'Has `npm run db:migrate:local` been run, and is the name or address already used by another admin?',
  );
}

const passwordNote = generated
  ? `
  Generated password (printed ONCE; it is a local dev credential, do not reuse it):

      ${password}
`
  : '';

console.log(`
Local dev admin ready.

  login name   ${name}
  reset email  ${email ?? 'unchanged'}
  user         ${discordId} (role admin, role_locked 1)
  sessions     cleared for this user
${passwordNote}
Sign in at http://localhost:4321/admin/login with the login name${email ? ' or the address' : ''}.
`);
