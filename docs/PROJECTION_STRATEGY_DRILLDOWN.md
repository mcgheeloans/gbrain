# Projection Strategy Drill-Down

Last updated: 2026-04-19
Upstream baseline: `013b348`
Related docs:
- `docs/INITIAL_OPENCLAW_NATIVE_BLUEPRINT.md`
- `docs/SEARCH_ARCHITECTURE_DRILLDOWN.md`
- `docs/INGESTION_GRAPH_BRIDGE_DRILLDOWN.md`
- `docs/OPERATIONS_COMMAND_BRIDGE_DRILLDOWN.md`
- `docs/ENGINE_BOUNDARY_ADAPTER_STRATEGY.md`
- `docs/UPSTREAM_DIVERGENCE.md`
- `docs/FEATURE_PARITY_CHECKLIST.md`

## Purpose

This doc defines what gets projected from canonical truth, when it gets projected, and what is allowed to fail without corrupting the system.

Question:

**How should compiled pages, retrieval chunks, FTS rows, and compatibility artifacts be materialized so that canonical truth stays durable and projection failures remain recoverable?**

This is the write-path safety doc.

---

## Executive summary

Projection is downstream materialization.
It is not truth.

For the OpenClaw-native design, that means:

- canonical entities/triples/timeline/freshness are the durable truth layer
- compiled pages are projections
- LanceDB chunks are projections
- FTS rows are projections
- compatibility link/page artifacts are projections

The single most important invariant is:

**projection failure must not roll back canonical writes**

If projection fails, the correct state is:
- truth is committed
- projection is stale or incomplete
- recompilation/reindex/retry can recover later

That is the only sane rule.

---

## What current code already shows

### Compile path

`src/clite/compile-entity.ts` currently does:

1. read canonical state
2. render page markdown
3. write page to disk
4. render topic chunks
5. index topic chunks in LanceDB
6. sync FTS rows as part of indexing
7. mark freshness via page write path

### Write path

`src/clite/write-page.ts`:
- writes compiled page to filesystem
- calls `markCompiled()` only after successful file write
- skips rewriting identical content
- still marks compiled if file already matches

### Index path

`src/clite/index-person.ts`:
- embeds topic chunks
- upserts chunks to LanceDB
- syncs FTS rows if db is present

### LanceDB path

`src/clite/lance-store.ts`:
- deletes old chunk rows by slug
- adds fresh chunk rows with metadata
- treats shared LanceDB as retrieval storage, not truth

### Current important subtlety

Right now `markCompiled()` happens during page write, before LanceDB/FTS indexing has definitely succeeded.
So current freshness semantics are closer to:

- “page projection is current”

not:

- “all projections are current”

That distinction matters.

---

## Projection layers

We should explicitly treat projections as separate layers.

## 1. Compiled page projection

Examples:
- filesystem markdown pages
- memory-wiki pages later
- page-like outputs used by `get_page`

Purpose:
- human-readable compiled representation
- wiki/Obsidian compatibility
- compatibility-facing page reads

Truth status:
- not truth
- compiled artifact from canonical state

---

## 2. Retrieval chunk projection

Examples:
- topic chunks in LanceDB
- embedded retrieval rows
- metadata-tagged chunk entries

Purpose:
- vector retrieval
- chunk-level ranking signals
- query answering

Truth status:
- not truth
- retrieval substrate derived from compiled/canonical state

---

## 3. Lexical/keyword projection

Examples:
- FTS rows like `person_chunks_fts`
- other keyword-oriented indexes later

Purpose:
- lexical search
- hybrid retrieval support

Truth status:
- not truth
- search convenience/index layer

---

## 4. Compatibility graph/page artifacts

Possible examples later:
- projected link rows
- compatibility page tables
- derived search/cache tables

Purpose:
- satisfy upstream-shaped features without treating upstream storage as canonical

Truth status:
- not truth
- compatibility materialization

---

## Projection order

The safe order should be:

1. canonical write commits
2. freshness/staleness reflects canonical change
3. projections refresh
4. projection status is updated

That means projection should always be downstream of canonical success.

Never the other way around.

---

## Projection failure rules

## Rule 1: canonical writes must survive projection failure

If:
- page write fails
- embedding fails
- LanceDB upsert fails
- FTS sync fails

then:
- canonical entities/triples/timeline must still remain committed
- the entity should remain recoverable by retrying projection

This is non-negotiable.

---

## Rule 2: projection freshness must be distinguishable from canonical freshness

Current code blurs this a bit.

If we only have one freshness bit and mark it during page write, then a later LanceDB/FTS failure can leave us in an awkward state where:
- canonical truth changed
- page file is current
- retrieval index is stale
- overall freshness looks okay

That is not fatal, but it is ambiguous.

Recommended model:
- canonical staleness says whether truth changed and needs compile/projection
- projection status says which downstream projections are current or stale

At minimum, conceptually separate:
- compiled page freshness
- retrieval projection freshness

---

