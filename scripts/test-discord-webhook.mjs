/**
 * Fires one test embed at DISCORD_WEBHOOK_URL to prove the webhook works,
 * WITHOUT ever printing the URL.
 *
 * The URL is a bearer credential: anyone holding it can post into the channel,
 * regardless of who can read it. So this script reads it from `.dev.vars`
 * (gitignored) and never echoes it — not to stdout, not into an error message.
 *
 *   node scripts/test-discord-webhook.mjs
 *   node scripts/test-discord-webhook.mjs --close   # also test the edit path
 *
 * It reuses the SAME host validation as src/lib/notify/discord.ts. That matters:
 * a URL the app would reject behaves *identically* to one that is missing —
 * postFlareToDiscord returns null and logs nothing — so a "wrong host" mistake
 * is otherwise invisible until you wonder why no flare ever arrives.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function readDevVar(name) {
  let text;
  try {
    text = readFileSync(join(root, '.dev.vars'), 'utf8');
  } catch {
    fail('.dev.vars not found. Copy .dev.vars.example to .dev.vars first.');
  }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    if (t.slice(0, i).trim() === name) return t.slice(i + 1).trim();
  }
  return '';
}

/** Byte-for-byte the rule from src/lib/notify/discord.ts. */
function accepted(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'discord.com' || host === 'discordapp.com' || host.endsWith('.discord.com');
  } catch {
    return false;
  }
}

function fail(msg) {
  console.error(`\n  FAIL  ${msg}\n`);
  process.exit(1);
}

const raw = readDevVar('DISCORD_WEBHOOK_URL');

if (!raw) {
  fail(
    'DISCORD_WEBHOOK_URL is empty in .dev.vars.\n' +
      '        Paste the webhook URL there (Channel Settings > Integrations > Webhooks).\n' +
      '        Do NOT paste it into chat — it is a bearer credential.',
  );
}
if (raw !== raw.trim() || /^["'].*["']$/.test(raw)) {
  fail('DISCORD_WEBHOOK_URL has surrounding whitespace or quotes — strip them.');
}
if (!accepted(raw)) {
  fail(
    'DISCORD_WEBHOOK_URL is not a Discord host, so the app would silently refuse it.\n' +
      '        Expected discord.com / discordapp.com. The app treats a rejected URL\n' +
      '        exactly like a missing one, which is why this check exists.',
  );
}

console.log('  URL present, well-formed, and on an accepted Discord host.');
console.log('  Posting a test embed…');

const embed = {
  title: '🔥 Raid starting',
  color: 0xe2703a,
  description: 'Test flare from `scripts/test-discord-webhook.mjs` — safe to ignore.',
  fields: [
    { name: 'Boss', value: 'Test Boss', inline: true },
    { name: 'Needs', value: '2 more', inline: true },
    { name: 'Where', value: 'Test POI', inline: true },
    { name: 'Expires', value: 'in 45 min', inline: true },
  ],
  footer: { text: 'PoGo TXK · webhook connectivity test' },
  timestamp: new Date().toISOString(),
};

const res = await fetch(`${raw}${raw.includes('?') ? '&' : '?'}wait=true`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    username: 'PoGo TXK',
    embeds: [embed],
    allowed_mentions: { parse: [] },
  }),
  signal: AbortSignal.timeout(5000),
});

if (!res.ok) {
  const hint =
    res.status === 401 || res.status === 403
      ? ' — the webhook was deleted or the URL is wrong'
      : res.status === 404
        ? ' — no such webhook; it was probably deleted and recreated'
        : res.status === 429
          ? ' — rate limited, wait a moment'
          : '';
  fail(`Discord returned ${res.status} ${res.statusText}${hint}`);
}

const body = await res.json().catch(() => null);
const id = body?.id ?? null;

console.log(`\n  PASS  Embed delivered. message id: ${id ?? '(none returned)'}`);

if (!id) {
  console.log(
    '\n  NOTE  Discord did not return a message id. postFlareToDiscord() relies on\n' +
      '        ?wait=true returning one so it can strike the embed through when the\n' +
      '        flare closes. Worth investigating if this persists.',
  );
} else if (process.argv.includes('--close')) {
  console.log('  Testing the close/edit path…');
  const patch = await fetch(`${raw}/messages/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ embeds: [{ title: '✅ Flare closed', color: 0x5a6675 }] }),
    signal: AbortSignal.timeout(5000),
  });
  console.log(
    patch.ok
      ? '  PASS  Edit path works — closed flares will strike through correctly.'
      : `  WARN  Edit path returned ${patch.status}; flares will post but never visibly close.`,
  );
}

console.log('\n  Check the channel — you should see the embed.\n');
