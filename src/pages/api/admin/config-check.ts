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
import { json, requireImportToken } from '~/lib/admin-auth';

export const prerender = false;

/** Every variable the code reads, and whether the feature it drives is required. */
const EXPECTED = [
  { name: 'DISCORD_CLIENT_ID', required: true, note: 'Discord sign-in' },
  { name: 'DISCORD_CLIENT_SECRET', required: true, note: 'Discord sign-in' },
  { name: 'IMPORT_TOKEN', required: true, note: 'these maintenance endpoints' },
  { name: 'DISCORD_GUILD_ID', required: false, note: 'guild membership check' },
  { name: 'DISCORD_BOOTSTRAP_ADMIN_ID', required: false, note: 'first admin' },
  { name: 'DISCORD_ROLE_ADMIN', required: false, note: 'role mapping' },
  { name: 'DISCORD_ROLE_AMBASSADOR', required: false, note: 'role mapping' },
  { name: 'DISCORD_ROLE_MEMBER', required: false, note: 'role mapping' },
] as const;

export async function GET(ctx: APIContext): Promise<Response> {
  const denied = requireImportToken(ctx.request, env);
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
  const known = new Set(EXPECTED.map((v) => v.name));
  const unrecognised = Object.keys(bag).filter(
    (k) => /^(DISCORD|IMPORT|VAPID|SESSION)/i.test(k) && !known.has(k as never),
  );

  const missingRequired = vars.filter((v) => v.required && !v.present).map((v) => v.name);

  return json({
    ok: missingRequired.length === 0,
    bindings: {
      DB: typeof bag.DB === 'object' && bag.DB !== null,
      MEDIA: typeof bag.MEDIA === 'object' && bag.MEDIA !== null,
      CACHE: typeof bag.CACHE === 'object' && bag.CACHE !== null,
    },
    vars,
    missingRequired,
    unrecognisedSimilarNames: unrecognised,
    hint: missingRequired.length
      ? `Not visible to the Worker: ${missingRequired.join(', ')}. Check the name is exact (case-sensitive, no trailing space) and that it was saved under this Worker rather than a preview environment.`
      : 'All required variables are present.',
  });
}
