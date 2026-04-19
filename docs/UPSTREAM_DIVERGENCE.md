# Upstream Divergence Log

Status: living document
Owner: local OpenClaw adaptation
Last updated: 2026-04-19
Upstream baseline: `origin/master` at `013b348` (`v0.12.3: Reliability wave — sync deadlock, search timeout scoping, wikilinks, orphans (#216)`)
Previous local anchor before upstream refresh: `514105e` (`docs: add C-lite graph rerank benchmark note`)
Purpose: keep this fork close to upstream gbrain while making the OpenClaw-native backend work.

## Why this file exists

This fork is **not** trying to replace gbrain with a different product.
The goal is to preserve as much upstream structure and behavior as possible while swapping backend dependencies so the system works on:

- OpenClaw memory infrastructure (LanceDB Pro shared retrieval/index)
- built-in embeddings and LLM query expansion
- no extra paid API dependency (replaces the original PGLite-centered setup)

This file is the first place to check before pulling upstream changes or adding new local modifications.

---

## Divergence rules

1. Prefer **adapter-layer substitutions** over broad rewrites.
2. Keep **upstream shapes, names, and flows** unless a local change buys something important.
3. Document every intentional deviation here.
4. Mark whether a change is:
   - **adapter-only**: backend swap, same product behavior target
   - **behavior drift**: local behavior intentionally differs from upstream
   - **temporary/local experiment**: useful for evaluation, not yet committed to architecture
5. Use this merge-risk rubric consistently:
   - **Low**: adapter wiring only, no intended product-behavior change
   - **Medium**: shared interfaces, names, or assumptions changed, manual merge review required
   - **High**: ranking, output shape, or public behavior changed and upstream updates will likely need re-evaluation
6. If a local optimization increases future merge pain, it needs a written reason.

---

## Current architectural stance

### Canonical truth
- **Local choice:** SQLite sidecar for canonical structured truth
- **Classification:** adapter-only
- **Reason:** canonical writes should survive retrieval/index failures; retrieval projection should be downstream of durable writes
- **Upstream mapping:** memory/canonical layer, previously explored through PGLite-centric paths

### Retrieval/index backend
- **Local choice:** shared LanceDB Pro backend
- **Classification:** adapter-only
- **Reason:** reuse existing OpenClaw memory infrastructure, embeddings, and retrieval stack instead of introducing a separate paid-key dependency path
- **Upstream mapping:** search/index layer

### Query expansion
- **Local choice:** built-in OpenClaw/OAuth-backed LLM expansion path
- **Classification:** adapter-only
- **Reason:** preserve hybrid retrieval quality without requiring the original paid API setup
- **Upstream mapping:** query expansion / search enhancement path

### Compiled page layer
- **Local choice:** keep wiki/page rendering as a compiled layer above canonical truth
- **Classification:** adapter-only
- **Reason:** pages are a projection, not source of truth
- **Upstream mapping:** memory-wiki / compiled page behavior

### Graph/timeline layer
- **Local choice:** thin SQLite graph/timeline sidecar, not heavier embedded graph/postgres-like replacement
- **Classification:** adapter-only
- **Reason:** enough structure for canonical entities, aliases, triples, and ranking support without overbuilding
- **Upstream mapping:** entity/relationship/timeline support

---

## Implemented local divergences

### 1. Entity-aware C-lite compile/retrieve path
- **Classification:** adapter-only
- **Status:** committed
- **Date introduced:** 2026-04-19
- **Local files:**
  - `src/clite/compile-entity.ts` — factory dispatch by entity type
  - `src/clite/render-person.ts` — person page rendering
  - `src/clite/render-company-page.ts` — company page rendering
  - `src/clite/render-project-page.ts` — project page rendering
  - `src/clite/entities.ts` — entity upsert/query adapter
  - `src/clite/write-page.ts` — page write to disk
  - `src/clite/retrieve-person.ts` — entity-aware page retrieval/ranking path
  - `src/core/search/clite-adapter.ts` — query adapter that exposes C-lite retrieval through the core search surface
- **Upstream mapping:** page/write semantics come from `src/core/engine.ts`, `src/core/pglite-engine.ts`, and `src/core/types.ts`; query-surface adaptation is local via `src/core/search/clite-adapter.ts` rather than an upstream compile/render file
- **Commits:**
  - `f7a4c7d` broaden C-lite to company + project entity types
  - `0610c5e` naming clarity / flaky test fix
- **What changed:**
  - moved from person-only assumptions to entity-aware compile/render/retrieve support
  - retained backward-compat aliases where practical
- **Why:** upstream gbrain already treats more than people as first-class memory objects
- **Merge risk:** Medium, mostly naming and dispatch surface

### 2. Shared-scope retrieval on `gbrain:entities`
- **Classification:** adapter-only
- **Status:** committed
- **Date introduced:** 2026-04-19
- **Local files:**
  - `src/clite/retrieve-person.ts` — `SCOPE = 'gbrain:entities'`
  - `src/clite/lance-store.ts` — `SCOPE = 'gbrain:entities'` for LanceDB writes
