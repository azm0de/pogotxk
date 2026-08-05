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

export function avatarUrl(discordId: string, hash: string | null): string | null {
  if (!hash) return null;
  const ext = hash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${discordId}/${hash}.${ext}?size=128`;
}
