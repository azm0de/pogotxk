/**
 * Checks the notification guards that do not need a network.
 *
 *   npx tsx scripts/test-notify.ts
 *
 * The webhook host check is the security-relevant one: DISCORD_WEBHOOK_URL is
 * configuration, and a wrong or hostile value would quietly forward every flare
 * — including trainer names and locations — to somebody else's server.
 */

import {
  closeOutcomeForStatus,
  flareEmbed,
  webhookUrl,
  type FlareNotification,
} from '../src/lib/notify/discord';
import { vapidKeys, pushPublicKey } from '../src/lib/notify/push';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`,
  );
  if (!ok) failures++;
}

const env = (vars: Record<string, string | undefined>) => vars as unknown as Env;
const accepted = (url: string) => webhookUrl(env({ DISCORD_WEBHOOK_URL: url })) !== null;

console.log('\n== Discord webhook host allowlist ==');
check('canonical discord.com', accepted('https://discord.com/api/webhooks/1/abc'), true);
check('legacy discordapp.com', accepted('https://discordapp.com/api/webhooks/1/abc'), true);
check('ptb subdomain', accepted('https://ptb.discord.com/api/webhooks/1/abc'), true);

console.log('\n  hostile / mistaken values must be refused:');
check('arbitrary host', accepted('https://evil.example/api/webhooks/1/abc'), false);
// The classic near-miss: a suffix match on "discord.com" would accept this.
check('suffix lookalike', accepted('https://notdiscord.com/api/webhooks/1/abc'), false);
check('embedded in path', accepted('https://evil.example/discord.com/webhooks'), false);
check('userinfo trick', accepted('https://discord.com@evil.example/webhooks'), false);
check('not a url at all', accepted('definitely-not-a-url'), false);
check('unset', webhookUrl(env({})), null);
check('empty string', webhookUrl(env({ DISCORD_WEBHOOK_URL: '' })), null);

/**
 * Closing an embed is a best-effort edit against someone else's API, so the
 * only thing that keeps it correct is knowing which failures are worth
 * repeating. Get this wrong in one direction and closed flares stay advertised
 * forever; get it wrong in the other and one deleted message is re-attempted on
 * every board read for the life of the deployment.
 */
console.log('\n== Discord close-edit outcome classification ==');
check('200 -> edited', closeOutcomeForStatus(200), 'edited');
check('204 -> edited', closeOutcomeForStatus(204), 'edited');

console.log('\n  unrecoverable — stop retrying:');
check('404 message deleted', closeOutcomeForStatus(404), 'gone');
check('401 webhook rotated', closeOutcomeForStatus(401), 'gone');
check('403 forbidden', closeOutcomeForStatus(403), 'gone');

console.log('\n  transient — must be retried:');
// The one most likely to be misclassified: a burst of flares expiring together
// is exactly when Discord rate-limits, and treating that as permanent would
// silently drop the whole burst.
check('429 rate limited', closeOutcomeForStatus(429), 'retry');
check('500 server error', closeOutcomeForStatus(500), 'retry');
check('502 bad gateway', closeOutcomeForStatus(502), 'retry');
check('503 unavailable', closeOutcomeForStatus(503), 'retry');

console.log('\n== VAPID configuration ==');
const good = {
  VAPID_PUBLIC_KEY: 'pub',
  VAPID_PRIVATE_KEY: 'priv',
  VAPID_SUBJECT: 'mailto:a@b.com',
};
check('fully configured', vapidKeys(env(good)) !== null, true);
check('public key surfaced', pushPublicKey(env(good)), 'pub');
check('unconfigured -> null', vapidKeys(env({})), null);
check('missing private key', vapidKeys(env({ ...good, VAPID_PRIVATE_KEY: undefined })), null);
check('missing public key', vapidKeys(env({ ...good, VAPID_PUBLIC_KEY: undefined })), null);

// Apple returns 403 for a subject that is not mailto: or https://, and only on
// iOS — so a bad subject looks like "push works, except on iPhones".
console.log('\n  subject must be mailto: or https: (Apple 403s otherwise):');
check('https subject ok', vapidKeys(env({ ...good, VAPID_SUBJECT: 'https://a.com' })) !== null, true);
check('bare email refused', vapidKeys(env({ ...good, VAPID_SUBJECT: 'a@b.com' })), null);
check('http refused', vapidKeys(env({ ...good, VAPID_SUBJECT: 'http://a.com' })), null);
check('missing subject refused', vapidKeys(env({ ...good, VAPID_SUBJECT: undefined })), null);

/*
 * The embed body.
 *
 * This is shared by posting a flare and by editing one after the trainer fixes
 * the boss. That sharing is the point: an embed is delivered once and then sits
 * in the channel indefinitely, so if the two builders drifted, a corrected
 * flare would keep advertising the old boss to everybody who scrolled past.
 */
console.log('\n== flare embed ==');
const ORIGIN = 'https://pogotxk.gnomelabz.workers.dev';
const raid: FlareNotification = {
  id: 1,
  kind: 'raid',
  boss: 'Mewtwo',
  tier: 'Tier 5',
  needed: null,
  note: 'Starting in 5',
  expiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
  poi: { name: 'Campsite - Genuine', slug: 'campsite-genuine', lat: 33.4, lng: -94.0 },
  author: { name: 'azm.0' },
};
const fieldsOf = (f: FlareNotification) =>
  (flareEmbed(f, ORIGIN).fields as { name: string; value: string }[]).map((x) => x.name);
const valueOf = (f: FlareNotification, name: string) =>
  (flareEmbed(f, ORIGIN).fields as { name: string; value: string }[]).find((x) => x.name === name)
    ?.value;

check('boss shown', valueOf(raid, 'Boss'), 'Mewtwo');
check('tier shown', valueOf(raid, 'Tier'), 'Tier 5');
check('location shown', valueOf(raid, 'Where'), 'Campsite - Genuine');
check('note becomes the description', flareEmbed(raid, ORIGIN).description, 'Starting in 5');
check('links to the pin', flareEmbed(raid, ORIGIN).url, `${ORIGIN}/map?poi=campsite-genuine`);

// Absent fields must vanish rather than render empty: a "Tier" row reading
// nothing looks like a bug in the app to everyone who sees the embed.
console.log('\n  fields we do not have are omitted, not blanked:');
check('no tier -> no Tier row', fieldsOf({ ...raid, tier: null }).includes('Tier'), false);
check('no boss -> no Boss row', fieldsOf({ ...raid, boss: null }).includes('Boss'), false);
check('no poi -> no Where row', fieldsOf({ ...raid, poi: null }).includes('Where'), false);
check('no poi -> links to the board', flareEmbed({ ...raid, poi: null }, ORIGIN).url, `${ORIGIN}/live`);
check('expiry is always there', fieldsOf({ ...raid, boss: null, tier: null, poi: null }), ['Expires']);

// `needed` is the invites counter; it must not ride along on a raid.
const invites: FlareNotification = { ...raid, kind: 'remote_invites', tier: null, needed: 3 };
check('invites show a count', valueOf(invites, 'Needs'), '3 more');
check('a raid with no count shows none', fieldsOf(raid).includes('Needs'), false);

console.log(failures ? `\nFAILED (${failures})\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
