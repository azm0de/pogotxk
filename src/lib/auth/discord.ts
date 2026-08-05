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

export function authorizeUrl(
  cfg: DiscordConfig,
  url: URL,
  state: string,
  challenge: string,
): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri(url),
    response_type: 'code',
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'none',
  });
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
export async function fetchGuildRoles(
  accessToken: string,
  guildId: string | undefined,
): Promise<string[] | null> {
  // No guild configured yet — treat as "not a member" rather than calling the
  // API with an empty id, which would 400.
  if (!guildId) return null;

  const res = await fetch(`${API}/users/@me/guilds/${guildId}/member`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Discord guild member lookup failed (${res.status})`);

  const body = (await res.json()) as { roles?: string[] };
  return body.roles ?? [];
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
 * Insert or refresh the user record. Profile fields and role are re-synced on
 * every login, so a Discord role change takes effect the next time they sign
 * in. Locally-owned fields (team, trainer name/level) are left alone.
 */
export async function upsertUser(
  db: D1Database,
  user: DiscordUser,
  role: Role,
): Promise<{ id: number; role: Role; team: Team | null; isBanned: boolean }> {
  await db
    .prepare(
      `INSERT INTO users (discord_id, username, global_name, avatar_hash, role, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT (discord_id) DO UPDATE SET
         username     = excluded.username,
         global_name  = excluded.global_name,
         avatar_hash  = excluded.avatar_hash,
         role         = excluded.role,
         last_seen_at = excluded.last_seen_at,
         updated_at   = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
    )
    .bind(user.id, user.username, user.global_name, user.avatar, role)
    .run();

  const row = await db
    .prepare('SELECT id, role, team, is_banned FROM users WHERE discord_id = ?1')
    .bind(user.id)
    .first<{ id: number; role: Role; team: Team | null; is_banned: number }>();

  if (!row) throw new Error('User upsert did not produce a row');
  return { id: row.id, role: row.role, team: row.team, isBanned: row.is_banned === 1 };
}
