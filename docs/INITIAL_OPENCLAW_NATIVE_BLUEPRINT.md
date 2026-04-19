# Initial OpenClaw-Native Blueprint

Last updated: 2026-04-19
Upstream baseline: `013b348` (`v0.12.3`)
Purpose: broad first-pass map of how current gbrain architecture fits together, what assumes Postgres/PGLite today, and how each subsystem should map onto the OpenClaw-native backend direction.

## Why this doc exists

We should not design the OpenClaw-native fork one feature at a time in isolation.
The right first step is a whole-system map:

- what gbrain core does today
- where storage/engine assumptions actually live
- which parts are already cleanly abstracted
- which parts are still product behavior rather than backend wiring
- where the OpenClaw-native stack can be a thin adapter
- where we are drifting into a real fork

This is the initial blueprint, not the final design.
Its job is to give us the drill-down order.

---

## Executive view

Current gbrain is already split into a few clean layers:

1. **Core contract layer**
   - `src/core/engine.ts`
   - `src/core/engine-factory.ts`
   - defines the `BrainEngine` interface

2. **Engine implementations**
   - `src/core/postgres-engine.ts`
   - `src/core/pglite-engine.ts`
   - these implement storage/search/graph/timeline/version/config methods

3. **Shared ingest/search logic above the engine**
   - `src/core/import-file.ts`
   - `src/core/embedding.ts`
   - `src/core/chunkers/*`
   - `src/core/search/*`
   - `src/core/link-extraction.ts`
   - `src/core/sync.ts`

4. **Operation/CLI surface**
   - `src/core/operations.ts`
   - `src/commands/*`
   - MCP and CLI mostly work through these layers

5. **Async orchestration / jobs**
   - `src/core/minions/*`

This is good news.
It means the repo is not one giant Postgres blob.
A lot of behavior is already above the engine boundary.

The important catch is this:
**the current `BrainEngine` contract is page/chunk/search centric, not canonical-entity/triple centric.**
That is the main architectural mismatch with the OpenClaw-native C-lite direction.

---

## Current architecture by subsystem

### 1. Engine contract

**Current files**
- `src/core/engine.ts`
- `src/core/engine-factory.ts`
- `docs/ENGINES.md`

**What it does now**
- Defines a large storage contract around:
  - pages
  - chunks
  - links
  - timeline
  - raw data
  - versions
  - ingest log
  - search
  - config
  - raw SQL execution
- Factory currently supports only:
  - `postgres`
  - `pglite`

**Current backend assumption**
- Engine is pluggable, but only for engines that implement the existing page/chunk/search contract.
- SQLite sidecar canonical truth is not represented as a first-class engine concept.

**OpenClaw-native mapping**
- Keep `BrainEngine` as the compatibility surface for upstream behavior.
- Do **not** try to force canonical triples directly into the existing engine interface yet.
- Instead, use an adapter strategy:
  - canonical truth lives in C-lite SQLite sidecar
  - compiled pages are projected into an engine-compatible retrieval shape
  - query surface can be adapted through `src/core/search/clite-adapter.ts`

**Recommendation**
- Treat `BrainEngine` as an upstream compatibility boundary, not the source-of-truth model.

**Risk**
- If we try to make `BrainEngine` itself canonical-triple-aware too early, we create a real fork with painful future merges.

---

### 2. Engine implementations

**Current files**
- `src/core/postgres-engine.ts`
- `src/core/pglite-engine.ts`
- `src/core/pglite-schema.ts`
- `src/core/schema-embedded.ts`
- `src/core/migrate.ts`

**What they do now**
- implement the full CRUD/search/timeline/graph/version contract
- persist `pages`, `content_chunks`, `links`, `timeline_entries`, etc.
- expose `searchKeyword()` and `searchVector()` directly at engine level

**Current backend assumption**
- source of truth is page-centric relational storage
- search works directly over engine-managed chunks
- links/timeline are engine-owned tables, not downstream projections from another canonical layer

**OpenClaw-native mapping**
- We should not replace these engines immediately.
- Near-term, C-lite should remain a parallel architecture that:
  - owns canonical truth in SQLite
  - projects compiled pages/chunks into LanceDB-backed retrieval
  - adapts query access through core search surface where practical

**Recommendation**
- Avoid inventing `sqlite` as a new `BrainEngine` type right now.
- Keep the OpenClaw-native backend as a **sidecar architecture plus adapters** until subsystem parity is clearer.

**Risk**
- A premature third engine implementation would duplicate too much of current upstream behavior.

---

