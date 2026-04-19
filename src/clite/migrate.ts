/**
 * Migration: schema v2 → v3
 *
 * Adds frontmatter edge provenance columns to the triples table:
 *   link_source  — manual|frontmatter|markdown|auto
 *   origin_slug  — which page created this edge
 *   origin_field — which YAML frontmatter field
 *
 * Also updates the unique dedup index to include the new columns
 * and bumps the schema version in clite_meta.
 *
 * Safe to run idempotently — uses IF NOT EXISTS / IF EXISTS guards.
 */

import type { Database } from 'bun:sqlite';

export function migrateV2toV3(db: Database): void {
  const version = db.query(
    `SELECT value FROM clite_meta WHERE key = 'schema_version'`
  ).get() as { value: string } | null;

  if (version && version.value === '3') {
    console.log('migrateV2toV3: already at schema v3, skipping');
    return;
  }

  if (version && version.value !== '2') {
    throw new Error(`migrateV2toV3: unexpected schema version '${version.value}', expected '2' or '3'`);
  }

  console.log('migrateV2toV3: migrating schema v2 → v3...');

  db.transaction(() => {
    // 1. Add new columns (idempotent — ALTER TABLE ADD COLUMN errors if column exists,
    //    so we catch and skip)
    const newColumns: Array<{ name: string; def: string }> = [
      { name: 'link_source',  def: "TEXT NOT NULL DEFAULT 'manual'" },
      { name: 'origin_slug',  def: 'TEXT' },
      { name: 'origin_field', def: 'TEXT' },
    ];

    for (const col of newColumns) {
      try {
        db.exec(`ALTER TABLE triples ADD COLUMN ${col.name} ${col.def}`);
        console.log(`  added column: triples.${col.name}`);
      } catch (e: any) {
        if (e.message?.includes('duplicate column')) {
          console.log(`  column already exists: triples.${col.name}, skipping`);
        } else {
          throw e;
        }
      }
    }

    // 2. Backfill: set link_source = 'manual' for any rows still at default
    //    (the DEFAULT handles new rows, but existing rows from v2 need explicit update)
    const backfilled = db.prepare(
      `UPDATE triples SET link_source = 'manual' WHERE link_source IS NULL OR link_source = ''`
    ).run();
    console.log(`  backfilled link_source for ${backfilled.changes} rows`);

    // 3. Drop old dedup index and recreate with new columns
    try {
      db.exec(`DROP INDEX IF EXISTS idx_triples_dedup`);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_triples_dedup ON triples(
          subject_entity_slug, predicate,
          COALESCE(object_entity_slug, ''), COALESCE(object_literal, ''),
          status, COALESCE(valid_to, ''),
          link_source, COALESCE(origin_field, '')
        )
      `);
      console.log('  recreated dedup index with link_source + origin_field');
    } catch (e: any) {
      console.error('  failed to recreate dedup index:', e.message);
      throw e;
    }

    // 4. Add new indexes
    db.exec(`CREATE INDEX IF NOT EXISTS idx_triples_link_source ON triples(link_source)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_triples_origin_slug ON triples(origin_slug)`);
    console.log('  added indexes: idx_triples_link_source, idx_triples_origin_slug');

    // 5. Add check constraint
    // SQLite doesn't support ALTER TABLE ADD CONSTRAINT, so we add it via
    // a manual check. For existing DBs, the constraint is enforced at the
    // application level via insertTriple(). New DBs created from schema v3
    // get it in the CREATE TABLE statement.
    console.log('  note: chk_link_source enforced at application level for migrated DBs');

    // 6. Bump schema version
    db.prepare(
      `UPDATE clite_meta SET value = '3' WHERE key = 'schema_version'`
    ).run();
    console.log('  bumped schema_version to 3');
  })();

  console.log('migrateV2toV3: done');
}

/**
 * Auto-migrate: run all pending migrations in order.
 * Add new migration functions here as schema versions increase.
 */
export function autoMigrate(db: Database): void {
  const version = db.query(
    `SELECT value FROM clite_meta WHERE key = 'schema_version'`
  ).get() as { value: string } | null;

  const current = version?.value ?? '0';
  console.log(`autoMigrate: current schema version = ${current}`);

  if (current === '3') {
    console.log('autoMigrate: up to date');
    return;
  }

  // Run migrations in order
  if (current < '3') {
    migrateV2toV3(db);
  }

  // Future: if (current < '4') { migrateV3toV4(db); }
}
