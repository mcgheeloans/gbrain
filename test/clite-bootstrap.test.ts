import { describe, test, expect, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { unlinkSync } from 'node:fs';
import { bootstrap, verifySchema, listTables, open } from '../src/clite/bootstrap.ts';

const TEST_DB = '/tmp/gbrain-clite-test.db';

function cleanup() {
  try { unlinkSync(TEST_DB); } catch {}
  try { unlinkSync(TEST_DB + '-wal'); } catch {}
  try { unlinkSync(TEST_DB + '-shm'); } catch {}
}

cleanup();

describe('C-lite bootstrap', () => {
  test('bootstrap creates a fresh database with all required tables', () => {
    cleanup();
    const result = bootstrap(TEST_DB);
    expect(result.created).toBe(true);
    expect(result.path).toBe(TEST_DB);

    const tables = listTables(result.db);
    expect(tables).toContain('entities');
    expect(tables).toContain('entity_aliases');
    expect(tables).toContain('triples');
    expect(tables).toContain('timeline_events');
    expect(tables).toContain('entity_freshness');
    expect(tables).toContain('verification_runs');
    expect(tables).toContain('clite_meta');

    result.db.close();
  });

  test('bootstrap on existing DB does not recreate and passes verification', () => {
    const result = bootstrap(TEST_DB);
    expect(result.created).toBe(false);

    // Should not throw
    verifySchema(result.db);
    result.db.close();
  });

  test('WAL mode is enabled', () => {
    const db = new Database(TEST_DB);
    const row = db.query('PRAGMA journal_mode').get() as any;
    expect(row.journal_mode).toBe('wal');
    db.close();
  });

  test('foreign keys are enforced', () => {
    const db = new Database(TEST_DB);
    db.exec('PRAGMA foreign_keys=ON');
    const row = db.query('PRAGMA foreign_keys').get() as any;
    expect(row.foreign_keys).toBe(1);

    // Verify actual enforcement
    expect(() => {
      db.exec("INSERT INTO entity_aliases (entity_id, alias) VALUES (999999, 'ghost')");
    }).toThrow();

    db.close();
  });

  test('clite_meta has schema_version 3 and engine', () => {
    const db = new Database(TEST_DB);
    const meta = db.query('SELECT key, value FROM clite_meta ORDER BY key').all() as { key: string; value: string }[];
    const map = Object.fromEntries(meta.map(r => [r.key, r.value]));
    expect(map.schema_version).toBe('3');
    expect(map.engine).toBe('clite-sqlite');
    db.close();
  });

  test('entities table is a clean registry (no frontmatter or content_hash)', () => {
    const db = new Database(TEST_DB);
    const cols = getColumnNames(db, 'entities');
    expect(cols).toContain('id');
    expect(cols).toContain('slug');
    expect(cols).toContain('type');
    expect(cols).toContain('title');
    expect(cols).toContain('summary');
    expect(cols).toContain('created_at');
    expect(cols).toContain('updated_at');
    // Page-ish columns should NOT exist
    expect(cols).not.toContain('frontmatter');
    expect(cols).not.toContain('content_hash');
    db.close();
  });

  test('triples have temporal and provenance fields', () => {
    const db = new Database(TEST_DB);
    const cols = getColumnNames(db, 'triples');
    // Temporal
    expect(cols).toContain('valid_from');
    expect(cols).toContain('valid_to');
    expect(cols).toContain('status');
    expect(cols).toContain('context');
    // Provenance
    expect(cols).toContain('source_type');
    expect(cols).toContain('source_ref');
    // Legacy 'source' column should NOT exist
    expect(cols).not.toContain('source');
    db.close();
  });

  test('triples CHECK constraint rejects both NULL objects', () => {
    const db = new Database(TEST_DB);
    db.exec('PRAGMA foreign_keys=ON');
    db.exec("INSERT OR IGNORE INTO entities (slug, title, type) VALUES ('test-entity', 'Test', 'person')");

    expect(() => {
      db.exec(`
        INSERT INTO triples (subject_entity_slug, predicate, object_entity_slug, object_literal)
        VALUES ('test-entity', 'knows', NULL, NULL)
      `);
    }).toThrow();

    db.close();
  });

  test('triples CHECK constraint rejects both non-NULL objects', () => {
    const db = new Database(TEST_DB);
    db.exec('PRAGMA foreign_keys=ON');
    db.exec("INSERT OR IGNORE INTO entities (slug, title, type) VALUES ('test-entity2', 'Test2', 'person')");

    expect(() => {
      db.exec(`
        INSERT INTO triples (subject_entity_slug, predicate, object_entity_slug, object_literal)
        VALUES ('test-entity', 'works_at', 'test-entity2', 'some literal')
      `);
    }).toThrow();

    db.close();
  });

  test('triple with temporal defaults inserts correctly (entity-to-entity)', () => {
    const db = new Database(TEST_DB);
    db.exec(`
      INSERT OR IGNORE INTO triples (subject_entity_slug, predicate, object_entity_slug, status, source_type)
      VALUES ('test-entity', 'knows', 'test-entity2', 'current', 'manual')
    `);
    const rows = db.query(
      "SELECT status, source_type, source_ref, valid_to FROM triples WHERE subject_entity_slug = 'test-entity' AND predicate = 'knows'"
    ).all() as any[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].status).toBe('current');
    expect(rows[0].source_type).toBe('manual');
    expect(rows[0].valid_to).toBeNull(); // open-ended
    db.close();
  });

  test('triple with literal inserts correctly', () => {
    const db = new Database(TEST_DB);
    db.exec(`
      INSERT INTO triples (subject_entity_slug, predicate, object_literal, source_type, source_ref)
      VALUES ('test-entity', 'title', 'Senior Loan Officer', 'user', 'direct-input')
    `);
    const rows = db.query(
      "SELECT source_type, source_ref FROM triples WHERE object_literal = 'Senior Loan Officer'"
    ).all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].source_type).toBe('user');
    expect(rows[0].source_ref).toBe('direct-input');
    db.close();
  });

  test('triples dedup index considers status and valid_to', () => {
    const db = new Database(TEST_DB);
    db.exec('PRAGMA foreign_keys=ON');

    // Same (subject, predicate, object) but different status should both exist
    db.exec(`
      INSERT INTO triples (subject_entity_slug, predicate, object_literal, status, valid_to)
      VALUES ('test-entity', 'color', 'blue', 'superseded', '2024-01-01T00:00:00')
    `);
    db.exec(`
      INSERT INTO triples (subject_entity_slug, predicate, object_literal, status, valid_to)
      VALUES ('test-entity', 'color', 'blue', 'current', NULL)
    `);
    const rows = db.query(
      "SELECT status FROM triples WHERE subject_entity_slug = 'test-entity' AND predicate = 'color' ORDER BY status"
    ).all() as any[];
    expect(rows.length).toBe(2);

    db.close();
  });

  test('entity_aliases has alias_type column', () => {
    const db = new Database(TEST_DB);
    const cols = getColumnNames(db, 'entity_aliases');
    expect(cols).toContain('alias_type');

    // Insert with alias_type
    const entity = db.query("SELECT id FROM entities WHERE slug = 'test-entity'").get() as any;
    db.exec(`
      INSERT OR IGNORE INTO entity_aliases (entity_id, alias, alias_type)
      VALUES (${entity.id}, 'te', 'abbreviation')
    `);
    const row = db.query("SELECT alias_type FROM entity_aliases WHERE alias = 'te'").get() as any;
    expect(row.alias_type).toBe('abbreviation');

    db.close();
  });

  test('timeline_events has event_type, source_type, source_ref, confidence', () => {
    const db = new Database(TEST_DB);
    const cols = getColumnNames(db, 'timeline_events');
    expect(cols).toContain('event_type');
    expect(cols).toContain('source_type');
    expect(cols).toContain('source_ref');
    expect(cols).toContain('confidence');
    // Legacy 'source' should NOT exist
    expect(cols).not.toContain('source');

    // Insert with new fields
    db.exec(`
      INSERT INTO timeline_events (entity_slug, event_type, date, source_type, source_ref, confidence, summary)
      VALUES ('test-entity', 'milestone', '2024-06-15', 'user', 'direct', 0.95, 'Started new role')
    `);
    const row = db.query("SELECT event_type, source_type, source_ref, confidence FROM timeline_events WHERE summary = 'Started new role'").get() as any;
    expect(row.event_type).toBe('milestone');
    expect(row.source_type).toBe('user');
    expect(row.confidence).toBe(0.95);

    db.close();
  });

  test('entity_freshness has correct temporal columns', () => {
    const db = new Database(TEST_DB);
    const cols = getColumnNames(db, 'entity_freshness');
    expect(cols).toContain('latest_event_at');
    expect(cols).toContain('latest_triple_change_at');
    expect(cols).toContain('compiled_updated_at');
    expect(cols).toContain('stale');
    expect(cols).toContain('freshness_reason');
    // Old columns should NOT exist
    expect(cols).not.toContain('last_checked');
    expect(cols).not.toContain('last_updated');
    expect(cols).not.toContain('check_count');
    expect(cols).not.toContain('staleness');

    db.close();
  });

  test('entity_freshness stale is constrained to 0/1', () => {
    const db = new Database(TEST_DB);
    db.exec('PRAGMA foreign_keys=ON');

    db.exec(`
      INSERT INTO entity_freshness (entity_slug, stale, freshness_reason)
      VALUES ('test-entity', 0, '')
    `);
    const row = db.query("SELECT stale FROM entity_freshness WHERE entity_slug = 'test-entity'").get() as any;
    expect(row.stale).toBe(0);

    db.close();
  });

  test('open() works on existing database', () => {
    const db = open(TEST_DB);
    const tables = listTables(db);
    expect(tables.length).toBeGreaterThanOrEqual(7);
    db.close();
  });

  test('verifySchema throws on a database missing tables', () => {
    const emptyDb = new Database(':memory:');
    expect(() => verifySchema(emptyDb)).toThrow(/Missing tables/);
    emptyDb.close();
  });
});

afterAll(() => {
  cleanup();
});

/** Helper: get column names for a table. */
function getColumnNames(db: Database, table: string): string[] {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map(r => r.name);
}
