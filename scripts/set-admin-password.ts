/**
 * Sets an admin's password — the credential behind `/admin/login`.
 *
 *   npm run set:password -- --discord-id <snowflake>
 *   npm run set:password -- --create <name>            # a standalone admin
 *   npm run set:password -- --create <name> --email you@example.com
 *   npm run set:password -- --discord-id <id> --remote # asks twice first
 *
 * Writes the `admin_credentials` row and pins `users.role_locked = 1`, so the
 * next Discord sign-in cannot demote the account back to `member`.
 *
 * `--create` is how the site's admins are made: it mints a standalone identity
 * under a synthetic `admin:<name>` id, with no Discord account behind it and no
 * way in except the password set here. `--discord-id` is the other shape — a
 * password added to somebody's existing Discord-backed row — and it is the one
 * the `role_locked` pin above actually has work to do for.
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
import { fileURLToPath } from 'node:url';

import { DEFAULT_ITERATIONS, hashPassword } from '../src/lib/auth/password';
// Relative, like the import above, and importable for the same reason:
// `src/lib/notify/email.ts` takes `env` as a parameter rather than importing
// `cloudflare:workers`, so it loads under plain `tsx`. Sharing the validator is
// what makes "the address this writes is the address the route will look up"
// a fact rather than two regexes that agree today.
import { normalizeEmail } from '../src/lib/notify/email';
import { rows } from './d1-json';

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
const emailFlag = flag('email');
const clearEmail = has('clear-email');

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

  --create       Mints a standalone admin identity: a users row with a
                 synthetic, non-numeric discord_id ("admin:<name>") that can
                 never collide with a real Discord snowflake, and no Discord
                 account behind it. This is how the site's admins are made —
                 the password set here is the only way into the account.

  --email <addr> The address a password-reset link is mailed to. Sets it or
                 changes it; leaving the flag off leaves whatever is on file
                 alone. Unique across admins. Needs migration 0005.

                 SETTING ONE WIDENS THE THREAT MODEL and that is the trade:
                 the account becomes as strong as the weaker of the password
                 and that mailbox, in exchange for there being a way back in
                 at all. Pick a mailbox with its own strong password and
                 two-factor, not one shared with anybody.

  --clear-email  Remove the address, so no reset is possible for that admin
                 and the password is the whole of their access again.

  --remote       Write to the PRODUCTION database. Asks for a typed
                 confirmation naming the database and the user. Default is local.

  --revoke-sessions
                 Also delete every existing session for that user. NOT the
                 default: rotating a password should not sign you out of the
                 Discord session you are using to run this.`,
  );
}
if (discordId && createName) die('Pass --discord-id or --create, not both.');
if (emailFlag !== null && clearEmail) die('Pass --email or --clear-email, not both.');

/*
 * Validated here, at the top, before anything is read or written and long
 * before a password is prompted for.
 *
 * Front-loading it is the same lesson the login-name collision taught on
 * 2026-09-21: a refusal that surfaces after the operator has confirmed a
 * production write, chosen a passphrase and typed it back is a refusal that
 * throws all of that away for something knowable at the start.
 *
 * `normalizeEmail` is the app's own validator, shared rather than re-typed —
 * and its character set is load-bearing here for a second reason: `--file` has
 * no parameter binding, so this value is interpolated into SQL text below.
 * Nothing it accepts contains a quote, a backslash or a semicolon.
 */
let email: string | null = null;
if (emailFlag !== null) {
  email = normalizeEmail(emailFlag);
  if (!email) {
    die(
      `--email must be an ordinary email address. Got: ${JSON.stringify(emailFlag)}

No quoted local parts, no angle brackets, no display name — just
someone@example.com. It is lowercased before it is stored, because the schema
and the reset lookup both work in lowercase.`,
    );
  }
}

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
 * Wrangler's own entry point, run through this same node binary.
 *
 * Not `npx` with `shell: true`. That shell is what forced the temp-file dance
 * below — it re-parses the argument list, so a multi-word `--command` arrived at
 * wrangler split into pieces and was rejected. Handing the script to `node`
 * directly means argv is passed verbatim on every platform, `.cmd` shims are out
 * of the picture, and `--command` becomes usable again. Which matters, because
 * of the next comment.
 */
const WRANGLER = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));

