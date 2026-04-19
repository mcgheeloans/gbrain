/**
 * C-lite bootstrap: initialize a fresh SQLite database for the lightweight GBrain path.
 *
 * Usage:
 *   import { bootstrap } from './clite/bootstrap.ts';
 *   const db = bootstrap('/path/to/brain.db');
 *
 * Or from CLI:
 *   bun run src/clite/init-cli.ts /path/to/brain.db
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { CLITE_SCHEMA_SQL } from './schema.ts';

export interface BootstrapResult {
  db: Database;
  /** true if this was a fresh create, false if database already existed */
  created: boolean;
  /** Path to the database file, or ':memory:' */
  path: string;
}

const REQUIRED_TABLES = [
  'entities',
  'entity_aliases',
  'triples',
  'timeline_events',
  'entity_freshness',
  'verification_runs',
  'clite_meta',
  'person_chunks_fts',
] as const;

/**
 * Initialize a C-lite SQLite database.
 *
 * - Creates the file if it doesn't exist.
 * - Runs the full schema (CREATE IF NOT EXISTS), so safe to call on existing DBs.
 * - Enables WAL mode and foreign keys.
 * - Verifies all required tables exist after initialization.
 */
export function bootstrap(dbPath: string): BootstrapResult {
  const created = !existsFile(dbPath);

  const db = new Database(dbPath, { create: true });
  // WAL mode is set inside schema SQL, but also set here in case schema was
  // partially applied on a previous run.
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');

  db.exec(CLITE_SCHEMA_SQL);

  // Ensure FTS5 index exists even on older databases that predate it
  ensureFts5(db);

  // Verify all required tables exist
  verifySchema(db);

  return { db, created, path: dbPath };
}

/**
 * Open an existing C-lite database without re-running the full schema.
 * Throws if required tables are missing.
 */
export function open(dbPath: string): Database {
  if (!existsFile(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  verifySchema(db);
  ensureFts5(db);
  return db;
}

/**
 * Verify all required C-lite tables exist.
 * Throws with a clear message if any are missing.
 */
export function verifySchema(db: Database): string[] {
  const existing = new Set(
    db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name as string)
  );

  const missing = REQUIRED_TABLES.filter((t) => !existing.has(t));
  if (missing.length > 0) {
    throw new Error(
      `C-lite schema incomplete. Missing tables: ${missing.join(', ')}. ` +
        `Run bootstrap() to initialize.`
    );
  }

  return [...existing];
}

/**
 * Get the list of all tables in the database.
 */
export function listTables(db: Database): string[] {
  return db
    .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r: any) => r.name as string);
}

/**
 * Ensure the FTS5 virtual table and triggers exist.
 * Idempotent — safe to call on databases that already have them.
 */
export function ensureFts5(db: Database): void {
  // Check if entities_fts exists and what its schema is
  const existingFts = db.query(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='entities_fts'"
  ).get() as any;

  if (existingFts?.sql) {
    // Table exists — check if it has the right columns (entity_type vs type)
    // If it references 'entity_type' which doesn't exist in content table, fix it
    if (existingFts.sql.includes('entity_type')) {
      db.exec('DROP TABLE IF EXISTS entities_fts');
      existingFts.sql = null; // force recreate
    }
  }

  if (!existingFts?.sql) {
    // Create FTS5 virtual table if not exists.
    // Note: content='entities' means FTS columns shadow the entities table columns.
    // Since entities has 'type' not 'entity_type', we use type here and the
    // triggers below map new.type → type FTS column via explicit values.
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
        slug,
        title,
        summary,
        type,
        content='entities',
        content_rowid='id'
      );
    `);
  }

  // Create sync triggers if they don't exist
  const existing = new Set(
    db.query("SELECT name FROM sqlite_master WHERE type='trigger'")
      .all()
      .map((r: any) => r.name as string)
  );

  if (!existing.has('entities_fts_insert')) {
    db.exec(`
      CREATE TRIGGER entities_fts_insert AFTER INSERT ON entities BEGIN
        INSERT INTO entities_fts(rowid, slug, title, summary, type)
          VALUES (new.id, new.slug, new.title, new.summary, new.type);
      END;
    `);
  }
  if (!existing.has('entities_fts_update')) {
    db.exec(`
      CREATE TRIGGER entities_fts_update AFTER UPDATE ON entities BEGIN
        INSERT INTO entities_fts(entities_fts, rowid, slug, title, summary, type)
          VALUES ('delete', old.id, old.slug, old.title, old.summary, old.type);
        INSERT INTO entities_fts(rowid, slug, title, summary, type)
          VALUES (new.id, new.slug, new.title, new.summary, new.type);
      END;
    `);
  }
  if (!existing.has('entities_fts_delete')) {
    db.exec(`
      CREATE TRIGGER entities_fts_delete AFTER DELETE ON entities BEGIN
        INSERT INTO entities_fts(entities_fts, rowid, slug, title, summary, type)
          VALUES ('delete', old.id, old.slug, old.title, old.summary, old.type);
      END;
    `);
  }

  // Rebuild FTS index if it's empty but entities exist (fresh FTS on existing DB)
  const ftsCount = (db.query('SELECT count(*) as c FROM entities_fts').get() as any)?.c ?? 0;
  const entityCount = (db.query('SELECT count(*) as c FROM entities').get() as any)?.c ?? 0;
  if (ftsCount === 0 && entityCount > 0) {
    db.exec("INSERT INTO entities_fts(entities_fts) VALUES ('rebuild');");
  }
}

function existsFile(path: string): boolean {
  if (path === ':memory:') return false;
  return existsSync(path);
}
