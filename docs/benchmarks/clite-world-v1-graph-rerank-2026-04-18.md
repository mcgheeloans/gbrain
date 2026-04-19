# C-lite world-v1 benchmark, graph-aware rerank

Date: 2026-04-18 America/Los_Angeles

## Summary

C-lite retrieval improved materially after adding graph-aware reranking for relationship queries.

The fix uses the SQLite canonical graph as a ranking signal:
- detect query intent, like founder, investor, advisor, employee, employer/company
- resolve mentioned entities from the `entities` table
- follow matching relationship predicates in `triples`
- strongly boost graph-linked candidate entities, lightly demote unrelated candidates

This addressed the main failure mode from earlier runs, where semantic similarity retrieved the right neighborhood but often ranked the wrong person first.

## Files changed

- `src/clite/retrieve-person.ts`
- `test/clite-retrieve.test.ts`

Commit:
- `82da1c9` — `feat: add graph-aware reranking for relationship queries`

## Validation

Focused retrieval test suite:
- command: `bun test test/clite-retrieve.test.ts`
- result: 9 pass, 0 fail

A regression test was added to verify that a founder query prefers the graph-linked person answer over a semantically similar but unrelated person.

## Eval dataset

Benchmark used the existing world-v1 sample eval flow with 23 relationship-oriented queries and k=5.

Representative query families:
- `who founded X`
- `founder of X`
- `who invested in X`
- `advisor to X`
- `employee at X`
- `where does PERSON work`
- `PERSON company`

## Results

### Core

- mean precision: `0.1304`
- mean recall: `0.6304`
- mean MRR: `0.5000`
- mean nDCG: `0.5292`
- top1 hits: `8`

### C-lite before graph-aware rerank

- mean precision: `0.2000`
- mean recall: `0.9565`
- mean MRR: `0.5507`
- mean nDCG: `0.6548`
- top1 hits: `6`

### C-lite after graph-aware rerank

- mean precision: `0.2087`
- mean recall: `1.0000`
- mean MRR: `0.9710`
- mean nDCG: `0.9783`
- top1 hits: `22`

## Notable improvements

These moved to correct top-1 after the graph-aware rerank:
- `who founded Quantum` → `people/ulrich-johnson-7`
- `founder of Forge` → `people/adam-lee-19`
- `advisor to Forge` → `people/tara-jackson-173`
- `who founded Iris` → `people/mia-park-36`
- `employee at Quantum` → `people/tina-lopez-117`
- `who founded Zenith` → `people/priya-zhang-27`

Company-affiliation style queries also remained strong:
- `where does Adam Lee work`
- `where does Priya Zhang work`
- `where does Ulrich Johnson work`

## Remaining weakness

One sampled investor-style case was still noisy:
- `who invested in Vox`

That means the new ranking is much better, but not perfect. The remaining likely work is narrower predicate-specific tuning for investor queries and/or stronger lexical tie-breaking around the mentioned company.

## Interpretation

This result supports the layered architecture decision:
- SQLite sidecar remains canonical truth
- LanceDB remains retrieval/index infrastructure
- graph facts should participate in ranking, not just storage

The important lesson is that vector retrieval alone was good at neighborhood recall, but relationship queries needed graph-aware reranking to reliably put the right entity first.
