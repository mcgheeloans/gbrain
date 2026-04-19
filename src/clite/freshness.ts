/**
 * Freshness adapter: track and recompute entity staleness.
 */
import type { Database } from 'bun:sqlite';

export interface FreshnessRow {
  entity_slug: string;
  latest_event_at: string | null;
  latest_triple_change_at: string | null;
  compiled_updated_at: string | null;
  stale: number;
  freshness_reason: string;
}

/**
 * Recompute freshness for a single entity.
 * Compares latest_event_at / latest_triple_change_at against compiled_updated_at.
 * Updates the entity_freshness row.
 */
export function recomputeFreshness(db: Database, entitySlug: string): FreshnessRow {
  // Get latest event timestamp
  const evt = db.query(
    `SELECT MAX(created_at) as at FROM timeline_events WHERE entity_slug = ?`
  ).get(entitySlug) as any;
  const latestEventAt = evt?.at ?? null;

  // Get latest triple change timestamp
  const tri = db.query(
    `SELECT MAX(updated_at) as at FROM triples WHERE subject_entity_slug = ? OR object_entity_slug = ?`
  ).get(entitySlug, entitySlug) as any;
  const latestTripleAt = tri?.at ?? null;

  // Get current freshness row (if any) for compiled_updated_at
  const existing = db.query(
    'SELECT * FROM entity_freshness WHERE entity_slug = ?'
  ).get(entitySlug) as FreshnessRow | null;
  const compiledAt = existing?.compiled_updated_at ?? null;

  // Determine staleness
  let stale = 0;
  let reason = '';

  if (compiledAt === null) {
    // Never compiled → stale if there's any data
    if (latestEventAt || latestTripleAt) {
      stale = 1;
      reason = 'never compiled';
    }
  } else {
    if (latestEventAt && latestEventAt > compiledAt) {
      stale = 1;
      reason = 'new timeline events since last compile';
    } else if (latestTripleAt && latestTripleAt > compiledAt) {
      stale = 1;
      reason = 'triple changes since last compile';
    }
  }

  db.prepare(
    `INSERT INTO entity_freshness (entity_slug, latest_event_at, latest_triple_change_at, stale, freshness_reason)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(entity_slug) DO UPDATE SET
       latest_event_at = excluded.latest_event_at,
       latest_triple_change_at = excluded.latest_triple_change_at,
       stale = excluded.stale,
       freshness_reason = excluded.freshness_reason`
  ).run(entitySlug, latestEventAt, latestTripleAt, stale, reason);

  return db.query('SELECT * FROM entity_freshness WHERE entity_slug = ?').get(entitySlug) as FreshnessRow;
}

/**
 * Mark an entity as compiled (sets compiled_updated_at to now, clears stale).
 * Used later when compile is implemented.
 */
export function markCompiled(db: Database, entitySlug: string): void {
  // Use SQLite datetime directly to ensure format consistency.
  // We set compiled_updated_at 1 second ahead so that any events/triples
  // committed in the same second as the compile are correctly considered fresh.
  const row = db.query("SELECT datetime('now', '+1 second') as ts").get() as any;
  const now = row.ts as string;
  db.prepare(
    `INSERT INTO entity_freshness (entity_slug, compiled_updated_at, stale, freshness_reason)
     VALUES (?, ?, 0, '')
     ON CONFLICT(entity_slug) DO UPDATE SET
       compiled_updated_at = excluded.compiled_updated_at,
       stale = 0,
       freshness_reason = ''`
  ).run(entitySlug, now);
}
