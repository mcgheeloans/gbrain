/**
 * C-lite maintenance and background job support.
 *
 * Phase 7 decision: C-lite does NOT implement its own job queue or minion system.
 * Instead, it exposes maintenance tasks as callable functions that can be wired into
 * OpenClaw's native cron/heartbeat infrastructure.
 *
 * Rationale:
 * - Upstream gbrain uses a Postgres-native minion system (pg_notify, LISTEN/NOTIFY,
 *   advisory locks, worker processes). C-lite runs on SQLite + LanceDB, so porting
 *   that system would require reimplementing Postgres primitives in SQLite.
 * - OpenClaw already has cron jobs, heartbeat tasks, and session-based work.
 *   Delegating to OpenClaw's infrastructure avoids duplication and keeps C-lite
 *   focused on its core competency: entity storage, retrieval, and graph queries.
 * - The maintenance tasks here are designed to be idempotent and safe to run
 *   concurrently (SQLite WAL mode allows reads during writes).
 */

import type { Database } from 'bun:sqlite';

// ── Maintenance task types ──────────────────────────────────────────

export interface MaintenanceResult {
  task: string;
  status: 'ok' | 'skipped' | 'error';
  details: Record<string, unknown>;
  durationMs: number;
}

// ── Stale projection cleanup ─────────────────────────────────────────

/**
 * Mark entity projections as stale if their canonical page was updated
 * more recently than the last successful projection.
 *
 * Returns count of entities marked stale.
 */
export function markStaleProjections(db: Database): MaintenanceResult {
  const start = performance.now();

  try {
    // Mark entities stale if compiled canonical was updated after last projection
    const result = db.prepare(`
      UPDATE entity_freshness
      SET stale = 1,
          freshness_reason = 'compiled updated after projection'
      WHERE stale = 0
        AND compiled_updated_at IS NOT NULL
        AND (page_projected_at IS NULL OR page_projected_at < compiled_updated_at)
    `).run();

    return {
      task: 'markStaleProjections',
      status: 'ok',
      details: { staleCount: result.changes },
      durationMs: performance.now() - start,
    };
  } catch (e: any) {
    return {
      task: 'markStaleProjections',
      status: 'error',
      details: { error: e.message },
      durationMs: performance.now() - start,
    };
  }
}

// ── Orphan entity cleanup ────────────────────────────────────────────

/**
 * Find entities that have no pages, no triples, and no chunks.
 * These are typically created by failed imports or abandoned workflows.
 *
 * Does NOT delete — just reports. Deletion should be explicit.
 */
export function findOrphanEntities(db: Database): MaintenanceResult {
  const start = performance.now();

  try {
    const orphans = db.query(`
      SELECT e.slug, e.type, e.title
      FROM entities e
      WHERE NOT EXISTS (SELECT 1 FROM timeline_events te WHERE te.entity_slug = e.slug)
        AND NOT EXISTS (SELECT 1 FROM triples t WHERE t.subject_entity_slug = e.slug OR t.object_entity_slug = e.slug)
        AND NOT EXISTS (SELECT 1 FROM entity_freshness ef WHERE ef.entity_slug = e.slug)
    `).all() as Array<{ slug: string; type: string; title: string }>;

    return {
      task: 'findOrphanEntities',
      status: 'ok',
      details: {
        orphanCount: orphans.length,
        orphans: orphans.slice(0, 20), // cap at 20 for log safety
      },
      durationMs: performance.now() - start,
    };
  } catch (e: any) {
    return {
      task: 'findOrphanEntities',
      status: 'error',
      details: { error: e.message },
      durationMs: performance.now() - start,
    };
  }
}

// ── Triple consistency check ─────────────────────────────────────────

/**
 * Verify that triples reference valid entities. Reports broken references.
 */
export function checkTripleConsistency(db: Database): MaintenanceResult {
  const start = performance.now();

  try {
    const brokenSubjects = db.query(`
      SELECT DISTINCT t.subject_entity_slug as slug
      FROM triples t
      WHERE t.subject_entity_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.slug = t.subject_entity_slug)
      LIMIT 100
    `).all() as Array<{ slug: string }>;

    const brokenObjects = db.query(`
      SELECT DISTINCT t.object_entity_slug as slug
      FROM triples t
      WHERE t.object_entity_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.slug = t.object_entity_slug)
      LIMIT 100
    `).all() as Array<{ slug: string }>;

    const brokenSubjectsSet = new Set(brokenSubjects.map(r => r.slug));
    for (const r of brokenObjects) brokenSubjectsSet.add(r.slug);

    return {
      task: 'checkTripleConsistency',
      status: 'ok',
      details: {
        brokenSubjectCount: brokenSubjects.length,
        brokenObjectCount: brokenObjects.length,
        brokenSlugs: [...brokenSubjectsSet].slice(0, 20),
      },
      durationMs: performance.now() - start,
    };
  } catch (e: any) {
    return {
      task: 'checkTripleConsistency',
      status: 'error',
      details: { error: e.message },
      durationMs: performance.now() - start,
    };
  }
}

// ── Unresolved link report ───────────────────────────────────────────

/**
 * Report unresolved frontmatter links that couldn't be matched to entity slugs.
 */
export function reportUnresolvedLinks(db: Database): MaintenanceResult {
  const start = performance.now();

  try {
    // Count triples with unresolved frontmatter links in context
    const row = db.query(`
      SELECT COUNT(*) as cnt FROM triples
      WHERE context LIKE '%unresolved%'
    `).get() as { cnt: number } | null;

    return {
      task: 'reportUnresolvedLinks',
      status: 'ok',
      details: {
        unresolvedCount: row?.cnt ?? 0,
      },
      durationMs: performance.now() - start,
    };
  } catch (e: any) {
    return {
      task: 'reportUnresolvedLinks',
      status: 'error',
      details: { error: e.message },
      durationMs: performance.now() - start,
    };
  }
}

// ── Run all maintenance tasks ────────────────────────────────────────

/**
 * Run all maintenance tasks and return results.
 * Designed to be called from OpenClaw cron or heartbeat.
 *
 * Usage in OpenClaw cron:
 *   Task: "run clite maintenance on <db-path>"
 *   The agent reads this module, imports runAllMaintenance, and calls it.
 *
 * Usage in OpenClaw heartbeat:
 *   Add to HEARTBEAT.md:
 *     - Check C-lite DB health: run `bun -e "..." ` or call from session
 */
export function runAllMaintenance(db: Database): MaintenanceResult[] {
  return [
    markStaleProjections(db),
    findOrphanEntities(db),
    checkTripleConsistency(db),
    reportUnresolvedLinks(db),
  ];
}

// ── OpenClaw integration notes ───────────────────────────────────────

/**
 * OPENCLAW INTEGRATION GUIDE
 *
 * C-lite delegates all job scheduling and orchestration to OpenClaw.
 * Here's how to wire up each maintenance task:
 *
 * 1. STALE PROJECTION MARKING (every 5-15 minutes)
 *    OpenClaw cron job → session spawns → imports markStaleProjections → runs it
 *
 * 2. ORPHAN ENTITY CLEANUP (daily)
 *    OpenClaw cron job → reviews orphan report → asks for confirmation before delete
 *
 * 3. TRIPLE CONSISTENCY (weekly or on-demand)
 *    OpenClaw heartbeat or manual trigger → report → fix if needed
 *
 * 4. UNRESOLVED LINKS (after bulk imports)
 *    Triggered manually or after importFromContent completes
 *
 * Key principle: C-lite provides the functions. OpenClaw provides the scheduler.
 * No need to build a queue, worker pool, or governor inside C-lite.
 */
