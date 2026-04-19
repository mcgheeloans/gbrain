# Ingestion + Graph Bridge Drill-Down

Last updated: 2026-04-19
Upstream baseline: `013b348`
Related docs:
- `docs/INITIAL_OPENCLAW_NATIVE_BLUEPRINT.md`
- `docs/SEARCH_ARCHITECTURE_DRILLDOWN.md`
- `docs/UPSTREAM_DIVERGENCE.md`
- `docs/FEATURE_PARITY_CHECKLIST.md`

## Purpose

This doc maps the backend coupling points for:

- import
- sync
- link extraction
- timeline extraction
- compile
- retrieval projection
- graph-backed search signals

This is the second major architecture seam after search.

The question is not “how do we rewrite gbrain?”
The real question is:

**where do gbrain features depend on backend-owned page/link/timeline state, and how do we adapt those dependencies to our canonical SQLite + compile + LanceDB projection model?**

---

## Executive summary

Upstream and OpenClaw-native C-lite have opposite data gravity.

### Upstream gravity

Upstream is basically:

1. parse markdown into page fields
2. write page/chunks into engine-owned tables
3. optionally extract links/timeline from page text
4. use engine-owned links/timeline/search tables as the feature substrate

### OpenClaw-native gravity

Our current C-lite direction is basically:

1. ingest canonical entities/triples/timeline into SQLite sidecar
2. recompute freshness
3. compile entity state into page-like markdown
4. project compiled chunks into LanceDB/FTS
5. use canonical graph/timeline truth as the feature substrate

So the same product features are anchored differently.

That is the bridge problem.

---

## Current upstream ingest/graph model

### Key upstream files

- `src/core/import-file.ts`
- `src/commands/import.ts`
- `src/commands/sync.ts`
- `src/commands/extract.ts`
- `src/core/link-extraction.ts`

### What upstream does

#### Import path

`importFromContent()` does:

1. parse markdown
2. compute content hash
3. chunk `compiled_truth` and `timeline`
4. embed chunks
5. transaction:
   - version existing page
   - put page
   - reconcile tags
   - upsert chunks or delete stale chunks

So page/chunk storage is the primary committed write.

#### Sync path

`performSync()` does:

1. inspect git diff
2. delete/rename/reimport pages
3. persist sync state
4. best-effort extract links/timeline
5. best-effort embed

So sync also remains page-first.

#### Extract path

`extract.ts` and `link-extraction.ts` then derive:
- typed links
- timeline entries
from markdown/frontmatter content.

Important: in upstream, graph and timeline are largely **derived from page content**.
They are not the canonical primary write shape.

---

## Current C-lite ingest/graph model

### Key C-lite files

- `src/clite/ingest-note.ts`
- `src/clite/triples.ts`
- `src/clite/timeline.ts`
- `src/clite/freshness.ts`
- `src/clite/read-models.ts`
- `src/clite/compile-entity.ts`
- `src/clite/index-person.ts`
- `src/clite/lance-store.ts`

### What C-lite does

#### Canonical ingest

`ingestNote()` does:

1. extract entities/relationships from source note
2. upsert entities + aliases
3. append timeline events
4. insert triples
5. recompute freshness

That is the primary write.

#### Compile path

`compileEntity()` then does:

1. read composed entity state from SQLite
2. render entity page markdown
3. write page to disk
4. render topic chunks
5. embed + upsert chunks into LanceDB
6. sync FTS rows
7. mark freshness via compile state

So compiled pages and retrieval chunks are downstream projections.

Important: in C-lite, graph and timeline are **canonical truth**, while page text is a compiled artifact.

---

## The bridge in one sentence

### Upstream
Page text → extracted links/timeline → search/graph features

### OpenClaw-native
Canonical entities/triples/timeline → compiled page/chunks → search/graph features

Same features, opposite causal direction.

---

## Backend coupling points we have to adapt

These are the places where gbrain features currently assume the upstream backend model.

## 1. Page import as the authoritative write

### Upstream assumption
The engine’s `putPage()` + `upsertChunks()` transaction is the durable core write.

### OpenClaw-native adaptation
For our backend, the durable core write should be:
- entities
- aliases
- triples
- timeline
- freshness

Compiled page writes and retrieval index writes should be downstream.

### Rule
Do not treat page import as canonical in the OpenClaw-native design.
Treat it as a compatibility-facing projection or ingress path.

---

## 2. Graph derived from page text

### Upstream assumption
Links are extracted from markdown/frontmatter and stored in engine-owned link tables.

### OpenClaw-native adaptation
Graph truth should come from canonical triples.
Compiled pages may still contain links, but those links should be a projection of canonical truth, not the only source of truth.

### Rule
Important graph-backed features should depend on canonical triples first, not on re-extracting meaning from compiled prose.

---

## 3. Timeline derived from page text

### Upstream assumption
Timeline entries are extracted from markdown sections/bullets/headers.

### OpenClaw-native adaptation
Timeline should be stored canonically, then rendered into page/timeline sections.

### Rule
Timeline extraction can exist as an ingestion strategy, but rendered timeline text should not be the canonical store.

---

## 4. Freshness and recompilation responsibility

### Upstream assumption
Content hash and sync state determine whether page/chunks need updating.

### OpenClaw-native adaptation
Freshness should be tied to canonical changes:
- triple changes
- timeline changes
- entity changes
versus `compiled_updated_at`

