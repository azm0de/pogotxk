/**
 * Discord as the identity provider.
 *
 * The community already lives on Discord, so guild membership *is* the
 * membership check — no separate account system, and roles stay in one place.
 *
 * Scopes: `identify` for the profile, `guilds.members.read` to read the
 * caller's roles in our guild. Neither is a privileged intent.
 */

import type { Role, Team } from './types';

const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/v10/oauth2/token';
const API = 'https://discord.com/api/v10';
const SCOPES = 'identify guilds.members.read';

export interface DiscordConfig {
  clientId: string;
  clientSecret: string;
  /**
   * Optional. Without it the guild lookup is skipped and everyone signs in as a
   * guest — which still lets `bootstrapAdminId` in, so a fresh deployment can
   * reach the admin console before the server has been wired up.
   */
  guildId?: string;
  roleAdmin?: string;
  roleAmbassador?: string;
  roleMember?: string;
  /** Discord user id that is always admin — bootstraps the first login. */
  bootstrapAdminId?: string;
}

/** Pulls Discord settings off the env, or null when not configured yet. */
export function discordConfig(env: Env): DiscordConfig | null {
  const e = env as unknown as Record<string, string | undefined>;
  if (!e.DISCORD_CLIENT_ID || !e.DISCORD_CLIENT_SECRET) return null;
  return {
    clientId: e.DISCORD_CLIENT_ID,
    clientSecret: e.DISCORD_CLIENT_SECRET,
    guildId: e.DISCORD_GUILD_ID,
    roleAdmin: e.DISCORD_ROLE_ADMIN,
    roleAmbassador: e.DISCORD_ROLE_AMBASSADOR,
    roleMember: e.DISCORD_ROLE_MEMBER,
    bootstrapAdminId: e.DISCORD_BOOTSTRAP_ADMIN_ID,
  };
}

export function redirectUri(url: URL): string {
  return new URL('/auth/callback', url.origin).toString();
}

/** RFC 7636 S256 challenge, base64url with padding stripped. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * `none` skips Discord's approval screen for anyone who has already authorised
 * the app — a returning member signs in without touching anything.
 *
 * Discord documents that case and only that case. What it does when the user
 * has *never* authorised is not written down anywhere: it may show the screen
 * regardless, or it may bounce back with an error. That is not a good thing to
 * be guessing about on the one flow that gates every member's access, so the
 * callback catches the "needs interaction" family of errors and retries once.
 *
 * That retry sends NO `prompt` at all (`default`), not `consent`. `consent`
 * forces Discord's approval screen even for someone who authorised the app
 * long ago — and the commonest way to reach the retry is `login_required`,
 * which means "no Discord session in THIS browser", not "never authorised".
 * On a phone whose owner uses the Discord app rather than Safari, that is
 * every single sign-in. Omitting `prompt` lets Discord show the minimum it
 * actually needs: a login screen if there is no session, the approval screen
 * only if the app has genuinely never been authorised, and nothing extra.
 * First sign-in still works, which was the point of retrying at all.
 *
 * `consent` survives for the one case that genuinely wants it: "use a
 * different account", where the approval screen is the only screen Discord
 * offers that can switch accounts. See `signOutTarget`.
 */
export type AuthPrompt = 'none' | 'consent' | 'default';

export function authorizeUrl(
  cfg: DiscordConfig,
  url: URL,
  state: string,
  challenge: string,
  prompt: AuthPrompt = 'none',
): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri(url),
    response_type: 'code',
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  // Omitted entirely for `default` — sending `prompt=` empty is not the same
  // as not sending it, and Discord treats the absent parameter as "do the
  // minimum necessary".
  if (prompt !== 'default') params.set('prompt', prompt);
  return `${AUTHORIZE_URL}?${params}`;
}

export async function exchangeCode(
  cfg: DiscordConfig,
  url: URL,
  code: string,
  verifier: string,
): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(url),
      code_verifier: verifier,
    }),
  });

  if (!res.ok) {
    throw new Error(`Discord token exchange failed (${res.status})`);
  }
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error('Discord token response had no access_token');
  return body.access_token;
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

