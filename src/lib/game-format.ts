/**
 * Turning ScrapedDuck's game data into things a page can print.
 *
 * Split out of `scrapedduck.ts` on 2026-09-08 for one reason: that module
 * imports `cloudflare:workers` at the top level for the KV cache, and a
 * module-scope Workers import cannot be loaded by `tsx`. Ten pure functions —
 * the tier ranking, the CP formatting, the relative clock, the HTML entity
 * unescaping — were therefore untestable purely by association, despite
 * touching no binding, no network and no clock but the one handed to them.
 *
 * Nothing here may import `cloudflare:workers`, directly or transitively. That
 * is the whole point of the file, and `scripts/test-game-format.ts` stops
 * running the moment it is broken.
 *
 * The direction of the dependency matters too: `scrapedduck.ts` imports this,
 * never the other way round. Fetching knows about formatting; formatting knows
 * nothing about where the bytes came from.
 */

/** A raid boss's CP band. Lives here because `formatCp` is what renders it. */
export interface CpRange {
  min: number;
  max: number;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/**
 * Research task text arrives as a fragment of Leek Duck's own markup
 * ("<span>Catch 7 Pokémon</span>"). We want the words, not the span — and we
 * never want to render upstream HTML unescaped, so this strips rather than
 * sanitises.
 */
export function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (entity, body: string) => {
      // Numeric forms are not in the table and there are too many to enumerate,
      // so decode them arithmetically. A named entity we do not know is left
      // as-is: showing "&hellip;" is honest, showing a wrong glyph is not.
      if (body.startsWith('#')) {
        const hex = body[1] === 'x' || body[1] === 'X';
        const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
        // Reject non-characters and anything out of range rather than emitting
        // a replacement char.
        if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
          try {
            return String.fromCodePoint(code);
          } catch {
            return entity;
          }
        }
        return entity;
      }
      return ENTITIES[entity.toLowerCase()] ?? entity;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * "637" when the spread is a single value, "688–739" otherwise.
 *
 * Tolerates a missing or malformed range. The payload is a third-party scrape:
 * `fetchUpstream` proves it is a non-empty array but nothing checks the shape of
 * the entries inside it, and one boss arriving without `combatPower` would throw
 * out of the template and 500 the whole page. Worse, that payload is written to
 * KV *before* the render runs, so the 500 would outlive the bad upstream commit.
 * A dash on one card is the failure this module promises everywhere else.
 */
export function formatCp(range: CpRange | null | undefined): string {
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return '—';
  return range.min === range.max ? String(range.min) : `${range.min}–${range.max}`;
}

/**
 * Non-numeric raid tiers, checked longest-first so "Mega Legendary" is not
 * swallowed by the "mega" test.
 */
const NAMED_TIERS: readonly (readonly [pattern: string, rank: number])[] = [
  ['mega legendary', 110],
  ['mega', 100],
  ['primal', 120],
  ['ultra beast', 130],
  ['elite', 140],
];

/**
 * Sort key for a raid tier.
 *
 * Niantic invents new tiers (Elite, Primal, Shadow, Mega Legendary) faster than
 * anyone updates a constant, so rank is derived from the string: star tiers by
 * their number, named tiers in a fixed order after them, Shadow variants after
 * everything, and an unrecognised tier at the end — visible rather than lost.
 */
export function raidTierRank(tier: string): number {
  const t = tier.toLowerCase();
  const shadowOffset = t.includes('shadow') ? 1000 : 0;

  const stars = /(\d+)[\s-]*star/.exec(t);
  if (stars) return shadowOffset + Number(stars[1]);

  for (const [pattern, rank] of NAMED_TIERS) {
    if (t.includes(pattern)) return shadowOffset + rank;
  }
  return shadowOffset + 900;
}

/** Stable slug for a tier, used as a CSS hook: "5-Star Raids" -> "5-star-raids". */
export function slugifyLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Egg pools sort by walking distance: 1, 2, 5, 7, 10, 12 km. */
export function eggDistanceRank(eggType: string): number {
  const km = /(\d+)/.exec(eggType);
  return km ? Number(km[1]) : 999;
}

const RESEARCH_ORDER = ['catch', 'throw', 'explore', 'battle', 'rocket', 'training', 'buddy'];

const RESEARCH_LABELS: Record<string, string> = {
  catch: 'Catching',
  throw: 'Throwing',
  explore: 'Exploring',
  battle: 'Battling',
  rocket: 'Team GO Rocket',
  training: 'Training',
  buddy: 'Buddy',
  other: 'Other tasks',
};

export function researchCategoryRank(type: string): number {
  if (type === 'other') return 999;
  const index = RESEARCH_ORDER.indexOf(type);
  return index === -1 ? 500 : index;
}

export function researchCategoryLabel(type: string): string {
  // Unknown categories are title-cased rather than bucketed into "Other", so a
  // new upstream category still reads as itself.
  return RESEARCH_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

export interface Group<T> {
  key: string;
  items: T[];
}

/** Group items by a derived key, with the groups themselves in `rankOf` order. */
export function groupSorted<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  rankOf: (key: string) => number,
): Group<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }

  return [...groups.entries()]
    .map(([key, groupItems]) => ({ key, items: groupItems }))
    .sort((a, b) => rankOf(a.key) - rankOf(b.key) || a.key.localeCompare(b.key));
}

/** "12 minutes ago" — coarse on purpose; the exact clock time sits beside it. */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never';

  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms < 60_000) return 'just now';

  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
