# Operations + Command Bridge Drill-Down

Last updated: 2026-04-19
Upstream baseline: `013b348`
Related docs:
- `docs/INITIAL_OPENCLAW_NATIVE_BLUEPRINT.md`
- `docs/SEARCH_ARCHITECTURE_DRILLDOWN.md`
- `docs/INGESTION_GRAPH_BRIDGE_DRILLDOWN.md`
- `docs/UPSTREAM_DIVERGENCE.md`
- `docs/FEATURE_PARITY_CHECKLIST.md`

## Purpose

This doc maps the user-facing and tool-facing command surfaces to the OpenClaw-native backend flow.

Question:

**How do we keep gbrain’s CLI/API/operations surface familiar while routing the actual work through canonical ingest, freshness, compile, and projection?**

This is where architecture stops being abstract and becomes product behavior.

---

## Executive summary

The repo already gives us a very good command boundary:

1. **CLI-only commands** in `src/cli.ts`
2. **contract-first shared operations** in `src/core/operations.ts`
3. **engine interface** in `src/core/engine.ts`

That means we do not need to invent a brand new surface.
We need to change what happens behind that surface.

The correct move is:

- keep the operation names and CLI ergonomics as stable as possible
- redefine the internal routing for selected operations so they hit the canonical backend flow
- avoid pushing canonical-side complexity into the user-facing command layer

In other words:
**preserve the verbs, swap the plumbing.**

---

## What the current command surface actually is

### CLI layer

From `src/cli.ts` there are two buckets:

#### A. CLI-only commands
Examples:
- `import`
- `sync`
- `extract`
- `embed`
- `eval`
- `orphans`
- `graph-query`
- `jobs`
- `doctor`
- `migrate`

These bypass the operation layer and call command modules directly.

#### B. Shared operations surfaced through CLI
Examples from `src/core/operations.ts`:
- `get_page`
- `put_page`
- `search`
- `query`
- `add_link`
- `get_backlinks`
- `traverse_graph`
- `add_timeline_entry`
- `get_timeline`
- `sync_brain`
- file operations
- jobs operations

These are the real contract surface for CLI + MCP + tools-json.

### Important implication

The operation layer is already the best compatibility boundary in the repo.
If we are going to adapt backend behavior without making the product feel alien, this is where we should do it.

---

## Current routing model

Today the rough routing is:

- CLI parses args
- operation handler or CLI-only command is selected
- operation handler talks to `BrainEngine`
- engine owns the durable page/chunk/link/timeline substrate

That is consistent with upstream’s page-first architecture.

For OpenClaw-native, we should keep the first two layers and change the last two.

---

## Recommended target routing model

For the OpenClaw-native backend, the internal routing should be:

1. **Surface layer**
   - CLI / MCP / tools-json / operations

2. **Bridge/orchestration layer**
   - canonical ingest orchestration
   - freshness marking
   - compile scheduling or execution
   - projection refresh
   - compatibility shaping

3. **Canonical core**
   - entities
   - aliases
   - triples
   - timeline
   - freshness

4. **Projection layer**
   - compiled pages
   - LanceDB chunks
   - FTS rows
   - compatibility-facing link/page artifacts when needed

5. **Consumption layer**
   - query/search
   - graph traversal/ranking
   - page reads
   - timeline reads

The user should mostly still see the same commands.

---

## Per-surface mapping

## 1. `put_page`

### Current behavior
`put_page` calls `importFromContent()`, which:
- parses markdown
- writes page/chunks transactionally
- optionally embeds
- optionally auto-links afterward

### Problem
This assumes page text is canonical.
That does not match the OpenClaw-native design.

### Recommended bridge behavior
For the native backend, `put_page` should become one of two things:

#### Option A, preferred long-term
Treat `put_page` as an ingress compatibility operation:
- parse incoming markdown into canonical entities/triples/timeline when possible
- persist canonical truth
- mark affected entities stale
- compile/projection refresh as follow-up
- optionally persist the original content as raw/source material

#### Option B, short-term compatibility
Accept page writes as a compatibility-side source, but route them through:
- canonical extraction
- canonical write
- compile/projection refresh
instead of treating page rows as ultimate truth

### Recommendation
Do not let `put_page` remain a permanent direct write into the authoritative model for the native backend.
It should become a bridge operation.

---

## 2. `get_page`

### Current behavior
Reads a page directly from engine storage.

### Recommended bridge behavior
For the native backend, `get_page` should read the compiled/projection page representation.

Meaning:
- canonical state is primary
- page content returned to users/tools is compiled from canonical state
- optionally include provenance or staleness if useful later

### Recommendation
Keep `get_page` as a stable user-facing verb.
Just make it read compiled state instead of assuming authored page rows are the source of truth.

---

## 3. `search` and `query`

### Current behavior
- `search` uses engine keyword search
- `query` uses hybrid search, or `cliteQuerySearch()` when `query_backend === 'clite'`

### Recommended bridge behavior
This is already close to what we want.

The right model is:
- `search` and `query` remain stable verbs
- bridge decides which retrieval backend and graph-signal source to use
- search contract stays stable while signal sources swap underneath

### Recommendation
Do not change the surface.
Strengthen the adapter boundary under it.

---

## 4. `add_link`, `remove_link`, `get_links`, `get_backlinks`, `traverse_graph`

### Current behavior
These assume engine-owned link rows are the graph substrate.

