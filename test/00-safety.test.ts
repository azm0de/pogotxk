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
 * Since 2026-09-22 there are **two** outbound senders to hold shut. The second
 * is Resend, added with the admin password reset, and it is the more dangerous
 * of the pair: the message it sends is a working link to change an admin's
 * password, it goes to a real person's mailbox rather than a channel, and a
 * mail cannot be unsent any more than an embed can. It is blanked in
 * `vitest.config.ts` the same way and proven shut the same way here.
 *
 * Named `00-` so it is the first thing anyone sees fail.
 */

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getDiscordEvents } from '~/lib/discord-events';
import { postFlareToDiscord, webhookUrl, type FlareNotification } from '~/lib/notify/discord';
import { emailConfigured, emailFrom, resendApiKey, sendEmail } from '~/lib/notify/email';
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

/** The one host `sendEmail` will hand an API key to. */
function isResendHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'api.resend.com' || h === 'resend.com' || h.endsWith('.resend.com');
}

describe('outbound credentials are neutralised under test', () => {
  it.each([
    'DISCORD_WEBHOOK_URL',
    'DISCORD_BOT_TOKEN',
    'VAPID_PUBLIC_KEY',
    'VAPID_PRIVATE_KEY',
    'VAPID_SUBJECT',
    // The second sender. Both halves, because `sendEmail` needs both and
    // blanking only one would leave the rail depending on which one.
    'RESEND_API_KEY',
    'RESEND_FROM',
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

  it('no binding at all carries a Resend URL either', () => {
    // The same sweep for the second sender. `sendEmail` takes its endpoint from
    // a constant rather than from configuration, so this is not guarding the
    // send path — it is guarding against a binding that *looks* like an
    // endpoint being introduced later and being read by something that trusts
    // it, which is precisely how the webhook incident happened.
    const offenders = Object.entries(bag)
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => [key, hostnameOf(value as string)] as const)
      .filter(([, host]) => host !== null && isResendHost(host))
      .map(([key]) => key);

    expect(offenders, 'these bindings resolve to a Resend host').toEqual([]);
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

describe('the mail path cannot reach Resend', () => {
  /*
   * The second sender, held shut the same way as the first — and this is the
   * one where the blast radius is worst. `sendEmail`'s only caller mails a
   * live link that sets an admin's password, to a real person's inbox. A
   * stray send in a test run is not a stray message in a channel somebody can
   * delete; it is a password-reset link in somebody's mail, and a reset link
   * that has genuinely been delivered to a mailbox is a credential.
   */
  it('the configuration reports itself disabled', () => {
    // The app's own gate, which is what actually decides whether anything is
    // sent. Asserted as a boolean rather than against the values, for the same
    // reason the emptiness checks above assert on `length`: Vitest prints what
    // it compared, and a failure here means a real key is loaded.
    expect(resendApiKey(env) === null, 'RESEND_API_KEY was accepted').toBe(true);
    expect(emailFrom(env) === null, 'RESEND_FROM was accepted').toBe(true);
    expect(emailConfigured(env), 'the mail sender reports itself configured').toBe(false);
  });

  it('sendEmail sends nothing, and does not even try', async () => {
    const discord = mockDiscord();

    const outcome = await sendEmail(env, {
      to: 'nobody@example.test',
      subject: 'safety test — must never be sent',
      text: 'safety test — must never be sent',
    });

    expect(outcome).toBe('disabled');
    // `sendEmail` swallows transport errors and returns `retry`, so "the stub
    // threw" would be invisible in the return value. The recorded call list is
    // the assertion that matters: nothing was attempted at all.
    discord.assertNotCalled();
  });

  it('refuses even when handed a recipient that is perfectly valid', async () => {
    // The refusal must come from the configuration being absent, not from the
    // message being malformed — otherwise this file would pass against a
    // sender that happily posts a well-formed message to a live API.
    const discord = mockDiscord();

    expect(
      await sendEmail(env, { to: 'admin@pogotxk.test', subject: 'x', text: 'x' }),
    ).toBe('disabled');
    discord.assertNotCalled();
  });

  it('refuses a message with an HTML part just the same', async () => {
    // Since 2026-09-23 the reset mail carries a branded HTML part beside its
    // text. A richer message is no reason for the path to open: the refusal
    // comes from the configuration, whatever the message holds.
    const discord = mockDiscord();

    expect(
      await sendEmail(env, {
        to: 'admin@pogotxk.test',
        subject: 'x',
        text: 'x',
        html: '<p>safety test — must never be sent</p>',
      }),
    ).toBe('disabled');
    discord.assertNotCalled();
  });
});

describe('no test reaches the network at all', () => {
  it('an unstubbed fetch is refused', async () => {
    // Blanking the credentials closes the Discord paths. This closes the rest:
    // every third party, under any binding, whether or not anyone thought of it.
    await expect(fetch('https://example.com/')).rejects.toThrow(/real outbound request/);
  });

  it.each(['https://api.resend.com/emails', 'https://discord.com/api/webhooks/1/x'])(
    'including %s specifically',
    async (url) => {
      /*
       * The two senders named, rather than left to the general rule above.
       *
       * The general rule is the one that actually holds — `test/setup.ts`
       * replaces `globalThis.fetch` before every test in every file, and
       * nothing keeps a reference to the original afterwards, so there is no
       * path back to the network for any host. Naming these two is a legibility
       * assertion: the two endpoints whose messages cannot be recalled are
       * stated in the file somebody reads when they are worried about exactly
       * that, instead of being covered by implication.
       */
      await expect(fetch(url, { method: 'POST' })).rejects.toThrow(/real outbound request/);
    },
  );

  it('a stub covers code running inside a route, not only the test', async () => {
    // The property every route test depends on. The game feed is the app's one
    // unconditional third-party call and it happens deep inside the route, so
    // seeing it recorded here proves the stub reaches through `SELF`.
    const discord = mockDiscord();
    await SELF.fetch('https://pogotxk.test/api/game/raids.json');

    discord.assertCalled('raw.githubusercontent.com');
  });
});