### Rule
Compilation staleness belongs to canonical-side freshness metadata, not just page hash comparison.

---

## 5. Search signals from backend-owned links/chunks

### Upstream assumption
Search can ask the engine for:
- vector results
- keyword results
- backlink counts
- chunk embeddings

These are built on page/chunk/link tables the engine owns.

### OpenClaw-native adaptation
We need equivalent signals sourced from:
- LanceDB projected chunks
- SQLite triples as graph signal source
- FTS rows for lexical retrieval where needed

### Rule
Preserve the search contract, but swap the signal source under it.
This is exactly the kind of adaptation we want.

---

## 6. Sync/import workflow expectations

### Upstream assumption
`import` and `sync` mean “read files, write pages, then enrich.”

### OpenClaw-native adaptation
Those same commands can still exist, but internally they should map to phases like:

1. canonical ingest
2. canonical graph/timeline updates
3. freshness recompute
4. compile stale entities
5. update retrieval projections

### Rule
Keep the familiar workflow entry points, but change the internal write order.

---

## Feature-to-backend mapping

## Import / Sync

### Upstream tie
- `src/core/import-file.ts`
- `src/commands/import.ts`
- `src/commands/sync.ts`

### Native bridge
- filesystem/repo change detection still useful
- but changed files should feed canonical ingest, not just page row replacement

### Recommendation
Define import/sync as orchestration commands, not canonical data-model commitments.

---

## Link extraction / graph features

### Upstream tie
- `src/commands/extract.ts`
- `src/core/link-extraction.ts`

### Native bridge
- extraction is one possible canonical ingest source
- canonical triples become the persistent graph layer
- compiled links are optional projections, not sole graph truth

### Recommendation
Treat link extraction as a parser into canonical triples, not as a post-hoc graph side table forever.

---

## Timeline features

### Upstream tie
- `extract.ts` timeline logic
- engine timeline entry methods

### Native bridge
- canonical timeline events stored in SQLite
- compiled page timeline sections rendered from those rows
- search can still consume timeline chunks as projection output

### Recommendation
Preserve timeline as a feature, but move its primary storage into canonical state.

---

## Compile / page rendering

### Upstream tie
In upstream, pages are the authored/core objects.

### Native bridge
In our design, pages are compiled outputs from canonical entity state.

### Recommendation
Lean into compile as a first-class projection stage.
This is a core architectural difference, and it is okay.

---

## Retrieval / graph ranking

### Upstream tie
Graph-aware signals come from engine-owned links/backlink counts and chunk tables.

### Native bridge
Graph-aware signals should come from canonical triples and projected chunks.

### Recommendation
Graph ranking is not “extra spice.”
It is a valid feature requirement.
The adaptation goal is to supply graph signals from our canonical graph instead of upstream link tables.

That is adaptation, not product drift.

---

## What should stay familiar vs what should change

## Keep familiar

- import/sync command surface
- search/query command surface
- page-like output for wiki/Obsidian compatibility
- hybrid retrieval mental model
- graph-aware ranking as a feature class

## Change internally

- canonical write target
- source of graph truth
- source of timeline truth
- freshness model
- compile responsibility
- retrieval signal substrate

---

## Architecture stance

### Upstream-compatible surface
These should remain close to upstream:
- commands
- operations
- query ergonomics
- page/result shapes where practical

### OpenClaw-native core
These should be native-first:
- canonical entities
- aliases
- triples
- canonical timeline
- freshness
- compile pipeline
- retrieval projection

### Bridge layer
This is the missing middle we need to make explicit.
It should define:
- how imported files become canonical writes
- how canonical writes mark entities stale
- how stale entities get compiled
- how compilation refreshes retrieval/search signals
- how graph/timeline features read from canonical truth while preserving familiar behavior upstream

---

## Recommended target flow

For the OpenClaw-native backend, the ideal internal flow is:

1. **Ingress**
   - note/file/repo/email input arrives

2. **Canonical ingest**
   - entities
   - aliases
   - triples
   - timeline events
   - provenance/freshness updates

3. **Freshness evaluation**
   - mark affected entities stale

4. **Compile**
   - render page-like markdown from canonical state

5. **Projection refresh**
   - LanceDB chunks
   - FTS lexical rows
   - any compatibility-facing page/link artifacts

6. **Feature consumption**
   - search
   - graph ranking
   - timeline views
   - wiki page reads

This keeps durable truth upstream of retrieval.
That is the most important invariant.

---

## Rules for adaptation

A backend adaptation is good if it:
- preserves the user-facing feature
- changes where the feature’s required data comes from
- moves truth toward canonical-side storage
- keeps projections downstream of durable writes

A backend adaptation is risky if it:
- keeps extracting important truth from compiled prose even after we have canonical truth
- duplicates graph/timeline truth in multiple conflicting places
- lets retrieval/index failures block canonical writes
- couples commands directly to projection internals instead of the bridge

---

## Current recommendation

The right mental model is:

- upstream gbrain is **page-first and derived-graph**
- OpenClaw-native gbrain should be **canonical-graph-first and compiled-page**

So our job is not to mimic upstream storage literally.
Our job is to preserve the feature behavior while moving the dependency points:

- from page tables to canonical entities/triples/timeline
- from engine-owned graph state to canonical graph state
- from direct page import to ingest → freshness → compile → project

That is the bridge.

And I think this is the right backbone for the whole fork.
If we get this layer right, the rest stops feeling like a pile of exceptions.