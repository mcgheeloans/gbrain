# C-lite Review Memo — 2026-04-19

## Context

OpenClaw memory stack has been evolving since late March. The gbrain/C-lite work is a sidecar project sitting alongside the main OpenClaw memory stack (lossless-claw + memory-lancedb-pro). The goal is to build a structured, entity-aware canonical truth layer that persists to SQLite, compiles pages to disk, and projects into LanceDB for hybrid retrieval.

This memo covers all progress from the first C-lite vertical slice (2026-04-18) through the entity broadening work (2026-04-19).

---

## What We Started With

Original problem: The OpenClaw memory system had no structured canonical truth layer. Memory was captured loosely, retrieval was fuzzy, and there was no persistent, verifiable record of what the system "knew" about entities.

The gbrain experiment evolved from an initial engine rewrite idea into a C-lite sidecar — a lightweight SQLite-based canonical store that:
1. Ingests raw notes (person, company, project entities)
2. Compiles structured pages to disk
3. Projects into LanceDB for hybrid keyword+vector retrieval

---

## What Was Built (Tickets 1–8, 2026-04-18 to 2026-04-19)

### Architecture

Layer model (bottom to top):
1. **SQLite canonical store** — temporal triple-store (entities, triples, aliases, timelines, freshness)
2. **Compile/write** — converts entity state to rendered pages on disk
3. **LanceDB Pro** — shared retrieval backend (hybrid keyword+vector, query expansion, reranking/fusion)
4. **memory-wiki** — compiled page layer (already existed)

### Key Files

| File | Role |
|------|------|
| `src/clite/schema.sqlite.ts` | Bootstrap schema: entity registry, triples, aliases, timeline, freshness |
| `src/clite/ingest-note.ts` | Parse demo note → upsert entity + triples + aliases |
| `src/clite/read-models.ts` | `getEntityState()` — subject triples; `getEntityInboundState()` — object triples |
| `src/clite/compile-entity.ts` | Factory: dispatch by entity type → correct renderer |
| `src/clite/render-person-page.ts` | Person page: Facts + Timeline |
| `src/clite/render-company-page.ts` | Company page: Facts (subject+inbound) + Team |
| `src/clite/render-project-page.ts` | Project page: Facts + Team |
| `src/clite/render-topic-chunks.ts` | Predicate-topic maps per entity type; `renderTopicChunks()` |
| `src/clite/write-page.ts` | Write page to disk, mark entity compiled |
| `src/clite/verify-slice.ts` | Run ingest+compile+LanceDB index, verify all checks |
| `src/clite/lance-store.ts` | LanceDB shared table (`gbrain:entities`), entity type in metadata |
| `src/clite/retrieve-entity.ts` | Hybrid chunk search, query expansion, reranking, compiled-truth boost, backlink boost, type diversity cap |
| `src/core/search/clite-adapter.ts` | Adapter so OpenClaw search routing uses C-lite retrieval |
| `src/clite/query-operation.ts` | Query operation routing through C-lite backend |
| `test/clite-compile.test.ts` | Compile happy path, company, entity-not-found |
| `test/clite-verify.test.ts` | Verification happy path, failure cases, persistence |
| `test/clite-retrieve.test.ts` | Hybrid search, query expansion, type diversity, fused page results |
| `test/clite-query-operation.test.ts` | Query routing through C-lite |
| `test/clite-ab-compare.test.ts` | A/B harness (currently skipped, needs real pages) |

### Key Design Decisions

1. **SQLite is canonical, LanceDB is retrieval projection** — writes go to SQLite first; LanceDB can lag without losing truth
2. **Entity-aware, not person-only** — people, companies, and projects all compile and retrieve; scope is `gbrain:entities`
3. **Inbound triples for companies/projects** — `getEntityInboundState()` returns object triples so company pages show "who works here" and project pages show "who leads/contributes"
4. **Topic chunk diversity** — different predicate-topic maps per entity type to improve embedding diversity in LanceDB
5. **Hybrid retrieval** — FTS5 keyword + vector similarity, with compiled-truth boost and reranking/fusion
6. **Query expansion via LLM** — async LLM call to rewrite query (can be disabled with `expansion: false`)

---

## What Works

- ✅ All 26 unit tests pass
- ✅ Entity ingest with typed entities (person/company/project)
- ✅ Triple persistence to SQLite with temporal provenance
- ✅ Compile/write/disk verification pipeline
- ✅ LanceDB indexing with entity-aware metadata
- ✅ Hybrid retrieval with keyword+vector
- ✅ Query expansion (toggleable)
- ✅ Compiled-truth boost at retrieval time
- ✅ Backlink boost via graph evidence
- ✅ Type diversity cap (limits one entity type dominating results)
- ✅ Entity broadening to companies and projects
- ✅ Backward-compatible aliases for all renamed functions/types

---

## What's Not Working / Known Issues

1. **A/B comparison harness skipped** — `clite-ab-compare.test.ts` skips all 9 tests because it needs real compiled pages and a live LanceDB index; the harness exists but needs real data to run meaningfully

2. **LanceDB scope change requires reindex** — changing scope from `gbrain:people` to `gbrain:entities` means existing indexed entries won't be found by new queries; a migration/reindex step is needed for real-data testing

3. **Query expansion depends on async LLM** — expansion path depends on async LLM access; test with `expansion: false` to avoid confounds

4. **Global/shared LanceDB index** — test isolation requires careful cleanup to avoid index pollution between test runs

5. **Restart continuity still not fully solved** — upstream OpenClaw issue; not related to C-lite but noted in memory architecture notes

6. **Memory status cosmetic warning** — `memory-lancedb-pro` shows "unavailable" warning but plugin itself is healthy; cosmetic only

---

## What's Left (From Scope Doc)

### Remaining scope items (not yet done or partially done):
- **Ticket 2 (out of scope for v1):** Auto-linking hook (`put_page` post-hook to extract wiki links → triples) — skipped for v1
- **Real-data stress testing** (scope doc Ticket 2) — swap hardcoded Sarah/Acme fixtures for actual notes, test with real entity data

### Not in scope for C-lite v1:
- `deal`, `yc`, `civic`, `concept`, `source`, `media` entity types
- Meetings
- MCP/CLI surface changes
- Query routing changes beyond C-lite adapter

---

## Recent Commits

```
f7a4c7d feat: broaden C-lite to company + project entity types
bf3578a feat: topic-specific chunk rendering for embedding diversity
0c55330 feat: LLM query expansion via openai-codex OAuth (free)
c4a0bc1 feat: comparison harness for core vs clite search paths
40f7e45 fix: expansion forwarding, embedder reuse, and FTS5 keyword search
81b3f7a feat: knowledge graph layer — auto-link, typed relationships, graph-query (v0.10.3)
```

---

## Open Questions / Next Steps

1. **Real-data testing** — Next logical step. Reindex existing memory pages into `gbrain:entities` scope, run the A/B comparison harness with real content.

2. **Auto-linking hook** — The `put_page` post-hook that extracts wiki links and converts them to triples is out of scope for v1 but would complete the compiled-truth loop.

3. **Deal/entity types** — If Al wants mortgage-specific entities (deals, lenders, properties), those would be new types beyond the current scope.

4. **CLI/MCP surface** — Currently the C-lite is accessed via internal adapter; a direct CLI or MCP interface hasn't been discussed.

5. **Performance at scale** — All tests run against small demo data; behavior under hundreds of entities and thousands of triples is unknown.

---

*Review date: 2026-04-19 05:08 UTC | Max (primary) + Claude (reviewer)*