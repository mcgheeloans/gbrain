# Search Architecture Drill-Down

Last updated: 2026-04-19
Upstream baseline: `013b348`
Related docs:
- `docs/INITIAL_OPENCLAW_NATIVE_BLUEPRINT.md`
- `docs/UPSTREAM_DIVERGENCE.md`
- `docs/FEATURE_PARITY_CHECKLIST.md`

## Purpose

This doc narrows the broad blueprint down to the search stack.

Reason: search is the easiest place for an OpenClaw-native backend adaptation to silently become a real product fork.

We need a hard boundary between:

1. backend substitution
2. projection/index shape
3. ranking behavior
4. benchmark-specific tuning

If we do not separate those, we will end up with a search stack that works on our sample evals but becomes painful to compare, maintain, and merge with upstream.

---

## Current upstream search shape

### Core files

- `src/core/search/hybrid.ts`
- `src/core/search/keyword.ts`
- `src/core/search/vector.ts`
- `src/core/search/dedup.ts`
- `src/core/search/intent.ts`
- `src/core/search/expansion.ts`
- `src/core/search/eval.ts`

### Effective upstream pipeline

The current upstream-friendly hybrid stack is:

1. detect query detail intent
2. run keyword search via engine
3. run vector search via engine
4. optionally expand queries
5. fuse ranked lists with RRF
6. normalize and apply compiled-truth boost
7. cosine re-score against query embedding
8. apply backlink boost
9. dedup
10. return ranked chunk/page results

### Key architectural point

This is good architecture.

Most of the ranking pipeline is **above** the engine layer.
That means backend substitution is possible without rewriting the entire search system.

The engine is mainly responsible for:
- `searchKeyword()`
- `searchVector()`
- `getEmbeddingsByChunkIds()`
- `getBacklinkCounts()`

That is a much cleaner seam than it first looked.

---

## Current C-lite search shape

### Relevant files

- `src/core/search/clite-adapter.ts`
- `src/clite/retrieve-person.ts`
- `src/clite/lance-store.ts`
- `src/clite/llm-expand.ts`

### What C-lite currently does

C-lite currently bundles together several concerns inside `retrieve-person.ts`:

1. query expansion
2. vector retrieval from shared LanceDB scope `gbrain:entities`
3. local keyword scoring over chunk text/title
4. fusion
5. normalization
6. compiled-truth boost
7. cosine re-score
8. backlink boost via SQLite triples
9. dedup
10. query-intent detection
11. entity mention / graph-aware reranking
12. page aggregation and snippet selection

This means C-lite search is not just a backend adapter today.
It is already a partial alternate search stack.

---

## The real boundary problem

There are three different categories of logic currently mixed together.

### A. Legitimate backend substitution

These are safe adaptations and should remain acceptable:

- using LanceDB instead of engine-native vector search
- using SQLite canonical graph data instead of engine-native link tables
- using OpenClaw-native LLM expansion provider instead of upstream provider
- projecting compiled canonical pages into a shared retrieval index

These are implementation substitutions, not product redesign.

### B. Legitimate projection logic

These are also acceptable, but need documentation:

- compiled canonical pages becoming retrieval chunks
- topic-aware chunk projection for compiled pages
- entity metadata attached to indexed chunks
- shared-scope retrieval over `gbrain:entities`

These are about how the OpenClaw-native backend presents data to the search layer.

### C. Product-level ranking divergence

These are much riskier and must be treated as explicit divergence:

- graph-aware answer promotion
- person-vs-company intent reranking
- entity mention multipliers
- relation-verb proximity boosts
- benchmark-driven query-shaping rules

These change the meaning of search quality, not just the plumbing.

This is the fault line.

---

## Recommended search-layer architecture

## 1. Keep upstream hybrid search as the default conceptual model

The default model should still be:

- keyword retrieval
- vector retrieval
- fusion
- rescoring
- backlink boost
- dedup

That keeps us close to upstream and preserves comparability.

## 2. Treat C-lite as a retrieval provider plus projection source first

The first job of C-lite search should be:

- provide vector-retrievable compiled chunks
- provide keyword-accessible compiled chunks or equivalent lexical scores
- provide graph-derived metadata signals where needed

Not: become a separate all-in-one search engine with bespoke ranking rules.

## 3. Isolate divergence into explicit rerank stages

If we keep entity/graph-aware reranking, it should be isolated as a named layer such as:

- baseline retrieval
- optional entity-aware rerank
- optional graph-answer rerank

That way we can:
- turn it on/off in evals
- compare it against upstream-like baseline retrieval
- document exactly what changed

Right now too much of that is bundled together.

---

## Proposed target shape

