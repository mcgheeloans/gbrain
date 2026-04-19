/**
 * Read models: compose entity state from multiple tables.
 */
import type { Database } from 'bun:sqlite';
import type { EntityRow } from './entities.ts';
import type { TripleRow } from './triples.ts';
import type { TimelineEventRow } from './timeline.ts';
import type { FreshnessRow } from './freshness.ts';

export interface EntityState {
  entity: EntityRow;
  aliases: { alias: string; alias_type: string }[];
  triples: TripleRow[];
  recentTimeline: TimelineEventRow[];
  freshness: FreshnessRow | null;
}

/**
 * Get the full composed state for an entity.
 */
export function getEntityState(db: Database, entitySlug: string): EntityState | null {
  const entity = db.query('SELECT * FROM entities WHERE slug = ?').get(entitySlug) as EntityRow | null;
  if (!entity) return null;

  const aliases = db.query(
    `SELECT alias, alias_type FROM entity_aliases a
     JOIN entities e ON e.id = a.entity_id
     WHERE e.slug = ?`
  ).all(entitySlug) as { alias: string; alias_type: string }[];

  const triples = db.query(
    `SELECT * FROM triples
     WHERE (subject_entity_slug = ? OR object_entity_slug = ?)
       AND status = 'current' AND valid_to IS NULL
     ORDER BY predicate`
  ).all(entitySlug, entitySlug) as TripleRow[];

  const recentTimeline = db.query(
    `SELECT * FROM timeline_events WHERE entity_slug = ?
     ORDER BY date DESC, created_at DESC LIMIT 10`
  ).all(entitySlug) as TimelineEventRow[];

  const freshness = db.query(
    'SELECT * FROM entity_freshness WHERE entity_slug = ?'
  ).get(entitySlug) as FreshnessRow | null;

  return { entity, aliases, triples, recentTimeline, freshness };
}

/**
 * Build a slug→title map for a set of entity slugs.
 * Returns a Map where missing slugs are simply absent.
 */
export function resolveEntityTitles(
  db: Database,
  slugs: Iterable<string>
): Map<string, string> {
  const result = new Map<string, string>();
  for (const slug of slugs) {
    if (result.has(slug)) continue;
    const row = db.query('SELECT title FROM entities WHERE slug = ?').get(slug) as { title: string } | null;
    if (row) result.set(slug, row.title);
  }
  return result;
}