### 3. Ingestion pipeline

**Current files**
- `src/core/import-file.ts`
- `src/commands/import.ts`
- `src/commands/extract.ts`
- `src/commands/embed.ts`
- `src/commands/sync.ts`
- `src/core/import-file.ts`
- `src/core/link-extraction.ts`
- `src/core/sync.ts`

**What it does now**
- parses markdown into page fields
- hashes for idempotency
- chunks text
- embeds chunks
- writes page/tags/chunks transactionally
- later workflows enrich links/timeline
- sync uses git-diff-based incremental manifest logic

**Current backend assumption**
- ingest is page-first
- import and embedding are coupled to the page/chunk model
- links/timeline can be backfilled or reconciled after page import

**OpenClaw-native mapping**
- Current C-lite ingest (`src/clite/ingest-note.ts`) is much narrower:
  - canonical entities
  - aliases
  - triples
  - timeline
  - freshness
  - compile happens separately
- This is a real architectural difference, but it is still compatible if we treat C-lite ingest as the canonical write layer and build a bridge to upstream-style workflow entry points.

**Recommendation**
- Do not contort canonical ingest into fake page-first semantics.
- Instead define a bridge:
  - upstream workflow entry points stay familiar
  - internally they resolve into canonical ingest + compile + index refresh phases

**Risk**
- If we leave this bridge undefined, every feature pipeline will fork on its own.

---

### 4. Chunking subsystem

**Current files**
- `src/core/chunkers/recursive.ts`
- `src/core/chunkers/semantic.ts`
- `src/core/chunkers/llm.ts`
- `docs/architecture/infra-layer.md`

**What it does now**
- recursive chunker is deterministic default
- semantic chunker uses sentence embeddings + similarity boundaries
- LLM chunker asks a model for topic shifts

**Current backend assumption**
- chunking happens before storage, but it assumes chunk targets are page text fields (`compiled_truth`, `timeline`)

**OpenClaw-native mapping**
- Chunking logic is one of the cleanest reusable subsystems.
- But C-lite currently also has topic-aware chunk shaping in:
  - `src/clite/render-topic-chunks.ts`
- That means local chunking is partly a retrieval-ranking strategy, not just a preprocessing step.

**Recommendation**
- Keep upstream chunkers as generic utilities.
- Treat C-lite topic-aware chunking as a separate projection/ranking layer, not a replacement for all chunking.

**Risk**
- If topic-aware chunk shaping bleeds into the generic chunker layer, we increase merge pain and make eval harder to interpret.

---

### 5. Embeddings subsystem

**Current files**
- `src/core/embedding.ts`
- `src/clite/embedder.ts`

**What it does now**
- upstream embedding service uses OpenAI embeddings directly
- batch + retry + truncation are shared service concerns

**Current backend assumption**
- embedding generation is outside the engine
- storage engines only persist/search embeddings

**OpenClaw-native mapping**
- This is a clean adaptation point.
- OpenClaw-native path should preserve the same separation:
  - embedding provider logic outside canonical DB
  - retrieval/index layer consumes vectors
- C-lite should not hardcode a provider-specific worldview into canonical truth.

**Recommendation**
- Keep embedding provider as replaceable infrastructure.
- Preserve “embedding is not the engine” as a strong rule.

**Risk**
- Low, if kept isolated.

---

### 6. Search subsystem

**Current files**
- `src/core/search/hybrid.ts`
- `src/core/search/keyword.ts`
- `src/core/search/vector.ts`
- `src/core/search/intent.ts`
- `src/core/search/expansion.ts`
- `src/core/search/dedup.ts`
- `src/core/search/clite-adapter.ts`
- `src/clite/retrieve-person.ts`
- `src/clite/llm-expand.ts`
- `src/clite/lance-store.ts`

**What it does now**
- query expansion
- vector + keyword retrieval
- reciprocal rank fusion
- cosine rescoring
- backlink boost
- dedup

**Current backend assumption**
- upstream core search expects engine-driven keyword/vector retrieval
- ranking logic above that is shared

**OpenClaw-native mapping**
- This subsystem is partly adapter-friendly and partly drift-prone.
- Clean adapter parts:
  - query expansion provider swap
  - vector backend swap
  - keyword backend swap
- Drift-prone parts:
  - topic-aware chunk shaping
  - graph-aware reranking
  - entity-intent ranking heuristics

**Recommendation**
- Keep search architecture as close to upstream as possible.
- Limit divergence to:
  - retrieval backend substitution
  - proven ranking improvements with explicit docs and evals