### Layer 1: retrieval primitives

Responsibility:
- fetch candidate chunks/pages
- no heavy intent-specific product logic

Possible sources:
- LanceDB vector retrieval
- lexical retrieval over compiled chunks
- canonical graph metadata lookup

### Layer 2: shared ranking pipeline

Responsibility:
- fusion
- normalization
- compiled-truth boost
- cosine re-score
- backlink boost
- dedup

This should stay as close to upstream as practical.

### Layer 3: explicit optional rerankers

Responsibility:
- graph-aware answer promotion
- entity-intent reranking
- relation-query answer typing

This layer is where divergence belongs.
It must be:
- explicit
- measurable
- toggleable in tests/evals
- documented in divergence docs

### Layer 4: page aggregation / result shaping

Responsibility:
- collapse chunk hits into page results
- pick snippets
- expose final result structure

This is presentation/projection logic, not retrieval truth.

---

## Concrete file-level recommendation

### Keep as upstream-aligned core

- `src/core/search/hybrid.ts`
- `src/core/search/dedup.ts`
- `src/core/search/intent.ts`
- `src/core/search/eval.ts`

These are the comparison spine.
Do not casually fork them.

### Treat as adapter boundary

- `src/core/search/clite-adapter.ts`

This file should remain thin.
Its job should be routing and shape adaptation, not owning a second search philosophy.

### Split current C-lite retrieval stack conceptually

Current overloaded file:
- `src/clite/retrieve-person.ts`

It currently contains at least four concerns:
1. retrieval backend access
2. shared ranking logic
3. divergence reranking
4. page shaping

Even if we do not physically split it immediately, we should treat it as these four conceptual modules.

Suggested eventual split:
- `src/clite/retrieve-base.ts`
- `src/clite/retrieve-rank.ts`
- `src/clite/retrieve-rerank-graph.ts`
- `src/clite/retrieve-pages.ts`

Not because filenames matter, but because architecture clarity does.

---

## Rules for acceptable divergence

A search change is acceptable by default if it is one of these:

- backend/provider substitution
- index/projection shape needed by the OpenClaw-native stack
- parity-preserving ranking behavior already present conceptually upstream

A search change must be treated as explicit divergence if it:

- changes answer-type preference
- changes entity-vs-container ranking policy
- adds graph-derived answer promotion
- is introduced mainly to fix a benchmark miss
- cannot be described as a backend swap or projection necessity

If a change falls in the second bucket, it needs:
- doc entry in divergence docs
- eval evidence beyond one anecdotal query
- ability to disable it during comparison if practical

---

## My current read on the existing C-lite search work

### Good and reusable

These look like solid architectural moves:
- shared LanceDB retrieval scope `gbrain:entities`
- compiled-truth projection into retrieval index
- backlink boost from canonical triples
- keeping recall-oriented retrieval broad before page shaping

### Valid but needs discipline

These are reasonable, but need cleaner isolation:
- topic-aware chunk shaping
- local query expansion fallback
- page-level aggregation from chunk hits

### Risky / likely to drift

These are where benchmark-chasing starts:
- relation-verb proximity boosts
- query-specific person/company reranking
- entity mention multipliers tuned around specific misses
- graph-aware answer promotion that only exists for selected query classes

Some of these may still be worth keeping, but they should no longer be treated as invisible plumbing.

---

## Recommended immediate next changes

1. **Document search divergence explicitly**
   - add a search-specific divergence section to `UPSTREAM_DIVERGENCE.md`

2. **Define baseline vs enhanced retrieval modes**
   - baseline: backend substitution + shared ranking only
   - enhanced: optional graph/entity rerank layers

3. **Use evals to compare both modes**
   - not just “core vs C-lite”
   - also “C-lite baseline vs C-lite enhanced”

4. **Stop treating benchmark-specific fixes as neutral infrastructure**
   - if it fixes Vox-like misses via query-specific logic, call it what it is

5. **Keep `clite-adapter.ts` thin**
   - routing, shaping, wiring only

---

## Current recommendation

For the OpenClaw-native fork, search should be framed like this:

- **Baseline commitment:** preserve upstream hybrid search concepts
- **Backend adaptation:** swap retrieval/index/expansion providers as needed
- **Canonical advantage:** use SQLite truth + triples to project better chunks and metadata
- **Divergence discipline:** isolate entity/graph-aware rerankers as optional, documented layers

That gives us the best shot at both:
- practical search quality
- future upstream compatibility

And honestly, that’s the whole game here.
If we keep the search boundary clean, the rest of the backend story stays manageable.
If we don’t, we end up with a fork that looks compatible on paper and isn’t.