function wrangler(args: string[]): string {
  try {
    return execFileSync(process.execPath, [WRANGLER, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    /*
     * wrangler reports a failed statement as JSON on stdout and exits non-zero,
     * so execFileSync throws and the useful sentence — "UNIQUE constraint
     * failed: admin_credentials.username" — ends up buried in a Node stack
     * trace under `output[1]`. Dig it out and lead with it. The operator of this
     * script is standing at a prompt, not reading a core dump.
     */
    const e = err as { stdout?: string; output?: (string | null)[] };
    const text = e.stdout ?? e.output?.[1] ?? '';
    const at = text.indexOf('{');
    if (at !== -1) {
      try {
        const parsed = JSON.parse(text.slice(at)) as { error?: { text?: string } };
        if (parsed.error?.text) die(`D1 refused the statement:\n\n  ${parsed.error.text}`);
      } catch {
        /* not JSON after all — fall through to the original error */
      }
    }
    throw err;
  }
}

const TARGET = ['d1', 'execute', 'pogotxk-db', remote ? '--remote' : '--local'];

/**
 * READS go through `--command`, and they have to.
 *
 * `wrangler d1 execute --file` does not return query rows when it is pointed at
 * `--remote`. It answers with a summary object instead — "Total queries
 * executed", "Rows read", "Rows written", "Database size (MB)" — while the same
 * `--file` against `--local` returns the rows. `--command` returns rows on both.
 *
 * That asymmetry cost a production run on 2026-09-21: every column came back
 * `undefined`, so the confirmation prompt printed `id undefined / role
 * undefined`, the existence check read a summary object as a user row and
 * announced it was "reusing" a row that did not exist, and the script died on
 * `user.username.toLowerCase()`. Nothing was written, but only because the crash
 * happened to land before the write.
 */
function d1Read(sql: string): string {
  return wrangler([...TARGET, '--command', sql, '--json']);
}

/**
 * WRITES stay on `--file`. They are multi-statement, they return nothing worth
 * reading, and the file keeps the salt and hash out of the process argument
 * list where `ps` and the shell's history can see them.
 */
function d1Write(sql: string): string {
  const file = join(scratch, `q-${randomBytes(4).toString('hex')}.sql`);
  pending = file;
  try {
    writeFileSync(file, sql, { encoding: 'utf8', mode: 0o600 });
    return wrangler([...TARGET, '--file', file, '--json']);
  } finally {
    rmSync(file, { force: true });
    pending = null;
  }
}

/**
 * A write whose failure is not worth stopping for.
 *
 * Exactly one caller: clearing outstanding reset links, against a database
 * that may predate `0005_admin_password_reset.sql`. It cannot go through
 * `d1Write`, because `wrangler()` reports a rejected statement by calling
 * `die()` — a `process.exit` nothing can catch — which is right for every
 * other statement here and wrong for this one.
 *
 * Deliberately narrow: it returns whether the statement ran, and the caller
 * reports that rather than pretending it did.
 */
function d1WriteOptional(sql: string): boolean {
  const file = join(scratch, `q-${randomBytes(4).toString('hex')}.sql`);
  pending = file;
  try {
    writeFileSync(file, sql, { encoding: 'utf8', mode: 0o600 });
    execFileSync(process.execPath, [WRANGLER, ...TARGET, '--file', file, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(file, { force: true });
    pending = null;
  }
}

// `rows` lives in ./d1-json.ts so a test can reach it without running this
// script's argv parsing and usage exit. The shape it guards against, and why it
// throws rather than returning [], are documented there.

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
/*
 * Both `--create` and the login username pass through this, and it has a
 * second job besides keeping the SQL below honest: **it refuses `@`**, and
 * since 2026-09-23 the sign-in route depends on that. `/api/auth/admin-login`
 * accepts a username or the recovery address in one box and picks the column
 * by whether the value contains `@` — so a login name with an `@` in it would
 * be looked up as an address and could never be used to sign in. Every stored
 * address has an `@` (the column's CHECK insists) and no login name may, which
 * is what keeps the two namespaces apart without a migration. Widening this
 * character class to admit `@` breaks that; it is not a formatting preference.
 */
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

If you meant to create a standalone admin, with no Discord account behind it,
use --create <name> instead. Never invent a numeric id: the next real
sign-in by that person would insert a SECOND users row for them, because
upsertUser matches on discord_id.`,
      );
    }
    user = rows<UserRow>(
      d1Read(
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
matter, this script sets it), then run this again. If the admin is not meant to
have a Discord account behind them at all, that is what --create is for.`,
      );
    }
  } else {
    /*
     * A synthetic, deliberately NON-NUMERIC id.
     *
     * Discord snowflakes are digits only, so "admin:justin" can never collide
     * with a real one and can never be matched by upsertUser's
     * ON CONFLICT (discord_id). That is what makes the identity standalone: no
     * Discord sign-in can ever reach this row, whoever signs in. Exactly the
     * property `anonymizedIdentity` uses for "deleted:<id>"
     * (src/lib/auth/deletion.ts), and the same principle as dev-session.ts's
     * 'dev-local-admin' row.
     *
     * **The prefix has to match what production already holds.** The rows are
     * `admin:nic` and `admin:justin`; minting under any other prefix would not
     * fail, it would quietly start a second convention and a second account for
     * a name that already has one.
     */
    const name = assertName('--create', (createName ?? '').toLowerCase());
    const synthetic = `admin:${name}`;

    // `Nic` from `nic`, matching the `global_name` the existing rows carry.
    // `name` has already been through `assertName`, so capitalising its first
    // character cannot introduce anything the SQL below has to worry about.
    const displayName = name.charAt(0).toUpperCase() + name.slice(1);

    const existing = rows<UserRow>(
      d1Read(
        `SELECT id, discord_id, username, global_name, role, is_banned
           FROM users WHERE discord_id = '${synthetic}'`,
      ),
    )[0];

    if (existing) {
      user = existing;
      console.log(`Reusing the existing admin row ${synthetic}.\n`);
    } else {
      d1Write(
        `INSERT INTO users (discord_id, username, global_name, role)
         VALUES ('${synthetic}', '${name}', '${displayName}', 'admin')`,
      );
      user = rows<UserRow>(
        d1Read(
          `SELECT id, discord_id, username, global_name, role, is_banned
             FROM users WHERE discord_id = '${synthetic}'`,
        ),
      )[0];
      if (!user) die('The admin users row was not created.');
      console.log(`Created admin row ${synthetic}.\n`);
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

  /*
   * Ask until the name is actually free.
   *
   * `admin_credentials.username` is UNIQUE across every admin, so a name
   * already spoken for is a real conflict rather than a preference. The check
   * lives HERE, in front of the password prompt, because the alternative is
   * what happened on 2026-09-21: the collision surfaced from SQLite at the
   * INSERT, which is after the operator has confirmed a production write,
   * chosen a passphrase and typed it back — all of it thrown away by a
   * constraint that was knowable before any of it was asked for.
   *
   * Looping rather than dying for the same reason. Being sent back to the shell
   * to redo the confirmations is a punishment for a typo.
   */
  let loginName = '';
  for (;;) {
    const answer = (await ask(rl, `\nLogin username [${suggested || 'admin'}]: `)).trim();
    loginName = assertName('login username', (answer || suggested || 'admin').toLowerCase());

    const clash = rows<{ discord_id: string; username: string }>(
      d1Read(
        `SELECT u.discord_id, u.username
           FROM admin_credentials c JOIN users u ON u.id = c.user_id
          WHERE c.username = '${loginName}' AND c.user_id <> ${user.id}`,
      ),
    )[0];

    if (!clash) break;

    console.log(
      `\n  "${loginName}" is already the login name for ${clash.username} (${clash.discord_id}).` +
        `\n  Login names are unique across all admins — pick another.\n`,
    );
  }

  /* ---- the recovery address ---- */

  /*
   * Checked before the password prompt, for the reason spelled out where
   * `--email` is validated: a UNIQUE violation that surfaces from SQLite at
   * the INSERT arrives after everything expensive has already been asked for.
   *
   * Unlike the login name this does not loop, because there is nothing to
   * loop on — the address came from the command line, not from a prompt, and
   * the fix is a different flag rather than a different answer.
   */
  if (email) {
    const taken = rows<{ discord_id: string; username: string }>(
      d1Read(
        `SELECT u.discord_id, u.username
           FROM admin_credentials c JOIN users u ON u.id = c.user_id
          WHERE c.email = '${email}' AND c.user_id <> ${user.id}`,
      ),
    )[0];

    if (taken) {
      die(
        `That address is already on file for ${taken.username} (${taken.discord_id}).

Addresses are unique across admins, because a reset request has to be able to
say which single account it is for. Nothing was written.`,
      );
    }

    console.log(`\nReset link address: ${email}`);
    console.log('  Anyone who can read that mailbox can take this account.\n');
  }
  if (clearEmail) {
    console.log('\nThe reset address will be removed. No reset will be possible for');
    console.log('this admin, and the password becomes the whole of their access again.\n');
  }

  /* ---- the password ---- */

  console.log(`
Now the password. It is not echoed, and it is never printed or logged.

  * RECOMMENDED: press Enter on an empty prompt and let one be generated.
    Six random words, about 77 bits. That is the intended way to use this.
  * Minimum 16 characters if you type your own. The password's own entropy is
    what carries the security here — the iteration count cannot, because this
    account's Workers plan caps a request at 10 ms of CPU and the count had to
    fit inside it. A *memorable* 16-character password is not well protected by
    that; a generated passphrase is, because 2^77 guesses is out of reach
    whatever the multiplier.
  * There IS a reset link now (/admin/reset), but only for an admin with an
    address on file, and only as strong as that mailbox. It is a way back in,
    not a reason to choose a weaker password.
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
the password's own entropy is doing most of the work behind it — the iteration
count is pinned at the free plan's CPU ceiling and cannot help much.`,
    );
  }

  /*
   * Asked twice, and compared, because the failure mode is delayed: a typo'd
   * password is accepted silently, and the next person to find out is whoever
   * tries to use it. For a standalone `admin:<name>` identity there is no
   * Discord sign-in to fall back on, so the only other way out is the reset
   * link — which needs an address on file, which not every admin has, and
   * which lands in a mailbox behind a cooldown. Cheaper to ask twice.
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

  /*
   * The address is written only when the operator asked for one.
   *
   * It cannot ride in the ordinary column list. On the INSERT half, omitting
   * the column leaves it NULL, which is right for a brand-new row; on the
   * UPDATE half, `email = excluded.email` would then wipe an existing address
   * every time somebody merely rotated a password. So the column appears in
   * both halves or in neither, and the three-way split below is what keeps
   * "no flag means leave it alone" true.
   *
   * `email` has been through `normalizeEmail`, so there is no quote, backslash
   * or semicolon in it to interpolate.
   */
  const emailColumn = email ? ', email' : '';
  const emailValue = email ? `, '${email}'` : '';
  const emailUpdate = email
    ? 'email = excluded.email,'
    : clearEmail
      ? 'email = NULL,'
      : '';

  const statements = [
    `INSERT INTO admin_credentials (user_id, username, algorithm, iterations, salt, hash${emailColumn})
     VALUES (${user.id}, '${loginName}', 'pbkdf2-sha256', ${iterations}, '${salt}', '${hash}'${emailValue})
     ON CONFLICT (user_id) DO UPDATE SET
       username        = excluded.username,
       algorithm       = excluded.algorithm,
       iterations      = excluded.iterations,
       salt            = excluded.salt,
       hash            = excluded.hash,
       ${emailUpdate}
       failed_attempts = 0,
       locked_until    = NULL,
       updated_at      = strftime('%Y-%m-%dT%H:%M:%SZ', 'now');`,
    `UPDATE users SET role = 'admin', role_locked = 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE id = ${user.id};`,
  ];

  if (revokeSessions) statements.push(`DELETE FROM sessions WHERE user_id = ${user.id};`);

  d1Write(statements.join('\n'));

  /*
   * Outstanding reset links die with the password, always — not only under
   * `--revoke-sessions`.
   *
   * A link issued before this ran would otherwise still set a password on the
   * account afterwards, quietly replacing the one just chosen and signing
   * every session out with it. Sessions are a judgement call (rotating a
   * password should not sign you out of the window you are running this from);
   * a live reset link is not one.
   *
   * SEPARATE FROM THE WRITE ABOVE, AND ALLOWED TO FAIL. This script is pointed
   * at whichever database the flags say, and `0005_admin_password_reset.sql`
   * may not have been applied to it — `wrangler d1 execute --file` runs the
   * whole file as one unit, so a missing table in that list would take the
   * password write down with it. A database with no reset table has no links
   * to revoke, so failing here means nothing.
   */
  const resetsRevoked = d1WriteOptional(
    `DELETE FROM admin_password_resets WHERE user_id = ${user.id};`,
  );

  const emailLine = email
    ? email
    : clearEmail
      ? 'removed — no reset is possible for this admin'
      : 'unchanged';

  console.log(`
Done.

  user id      ${user.id}
  login name   ${loginName}
  reset email  ${emailLine}
  role         admin, and role_locked = 1 so Discord cannot demote it
  iterations   ${iterations}
  sessions     ${revokeSessions ? 'revoked' : 'left alone'}
  reset links  ${resetsRevoked ? 'revoked' : 'not revoked — is migration 0005 applied?'}

Sign in at /admin/login with the login name above, or with the reset email
if one is on file. Either goes in the same box.

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