- **Upstream mapping:** upstream scoping is implicit in PGLite table queries (`src/core/pglite-engine.ts`); no separate scope constant
- **What changed:**
  - retrieval scope changed from `gbrain:people` to `gbrain:entities`
  - indexing metadata now carries entity-aware fields
- **Why:** matches broadened entity model and shared LanceDB backend
- **Merge risk:** Medium, because tests and assumptions may still exist upstream around narrower scope names

### 3. OpenClaw-native hybrid search behavior
- **Classification:** adapter-only
- **Status:** committed
- **Date introduced:** 2026-04-19
- **Local files:**
  - `src/clite/retrieve-person.ts` — full retrieval pipeline (RRF fusion, boosts, dedup)
  - `src/clite/llm-expand.ts` — LLM query expansion via openai-codex OAuth
  - `src/clite/lance-store.ts` — LanceDB vector search adapter
  - `src/core/search/clite-adapter.ts` — adapter from core query flow into C-lite retrieval
  - `src/core/search/hybrid.ts` — upstream hybrid search reference point (RRF, compiled-truth boost, cosine re-score)
  - `src/core/search/keyword.ts` — upstream keyword search delegate
  - `src/core/search/vector.ts` — upstream vector search delegate
  - `src/core/search/intent.ts` — query intent classifier (zero-latency heuristic)
  - `src/core/search/eval.ts` — eval harness with IR metrics
  - `src/commands/eval.ts` — CLI eval command
- **Upstream mapping:** `src/core/search/hybrid.ts`, `src/core/search/keyword.ts`, `src/core/search/vector.ts`, `src/core/search/intent.ts`, and `src/core/pglite-engine.ts` are the comparison points; local C-lite retrieval does not replace compile/render paths, it adapts the query path and substitutes LanceDB-backed vector/keyword retrieval for the upstream `PGLiteEngine.searchVector()`/`searchKeyword()` calls
- **Commits:**
  - `40f7e45` expansion forwarding, embedder reuse, FTS5 keyword search
  - `0c55330` LLM query expansion via openai-codex OAuth
- **What changed:**
  - retrieval uses built-in embeddings, built-in expansion, FTS-style keyword search, and hybrid fusion through the OpenClaw-native stack
- **Why:** remove dependency on the original paid-key path while preserving search quality
- **Merge risk:** Medium, because upstream search internals may evolve independently

### 3a. Narrow C-lite canonical ingest path
- **Classification:** adapter-only
- **Status:** committed, intentionally narrow
- **Date introduced:** 2026-04-19
- **Local files:**
  - `src/clite/ingest-note.ts` — note-to-canonical ingest transaction into SQLite sidecar
  - `src/clite/entities.ts` — entity upsert during ingest
  - `src/clite/triples.ts` — relationship insertion during ingest
  - `src/clite/timeline.ts` — timeline append during ingest
  - `src/clite/freshness.ts` — freshness recompute after ingest
  - `src/clite/compile-entity.ts` — follow-on compile step, explicitly separate from ingest
- **Upstream mapping:** upstream ingestion flow is broader and centers on `src/commands/import.ts`, `src/commands/sync.ts`, `src/commands/extract.ts`, `src/commands/embed.ts`, `src/core/import-file.ts`, and `src/core/pglite-engine.ts`; C-lite ingest currently commits canonical structured truth only and leaves compile/index refresh as explicit later steps
- **What changed:**
  - local C-lite ingest is not yet a full upstream-style import/sync pipeline
  - it performs canonical entity/alias/triple/timeline/freshness writes in one transaction, then expects compile/retrieval refresh to happen separately
- **Why:** preserve the architectural rule that canonical writes succeed independently of retrieval/indexing, while keeping the first slice small and testable
- **Merge risk:** Medium, because future upstream ingestion changes matter for eventual parity even though current C-lite ingest is intentionally narrower

### 4. Topic-specific chunk rendering for embedding diversity
- **Classification:** behavior drift
- **Status:** committed
- **Date introduced:** 2026-04-19
- **Local files:**
  - `src/clite/render-topic-chunks.ts` — topic-specific chunk rendering with entity-type-aware predicate maps
  - `src/clite/compile-entity.ts` — invokes renderTopicChunks and indexes results
- **Upstream mapping:** upstream has no direct equivalent; upstream chunks are rendered as part of `PGLiteEngine` page compilation in `src/core/pglite-engine.ts`
- **Commit:** `bf3578a`
- **What changed:**
  - chunk rendering became more topic-aware for retrieval quality and entity-type diversity
- **Why:** improved recall and ranking behavior in local tests
- **Merge risk:** High, because this affects ranking behavior, not just wiring
- **Reconciliation trigger:** revisit if upstream adds its own entity/topic-aware chunking or if local eval gains disappear on broader datasets

