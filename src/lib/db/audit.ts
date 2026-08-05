/**
 * Audit trail.
 *
 * Every admin mutation records who did what. Only the fields that actually
 * changed are stored, so the log stays readable and does not become a second
 * copy of the database.
 */

export type AuditAction = 'create' | 'update' | 'delete' | 'archive' | 'restore' | 'import';

export interface AuditEntry {
  actorId: number | null;
  action: AuditAction;
  entity: string;
  entityId: string | number | null;
  diff?: unknown;
}

export async function recordAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  await db
    .prepare(
      'INSERT INTO audit_log (actor_id, action, entity, entity_id, diff_json) VALUES (?1, ?2, ?3, ?4, ?5)',
    )
    .bind(
      entry.actorId,
      entry.action,
      entry.entity,
      entry.entityId === null ? null : String(entry.entityId),
      entry.diff === undefined ? null : JSON.stringify(entry.diff),
    )
    .run();
}

/**
 * Field-level before/after for the fields present in `next`. Returns null when
 * nothing changed, so callers can skip writing a no-op audit row.
 */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  next: Partial<T>,
): Record<string, { from: unknown; to: unknown }> | null {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;
    if (before[key] !== value) diff[key] = { from: before[key], to: value };
  }
  return Object.keys(diff).length ? diff : null;
}
