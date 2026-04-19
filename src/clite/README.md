# C-lite: Lightweight SQLite Bootstrap for GBrain

C-lite is a minimal SQLite-backed schema for GBrain, designed as a temporal sidecar module
that works independently of the main PGLite/Postgres engine path.

## What it provides

- **entities** table (pure entity registry — no page content)
- **entity_aliases** (alternate names/slug lookups with alias_type)
- **triples** (temporal subject-predicate-object knowledge graph with provenance)
- **timeline_events** (dated events per entity with event_type and confidence)
- **entity_freshness** (staleness tracking for compiled state)
- **verification_runs** (health check history)
- **clite_meta** (schema version and internal metadata)
- SQLite WAL mode enabled from the start
- Foreign key enforcement

## Schema design

### entities
Pure entity registry. Stores identity (slug, type, title) and a short summary.
No page content, frontmatter, or content hashes — those belong to upstream sources.

### triples
Each triple is temporal:
- `valid_from` / `valid_to` define when the triple is true (NULL valid_to = still current)
- `status`: current | superseded | retracted | tentative
- `context`: optional JSON for extra metadata
- Provenance split into `source_type` (user|llm|import|manual) and `source_ref` (URL, model, path)
- Dedup considers subject, predicate, object, status, and valid_to — so superseded and current
  versions of the same fact coexist

### entity_aliases
Alternate names with `alias_type`: alternate, canonical, abbreviation, former.

### timeline_events
Dated events with `event_type`, `source_type`, `source_ref`, and `confidence`.

### entity_freshness
Tracks compiled-state staleness:
- `latest_event_at`, `latest_triple_change_at`, `compiled_updated_at`
- `stale` (0/1) and `freshness_reason`

## What it does NOT provide (yet)

- Retrieval / search integration
- Queue infrastructure
- Adapters, ingest logic, compile logic
- BrainEngine integration

## Initialize a database

```bash
# Default: creates ./gbrain-clite.db
bun run src/clite/init-cli.ts

# Custom path
bun run src/clite/init-cli.ts /path/to/my-brain.db
```

## Programmatic usage

```typescript
import { bootstrap } from './clite/bootstrap.ts';

const { db, created, path } = bootstrap('./my-brain.db');

// Use db.query(), db.exec(), etc.
const entities = db.query('SELECT * FROM entities').all();

db.close();
```

## Triple invariant

The `triples` table enforces that exactly one of `object_entity_slug` or `object_literal`
is set via a CHECK constraint. Attempting to insert a row with both NULL or both non-NULL
will fail.

## Running tests

```bash
bun test test/clite-bootstrap.test.ts
```
