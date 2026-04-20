/**
 * C-lite Adapter: public API surface for external callers.
 *
 * This module defines the thin adapter layer between external consumers
 * (MCP tools, CLI commands, agents) and the C-lite internals.
 *
 * ## Design rules
 *
 * 1. This module RE-EXPORTS stable functions. It does NOT contain logic.
 * 2. External callers should import from this module, not from internals.
 * 3. If logic grows beyond delegation, it belongs in a dedicated module,
 *    not in the adapter.
 * 4. The adapter should never contain search/ranking logic — that lives
 *    in retrieve-person.ts and its successors.
 * 5. When retrieve-person gets split into stages, the adapter's surface
 *    stays the same; only the internal wiring changes.
 *
 * ## Current surface
 *
 * - search(query, opts) → page-level results
 * - searchChunks(query, opts) → chunk-level results
 * - ingestNote(db, text) → canonical writes
 * - bridge(db, input, opts) → canonical + projection
 * - isEntitySlug(slug) → routing decision
 * - getStaleProjections(db) → health check
 *
 * ## Maximum complexity
 *
 * If this file exceeds ~100 lines of actual code (not comments/exports),
 * something is wrong. Logic should live in the modules it delegates to.
 */

// ── Search ────────────────────────────────────────────────────────────

export { retrieveEntityPages as search, retrieveEntityChunks as searchChunks } from './retrieve-person.ts';
export type { RetrievedEntityPage, RetrievedEntityChunk } from './retrieve-person.ts';

// ── Ingest ────────────────────────────────────────────────────────────

export { ingestNote } from './ingest-note.ts';

// ── Bridge ────────────────────────────────────────────────────────────

export { bridge, commitCanonical, commitAndProject, isEntitySlug } from './bridge.ts';
export type { BridgeInput, BridgeResult, BridgeOptions, BridgeEntityInput, BridgeTripleInput, BridgeTimelineInput } from './bridge.ts';

// ── Health ────────────────────────────────────────────────────────────

export { getStaleProjections, recomputeFreshness } from './freshness.ts';
export type { ProjectionStaleness, FreshnessRow } from './freshness.ts';

// ── Maintenance ───────────────────────────────────────────────────────

export {
  runAllMaintenance,
  markStaleProjections,
  findOrphanEntities,
  checkTripleConsistency,
  reportUnresolvedLinks,
} from './maintenance.ts';
export type { MaintenanceResult } from './maintenance.ts';

// ── Graph queries ──────────────────────────────────────────────────────

export {
  traverseGraph,
  findPeopleLinkedToCompany,
  findCompaniesLinkedToPerson,
  parseTemporalFilter,
} from './graph-query.ts';
export type { GraphQuery, GraphTraversalResult, TemporalFilter } from './graph-query.ts';

// ── Bootstrap ─────────────────────────────────────────────────────────

export { bootstrap } from './bootstrap.ts';
