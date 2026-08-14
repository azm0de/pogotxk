/**
 * Reports which configuration variables the Worker can actually see.
 *
 * Deliberately returns booleans and lengths only — never values — so it is safe
 * to call against production. Guarded by IMPORT_TOKEN.
 *
 * Exists because "I added the secret but the feature still says it is not
 * configured" is otherwise almost impossible to diagnose from outside: a
 * trailing space or a mistyped name looks identical to a missing variable.
 *
 *   curl "https://.../api/admin/config-check" -H "Authorization: Bearer $IMPORT_TOKEN"
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { json, requireImportAuth } from '~/lib/admin-auth';
import { webhookUrl } from '~/lib/notify/discord';

export const prerender = false;

/**
 * Every variable the code reads, and whether the feature it drives is required.
 *
 * Anything the Worker actually uses has to be listed here even when it is
 * optional, because `unrecognisedSimilarNames` below treats a DISCORD_/VAPID_
 * name that is absent from this list as a suspected typo. Leaving a working
 * variable out makes the diagnostic accuse it of being broken.
 */
const EXPECTED = [
  { name: 'DISCORD_CLIENT_ID', required: true, note: 'Discord sign-in' },
  { name: 'DISCORD_CLIENT_SECRET', required: true, note: 'Discord sign-in' },
  { name: 'IMPORT_TOKEN', required: true, note: 'these maintenance endpoints' },
  { name: 'DISCORD_GUILD_ID', required: false, note: 'guild membership check' },
  { name: 'DISCORD_BOOTSTRAP_ADMIN_ID', required: false, note: 'first admin' },
  { name: 'DISCORD_ROLE_ADMIN', required: false, note: 'role mapping' },
  { name: 'DISCORD_ROLE_AMBASSADOR', required: false, note: 'role mapping' },
  { name: 'DISCORD_ROLE_MEMBER', required: false, note: 'role mapping' },
  { name: 'DISCORD_WEBHOOK_URL', required: false, note: 'flares into Discord' },
  { name: 'VAPID_PUBLIC_KEY', required: false, note: 'web push' },
  { name: 'VAPID_PRIVATE_KEY', required: false, note: 'web push' },
  { name: 'VAPID_SUBJECT', required: false, note: 'web push' },
] as const;

export async function GET(ctx: APIContext): Promise<Response> {
  const denied = requireImportAuth(ctx, env);
  if (denied) return denied;

  const bag = env as unknown as Record<string, unknown>;

  const vars = EXPECTED.map((v) => {
    const raw = bag[v.name];
    const present = typeof raw === 'string' && raw.length > 0;
    const value = present ? (raw as string) : '';
    return {
      name: v.name,
      present,
      required: v.required,
      length: present ? value.length : 0,
      // The usual culprits when a value "looks" right but does not work.
      hasSurroundingWhitespace: present && value !== value.trim(),
      hasQuotes: present && /^["'].*["']$/.test(value),
      note: v.note,
    };
  });

  // Anything set on the Worker that looks Discord-related but is not a name we
  // read — catches DISCORD_CLIENTID, DISCORD_CLIENT_ID_ and similar typos.
  //
  // Strings only. `SESSION` is a KV namespace the Cloudflare adapter binds for
  // Astro sessions, and matching it here accused a working platform binding of
  // being a mistyped variable. Configuration is text; a binding is an object,
  // and no amount of squinting at its name changes that. This also covers any
  // future binding that happens to start with one of these words.
  const known = new Set(EXPECTED.map((v) => v.name));
  const unrecognised = Object.keys(bag).filter(
    (k) =>
      typeof bag[k] === 'string' &&
      /^(DISCORD|IMPORT|VAPID|SESSION)/i.test(k) &&
      !known.has(k as never),
  );

  const missingRequired = vars.filter((v) => v.required && !v.present).map((v) => v.name);

  return json({
    ok: missingRequired.length === 0,
    bindings: {
      DB: typeof bag.DB === 'object' && bag.DB !== null,
      MEDIA: typeof bag.MEDIA === 'object' && bag.MEDIA !== null,
      CACHE: typeof bag.CACHE === 'object' && bag.CACHE !== null,
    },
    // Presence is not the gate the webhook actually passes through. `webhookUrl`
    // also rejects any host that is not Discord's, and a rejected value behaves
    // *identically* to an absent one — `postFlareToDiscord` returns null and
    // logs nothing — so `present: true` alone never means flares are reaching
    // Discord. Asking here is the only way to know without firing a real flare
    // into a real channel. Boolean only; the URL is a bearer credential.
    webhook: {
      present: typeof bag.DISCORD_WEBHOOK_URL === 'string' && bag.DISCORD_WEBHOOK_URL.length > 0,
      accepted: webhookUrl(env) !== null,
    },
    vars,
    missingRequired,
    unrecognisedSimilarNames: unrecognised,
    hint: missingRequired.length
      ? `Not visible to the Worker: ${missingRequired.join(', ')}. Check the name is exact (case-sensitive, no trailing space) and that it was saved under this Worker rather than a preview environment.`
      : 'All required variables are present.',
  });
}
