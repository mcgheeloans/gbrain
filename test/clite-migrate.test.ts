import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrateV2toV3, autoMigrate } from '../src/clite/migrate.ts';
import * as fs from 'fs';

const TEST_DB = '/tmp/gbrain-migrate-test.db';

describe('migrate v2→v3', () => {
  beforeEach(() => {
    try { fs.unlinkSync(TEST_DB); } catch {}
  });
  afterEach(() => {
    try { fs.unlinkSync(TEST_DB); } catch {}
  });

  function createV2Database(): Database {
    const db = new Database(TEST_DB);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');

    // Minimal v2 schema — just the tables/columns that matter for migration
    db.exec(`
      CREATE TABLE entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL DEFAULT 'entity',
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE triples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_entity_slug TEXT NOT NULL REFERENCES entities(slug),
        predicate TEXT NOT NULL,
        object_entity_slug TEXT REFERENCES entities(slug),
        object_literal TEXT,
        valid_from TEXT NOT NULL DEFAULT (datetime('now')),
        valid_to TEXT,
        status TEXT NOT NULL DEFAULT 'current',
        context TEXT,
        confidence REAL NOT NULL DEFAULT 1.0,
        source_type TEXT NOT NULL DEFAULT '',
        source_ref TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT chk_triple_object CHECK (
          (object_entity_slug IS NOT NULL AND object_literal IS NULL)
          OR (object_entity_slug IS NULL AND object_literal IS NOT NULL)
        )
      );

      CREATE UNIQUE INDEX idx_triples_dedup ON triples(
        subject_entity_slug, predicate, COALESCE(object_entity_slug, ''),
        COALESCE(object_literal, ''), status, COALESCE(valid_to, '')
      );

      CREATE TABLE clite_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO clite_meta VALUES ('schema_version', '2'), ('engine', 'clite-sqlite');
    `);

    return db;
  }

  test('adds new columns to triples table', () => {
    const db = createV2Database();

    // Insert some v2 data
    db.exec("INSERT INTO entities (slug, type, title) VALUES ('people/jane', 'person', 'Jane')");
    db.exec("INSERT INTO entities (slug, type, title) VALUES ('companies/acme', 'company', 'Acme')");
    db.exec("INSERT INTO triples (subject_entity_slug, predicate, object_entity_slug) VALUES ('people/jane', 'works_at', 'companies/acme')");

    migrateV2toV3(db);

    // Check columns exist
    const cols = db.query('PRAGMA table_info(triples)').all() as any[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('link_source');
    expect(colNames).toContain('origin_slug');
    expect(colNames).toContain('origin_field');

    // Check existing data got backfilled
    const row = db.query('SELECT link_source FROM triples WHERE subject_entity_slug = ?')
      .get('people/jane') as any;
    expect(row.link_source).toBe('manual');

    // Check version bumped
    const ver = db.query("SELECT value FROM clite_meta WHERE key = 'schema_version'").get() as any;
    expect(ver.value).toBe('3');

    db.close();
  });

  test('is idempotent — running twice is a no-op', () => {
    const db = createV2Database();
    migrateV2toV3(db);
    // Second run should skip without error
    migrateV2toV3(db);

    const ver = db.query("SELECT value FROM clite_meta WHERE key = 'schema_version'").get() as any;
    expect(ver.value).toBe('3');

    db.close();
  });

  test('autoMigrate skips when already at v3', () => {
    const db = createV2Database();
    migrateV2toV3(db);
    // autoMigrate should detect v3 and do nothing
    autoMigrate(db);
    db.close();
  });

  test('new dedup index includes link_source and origin_field', () => {
    const db = createV2Database();
    db.exec("INSERT INTO entities (slug, type, title) VALUES ('people/jane', 'person', 'Jane')");
    db.exec("INSERT INTO entities (slug, type, title) VALUES ('companies/acme', 'company', 'Acme')");

    migrateV2toV3(db);

    // Should be able to insert same predicate with different link_source
    db.exec("INSERT INTO triples (subject_entity_slug, predicate, object_entity_slug, link_source, origin_field) VALUES ('people/jane', 'works_at', 'companies/acme', 'manual', NULL)");
    db.exec("INSERT INTO triples (subject_entity_slug, predicate, object_entity_slug, link_source, origin_slug, origin_field) VALUES ('people/jane', 'works_at', 'companies/acme', 'frontmatter', 'people/jane', 'company')");

    const rows = db.query("SELECT link_source, origin_field FROM triples WHERE subject_entity_slug = 'people/jane' ORDER BY link_source").all() as any[];
    expect(rows.length).toBe(2);
    expect(rows[0].link_source).toBe('frontmatter');
    expect(rows[1].link_source).toBe('manual');

    db.close();
  });
});
