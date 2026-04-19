/**
 * Entity adapter: upsert and query entities and aliases.
 */
import type { Database } from 'bun:sqlite';

// ── Types ───────────────────────────────────────────────────────────

export interface EntityRow {
  id: number;
  slug: string;
  type: string;
  title: string;
  summary: string;
  created_at: string;
  updated_at: string;
}

export interface AliasRow {
  id: number;
  entity_id: number;
  alias: string;
  alias_type: string;
  created_at: string;
}

// ── Entity operations ───────────────────────────────────────────────

/**
 * Insert or update an entity. If the slug already exists, updates title/summary/type
 * and bumps updated_at. Returns the entity row.
 */
export function upsertEntity(
  db: Database,
  slug: string,
  type: string,
  title: string,
  summary: string = ''
): EntityRow {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Try insert first
  const insert = db.prepare(
    `INSERT INTO entities (slug, type, title, summary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       type = excluded.type,
       title = excluded.title,
       summary = CASE WHEN excluded.summary = '' THEN entities.summary ELSE excluded.summary END,
       updated_at = excluded.updated_at`
  );
  insert.run(slug, type, title, summary, now, now);

  return getEntityBySlug(db, slug)!;
}

export function getEntityBySlug(db: Database, slug: string): EntityRow | null {
  return db.query('SELECT * FROM entities WHERE slug = ?').get(slug) as EntityRow | null;
}

export function getEntityById(db: Database, id: number): EntityRow | null {
  return db.query('SELECT * FROM entities WHERE id = ?').get(id) as EntityRow | null;
}

// ── Alias operations ────────────────────────────────────────────────

/**
 * Add an alias for an entity. Accepts either an entity slug or an entity id.
 * aliasType defaults to 'alternate'.
 */
export function addAlias(
  db: Database,
  entitySlugOrId: string | number,
  alias: string,
  aliasType: string = 'alternate'
): void {
  let entityId: number;
  if (typeof entitySlugOrId === 'string') {
    const row = getEntityBySlug(db, entitySlugOrId);
    if (!row) throw new Error(`Entity not found: ${entitySlugOrId}`);
    entityId = row.id;
  } else {
    entityId = entitySlugOrId;
  }

  db.prepare(
    `INSERT INTO entity_aliases (entity_id, alias, alias_type)
     VALUES (?, ?, ?)
     ON CONFLICT(entity_id, alias) DO NOTHING`
  ).run(entityId, alias, aliasType);
}

/**
 * Resolve a name or alias to an entity slug.
 * Tries direct slug match first, then alias lookup.
 */
export function resolveSlug(db: Database, nameOrAlias: string): string | null {
  // Direct slug match
  const direct = db.query('SELECT slug FROM entities WHERE slug = ?').get(nameOrAlias);
  if (direct) return (direct as any).slug;

  // Alias lookup
  const alias = db.query(
    `SELECT e.slug FROM entities e
     JOIN entity_aliases a ON a.entity_id = e.id
     WHERE a.alias = ?
     ORDER BY a.alias_type = 'canonical' DESC
     LIMIT 1`
  ).get(nameOrAlias);
  if (alias) return (alias as any).slug;

  return null;
}

/**
 * Get all aliases for an entity.
 */
export function getAliases(db: Database, entitySlug: string): AliasRow[] {
  return db.query(
    `SELECT a.* FROM entity_aliases a
     JOIN entities e ON e.id = a.entity_id
     WHERE e.slug = ?`
  ).all(entitySlug) as AliasRow[];
}