**Risk**
- High. Search is where “backend adaptation” quietly turns into product behavior divergence.

---

### 7. Graph / links / timeline

**Current files**
- `src/core/link-extraction.ts`
- `src/core/pglite-engine.ts`
- `src/core/postgres-engine.ts`
- `src/clite/triples.ts`
- `src/clite/timeline.ts`

**What it does now**
- upstream stores typed links and timeline entries inside engine-owned relational tables
- graph traversal and backlink counts are engine methods

**Current backend assumption**
- links are page-to-page graph edges
- timeline entries are page-attached relational rows

**OpenClaw-native mapping**
- C-lite is structurally richer here:
  - canonical triples
  - aliases
  - entity registry
  - freshness
  - timeline sidecar
- This is one of the strongest reasons not to collapse C-lite back into a plain page-centric engine.

**Recommendation**
- Preserve C-lite graph/timeline as canonical sidecar structure.
- Expose only the projections needed for upstream-compatible retrieval and UX.

**Risk**
- Medium. The danger is not technical impossibility, it is over-widening the public contract too early.

---

### 8. Operations / CLI / MCP surface

**Current files**
- `src/core/operations.ts`
- `src/cli.ts`
- `src/commands/*`
- `src/mcp/server.ts`

**What it does now**
- contract-first operations layer
- CLI and MCP both rely on shared operation definitions
- operations call into engine/import/search subsystems

**Current backend assumption**
- operations assume either core engine search or, in some paths, C-lite query adapter
- mutating workflows remain mostly upstream page-centric workflows

**OpenClaw-native mapping**
- This is where we should build compatibility bridges.
- User-facing commands should not need to know the entire backend redesign.

**Recommendation**
- Keep operation names and CLI semantics close to upstream.
- Change internals behind the operation layer first.

**Risk**
- Medium. If operations fork too far, upstream sync gets ugly fast.

---

### 9. Minions / async orchestration

**Current files**
- `src/core/minions/queue.ts`
- `src/core/minions/worker.ts`
- `src/core/minions/types.ts`
- `src/core/minions/attachments.ts`

**What it does now**
- database-backed queue
- worker claims jobs, renews locks, handles timeouts, retries, child jobs
- uses `BrainEngine.executeRaw()` and config/migration support

**Current backend assumption**
- queue is database-native and tightly tied to current engine storage capabilities
- async orchestration is not abstracted the same way storage/search is abstracted

**OpenClaw-native mapping**
- This likely should stay outside the first C-lite architecture pass.
- It is important, but it is not the first blocker for memory/search parity.

**Recommendation**
- Treat minions as a separate workstream.
- First decide whether OpenClaw-native gbrain should:
  - keep upstream minions on existing engine tables
  - or delegate background orchestration to OpenClaw-native job infrastructure later

**Risk**
- Medium to high if touched too early.

---

### 10. Storage / files / attachments

**Current files**
- `src/core/storage.ts`
- `src/core/storage/local.ts`
- `src/core/storage/s3.ts`
- `src/core/storage/supabase.ts`

**What it does now**
- pluggable binary storage backend
- largely independent from core structured memory model

**Current backend assumption**
- files are attachment infrastructure, not the canonical truth store

**OpenClaw-native mapping**
- This is already in decent shape.
- No major redesign needed yet.

**Recommendation**
- Leave this alone unless a concrete workflow requires changes.

**Risk**
- Low.

---

## Broad mapping summary

### Clean adapter candidates
These are the safest areas to swap or wrap without creating a deep fork:

- embedding provider layer
- vector retrieval backend
- keyword retrieval backend
- query expansion provider
- operation-level backend routing
- compiled page projection into shared retrieval index

### Areas that are already real product drift
These need strict documentation and eval discipline:

- topic-aware chunk shaping
- graph-aware relationship reranking
- entity-intent ranking heuristics
- canonical sidecar ingest being separate from upstream import/sync workflow

### Areas to postpone
These should not drive the first backend blueprint:

- minions/job system redesign
- file storage redesign
- deep MCP/CLI surface changes

---

## Proposed architecture stance

### Keep
- upstream operation surface
- upstream core search concepts where practical
- upstream chunkers as generic utilities
- upstream engine layer as compatibility contract

### Adapt
- retrieval/index backend to shared LanceDB Pro
- embedding provider to OpenClaw-native path
- query expansion to OpenClaw-native path
- query routing through `clite-adapter` where needed

### Preserve as local canonical design
- SQLite sidecar canonical truth
- entity registry + aliases + triples + freshness + timeline
- compile as projection, not source of truth
- retrieval failures must never roll back canonical writes

