# Engine Boundary + Adapter Strategy

Last updated: 2026-04-19
Upstream baseline: `013b348`
Related docs:
- `docs/INITIAL_OPENCLAW_NATIVE_BLUEPRINT.md`
- `docs/SEARCH_ARCHITECTURE_DRILLDOWN.md`
- `docs/INGESTION_GRAPH_BRIDGE_DRILLDOWN.md`
- `docs/OPERATIONS_COMMAND_BRIDGE_DRILLDOWN.md`
- `docs/UPSTREAM_DIVERGENCE.md`
- `docs/FEATURE_PARITY_CHECKLIST.md`

## Purpose

This doc answers the next hard question:

**What should remain inside `BrainEngine`, what should live in canonical-side modules, and what is the thinnest adapter strategy that keeps us close to upstream without forcing a fake sqlite engine too early?**

This is the architecture guardrail.

---

## Executive summary

`BrainEngine` is not a truth-model interface.
It is a **storage-and-feature substrate interface** built around upstream gbrain’s page/chunk/link/timeline world.

That is okay.

The mistake would be to treat it as the place where the OpenClaw-native canonical model must go live.
That would create a swollen, confused interface and a fork that gets harder to merge every month.

The right move is:

- keep `BrainEngine` as a compatibility/storage boundary
- keep canonical entities/triples/timeline/freshness in separate native modules
- use adapters/bridges where product surfaces need upstream-shaped outputs
- avoid introducing a full new `sqlite` `BrainEngine` implementation until there is a very strong reason

Short version:

**`BrainEngine` should serve the old shape. Canonical modules should own the new truth. The bridge should translate between them.**

---

## What `BrainEngine` actually is today

From `src/core/engine.ts`, `BrainEngine` owns methods for:

- pages CRUD
- chunks
- keyword/vector search
- links and graph traversal
- tags
- timeline
- raw data
- versions
- stats/health
- ingest log
- sync helpers
- config
- migrations
- raw SQL for queue/internal work

That is a very broad interface.

Important observation:
this is not “the domain model.”
This is “everything upstream gbrain currently expects an engine to provide.”

So `BrainEngine` is best understood as:

- a compatibility contract
- a storage-backed feature substrate
- a service boundary for existing upstream flows

Not:
- the natural home of canonical entity/triple truth

---

## Evidence from the current code

### 1. Engine factory only knows page-oriented engines

`src/core/engine-factory.ts` supports:
- `postgres`
- `pglite`

and explicitly rejects `sqlite`.

That tells us the current system assumes engines implement the full upstream page/chunk/link/timeline contract.

### 2. Types are page/chunk-first

`src/core/types.ts` centers on:
- `Page`
- `PageInput`
- `Chunk`
- `SearchResult`
- `Link`
- `TimelineEntry`

Even search results are chunk/page shaped, not entity/triple shaped.

### 3. C-lite is already entering through adapters, not engines

`src/core/search/clite-adapter.ts` does not try to make C-lite a full engine.
It adapts C-lite retrieval into upstream-shaped `SearchResult` objects.

That is the pattern.

It is already showing us the right architecture instinct.

---

## What should stay inside `BrainEngine`

These belong in `BrainEngine` because they are storage/feature substrate concerns for the existing upstream shape.

## 1. Page/chunk compatibility storage

Keep inside engine:
- `getPage`
- `putPage`
- `deletePage`
- `listPages`
- `getChunks`
- `upsertChunks`
- `deleteChunks`

Reason:
these define the existing page/chunk substrate and keep upstream code working.

In the OpenClaw-native model, they may become compatibility projections rather than canonical truth, but the interface itself is still useful.

---

## 2. Upstream-shaped search primitives

Keep inside engine:
- `searchKeyword`
- `searchVector`
- `getEmbeddingsByChunkIds`
- `getBacklinkCounts`

Reason:
upstream hybrid search is already cleanly layered above these primitives.

The engine should continue to provide upstream-shaped retrieval signals where that is still the active path.

For the native path, adapters may bypass some of them, but the interface remains valuable.

---

## 3. Compatibility graph/page traversal primitives

Keep inside engine for compatibility:
- `getLinks`
- `getBacklinks`
- `traverseGraph`
- `traversePaths`

Reason:
existing upstream features expect a graph-like capability at this layer.

But in the native architecture these should increasingly be fed from projected or adapted canonical graph state, not treated as the main truth.

---

## 4. Operational substrate

Keep inside engine:
- transactions
- config get/set
- migrations
- ingest log
- stats/health
- raw SQL for minions/internal jobs

Reason:
this is infrastructure, not domain truth.

---

## What should NOT be forced into `BrainEngine`

These should live in canonical-side modules, not be stuffed into the engine interface.

## 1. Entity registry and aliases

Keep outside engine:
- canonical entities
- aliases
- entity typing/normalization

Reason:
this is part of the canonical model, not a page/chunk substrate concern.

---

## 2. Canonical triples / graph truth

Keep outside engine:
- subject/predicate/object truth
- provenance-aware relationships
- temporal triple semantics
- canonical graph mutation logic

Reason:
this is the heart of the native design.
Trying to express it as just “links but more” inside `BrainEngine` would muddy both models.

---

## 3. Canonical timeline truth

Keep outside engine:
- timeline event model
- event provenance
- freshness relationships to canonical state

Reason:
upstream timeline entries are page-derived artifacts.
Our canonical timeline is deeper than that.

---

## 4. Freshness / compile-state logic

Keep outside engine:
- stale determination
- compile-needed logic
- last compiled state vs canonical state

Reason:
this is orchestration and truth-state logic, not storage substrate.

---

## 5. Compile/render logic

Keep outside engine:
- entity read models
- renderers
- page compilation
- topic chunk rendering
- projection shaping

