import type { JSX } from 'react';

import { FLARE_KINDS, type FlareKind } from '~/lib/db/flares';

/**
 * The six flare kinds, drawn.
 *
 * Emoji used to do this job on /go, which meant the icon set changed shape,
 * colour and weight with the reader's operating system and carried none of the
 * board's own vocabulary. These are authored SVG in one stroke weight, in the
 * silhouettes the map already uses (`src/components/map/markerIcons.ts`): the
 * gym tower and the teardrop pin are the same objects here as they are on a
 * pin, so a raid tile and a gym marker read as the same thing.
 *
 * House rules for anything added here:
 *
 * - 24x24 viewBox, 2px stroke, `currentColor`, no fill. One weight, so six
 *   icons in a row look like one set rather than six downloads.
 * - Round caps and joins. At 28px on a phone in sunlight the joins are most of
 *   what is left of the drawing.
 * - `aria-hidden` on the <svg>. Every place these are used has the kind's own
 *   name in text beside it — colour and shape are never the only signal here —
 *   so an icon that announced itself would just say everything twice.
 *
 * /live imports these too, so they take their labels from the same place the
 * icons come from: `FLARE_KIND_LABEL` in src/lib/db/flares.ts.
 */

/**
 * The gym tower, shared by `raid` and `gym_takedown`.
 *
 * Same object as `GLYPH_GYM` on the map, redrawn as an outline at this size:
 * ground line, two walls under a pitched roof, a doorway. Raid sets it alight;
 * takedown puts an arrow into it.
 */
const TOWER = (
  <>
    <path d="M4 21h16" />
    <path d="M7 21v-7l5-3 5 3v7" />
    <path d="M10 21v-4h4v4" />
  </>
);

const GLYPHS: Record<FlareKind, JSX.Element> = {
  /* A flame over the gym: the tile that means "this gym is hot, come now". */
  raid: (
    <>
      <path d="M12 2.6c1.8 1.6 2.7 2.8 2.7 4a2.7 2.7 0 0 1-5.4 0c0-1.2.9-2.4 2.7-4z" />
      {TOWER}
    </>
  ),
  /* The same gym with a strike coming down onto it. */
  gym_takedown: (
    <>
      <path d="M21 4.5l-4.5 4.5" />
      <path d="M16.5 9V6" />
      <path d="M16.5 9h3" />
      {TOWER}
    </>
  ),
  /* The map's own teardrop pin: "I am standing at this spot". */
  meetup_here: (
    <>
      <path d="M12 21.5s7-7.6 7-12.2A7 7 0 1 0 5 9.3c0 4.6 7 12.2 7 12.2z" />
      <circle cx="12" cy="9.3" r="2.6" />
    </>
  ),
  /* A torn ticket: passes going spare, handed out one at a time. */
  remote_invites: (
    <>
      <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h15A1.5 1.5 0 0 1 21 8.5V10a2 2 0 0 0 0 4v1.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 15.5V14a2 2 0 0 1 0-4z" />
      <path d="M14 7.6v8.8" strokeDasharray="2 2.4" />
    </>
  ),
  /* Two arrows passing each other. */
  trade: (
    <>
      <path d="M4 9h13" />
      <path d="M14 6l3 3-3 3" />
      <path d="M20 15H7" />
      <path d="M10 12l-3 3 3 3" />
    </>
  ),
  /* A raised hand: the catch-all, "someone come and help". */
  help: (
    <>
      <path d="M8.2 13.5V6.2a1.7 1.7 0 0 1 3.4 0v3.6" />
      <path d="M11.6 9.8V4.9a1.7 1.7 0 0 1 3.4 0v4.9" />
      <path d="M15 10.4a1.7 1.7 0 0 1 3.4 0V15a6 6 0 0 1-6 6h-1.3a5 5 0 0 1-3.7-1.6l-3-3.3a1.7 1.7 0 0 1 2.5-2.3l1.3 1.4" />
    </>
  ),
};

export interface FlareIconProps {
  kind: FlareKind;
  /** Rendered size in px, both axes. 24 is the size it was drawn at. */
  size?: number;
  className?: string;
}

export function FlareIcon({ kind, size = 24, className }: FlareIconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[kind]}
    </svg>
  );
}

/**
 * The same six at their drawn size, for somewhere that wants an element rather
 * than a component call — a lookup table beside `FLARE_KIND_LABEL`, say.
 */
export const FLARE_ICONS: Record<FlareKind, JSX.Element> = Object.fromEntries(
  FLARE_KINDS.map((kind) => [kind, <FlareIcon key={kind} kind={kind} />]),
) as Record<FlareKind, JSX.Element>;
