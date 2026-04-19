# Feature Parity Checklist

Last updated: 2026-04-19
Upstream baseline: `013b348` (same baseline as `docs/UPSTREAM_DIVERGENCE.md`)
Previous local anchor before upstream refresh: `514105e`
Last parity check: 2026-04-19
Purpose: Track alignment between the local OpenClaw-native gbrain fork and upstream. Focus on what's different, why, and what to do about it.

Companion doc: `docs/UPSTREAM_DIVERGENCE.md`

## Status definitions

| Status | Meaning |
| --- | --- |
| **Match** | Same behavior as upstream (may differ in implementation details) |
| **Adapted** | Same goal, different implementation to fit OpenClaw stack |
| **Diverged** | Intentionally different behavior — local is intentionally better or architecturally required |
| **Experimental** | Implemented but not yet validated or settled |
| **Unknown** | Not yet compared against current upstream |

Decision rule: Prefer **Adapted** over **Diverged**. Only keep **Diverged** when local behavior is clearly better for real use.

## Checklist

### Match

| Area | Divergence entries | Local files | Upstream files | Notes |
| --- | --- | --- | --- | --- |
| Compiled page generation | — | `src/clite/compile-entity.ts`, `src/clite/write-page.ts`, `src/clite/render-person.ts`, `src/clite/render-company-page.ts`, `src/clite/render-project-page.ts` | `src/core/pglite-engine.ts` (`putPage`, `upsertChunks` page/chunk persistence), `src/core/engine.ts` (interface), `src/core/types.ts` (`PageType`) | Pages are a projection, not source of truth, same intent as upstream |

### Adapted

| Area | Divergence entries | Local files | Upstream files | What differs locally | Done means |
| --- | --- | --- | --- | --- | --- |
| Canonical structured truth | #1 | `src/clite/bootstrap.ts`, `src/clite/schema.ts`, `src/clite/entities.ts`, `src/clite/triples.ts`, `src/clite/timeline.ts` | `src/core/pglite-engine.ts`, `src/core/engine.ts` | SQLite sidecar instead of PGLite canonical store | Local schema mapped to upstream canonical model ✅, re-check after upstream `699db50` engine/migrate changes |
| Retrieval / index backend | #2, #3 | `src/clite/lance-store.ts`, `src/clite/retrieve-person.ts` | `src/core/pglite-engine.ts` (searchVector/searchKeyword), `src/core/search/vector.ts`, `src/core/search/keyword.ts` | Shared LanceDB Pro backend replaces PGLite index path | Upstream index files and local LanceDB entry points mapped ✅ |
| Hybrid search | #3, partly #4 | `src/clite/retrieve-person.ts` (local RRF), `src/core/search/clite-adapter.ts`, `src/core/search/hybrid.ts` (upstream RRF) | `src/core/search/hybrid.ts`, `src/core/search/intent.ts`, `src/core/pglite-engine.ts` (`searchKeyword`, `searchVector`) | Vector + keyword + expansion via OpenClaw stack | A small parity test set exists and passes against world-v1 sample |
| Query expansion | #3 | `src/clite/llm-expand.ts` | No upstream equivalent (upstream uses paid-key API) | OpenClaw OAuth-backed expansion via openai-codex | Expansion-on/off expectations covered by tests |
| Entity support | #1, #2 | `src/clite/entities.ts`, `src/clite/compile-entity.ts` | `src/core/types.ts` (PageType), `src/core/pglite-engine.ts` | Covers person / company / project | Verify upstream entity breadth and reclassify if needed |
| Ingestion flow | #3a | `src/clite/ingest-note.ts`, `src/clite/entities.ts`, `src/clite/triples.ts`, `src/clite/timeline.ts`, `src/clite/freshness.ts`, `src/clite/compile-entity.ts` | `src/commands/import.ts`, `src/commands/sync.ts`, `src/commands/extract.ts`, `src/commands/embed.ts`, `src/core/import-file.ts`, `src/core/pglite-engine.ts` | C-lite ingest currently commits canonical structured truth in one transaction, then compiles/indexes separately, unlike upstream’s broader import/sync/extract/embed workflow | Decide whether parity means extending C-lite toward upstream workflow shape or keeping canonical ingest intentionally separate with a documented bridge |
| Eval harness | #7 | `src/core/search/eval.ts`, `src/commands/eval.ts`, `test/clite-compile.test.ts`, `test/clite-retrieve.test.ts`, `test/clite-ab-compare.test.ts`, `test/parity.test.ts` | Same files (local additions to upstream eval structure) | Local eval artifacts added | Parity test set exists ✅ |
| Upstream sync discipline | all | `docs/UPSTREAM_DIVERGENCE.md` | — | Divergence log exists | Every row has upstream file mapping ✅, baseline re-anchored to `013b348` |

### Diverged

| Area | Divergence entries | Local files | Upstream equivalent | What's different and why | Done means |
| --- | --- | --- | --- | --- | --- |
| Relationship query ranking | #5, #6 | `src/clite/retrieve-person.ts` (graph rerank), `src/clite/triples.ts` (graph data) | `src/core/search/hybrid.ts` (no graph reranking upstream) | Graph-aware reranking improved real-data retrieval, but some tuning may be benchmark-shaped | Keep reusable graph/entity-intent logic, gate/remove benchmark-specific tuning |
| Topic-aware chunk rendering | #4 | `src/clite/render-topic-chunks.ts`, `src/clite/compile-entity.ts` | None upstream (chunks rendered inline in PGLite compilation) | Chunk shaping affects retrieval behavior | Shaping rules documented; know when upstream would let us remove drift |

### Experimental

| Area | Divergence entries | Current state | Done means |
| --- | --- | --- | --- |
| Eval harness | #7 | Local sample eval exists, upstream parity harness is incomplete | Eval artifacts are either promoted into supported local tooling or explicitly discarded |

### Unknown

| Area | Divergence entries | Why unknown | Done means |
| --- | --- | --- | --- |
| Email-to-brain | not mapped yet | Product goal is clear, but no parity slice is defined | A minimum daily-use workflow is written down and tested end-to-end |
| Memory lifecycle (expire / forget) | not mapped yet | Not yet checked whether upstream has expiry/forget semantics | Upstream behavior is verified and the gap is classified as Match, Adapted, Diverged, or Unknown-with-blocker |
| Multi-scope / tenant isolation | not mapped yet | Local LanceDB Pro scopes exist, upstream parity is unknown | Upstream scoping behavior is verified and the architectural gap is documented |

## Priorities

1. ~~**Fill upstream file mappings** for every Adapted/Diverged row.~~ → done 2026-04-19, then re-anchored to `013b348`
2. **Resolve the ranking divergence cleanly**: keep reusable graph/entity-intent logic, drop or gate benchmark-specific tuning.
3. **Define minimum daily-use workflow** for email-to-brain and normal ingestion.
4. **Resolve eval harness status**: supported local tooling or disposable scaffolding, but not limbo.
5. **Re-check entity breadth and unknown rows** against the current upstream baseline.
6. **Re-check adapter assumptions touching `src/core/engine.ts` / `src/core/pglite-engine.ts`** after upstream `699db50`.

## Maintenance rule

Before changing any row status, verify that the upstream baseline above is still current. If the baseline moved, re-check all Match and Adapted rows before trusting the labels. That happened once already here when the baseline moved from `514105e` to `013b348`.