Reason:
engines should store/retrieve substrate.
They should not decide how canonical truth becomes compiled artifacts.

---

## 6. Canonical ingest/extraction semantics

Keep outside engine:
- note/file/email extraction into canonical form
- mapping source material into entities/triples/timeline
- source-specific ingestion workflows

Reason:
this belongs in the bridge/orchestration layer.

---

## What the adapter layer should do

The adapter layer is the missing middle.

Its job is to translate between:
- upstream-shaped expectations
- canonical native truth

without forcing either side to pretend to be the other.

## Adapter responsibilities

### 1. Shape adaptation

Example:
- canonical entity page result → upstream `SearchResult`
- canonical compiled page → upstream `Page`

### 2. Signal adaptation

Example:
- canonical triples → backlink counts / graph ranking signals
- projected chunks in LanceDB → upstream-style query hits

### 3. Workflow adaptation

Example:
- `put_page` surface call → canonical ingest + stale marking + compile
- `sync` surface call → canonical update pipeline, not direct truth writes to page tables

### 4. Compatibility projection

Example:
- canonical truth rendered into page-like markdown for `get_page`
- canonical graph projected into compatibility-facing link rows if needed temporarily

---

## The thinnest viable adapter strategy

This is what I think we should actually do.

## Layer 1: keep the current engine implementations

Keep:
- `PostgresEngine`
- `PGLiteEngine`

Do not rush to add:
- `SQLiteEngine`

Reason:
a new engine would need to impersonate the entire page/chunk/link/timeline contract.
That is a lot of work and it would likely lock in the wrong abstraction too early.

---

## Layer 2: grow canonical-side modules beside the engine

Canonical modules should own:
- entities
- aliases
- triples
- timeline
- freshness
- read models
- compile/render
- projection control

This is already where C-lite is heading.

---

## Layer 3: add targeted adapters at feature seams

Use adapters for:
- search/query
- page reads
- graph operations where needed
- workflow commands

Examples:
- `clite-adapter.ts` for query/search shape adaptation
- future `page-adapter.ts` for compiled page reads
- future graph adapter for canonical traversal/backlink shaping

Do this seam by seam, not as one giant magical abstraction.

---

## Layer 4: keep operations as the contract boundary

Let `src/core/operations.ts` remain the public product contract.

Operations should decide whether a request uses:
- existing engine methods directly
- canonical native modules directly
- or an adapter that bridges the two

That is much cleaner than forcing everything through `BrainEngine`.

---

## Why not create a `sqlite` BrainEngine right now

Tempting idea, wrong timing.

## Problem 1: wrong abstraction pressure

A `sqlite` engine would be forced to expose:
- pages
- chunks
- links
- timeline
- search primitives
- versions
- tags
- raw SQL
- health/stats

But our native design wants canonical entities/triples/timeline first, not page-first storage pretending to be canonical.

## Problem 2: premature lock-in

If we make a fake sqlite engine too early, we will end up molding the canonical design around an upstream storage interface instead of letting the bridge handle translation.

## Problem 3: duplicated complexity

We would be reimplementing a lot of compatibility storage behavior before we know which parts are truly worth preserving as engine concerns.

## Better rule

Only build a true new engine implementation if later evidence shows:
- the adapter layer is too thin to support the needed features cleanly, or
- enough of the contract is genuinely stable and worth implementing natively

We are not there yet.

---

## Recommended ownership map

## `BrainEngine` owns

- page/chunk substrate
- search primitives for upstream path
- compatibility graph/timeline substrate
- transactions/config/migrations/logging/stats
- operational plumbing

## Canonical modules own

- entities
- aliases
- triples
- canonical timeline
- freshness
- read models
- render/compile logic
- projection decisions
- canonical ingest semantics

## Adapters own

- shape translation
- feature-signal translation
- compatibility reads
- workflow routing between surface and canonical core

## Operations own

- public verb contract
- choosing which path to route through

---

## Example routing decisions

## Query/search

- operation: `query`
- adapter: `clite-adapter.ts`
- canonical source: SQLite + LanceDB projection + graph signals
- output shape: upstream `SearchResult[]`

This is the good pattern.

## Get page

Future good pattern:
- operation: `get_page`
- adapter: compiled page adapter
- canonical source: read model + compiled markdown
- output shape: upstream `Page`

## Put page

Future good pattern:
- operation: `put_page`
- bridge: ingest adapter
- canonical source: extracted entities/triples/timeline
- follow-up: freshness + compile + projection refresh

## Graph traversal

Future good pattern:
- operation: `traverse_graph`
- adapter: canonical graph traversal adapter
- canonical source: triples / graph read model
- output shape: `GraphNode[]` or `GraphPath[]`

---

## Decision rules

A responsibility belongs in `BrainEngine` if:
- it is part of the upstream page/chunk/link/timeline substrate
- it is an operational storage concern
- it serves as a stable primitive for upstream-compatible features

A responsibility belongs in canonical modules if:
- it defines durable truth in the native design
- it is entity/triple/timeline/freshness logic
- it controls compilation or truth-to-projection semantics

A responsibility belongs in adapters if:
- it converts native truth into upstream-shaped outputs
- it swaps signal sources while preserving feature contracts
- it routes workflows between public verbs and native internals

---

## Current recommendation

The clean architecture is:

- **Do not make `BrainEngine` the canonical model**
- **Do not build a fake sqlite engine yet**
- **Keep canonical truth in native modules**
- **Use thin adapters at the feature seams**
- **Use operations as the public contract boundary**

That gives us the best tradeoff:

- upstream compatibility stays manageable
- canonical design stays honest
- we avoid stuffing two incompatible worldviews into one interface

And honestly, that is the discipline that will keep this fork from turning into sludge.