export async function fetchUser(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(`${API}/users/@me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Discord /users/@me failed (${res.status})`);
  return (await res.json()) as DiscordUser;
}

/**
 * Read the caller's membership in our guild. A 404 means "not a member", which
 * is an expected outcome rather than an error — those users become guests.
 */
export type GuildLookup =
  /** No guild configured — Discord knows nothing, so the stored role stands. */
  | { known: false }
  /** Discord answered. `roles: null` means this person is not a member. */
  | { known: true; roles: string[] | null };

export async function fetchGuildRoles(
  accessToken: string,
  guildId: string | undefined,
): Promise<GuildLookup> {
  // Distinguishing these two matters: collapsing them to one null meant someone
  // who LEFT the Discord kept their site role forever, because "Discord says
  // they are not a member" was indistinguishable from "we did not ask".
  if (!guildId) return { known: false };

  const res = await fetch(`${API}/users/@me/guilds/${guildId}/member`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  // 404 is Discord telling us they are not in the guild — an answer, not a gap.
  if (res.status === 404) return { known: true, roles: null };
  if (!res.ok) throw new Error(`Discord guild member lookup failed (${res.status})`);

  const body = (await res.json()) as { roles?: string[] };
  return { known: true, roles: body.roles ?? [] };
}

/**
 * Map Discord state onto a site role.
 *
 * Guild membership is the baseline. If DISCORD_ROLE_MEMBER is configured that
 * specific role is required instead, for servers that gate behind a verify
 * step. Ambassador and admin roles upgrade from there.
 */
export function resolveRole(
  cfg: DiscordConfig,
  discordUserId: string,
  guildRoles: string[] | null,
): Role {
  if (cfg.bootstrapAdminId && discordUserId === cfg.bootstrapAdminId) return 'admin';
  if (guildRoles === null) return 'guest';

  if (cfg.roleAdmin && guildRoles.includes(cfg.roleAdmin)) return 'admin';
  if (cfg.roleAmbassador && guildRoles.includes(cfg.roleAmbassador)) return 'ambassador';
  if (cfg.roleMember) return guildRoles.includes(cfg.roleMember) ? 'member' : 'guest';
  return 'member';
}

/**
 * Insert or refresh the user record. Profile fields are re-synced on every
 * login. Locally-owned fields (team, trainer name/level) are left alone.
 *
 * The role is only overwritten when Discord is actually authoritative about
 * it — that is, when a guild is configured and we were able to read the
 * member's roles there. Without a guild, `resolveRole` can only ever answer
 * `guest`, and blindly writing that back would silently demote anyone promoted
 * by hand on their next sign-in. Which is precisely how the first admin gets
 * created before the guild is wired up.
 */
export async function upsertUser(
  db: D1Database,
  user: DiscordUser,
  role: Role,
  /** True when the role was derived from real guild data or the bootstrap id. */
  authoritative: boolean,
): Promise<{ id: number; role: Role; team: Team | null; isBanned: boolean }> {
  await db
    .prepare(
      `INSERT INTO users (discord_id, username, global_name, avatar_hash, role, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT (discord_id) DO UPDATE SET
         username     = excluded.username,
         global_name  = excluded.global_name,
         avatar_hash  = excluded.avatar_hash,
         role         = CASE WHEN ?6 = 1 THEN excluded.role ELSE users.role END,
         last_seen_at = excluded.last_seen_at,
         updated_at   = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
    )
    .bind(user.id, user.username, user.global_name, user.avatar, role, authoritative ? 1 : 0)
    .run();

  const row = await db
    .prepare('SELECT id, role, team, is_banned FROM users WHERE discord_id = ?1')
    .bind(user.id)
    .first<{ id: number; role: Role; team: Team | null; is_banned: number }>();

  if (!row) throw new Error('User upsert did not produce a row');
  return { id: row.id, role: row.role, team: row.team, isBanned: row.is_banned === 1 };
}
