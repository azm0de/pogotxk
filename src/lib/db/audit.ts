/**
 * Audit trail.
 *
 * Every admin mutation records who did what. Only the fields that actually
 * changed are stored, so the log stays readable and does not become a second
 * copy of the database.
 */

/**
 * `login` and `lockout` are the admin password door's two events, and
 * `reset-request` / `reset-complete` are the recovery path's. No migration was
 * needed to add any of them: `audit_log.action` is an unconstrained `TEXT`
 * column (`0001_initial.sql`), so the union here is the only thing narrowing it
 * — and widening the union rather than casting at the call site is what keeps
 * that list the actual vocabulary instead of a suggestion.
 *
 * The reset pair is two actions rather than one with a stage in the diff,
 * because the two are read for opposite reasons. `reset-request` answered
 * without a matching `reset-complete` is somebody asking for links they never
 * use, which is what an attack on this endpoint looks like from the inside;
 * a `reset-complete` nobody remembers doing is the thing that has to be
 * findable in a hurry. Filtering on `action` is how the audit view already
 * works, so they are separable there rather than only by reading diffs.
 *
 * Neither ever carries the address or the token — see the routes.
 */
export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'archive'
  | 'restore'
  | 'import'
  | 'login'
  | 'lockout'
  | 'reset-request'
  | 'reset-complete';

/**
 * A row that does not have an id yet, named by a column that is unique on its
 * table — the slug or R2 key of something being inserted in the same batch.
 * Lets a create and its audit row commit together; see `auditStatement`.
 */
export interface AuditRowRef {
  table: 'posts' | 'meetups' | 'pois' | 'media';
  column: 'slug' | 'r2_key';
  value: string;
}

export interface AuditEntry {
  actorId: number | null;
  action: AuditAction;
  entity: string;
  entityId: string | number | null | AuditRowRef;
  diff?: unknown;
}

function isRowRef(id: AuditEntry['entityId']): id is AuditRowRef {
  return typeof id === 'object' && id !== null;
}

/**
 * The audit INSERT as a prepared statement, for a route to put in the same
 * `db.batch` as the change it describes.
 *
 * A batch is one transaction, so the change and its record land together or
 * not at all. Written as two awaits, a failure between them left a change that
 * nobody could account for, or a record of one that never happened (admin
 * audit, 2026-10, B-15).
 *
 * The table and column of an `AuditRowRef` come from closed unions, never from
 * a request, which is what makes interpolating them safe.
 */
export function auditStatement(db: D1Database, entry: AuditEntry): D1PreparedStatement {
  const ref = isRowRef(entry.entityId) ? entry.entityId : null;
  const entityId = ref
    ? `(SELECT CAST(id AS TEXT) FROM ${ref.table} WHERE ${ref.column} = ?4)`
    : '?4';

  return db
    .prepare(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, diff_json)
       VALUES (?1, ?2, ?3, ${entityId}, ?5)`,
    )
    .bind(
      entry.actorId,
      entry.action,
      entry.entity,
      ref ? ref.value : entry.entityId === null ? null : String(entry.entityId),
      entry.diff === undefined ? null : JSON.stringify(entry.diff),
    );
}

export async function recordAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  await auditStatement(db, entry).run();
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
