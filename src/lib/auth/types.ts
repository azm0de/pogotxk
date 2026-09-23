/** Site roles, ordered least to most privileged. */
export const ROLES = ['guest', 'member', 'ambassador', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export type Team = 'valor' | 'mystic' | 'instinct';

export interface SessionUser {
  id: number;
  discordId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  role: Role;
  team: Team | null;
  trainerName: string | null;
  trainerLevel: number | null;
}

const RANK: Record<Role, number> = { guest: 0, member: 1, ambassador: 2, admin: 3 };

/** True when `user` holds `required` or better. */
export function hasRole(user: SessionUser | undefined, required: Role): boolean {
  if (!user) return false;
  return RANK[user.role] >= RANK[required];
}

/**
 * The `discord_id` prefix of a standalone admin identity: an account minted by
 * `scripts/set-admin-password.ts --create`, with a password and no Discord
 * account behind it. Production holds `admin:justin` and `admin:nic`.
 *
 * A Discord snowflake is digits only, so this can never collide with a real
 * one — the same property `deleted:<id>` relies on in `./deletion`. The setter
 * mints with this constant rather than its own copy of the string, so the two
 * cannot drift apart.
 */
export const STANDALONE_ADMIN_PREFIX = 'admin:';

/**
 * Whether `user` is a standalone admin identity rather than a Discord account.
 *
 * Nothing Discord-shaped applies to one: there is no Discord account to switch
 * away from, and self-service deletion would drop the credential that is the
 * account's only way in (`deleteAccount` deletes it, deliberately). Admin
 * accounts are managed with `npm run set:password` instead. The account menu
 * reads this, through `/api/me.json`, to leave those two rows out.
 *
 * About the identity, not the role: a Discord account that happens to be an
 * ambassador or an admin is still a Discord account and gets the full menu.
 */
export function isStandaloneAdmin(user: SessionUser | undefined): boolean {
  return user !== undefined && user.discordId.startsWith(STANDALONE_ADMIN_PREFIX);
}

export function avatarUrl(discordId: string, hash: string | null): string | null {
  if (!hash) return null;
  const ext = hash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${discordId}/${hash}.${ext}?size=128`;
}
