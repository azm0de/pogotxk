/**
 * The guard on the guard.
 *
 * `vitest.config.ts` blanks every binding that would reach somebody else's
 * server. This file proves it did, and — more to the point — proves the code
 * paths that use those bindings cannot get out even so. Testing that a control
 * works is not the same as testing it cannot be bypassed
 * (vault/Bugs Worth Remembering.md).
 *
 * Why it matters here in particular: `.dev.vars` holds a live
 * `DISCORD_WEBHOOK_URL` pointing at the community's real Discord, wrangler
 * folds that file into the bindings whenever a `configPath` is given, and
 * raising a flare posts an embed to whatever that value resolves to. A local
 * smoke test has already put a real message in that channel once. An embed
 * cannot be unsent.
 *
 * Named `00-` so it is the first thing anyone sees fail.
 */

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getDiscordEvents } from '~/lib/discord-events';
import { postFlareToDiscord, webhookUrl, type FlareNotification } from '~/lib/notify/discord';
import { mockDiscord } from './helpers/discord-mock';

/**
 * These are secrets, so they are absent from the generated `Cloudflare.Env` —
 * the same widening the app itself uses to read them.
 */
const bag = env as unknown as Record<string, unknown>;

/** Hosts `webhookUrl` accepts, which is the set that can reach a real channel. */
function isDiscordHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'discord.com' || h === 'discordapp.com' || h.endsWith('.discord.com');
}

function hostnameOf(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

describe('outbound credentials are neutralised under test', () => {
  it.each([
    'DISCORD_WEBHOOK_URL',
    'DISCORD_BOT_TOKEN',
    'VAPID_PUBLIC_KEY',
    'VAPID_PRIVATE_KEY',
    'VAPID_SUBJECT',
  ])('%s is blank', (key) => {
    const value = bag[key];
    expect(
      typeof value === 'string',
      `${key} should be overridden to an empty string in vitest.config.ts, got ${typeof value}. ` +
        'Without that override wrangler loads the real value out of .dev.vars.',
    ).toBe(true);
    // Assert on the length, never the value. A failure here means the real
    // credential is loaded, and Vitest prints what it compared — so comparing
    // the string itself would put the live webhook in the terminal and in
    // whatever log captured it, which is most of the harm this file exists to
    // prevent.
    expect(
      (value as string).length,
      `${key} is not empty — the real credential has leaked into the test run`,
    ).toBe(0);
  });

  it('the webhook does not point at Discord, whatever it holds', () => {
    // Deliberately not folded into the emptiness check above. If a future change
    // sets this to something non-empty for a good reason, that is survivable;
    // setting it to a Discord URL never is.
    const value = bag.DISCORD_WEBHOOK_URL;
    if (typeof value !== 'string' || value === '') return;
    const host = hostnameOf(value);
    expect(host === null || !isDiscordHost(host), `webhook host ${host} is a real Discord host`).toBe(
      true,
    );
  });

  it('no binding at all carries a Discord URL', () => {
    // The named checks above only cover the bindings that exist today. A new
    // secret could smuggle one in under a name nobody thought to list.
    const offenders = Object.entries(bag)
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => [key, hostnameOf(value as string)] as const)
      .filter(([, host]) => host !== null && isDiscordHost(host))
      .map(([key]) => key);

    expect(offenders, 'these bindings resolve to a Discord host').toEqual([]);
  });
});

describe('the delivery paths cannot reach Discord', () => {
  const flare: FlareNotification = {
    id: 1,
    kind: 'raid',
    boss: 'Mewtwo',
    tier: '5',
    needed: null,
    note: 'safety test — must never be sent',
    expiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
    poi: null,
    author: null,
  };

  it('webhookUrl refuses the configured value', () => {
    // The app's own gate, which is what actually decides whether anything is
    // sent. An empty string has to fail it, not merely look harmless.
    // `toBeNull()` would print the accepted URL on failure; the whole point is
    // that the URL must not be printed.
    expect(webhookUrl(env) === null, 'webhookUrl accepted the configured webhook').toBe(true);
  });

  it('postFlareToDiscord sends nothing', async () => {
    const discord = mockDiscord();
    const messageId = await postFlareToDiscord(env, flare, 'https://pogotxk.test');

    expect(messageId).toBeNull();
    // `postFlareToDiscord` swallows its own errors, so "the mock threw" would
    // not surface. The recorded call list is the assertion that matters.
    discord.assertNotCalled();
  });

  it('the Discord events feed cannot authenticate as the bot', async () => {
    const discord = mockDiscord();
    const result = await getDiscordEvents({ force: true });

    expect(result.error).toMatch(/DISCORD_BOT_TOKEN/);
    expect(result.events).toEqual([]);
    discord.assertNotCalled();
  });
});

describe('no test reaches the network at all', () => {
  it('an unstubbed fetch is refused', async () => {
    // Blanking the credentials closes the Discord paths. This closes the rest:
    // every third party, under any binding, whether or not anyone thought of it.
    await expect(fetch('https://example.com/')).rejects.toThrow(/real outbound request/);
  });

  it('a stub covers code running inside a route, not only the test', async () => {
    // The property every route test depends on. The game feed is the app's one
    // unconditional third-party call and it happens deep inside the route, so
    // seeing it recorded here proves the stub reaches through `SELF`.
    const discord = mockDiscord();
    await SELF.fetch('https://pogotxk.test/api/game/raids.json');

    discord.assertCalled('raw.githubusercontent.com');
  });
});
