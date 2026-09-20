/**
 * Sets the owner's break-glass password.
 *
 *   npm run set:password -- --discord-id <snowflake>
 *   npm run set:password -- --create <name>            # genuine break-glass
 *   npm run set:password -- --discord-id <id> --remote # asks twice first
 *
 * Writes the `admin_credentials` row and pins `users.role_locked = 1`, so the
 * next Discord sign-in cannot demote the account back to `member`.
 *
 * ---------------------------------------------------------------------------
 * THE PASSWORD NEVER BECOMES ANYTHING PRINTABLE
 * ---------------------------------------------------------------------------
 *
 * Standing project rule, and the reason this takes a prompt rather than a flag:
 * **never a CLI argument, never piped, never displayed.** An argument is in the
 * shell's history and in `ps`; a pipe is in the history too. So it is read from
 * a terminal with echo suppressed, handed straight to `hashPassword`, and left
 * to fall out of scope. Nothing below ever puts it in a string that could reach
 * a log, an error message or a stack trace.
 *
 * The same rule produced the VAPID private key procedure in
 * `vault/Configuration.md`: a value that is never displayed cannot be leaked by
 * a screenshot or a pasted transcript.
 *
 * ---------------------------------------------------------------------------
 * WHY THE IMPORT IS RELATIVE
 * ---------------------------------------------------------------------------
 *
 * `tsx` does not read the `~/` alias from tsconfig.json, and `src/lib/auth/
 * password.ts` is deliberately free of `cloudflare:workers` so it can be
 * imported from here. Sharing that exact module is what makes the hash this
 * writes verifiable by the Worker — see the known-answer vector asserted in
 * both test layers.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface, type Interface } from 'node:readline';

import { DEFAULT_ITERATIONS, hashPassword } from '../src/lib/auth/password';

/* --------------------------------------------------------------- arguments */

const argv = process.argv.slice(2);

function flag(name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return null;
  return argv[at + 1] ?? '';
}
const has = (name: string): boolean => argv.includes(`--${name}`);

const discordId = flag('discord-id');
const createName = flag('create');
const remote = has('remote');
const revokeSessions = has('revoke-sessions');

