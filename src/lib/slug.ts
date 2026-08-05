/** URL-safe slugs. Shared by the legacy import and the admin console. */

export function slugify(input: string): string {
  return (
    input
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // strip diacritics: Pokémon -> Pokemon
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  );
}

/**
 * Find a slug not already taken in `table`, appending -2, -3, … as needed.
 * `excludeId` lets a row keep its own slug when being renamed back to it.
 */
export async function uniqueSlugInTable(
  db: D1Database,
  table: 'pois' | 'posts' | 'meetups',
  desired: string,
  excludeId?: number,
): Promise<string> {
  const base = slugify(desired);

  // One query rather than a probe per candidate: pull everything already
  // sharing the prefix and pick the first free suffix.
  const rows = await db
    .prepare(
      `SELECT slug FROM ${table} WHERE (slug = ?1 OR slug LIKE ?2) AND (?3 IS NULL OR id != ?3)`,
    )
    .bind(base, `${base}-%`, excludeId ?? null)
    .all<{ slug: string }>();

  const taken = new Set(rows.results.map((r) => r.slug));
  if (!taken.has(base)) return base;

  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
