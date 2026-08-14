/**
 * Where the community actually is, in one place.
 *
 * This lived in `index.astro` until the header started rendering the same four
 * links. Two copies would have drifted the first time one changed, and the
 * Campfire entry is the one that makes that expensive: it is an AppsFlyer
 * OneLink that Campfire generated, carrying a base64 club id. Nobody is
 * retyping that correctly from memory, and a wrong copy fails silently by
 * opening the app to no club at all.
 *
 * `hint` is only used where there is room for a second line — the header shows
 * the mark alone.
 */

export type SocialName = 'discord' | 'campfire' | 'facebook' | 'instagram';

export interface Social {
  href: string;
  /** Also the accessible name wherever the mark appears without visible text. */
  label: string;
  hint: string;
  name: SocialName;
}

/**
 * On its own as well as in the list, because the two are wanted in different
 * places: the socials row renders every entry, while anything telling a guest
 * how to become a member wants this one link and nothing else. Naming it here
 * beats a `SOCIALS.find(...)` that has to be non-null-asserted at each use.
 */
export const DISCORD_INVITE = 'https://discord.com/invite/2sYR5YdRpH';

export const SOCIALS: readonly Social[] = [
  {
    href: DISCORD_INVITE,
    label: 'Discord',
    hint: 'Raids, chat, meetups',
    name: 'discord',
  },
  {
    href: 'https://campfire.onelink.me/eBr8?af_dp=campfire%3A%2F%2F&af_force_deeplink=true&deep_link_sub1=cj1jbHVicyZjPTI4Y2Y0NDJjLTg2M2UtNDcwZS1iYmQwLTQwNjdhNDcxMDJjYyZpPXRydWU%3D',
    label: 'Campfire',
    hint: 'Check in at meetups',
    name: 'campfire',
  },
  {
    href: 'https://www.facebook.com/groups/1792291964630166/',
    label: 'Facebook',
    hint: 'Community group',
    name: 'facebook',
  },
  {
    href: 'https://www.instagram.com/pogotxk',
    label: 'Instagram',
    hint: '@pogotxk',
    name: 'instagram',
  },
];