### 5. Graph-aware reranking for relationship queries
- **Classification:** behavior drift
- **Status:** committed and still being tuned
- **Date introduced:** 2026-04-19
- **Local files:**
  - `src/clite/retrieve-person.ts` — graph-aware reranking logic (relationship intent boost, Jaccard dedup)
  - `src/clite/triples.ts` — triple adapter providing graph-linked entity facts
- **Upstream mapping:** upstream ranking is in `src/core/search/hybrid.ts` (RRF + cosine re-score + backlink boost); no graph-triple-based reranking exists upstream
- **Commit:** `82da1c9`
- **What changed:**
  - retrieval uses graph-linked entity facts as a ranking signal for relationship intent
- **Why:** improved real-data relationship query performance materially in local world-v1 evals
- **Merge risk:** High, because this is ranking logic, not just backend substitution
- **Reconciliation trigger:** revisit if upstream ships stronger relationship intent ranking or if local top-1 gains stop holding on broader real-data evals

### 6. Additional uncommitted relationship-ranking tuning
- **Classification:** temporary/local experiment
- **Status:** uncommitted
- **Date introduced:** 2026-04-19
- **Upstream files affected:** local retrieval ranking test/tuning only, not yet mapped upstream
- **Files:**
  - `src/clite/retrieve-person.ts`
  - `test/clite-retrieve.test.ts`
- **What changed:**
  - ongoing tuning for the remaining `who invested in Vox` miss
  - test adjusted to better match the real failure mode
- **Why:** current eval is strong overall but still misses one top-1 investor case
- **Merge risk:** High until either committed or reverted, because uncommitted ranking work is a merge hazard by definition

### 7. Local evaluation artifacts
- **Classification:** temporary/local experiment
- **Status:** uncommitted
- **Date introduced:** 2026-04-19
- **Upstream files affected:** none unless promoted into official eval workflows
- **Files:**
  - `eval/world-v1-qrels-sample.json`
  - `scripts/clite-world-v1-sample.ts`
  - `scripts/world-v1-ab-eval.ts`
- **Purpose:** real-data ingest/eval harness for core-vs-C-lite comparison
- **Why:** gives a practical benchmark without requiring full upstream eval coupling
- **Merge risk:** Low if kept as local tooling, Medium if promoted into official workflows

---

## Current known good state

As of 2026-04-19, after rebasing local work onto upstream `013b348`:

- C-lite entity-aware path exists and works
- shared LanceDB Pro backend is active
- local eval previously reached **22/23 top-1** on the world-v1 sample after graph-aware reranking
- remaining known miss: **`who invested in Vox`**
- likely root cause: final page-ranking still under-promotes the graph-backed answer relative to semantically similar person pages

Relevant committed references:
- upstream baseline `013b348` (`v0.12.3`)
- previous local anchor `514105e` docs benchmark note
- `82da1c9` graph-aware reranking
- `0610c5e` flaky retrieval test fix and naming cleanup
- `f7a4c7d` entity broadening

Upstream changes between `514105e` and `013b348` were reviewed before re-anchoring. They primarily affected reliability, sync, wikilinks, orphans, extract/migrate timeouts, JSONB/markdown repair, and postgres paths (`src/commands/extract.ts`, `src/core/engine.ts`, `src/core/pglite-engine.ts`, `src/core/postgres-engine.ts`, `src/core/operations.ts`, `src/core/link-extraction.ts`). They did not directly replace or invalidate the current C-lite-specific divergence entries, but they do raise the priority of re-checking any mappings that touch `src/core/engine.ts` or `src/core/pglite-engine.ts`.

---

## What should stay close to upstream

Prefer upstream structure for:

- ingestion flow shape
- feature surface and command semantics
- page/render concepts
- schema naming where not actively harmful
- capability layout and docs taxonomy

Prefer local adapters for:

- storage backend
- retrieval/index backend
- embeddings provider path
- query expansion provider path
- auth/dependency substitution

Use extra caution before diverging in:

- ranking semantics
- compile output shape
- public feature behavior
- schema names that upstream touches frequently

---

## Update checklist when upstream changes

When reviewing upstream changes, ask:

1. Is this change in an area we only adapted, or an area where we intentionally drifted?
2. Can we absorb it by changing an adapter instead of changing product behavior?
3. Does our local ranking logic still match the upstream intent well enough?
4. Does this divergence entry need to be updated, removed, or narrowed?

---

## Immediate next documentation tasks

1. ~~Add a parity checklist by feature area.~~ → done, see `docs/FEATURE_PARITY_CHECKLIST.md`
2. ~~Replace the placeholder upstream-file notes with exact file mappings.~~ → done 2026-04-19
3. Resolve the uncommitted Vox-tuning experiment by either committing it or dropping it.
4. Keep this file current whenever a local divergence lands.

## Lifecycle rule

When a divergence is absorbed upstream or intentionally removed locally, do not silently delete it from history. Move it to a short archived section or commit history note so future sync work has an audit trail.
