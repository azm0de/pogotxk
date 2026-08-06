/**
 * Checks the notification guards that do not need a network.
 *
 *   npx tsx scripts/test-notify.ts
 *
 * The webhook host check is the security-relevant one: DISCORD_WEBHOOK_URL is
 * configuration, and a wrong or hostile value would quietly forward every flare
 * — including trainer names and locations — to somebody else's server.
 */

import { webhookUrl } from '../src/lib/notify/discord';
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

console.log(failures ? `\nFAILED (${failures})\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
