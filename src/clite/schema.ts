/**
 * C-lite schema: minimal SQLite tables for the lightweight GBrain path.
 *
 * This is a separate bootstrap from the PGLite/Postgres engines.
 * It intentionally does NOT depend on BrainEngine or the existing engine factory.
 */

export const CLITE_SCHEMA_SQL = `
-- Enable WAL mode for concurrent read/write performance.
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ============================================================
-- entities: core entity registry for C-lite
-- Pure registry — no page content, no frontmatter, no content_hash.
-- summary is kept because an entity registry benefits from a short
-- human-readable description of what each entity is.
-- ============================================================
CREATE TABLE IF NOT EXISTS entities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT    NOT NULL UNIQUE,
  type          TEXT    NOT NULL DEFAULT 'entity',
  title         TEXT    NOT NULL,
  summary       TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_updated ON entities(updated_at);

-- ============================================================
-- entity_aliases: alternate names / slugs for an entity
-- ============================================================
CREATE TABLE IF NOT EXISTS entity_aliases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias       TEXT    NOT NULL,
  alias_type  TEXT    NOT NULL DEFAULT 'alternate',  -- alternate|canonical|abbreviation|former
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_id, alias)
);

CREATE INDEX IF NOT EXISTS idx_entity_aliases_alias ON entity_aliases(alias);
CREATE INDEX IF NOT EXISTS idx_entity_aliases_type ON entity_aliases(alias_type);

-- ============================================================
-- triples: temporal subject-predicate-object knowledge graph
--
-- Temporal model:
--   valid_from / valid_to define when the triple is true.
--   valid_to NULL means "currently true" (open-ended).
--   status: current | superseded | retracted | tentative
--
-- Provenance is split into source_type (e.g. 'user', 'llm', 'import')
-- and source_ref (free-text reference like a URL, model name, or file path).
--
-- Invariant: exactly one of object_entity_slug or object_literal must be non-NULL.
-- ============================================================
CREATE TABLE IF NOT EXISTS triples (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_entity_slug TEXT    NOT NULL REFERENCES entities(slug) ON DELETE CASCADE,
  predicate           TEXT    NOT NULL,
  object_entity_slug  TEXT    REFERENCES entities(slug) ON DELETE CASCADE,
  object_literal      TEXT,
  valid_from          TEXT    NOT NULL DEFAULT (datetime('now')),
  valid_to            TEXT,                                  -- NULL = open-ended / still current
  status              TEXT    NOT NULL DEFAULT 'current',    -- current|superseded|retracted|tentative
  context             TEXT,                                  -- optional JSON blob with extra metadata
  confidence          REAL    NOT NULL DEFAULT 1.0,
  source_type         TEXT    NOT NULL DEFAULT '',           -- user|llm|import|manual|...
  source_ref          TEXT    NOT NULL DEFAULT '',           -- URL, model name, file path, etc.
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  CONSTRAINT chk_triple_object CHECK (
    (object_entity_slug IS NOT NULL AND object_literal IS NULL)
    OR
    (object_entity_slug IS NULL AND object_literal IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_triples_subject ON triples(subject_entity_slug);
CREATE INDEX IF NOT EXISTS idx_triples_predicate ON triples(predicate);
CREATE INDEX IF NOT EXISTS idx_triples_object_entity ON triples(object_entity_slug);
CREATE INDEX IF NOT EXISTS idx_triples_status ON triples(status);
CREATE INDEX IF NOT EXISTS idx_triples_validity ON triples(valid_from, valid_to);
CREATE UNIQUE INDEX IF NOT EXISTS idx_triples_dedup ON triples(
  subject_entity_slug, predicate, COALESCE(object_entity_slug, ''), COALESCE(object_literal, ''), status, COALESCE(valid_to, '')
);

-- ============================================================
-- timeline_events: dated events associated with entities
-- ============================================================
CREATE TABLE IF NOT EXISTS timeline_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_slug TEXT    NOT NULL REFERENCES entities(slug) ON DELETE CASCADE,
  event_type  TEXT    NOT NULL DEFAULT 'note',       -- note|milestone|change|observation|...
  date        TEXT    NOT NULL,                       -- ISO date: YYYY-MM-DD
  source_type TEXT    NOT NULL DEFAULT '',            -- user|llm|import|...
  source_ref  TEXT    NOT NULL DEFAULT '',            -- URL, model, file, etc.
  confidence  REAL    NOT NULL DEFAULT 1.0,
  summary     TEXT    NOT NULL,
  detail      TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_slug, date, event_type, summary)
);

CREATE INDEX IF NOT EXISTS idx_timeline_entity ON timeline_events(entity_slug);
CREATE INDEX IF NOT EXISTS idx_timeline_date ON timeline_events(date);
CREATE INDEX IF NOT EXISTS idx_timeline_event_type ON timeline_events(event_type);

-- ============================================================
-- entity_freshness: tracks staleness of each entity's compiled state
-- ============================================================
CREATE TABLE IF NOT EXISTS entity_freshness (
  entity_slug              TEXT    NOT NULL UNIQUE REFERENCES entities(slug) ON DELETE CASCADE,
  latest_event_at          TEXT,                                      -- most recent timeline_event
  latest_triple_change_at  TEXT,                                      -- most recent triple insert/update
  compiled_updated_at      TEXT,                                      -- when the compiled entity was last written
  stale                    INTEGER NOT NULL DEFAULT 0,               -- 0=fresh, 1=stale
  freshness_reason         TEXT    NOT NULL DEFAULT '',               -- human-readable reason if stale
  page_projected_at        TEXT,                                      -- when compiled wiki page was last written
  retrieval_projected_at   TEXT,                                      -- when LanceDB chunks were last indexed
  fts_projected_at         TEXT,                                      -- when FTS rows were last synced
  last_projection_error    TEXT,                                      -- last error from any projection stage, NULL if clean
  CHECK (stale IN (0, 1))
);

-- ============================================================
-- verification_runs: tracks schema verification / health check runs
-- ============================================================
CREATE TABLE IF NOT EXISTS verification_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  status      TEXT    NOT NULL DEFAULT 'started',  -- started|passed|failed
  checks_run  INTEGER NOT NULL DEFAULT 0,
  checks_pass INTEGER NOT NULL DEFAULT 0,
  detail      TEXT    NOT NULL DEFAULT '{}',  -- JSON blob with per-check results
  started_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_verification_status ON verification_runs(status);

-- ============================================================
-- clite_meta: internal metadata for the C-lite database itself
-- ============================================================
CREATE TABLE IF NOT EXISTS clite_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ============================================================
-- person_chunks_fts: FTS5 full-text index for keyword search
-- Populated during indexPersonPage() alongside LanceDB writes.
-- ============================================================
CREATE VIRTUAL TABLE IF NOT EXISTS person_chunks_fts USING fts5(
  slug,
  title,
  text,
  entity_type,
  content='',
  tokenize='porter unicode61'
);

INSERT OR IGNORE INTO clite_meta (key, value) VALUES
  ('schema_version', '2'),
  ('engine', 'clite-sqlite');

-- ============================================================
-- FTS5 full-text index over entities for keyword search
-- Note: FTS column is 'type' to shadow entities.type column; triggers map new.type → type
-- ============================================================
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  slug,
  title,
  summary,
  type,
  content='entities',
  content_rowid='id'
);

-- Keep FTS5 in sync with entities via triggers
CREATE TRIGGER IF NOT EXISTS entities_fts_insert AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(rowid, slug, title, summary, type)
    VALUES (new.id, new.slug, new.title, new.summary, new.type);
END;

CREATE TRIGGER IF NOT EXISTS entities_fts_update AFTER UPDATE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, slug, title, summary, type)
    VALUES ('delete', old.id, old.slug, old.title, old.summary, old.type);
  INSERT INTO entities_fts(rowid, slug, title, summary, type)
    VALUES (new.id, new.slug, new.title, new.summary, new.type);
END;

CREATE TRIGGER IF NOT EXISTS entities_fts_delete AFTER DELETE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, slug, title, summary, type)
    VALUES ('delete', old.id, old.slug, old.title, old.summary, old.type);
END;
`;
