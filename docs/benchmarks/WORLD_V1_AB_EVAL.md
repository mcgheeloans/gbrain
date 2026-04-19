# World-v1 A/B Eval Results

**Date:** 2026-04-19
**Queries:** 23 | **k:** 5
**Baseline:** `b964c31` (Phase 0a/0b/0c + bridge + projection status)

## Summary

| Metric | Core | C-lite | Delta |
|--------|------|--------|-------|
| Mean Precision@5 | 0.13 | 0.21 | +60% |
| Mean Recall@5 | 0.63 | 1.00 | +59% (perfect) |
| Mean MRR | 0.50 | 0.97 | +94% |
| Mean nDCG@5 | 0.53 | 0.98 | +85% |
| Top-1 Hits | 8/23 | 22/23 | +175% |

## Key findings

- C-lite dominates relationship queries ("where does X work", "who founded Y", "who invested in Z")
- Core's big weakness: returns the person when you asked for the company (person-entity match instead of graph resolution)
- Graph rerank at chunk level (without page-level double-boost) is sufficient and honest
- C-lite achieved perfect recall across all 23 queries

## Single miss

"who invested in Vox" → returned `noah-kapoor-15` (rank 1) instead of `fiona-moore-88` (rank 3)
- Noah's chunk: "active investor focused on developer tools" — strong keyword/vector match on "investor"
- Fiona's chunk: "advisor to Vox" — weaker vector match despite correct graph link
- Graph rerank boosted Fiona but not enough to overcome Noah's vector similarity gap

## Per-query breakdown

| Query | Expected | Core Top | C-lite Top | Core MRR | C-lite MRR |
|-------|----------|----------|------------|----------|------------|
| Adam Lee company | companies/forge-19 | ✅ | ✅ | 1.0 | 1.0 |
| where does Adam Lee work | companies/forge-19 | ❌ person | ✅ | 0 | 1.0 |
| Priya Zhang company | companies/zenith-27 | ❌ person | ✅ | 0.5 | 1.0 |
| where does Priya Zhang work | companies/zenith-27 | ❌ person | ✅ | 0 | 1.0 |
| Mia Park company | companies/iris-36 | ❌ person | ✅ | 0.5 | 1.0 |
| where does Mia Park work | companies/iris-36 | ❌ person | ✅ | 0.5 | 1.0 |
| Tina Lopez company | companies/quantum-7 | ❌ person | ✅ | 0 | 1.0 |
| where does Tina Lopez work | companies/quantum-7 | ❌ person | ✅ | 0 | 1.0 |
| Ulrich Johnson company | companies/quantum-7 | ✅ | ✅ | 1.0 | 1.0 |
| where does Ulrich Johnson work | companies/quantum-7 | ❌ person | ✅ | 0 | 1.0 |
| who founded Quantum | people/ulrich-johnson-7 | ❌ company | ✅ | 0 | 1.0 |
| founder of Quantum | people/ulrich-johnson-7 | ✅ | ✅ | 1.0 | 1.0 |
| employee at Quantum | people/tina-lopez-117 | ❌ company | ✅ | 0 | 1.0 |
| who founded Iris | people/mia-park-36 | ❌ company | ✅ | 0.5 | 1.0 |
| founder of Iris | people/mia-park-36 | ✅ | ✅ | 1.0 | 1.0 |
| who invested in Spire | wendy-hernandez-80, eric-martinez-93 | ❌ fiona | ✅ | 0.5 | 1.0 |
| who founded Forge | people/adam-lee-19 | ❌ company | ✅ | 0.5 | 1.0 |
| founder of Forge | people/adam-lee-19 | ✅ | ✅ | 1.0 | 1.0 |
| advisor to Forge | people/tara-jackson-173 | ❌ company | ✅ | 0.5 | 1.0 |
| who invested in Vox | people/fiona-moore-88 | ✅ | ❌ noah | 1.0 | 0.33 |
| who invested in Delta | people/david-zhang-83 | ✅ | ✅ | 1.0 | 1.0 |
| who founded Zenith | people/priya-zhang-27 | ❌ company | ✅ | 0 | 1.0 |
| founder of Zenith | people/priya-zhang-27 | ✅ | ✅ | 1.0 | 1.0 |

## Raw data

Full JSON output saved alongside this file in `eval/world-v1-qrels-sample.json`.