## Rule 3: retries should be idempotent

Projection should be safely rerunnable.

Current code is already mostly moving in that direction:
- page write skips identical content
- LanceDB upsert is delete-then-add by slug
- FTS rows are delete-then-insert by slug

That is good.

Keep it that way.

---

## Rule 4: projection can be sync or async based on cost, not truth status

Small/interactive writes may do projection synchronously.
Large or expensive batches may defer projection asynchronously.

But the truth model should not change based on that decision.

Meaning:
- sync projection = convenience
- async projection = scaling strategy
- canonical truth remains the same in both cases

---

## Recommended projection model

## Stage A: canonical commit

Commit:
- entities
- aliases
- triples
- timeline events
- provenance
- canonical freshness/staleness markers

Output:
- truth is durable
- affected entities are known

This is the commit boundary.

---

## Stage B: compile projection

Generate:
- compiled page markdown
- rendered human-readable entity pages

Write to:
- filesystem pages now
- memory-wiki or equivalent later

Failure effect:
- canonical truth remains committed
- page projection stale/incomplete
- retry needed

---

## Stage C: retrieval projection

Generate and write:
- topic chunks
- embeddings
- LanceDB entries
- chunk metadata

Failure effect:
- canonical truth remains committed
- retrieval quality degraded/stale
- retry needed

---

## Stage D: lexical projection

Generate and write:
- FTS rows
- keyword indexes

Failure effect:
- canonical truth remains committed
- keyword/hybrid retrieval degraded
- retry needed

---

## Stage E: compatibility projection

Generate and write only if needed:
- compatibility link rows
- compatibility page/summary artifacts
- caches

Failure effect:
- canonical truth remains committed
- specific compatibility features may degrade
- retry needed

---

## Sync vs async guidance

## Do synchronously when

- single-entity update
- interactive write path
- low latency and low cost
- user expects immediately usable compiled/searchable result

Likely sync candidates:
- small page compile
- small topic chunk refresh
- lightweight FTS refresh

## Do asynchronously when

- large repo sync
- email batch ingest
- many-entity import
- expensive embedding wave
- backfill/reindex/recompile work

Likely async candidates:
- large LanceDB reindex
- bulk compile waves
- eval refreshes
- compatibility backfills

---

## Current code issue to watch

### Current behavior
`writePersonPage()` calls `markCompiled()` after filesystem write succeeds.
Then `compileEntity()` proceeds to LanceDB indexing.
If indexing fails, the function logs a warning and returns the page write result.

### Why this is okay
This does **not** violate the main invariant.
Truth remains intact and projection failure does not roll back the write.
That part is good.

### Why it is still imperfect
It conflates:
- page projection freshness
with
- all projection freshness

So an entity may be marked compiled even if retrieval projection is stale.

### Recommendation
Eventually split projection status into at least:
- page projection current/stale
- retrieval projection current/stale

Even if stored in one table, the semantics should be separate.

---

## Projection status model

A simple target model could be:

- `canonical_dirty` or equivalent trigger source
- `page_projection_updated_at`
- `retrieval_projection_updated_at`
- `keyword_projection_updated_at`
- optional `last_projection_error`

Or more generally:
- one projection-status row per entity per projection kind

We do not need to implement that immediately, but the conceptual model should be explicit now.

---

## What counts as a projection vs truth

## Truth

- entities
- aliases
- triples
- canonical timeline
- provenance
- freshness inputs

## Projection

- rendered markdown page
- topic chunks
- embeddings
- LanceDB entries
- FTS rows
- caches
- compatibility graph/page tables

If it can be dropped and rebuilt from canonical state, it is a projection.

That is the test.

---

## Operational implications

## Rebuildability

We should be able to run:
- recompile entity
- reindex retrieval
- rebuild FTS
- rebuild compatibility artifacts

without touching canonical truth.

That is a major operational advantage.

## Monitoring

Operationally, warnings and status should distinguish:
- canonical write failures
- projection failures

These are different severities.

Canonical write failure = data risk.
Projection failure = freshness/search quality risk.

## Testing

Tests should separately cover:
- canonical commit success
- page projection success/failure behavior
- retrieval projection success/failure behavior
- idempotent rebuild behavior

---

## Decision rules

A good projection design:
- is fully downstream of truth
- is idempotent
- is rebuildable
- can fail without losing canonical truth
- distinguishes which projection is stale

A bad projection design:
- lets indexing failure roll back durable writes
- treats compiled artifacts as truth
- uses one vague freshness bit for everything forever
- makes projection state impossible to recover or reason about

---

## Current recommendation

The projection model should be:

- **canonical truth first**
- **compiled pages second**
- **retrieval/FTS/compatibility artifacts after that**
- **projection failures never roll back truth**
- **projection freshness tracked separately from canonical change state**

That gives us a clean safety story.

And honestly, that safety story is worth more than any clever retrieval trick, because it keeps the system recoverable when the inevitable indexing/embedder/provider failure happens.