### Avoid for now
- rewriting `BrainEngine`
- inventing a third fully-native engine implementation too early
- forcing canonical triples into every upstream abstraction immediately

---

## Initial subsystem-by-subsystem blueprint

| Subsystem | Current upstream center | OpenClaw-native target | Recommended stance |
| --- | --- | --- | --- |
| Engine contract | `src/core/engine.ts` | compatibility boundary | keep |
| Engine implementations | postgres/pglite engines | sidecar + adapters first | adapt around, don’t replace yet |
| Ingestion | import/sync/extract/embed | canonical ingest + compile bridge | adapted |
| Chunking | `src/core/chunkers/*` | shared utilities + local projection shaping | mostly keep |
| Embeddings | `src/core/embedding.ts` | OpenClaw-native provider path | adapt |
| Search | `src/core/search/*` | LanceDB-backed retrieval + disciplined reranking | adapt carefully |
| Graph/timeline | engine-owned relational tables | canonical triples/timeline sidecar | preserve local design |
| Operations/CLI/MCP | `src/core/operations.ts` | stable interface over new internals | keep surface |
| Minions | `src/core/minions/*` | separate later decision | postpone |
| Storage | `src/core/storage/*` | likely unchanged | keep |

---

## Biggest open questions

1. **Do we want a long-term third engine, or a durable sidecar+adapter architecture?**
   - My current answer: sidecar+adapter first.

2. **What is the exact bridge from upstream import/sync/extract to canonical ingest + compile?**
   - This needs a dedicated follow-up design slice.

3. **Which search/ranking changes are true backend adaptation vs benchmark-shaped local behavior drift?**
   - This needs continued eval discipline.

4. **How much of the graph/timeline model should ever be promoted into a public compatibility contract?**
   - Probably less than we’re tempted to expose.

5. **Should minions remain on the upstream engine tables or eventually move onto OpenClaw-native orchestration?**
   - Not first.

---

## Drill-down status

These drill-downs are complete. Each has its own doc:

1. **Search architecture** → `docs/SEARCH_ARCHITECTURE_DRILLDOWN.md`
2. **Ingestion + graph bridge** → `docs/INGESTION_GRAPH_BRIDGE_DRILLDOWN.md`
3. **Operations + command bridge** → `docs/OPERATIONS_COMMAND_BRIDGE_DRILLDOWN.md`
4. **Engine boundary + adapter strategy** → `docs/ENGINE_BOUNDARY_ADAPTER_STRATEGY.md`
5. **Projection strategy** → `docs/PROJECTION_STRATEGY_DRILLDOWN.md`

---

## Implementation roadmap (revised 2026-04-19)

This replaces the earlier drill-down order with a concrete, sequenced build plan.
Informed by full architectural review of the drill-down docs and current code.

### Phase 0: Fix known code-level problems (prerequisite)

These are bugs or structural issues in existing code that will compound if left alone.

**0a. Fix double graph-boost in `retrieve-person.ts`.**
`searchEntityChunks` applies `getGraphLinkedSlugs` boost at chunk level (1.75x linked / 0.9x unlinked).
Then `retrieveEntityPages` applies it again at page level (2.25x / 0.92x).
Effective ratio: ~4.75x for linked vs unlinked. That is too aggressive and masks
retrieval quality problems. Fix: apply graph boost in one place only (page level).

**0b. Extract graph reranking into a toggleable stage.**
Currently graph-aware reranking, entity-intent multipliers, and mention multipliers
are mixed into the main scoring loop. Extract them into named functions with an
`enable` flag so evals can compare “C-lite baseline” vs “C-lite + graph rerank”
without commenting out code. This is required before honest A/B eval is possible.

**0c. Sanitize FTS5 query construction.**
`ftsKeywordSearch` uses string interpolation for FTS5 MATCH. Current escaping only
handles double quotes. FTS5 syntax characters (`*`, `NOT`, `NEAR`, `OR`, `AND`, `^`)
are not sanitized. Add proper FTS5 token escaping.

### Phase 1: Bridge module (`src/clite/bridge.ts`)

This is the critical missing piece. Every drill-down doc references “the bridge” but
no bridge module exists.

**What it does:**
- Accepts source material (note text, extracted facts, or structured input)
- Commits canonical writes (entities, aliases, triples, timeline, freshness) in a
  single SQLite transaction
- Returns a list of affected entity slugs
- Optionally triggers compile + projection refresh for affected entities
- Reports projection status separately from canonical commit status