function die(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

if (!discordId && !createName) {
  die(
    `Usage:
  npm run set:password -- --discord-id <snowflake>
  npm run set:password -- --create <name>

  --discord-id   The Discord user id of an EXISTING users row. Look it up in
                 Discord with Developer Mode on. The row must already exist,
                 which means that person has signed in with Discord at least
                 once. That is deliberate — see below.

  --create       Break-glass only. Mints a users row with a synthetic,
                 non-numeric discord_id ("owner:<name>") that can never collide
                 with a real Discord snowflake. Use when nobody can sign in with
                 Discord at all.

  --remote       Write to the PRODUCTION database. Asks for a typed
                 confirmation naming the database and the user. Default is local.

  --revoke-sessions
                 Also delete every existing session for that user. NOT the
                 default: rotating a password should not sign you out of the
                 Discord session you are using to run this.`,
  );
}
if (discordId && createName) die('Pass --discord-id or --create, not both.');

/* ------------------------------------------------------------------- d1 */

// 0o700: the file below holds a salt and a hash. Neither is the password and
// neither is directly useful, but a world-readable temp file holding the
// material for an offline attack is not a thing to leave lying in /tmp.
const scratch = mkdtempSync(join(tmpdir(), 'pogotxk-pw-'));
try {
  // `mkdtemp` already creates at 0o700 on POSIX and the ACL is the user's own
  // on Windows, so this states the intent rather than changing it — and it
  // keeps the guarantee true if the default ever moves.
  chmodSync(scratch, 0o700);
} catch {
  // Windows can refuse chmod outright. The directory is already per-user there.
}

let pending: string | null = null;

/** Removes the temp file, however this process ends. */
function sweep(): void {
  if (pending) {
    try {
      rmSync(pending, { force: true });
    } catch {
      /* already gone */
    }
    pending = null;
  }
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

// Three belts: the `finally` around each call, the normal-exit handler, and
// Ctrl-C — which is the likeliest way this script ends, since it sits at a
// prompt waiting for a human.
process.on('exit', sweep);
process.on('SIGINT', () => {
  sweep();
  process.exit(130);
});

/**
 * Runs SQL through a temp file rather than `--command`.
 *
 * On Windows the shell splits a multi-word `--command` into separate arguments
 * and wrangler rejects it — the same reason `scripts/dev-session.ts` does this.
 */
function d1(sql: string): string {
  const file = join(scratch, `q-${randomBytes(4).toString('hex')}.sql`);
  pending = file;
  try {
    writeFileSync(file, sql, { encoding: 'utf8', mode: 0o600 });
    return execFileSync(
      'npx',
      [
        'wrangler',
        'd1',
        'execute',
        'pogotxk-db',
        remote ? '--remote' : '--local',
        '--file',
        file,
        '--json',
      ],
      { encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } finally {
    rmSync(file, { force: true });
    pending = null;
  }
}

function rows<T>(raw: string): T[] {
  const start = raw.indexOf('[');
  if (start === -1) return [];
  const parsed = JSON.parse(raw.slice(start)) as { results?: T[] }[];
  return parsed[0]?.results ?? [];
}

/**
 * `--file` has no parameter binding, so every value below is interpolated into
 * SQL text. That makes these assertions the only thing standing between a
 * surprising input and a statement that means something else.
 *
 * `dev-session.ts` interpolates without asserting. It gets away with it because
 * both of its values are constants in the file; nothing here is.
 */
const B64URL = /^[A-Za-z0-9_-]+$/;
function assertB64Url(label: string, value: string): string {
  if (!B64URL.test(value)) die(`Refusing to build SQL: ${label} is not base64url.`);
  return value;
}
function assertCount(value: number): number {
  if (!Number.isInteger(value) || value < 10_000) die(`Refusing to build SQL: bad iteration count.`);
  return value;
}
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{1,62}$/;
function assertName(label: string, value: string): string {
  if (!SAFE_NAME.test(value)) {
    die(
      `Refusing to build SQL: ${label} must be 2-63 characters of a-z, 0-9, dot, dash or underscore (lowercase).`,
    );
  }
  return value;
}
const SNOWFLAKE = /^\d{5,25}$/;

/* ---------------------------------------------------------------- prompts */

/**
 * A prompt that does not echo.
 *
 * `_writeToOutput` is a **private** readline API and this override is
 * load-bearing: replacing it is the only way to stop readline echoing each
 * keystroke. If a Node upgrade renames it, this stops suppressing and starts
 * printing the password — which is why the TTY refusal below exists rather than
 * a best-effort fallback.
 */
function hidden(rl: Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const target = rl as unknown as { _writeToOutput?: (s: string) => void };
    const restore = target._writeToOutput;
    process.stdout.write(prompt);
    target._writeToOutput = (chunk: string): void => {
      // Newlines still pass through, or Enter leaves the cursor mid-line.
      if (chunk.includes('\n')) process.stdout.write('\n');
    };
    rl.question('', (answer) => {
      target._writeToOutput = restore;
      resolve(answer);
    });
  });
}

function ask(rl: Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

/**
 * REFUSE LOUDLY WITHOUT A CONSOLE. This is the Windows trap.
 *
 * Under Git Bash (and any mintty), `node` is handed a pipe rather than a
 * console: `process.stdin.isTTY` is `undefined`, readline never enters its
 * character mode, and **the `_writeToOutput` override silently does nothing —
 * the password echoes in plain text** and stays in the scrollback. It looks
 * like it worked. Everything downstream is correct and the secret is on screen.
 *
 * There is no way to suppress echo on a pipe, so the only safe answer is to
 * stop.
 */
if (!process.stdin.isTTY) {
  die(
    `This terminal is not a console, so the password would be ECHOED IN PLAIN TEXT.

That is what happens under Git Bash / mintty, where node gets a pipe rather
than a console and echo cannot be suppressed at all.

Run it from one of these instead:
  * PowerShell
  * Windows Terminal (PowerShell or cmd tab)
  * Git Bash, but prefixed:   winpty npm run set:password -- <args>

Nothing was written.`,
  );
}

/** Six words from a small, unambiguous list. Printed once, then never again. */
const WORDS = [
  'anchor', 'basin', 'cedar', 'dunes', 'ember', 'fossil', 'gravel', 'harbor',
  'ivory', 'jetty', 'kettle', 'lantern', 'meadow', 'nickel', 'orchard', 'pebble',
  'quartz', 'ripple', 'saddle', 'timber', 'umber', 'velvet', 'willow', 'yonder',
  'almond', 'bronze', 'copper', 'driftwood', 'elder', 'flint', 'granite', 'hollow',
];
function passphrase(): string {
  const picks: string[] = [];
  // rejection-free: 32 words is a power of two, so a byte maps evenly.
  for (const byte of randomBytes(6)) picks.push(WORDS[byte % WORDS.length]!);
  return picks.join('-');
}

/* ------------------------------------------------------------------- main */

interface UserRow {
  id: number;
  discord_id: string;
  username: string;
  global_name: string | null;
  role: string;
  is_banned: number;
}

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

try {
  console.log(`\nTarget database: pogotxk-db (${remote ? 'REMOTE — PRODUCTION' : 'local'})\n`);

  /* ---- find or mint the user row ---- */

  let user: UserRow | undefined;

  if (discordId) {
    if (!SNOWFLAKE.test(discordId)) {
      die(
        `--discord-id must be a Discord snowflake (digits only). Got: ${JSON.stringify(discordId)}

If you meant to create a break-glass account that has never signed in with
Discord, use --create <name> instead. Never invent a numeric id: the next real
sign-in by that person would insert a SECOND users row for them, because
upsertUser matches on discord_id.`,
      );
    }
    user = rows<UserRow>(
      d1(
        `SELECT id, discord_id, username, global_name, role, is_banned
           FROM users WHERE discord_id = '${discordId}'`,
      ),
    )[0];

    if (!user) {
      die(
        `No users row has discord_id ${discordId}. Refusing to create one.

A users row keyed to a made-up snowflake is worse than no row: when that person
really does sign in with Discord, upsertUser's ON CONFLICT (discord_id) would
not match, and they would get a second account while the password row stayed
attached to the first.

So: have them sign in with Discord once (which is enough — the role does not
matter, this script sets it), then run this again. If Discord sign-in is not
possible at all, that is what --create is for.`,
      );
    }
  } else {
    /*
     * A synthetic, deliberately NON-NUMERIC id.
     *
     * Discord snowflakes are digits only, so "owner:justin" can never collide
     * with a real one and can never be matched by upsertUser's
     * ON CONFLICT (discord_id). Exactly the property `anonymizedIdentity` uses
     * for "deleted:<id>" (src/lib/auth/deletion.ts), and the same principle as
     * dev-session.ts's 'dev-local-admin' row.
     */
    const name = assertName('--create', (createName ?? '').toLowerCase());
    const synthetic = `owner:${name}`;

    const existing = rows<UserRow>(
      d1(
        `SELECT id, discord_id, username, global_name, role, is_banned
           FROM users WHERE discord_id = '${synthetic}'`,
      ),
    )[0];

    if (existing) {
      user = existing;
      console.log(`Reusing the existing break-glass row ${synthetic}.\n`);
    } else {
      d1(
        `INSERT INTO users (discord_id, username, global_name, role)
         VALUES ('${synthetic}', '${name}', 'Owner', 'admin')`,
      );
      user = rows<UserRow>(
        d1(
          `SELECT id, discord_id, username, global_name, role, is_banned
             FROM users WHERE discord_id = '${synthetic}'`,
        ),
      )[0];
      if (!user) die('The break-glass users row was not created.');
      console.log(`Created break-glass row ${synthetic}.\n`);
    }
  }

  /* ---- confirm it is the right person ---- */

  console.log('This row will be given a password and pinned to admin:\n');
  console.log(`  id           ${user.id}`);
  console.log(`  discord_id   ${user.discord_id}`);
  console.log(`  username     ${user.username}`);
  console.log(`  global_name  ${user.global_name ?? '(none)'}`);
  console.log(`  role         ${user.role}`);
  console.log(`  is_banned    ${user.is_banned}\n`);

  if (user.is_banned === 1) {
    console.log('NOTE: this account is banned. A banned account cannot sign in by any');
    console.log('      door — the password would be set and refused. Unban it first.\n');
  }

  if ((await ask(rl, 'Type yes to continue: ')).trim() !== 'yes') die('Nothing was written.');

  if (remote) {
    console.log('\nThis writes to the PRODUCTION database.');
    const phrase = `pogotxk-db ${user.username}`;
    const typed = await ask(rl, `Type exactly "${phrase}" to confirm: `);
    if (typed.trim() !== phrase) die('Confirmation did not match. Nothing was written.');
  }

  /* ---- the login username for the credential row ---- */

  const suggested = user.username.toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const answer = (await ask(rl, `\nLogin username [${suggested || 'owner'}]: `)).trim();
  const loginName = assertName('login username', (answer || suggested || 'owner').toLowerCase());

  /* ---- the password ---- */

  console.log(`
Now the password. It is not echoed, and it is never printed or logged.

  * RECOMMENDED: press Enter on an empty prompt and let one be generated.
    Six random words, about 77 bits. That is the intended way to use this.
  * Minimum 16 characters if you type your own. There is no reset link and no
    recovery email, so the password's own entropy is what carries the security
    here — the iteration count cannot, because this account's Workers plan caps
    a request at 10 ms of CPU and the count had to fit inside it. A *memorable*
    16-character password is not well protected by that; a generated passphrase
    is, because 2^77 guesses is out of reach whatever the multiplier.
`);

  let password = await hidden(rl, 'Password: ');
  let generated = false;

  if (password === '') {
    /*
     * Printed exactly once, and then required typed back below. Showing it is
     * unavoidable — it has to reach a password manager somehow — but requiring
     * it retyped means it cannot be set by someone who did not actually capture
     * it, which is the same failure a typo would cause.
     */
    password = passphrase();
    generated = true;
    console.log(`
  Generated passphrase — copy it into your password manager NOW.
  It will not be shown again:

      ${password}

  Now type it back to confirm it was saved.
`);
  } else if (password.length < 16) {
    die(
      `Password must be at least 16 characters. Got ${password.length}.

Nothing was written. This is the only door that does not depend on Discord, and
there is no reset link behind it, so the password is doing all the work.`,
    );
  }

  /*
   * Asked twice, and compared, because the failure mode is delayed and cruel:
   * a typo'd password is accepted silently, and the owner does not find out
   * until the day Discord is already broken and this was supposed to be the
   * way back in.
   */
  const again = await hidden(rl, generated ? 'Type it back: ' : 'Again: ');
  if (again !== password) die('The two entries did not match. Nothing was written.');

  /* ---- hash and write ---- */

  const stored = await hashPassword(password, DEFAULT_ITERATIONS);
  // Out of scope from here. Nothing below this line can reach the plaintext.
  password = '';

  const salt = assertB64Url('salt', stored.salt);
  const hash = assertB64Url('hash', stored.hash);
  const iterations = assertCount(stored.iterations);

  const statements = [
    `INSERT INTO admin_credentials (user_id, username, algorithm, iterations, salt, hash)
     VALUES (${user.id}, '${loginName}', 'pbkdf2-sha256', ${iterations}, '${salt}', '${hash}')
     ON CONFLICT (user_id) DO UPDATE SET
       username        = excluded.username,
       algorithm       = excluded.algorithm,
       iterations      = excluded.iterations,
       salt            = excluded.salt,
       hash            = excluded.hash,
       failed_attempts = 0,
       locked_until    = NULL,
       updated_at      = strftime('%Y-%m-%dT%H:%M:%SZ', 'now');`,
    `UPDATE users SET role = 'admin', role_locked = 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE id = ${user.id};`,
  ];

  if (revokeSessions) statements.push(`DELETE FROM sessions WHERE user_id = ${user.id};`);

  d1(statements.join('\n'));

  console.log(`
Done.

  user id      ${user.id}
  login name   ${loginName}
  role         admin, and role_locked = 1 so Discord cannot demote it
  iterations   ${iterations}
  sessions     ${revokeSessions ? 'revoked' : 'left alone'}

Sign in at /admin/login.

That path is not a secret and is not protecting anything: the repository is
public, so anyone can read it there. Nothing links to the page and it carries
noindex, which keeps a password form out of the nav and out of a search index
— tidiness, not defence. The password you just set and the lockout behind it
are what hold the door.
`);
} finally {
  rl.close();
  sweep();
}