### Problem
For the native backend, graph truth should live in canonical triples, not just link rows.

### Recommended bridge behavior
These operations should become graph compatibility verbs over canonical graph state.

Examples:
- `add_link` should map to canonical triple creation when semantically appropriate
- `remove_link` should map to canonical triple removal/supersession
- `get_backlinks` should be derived from canonical graph state or projected compatibility tables
- `traverse_graph` should operate over canonical graph edges first

### Recommendation
Keep the verbs, move the substrate from engine link tables to canonical graph state.

This is especially important because graph ranking and graph traversal are not side features in our design.

---

## 5. `add_timeline_entry`, `get_timeline`

### Current behavior
Direct engine timeline entry operations.

### Recommended bridge behavior
These should map naturally onto canonical timeline state.

This is actually one of the easiest adaptations:
- add timeline → append canonical timeline event
- get timeline → read canonical timeline events, optionally through compiled view formatting

### Recommendation
Minimal surface change, major internal simplification.

---

## 6. `sync_brain`, `import`, `extract`

### Current behavior
These are still page-first workflows.

- `import` walks files and imports pages
- `sync` diffs git and reimports pages, then extracts/embeds
- `extract` derives links/timeline from page text

### Problem
These commands currently encode upstream storage assumptions.

### Recommended bridge behavior
These should become orchestrators around the native pipeline.

#### `import`
Should mean:
- discover inputs
- parse/extract canonical facts
- write canonical state
- recompute freshness
- compile/project

#### `sync`
Should mean:
- detect changed source files
- determine affected entities / canonical records
- update canonical state
- mark stale
- compile/project affected entities
- update checkpoints/logs

#### `extract`
Should mean:
- run extraction into canonical graph/timeline state
not merely populate an auxiliary side table forever

### Recommendation
These are the highest-value places to add a real orchestration bridge.
They are workflow commands, not data-model truth.

---

## 7. `get_chunks`, file operations, raw data operations

### Current behavior
These expose lower-level storage primitives.

### Recommended bridge behavior
These should remain subordinate/internal-ish.

- `get_chunks` should expose projected retrieval chunks, not canonical truth
- raw data should remain provenance/input material
- files should remain attachments/input assets, not truth layer

### Recommendation
Do not let low-level projection/storage APIs become the conceptual center of the system.

---

## 8. Jobs / Minions

### Current behavior
Jobs exist as background orchestration capability.

### Recommended bridge behavior
This is where a lot of the canonical pipeline should eventually live.

Great candidates for jobs:
- canonical extraction
- stale-entity compile
- projection refresh
- eval runs
- large repo sync work

### Recommendation
Minions should become the asynchronous execution layer for the bridge, not a separate architecture island.

---

## Engine contract implications

### Current state
`BrainEngine` is still page/chunk/link/timeline centric.

### What not to do
Do not immediately force the entire canonical model into `BrainEngine`.
That would create a third incompatible engine abstraction too early.

### Better approach
Use the operation/command bridge as the adaptation layer.

That means:
- operations keep stable verbs
- bridge decides whether to call engine methods directly or canonical-side modules
- engine remains compatibility infrastructure where needed
- canonical core grows beside it, not jammed into it prematurely

### Recommendation
Treat `BrainEngine` as an implementation dependency, not the final architecture truth.

---

## Surface stability vs internal change

## Keep stable

- CLI command names users already understand
- operation names exposed to tools/MCP
- search/query ergonomics
- page read semantics at a high level
- graph and timeline feature semantics

## Change internally

- write path ordering
- source of truth
- graph source substrate
- timeline source substrate
- compile responsibility
- projection refresh responsibility
- use of background jobs for expensive follow-up work

---

## Decision rules

A good command/operation adaptation:
- preserves the verb
- changes the internals
- routes through canonical truth before projection when possible
- keeps retrieval/indexing downstream of durable writes

A bad command/operation adaptation:
- exposes backend weirdness directly to users
- duplicates separate write paths for the same feature forever
- leaves page-first direct writes as authoritative by accident
- treats extraction/compile/projection as optional side effects when they are actually core bridge stages

---

## Recommended target behavior by category

### Read operations
Default pattern:
- read compiled/projected or canonical-derived views
- do not expose storage internals unless explicitly low-level

### Mutating operations
Default pattern:
- write canonical state first
- mark stale / log provenance
- compile/project afterward, sync or async depending on cost

### Workflow commands
Default pattern:
- orchestrate the pipeline
- should not themselves define the truth model

### Search/graph/timeline operations
Default pattern:
- stable feature contract
- canonical-backed signals under the hood

---

## Concrete architecture stance

The operation layer should become the product contract.

The bridge behind it should be responsible for translating that contract into the OpenClaw-native pipeline:

- ingress
- canonical write
- freshness
- compile
- project
- serve

That gives us a clean story:

- users keep familiar commands
- tools keep familiar operations
- backend evolves underneath without pretending upstream storage must be copied literally

---

## Current recommendation

If we want the fork to stay sane, the command model should be:

- **same verbs**
- **different internals**
- **canonical-first write path**
- **projection-backed read/search path**
- **operation layer as compatibility contract**

That’s the move.

If we do this right, gbrain still feels like gbrain from the outside, while the backend becomes OpenClaw-native on the inside.
And that is exactly what we’re trying to pull off.