**What it does NOT do:**
- Replace upstream `importFromContent` or `putPage` directly
- Handle non-entity content (Phase 3 decision)
- Own the extraction/parsing logic (that stays in callers or future LLM extractors)

**Interface sketch:**
```typescript
interface BridgeInput {
  entities: Array<{ slug: string; type: string; title: string; summary?: string; aliases?: string[] }>;
  triples: Array<{ subjectSlug: string; predicate: string; objectEntitySlug?: string; objectLiteral?: string }>;
  timeline: Array<{ entitySlug: string; date: string; summary: string; eventType?: string }>;
  sourceRef?: string;
}

interface BridgeResult {
  canonical: { committed: boolean; entitySlugs: string[]; error?: string };
  projections: {
    compiled: { attempted: boolean; succeeded: string[]; failed: string[] };
    retrieval: { attempted: boolean; succeeded: string[]; failed: string[] };
  };
}

function bridge(db: Database, input: BridgeInput, options?: { compile?: boolean; index?: boolean; pagesDir?: string }): Promise<BridgeResult>;
```

**Key invariant:** projection failures never roll back canonical writes.

**Test targets:**
- canonical commit succeeds even when compile/index throws
- idempotent: same input twice produces same canonical state
- affected slugs list is correct
- projection status accurately reports partial failures

### Phase 2: Projection status in schema

Add per-entity, per-projection-kind freshness tracking to the SQLite schema.

**Schema change to `entity_freshness`:**
```sql
ALTER TABLE entity_freshness ADD COLUMN page_projected_at TEXT;
ALTER TABLE entity_freshness ADD COLUMN retrieval_projected_at TEXT;
ALTER TABLE entity_freshness ADD COLUMN fts_projected_at TEXT;
ALTER TABLE entity_freshness ADD COLUMN last_projection_error TEXT;
```

**Update `markCompiled`** to set `page_projected_at` (what it does now).
**Add `markRetrievalProjected`** called after successful LanceDB indexing.
**Add `markFtsProjected`** called after successful FTS sync.
**Add `getStaleProjections(db)`** that returns entities where any projection
timestamp is older than canonical change timestamp.

This makes staleness detectable and gives a foundation for async compilation
and `doctor`-style health checks.

### Phase 3: `put_page` bridge decision

Define what happens when `put_page` receives non-entity content on the native path.

**Options (pick one):**
- A: Non-entity pages bypass canonical, go to compatibility storage only
- B: Everything gets entity-ified with a generic “document” type
- C: `put_page` is blocked for non-entity content on native path

**Recommendation:** Option A for now. Entity-shaped content routes through bridge.
Everything else passes through to engine compatibility storage unchanged. This avoids
both a blocking restriction and a forced abstraction.

Document the decision and add a type-detection heuristic to the bridge caller.

### Phase 4: Eval promotion

Resolve the `eval/` and `scripts/` artifacts currently marked “experimental.”

Either:
- Move them into the test suite with CI integration
- Or delete them

Limbo eval tooling that isn't in CI gives false confidence. The world-v1 sample
eval is valuable, but only if it runs automatically.

### Phase 5: Adapter interface definition

Write down the `clite-adapter.ts` contract explicitly.

- What upstream search methods does it replace?
- What does it accept and return?
- What is the maximum complexity it should contain?
- When should logic move from the adapter to retrieve-person (or its successors)?

This prevents the adapter from silently growing into a second search engine.

### Phase 6 (later): Multi-entity and temporal queries

Current intent classifier handles `person_relation`, `company_affiliation`, and
`neutral`. Temporal queries (“upcoming deadlines”), aggregate queries (“recent
funding rounds”), and cross-type queries need design work. Defer until the bridge
and projection status are solid.

### Phase 7 (later): Minions decision

Whether to keep upstream minions on engine tables or delegate to OpenClaw-native
job infrastructure. Only after core memory/query architecture is proven.

---

## Current recommendation

The safest strategic path is:

- fix the known code-level problems first (Phase 0)
- build the bridge module that every drill-down doc assumes exists (Phase 1)
- add projection-status tracking so staleness is detectable (Phase 2)
- decide the `put_page` non-entity question (Phase 3)
- stay close to upstream at the operation and compatibility layers
- keep canonical truth in the local SQLite sidecar
- keep retrieval/index as a downstream projection into LanceDB Pro
- document every place where search/ranking turns into product drift
- delay any full “new engine” ambition until the sidecar+adapter shape proves insufficient

That gives us a blueprint that is opinionated, sequenced, and buildable.
