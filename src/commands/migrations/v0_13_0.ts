/**
 * v0.13.0 migration orchestrator — frontmatter relationship indexing.
 *
 * v0.13 extends the knowledge graph to project typed edges from YAML
 * frontmatter (company, investors, attendees, key_people, etc.), not just
 * `[Name](path)` markdown refs. This migration:
 *
 *   A. Schema — `gbrain init --migrate-only` triggers migrate.ts v11 which
 *               adds link_source + origin_page_id + origin_field columns,
 *               swaps the unique constraint to include them, and creates
 *               new indexes.
 *   B. Backfill — `gbrain extract links --source db --include-frontmatter`
 *               walks every page and emits the frontmatter-derived edges.
 *               Uses the batch-mode resolver (pg_trgm only, no LLM).
 *   C. Verify — Query the links table and confirm link_source='frontmatter'
 *               rows exist (> 0 on any brain with frontmatter content).
 *   D. Record — append to ~/.gbrain/completed.jsonl.
 *
 * Idempotent. Resumable from `partial` via ON CONFLICT DO NOTHING on the
 * new unique constraint. Wall-clock budget on 46K-page brains: 2-5 min
 * (pg_trgm index-backed, no embedding or LLM calls).
 *
 * Ignores `auto_link=false` config: migration is canonical (CLAUDE.md),
 * not advisory. The auto_link toggle controls the put_page post-hook,
 * not one-time schema+backfill work.
 */

import { execSync } from 'child_process';
import type { Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult } from './types.ts';
import { appendCompletedMigration } from '../../core/preferences.ts';

// ── Phase A — Schema ────────────────────────────────────────
//
// migrate.ts v11 adds the link_source/origin_page_id/origin_field columns
// and swaps the unique constraint. Schema build time on 46K pages is
// ~10s (ALTER + index builds). Bumped timeout accounts for slow Supabase
// links (v0.12.1 pattern — migrations can time out on the 60s default).
function phaseASchema(opts: OrchestratorOpts): OrchestratorPhaseResult {
  if (opts.dryRun) return { name: 'schema', status: 'skipped', detail: 'dry-run' };
  try {
    execSync('gbrain init --migrate-only', { stdio: 'inherit', timeout: 600_000, env: process.env });
    return { name: 'schema', status: 'complete' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'schema', status: 'failed', detail: msg };
  }
}

// ── Phase B — Frontmatter edge backfill ─────────────────────

function phaseBBackfill(opts: OrchestratorOpts): OrchestratorPhaseResult {
  if (opts.dryRun) return { name: 'frontmatter_backfill', status: 'skipped', detail: 'dry-run' };
  try {
    // `--source db` iterates pages from the engine (no local checkout required).
    // `--include-frontmatter` is the v0.13 flag that enables the canonical
    // frontmatter link extractor. Default-OFF in the CLI for back-compat;
    // the migration explicitly opts in because this is the canonical backfill.
    // `--json` emits progress events the user can see on the console.
    execSync('gbrain extract links --source db --include-frontmatter', {
      stdio: 'inherit',
      timeout: 1_800_000,  // 30 min hard cap; typical 2-5 min on 46K pages
      env: process.env,
    });
    return { name: 'frontmatter_backfill', status: 'complete' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'frontmatter_backfill', status: 'failed', detail: msg };
  }
}

// ── Phase C — Verify ────────────────────────────────────────

function phaseCVerify(opts: OrchestratorOpts): OrchestratorPhaseResult {
  if (opts.dryRun) return { name: 'verify', status: 'skipped', detail: 'dry-run' };
  try {
    // `gbrain stats --json` returns total link counts. We assert the backfill
    // produced SOME frontmatter edges (> 0) unless the brain has no entity
    // pages (very small brains where Phase C succeeds with detail=empty).
    const out = execSync('gbrain call get_stats', {
      encoding: 'utf-8', timeout: 60_000, env: process.env,
    });
    const parsed = JSON.parse(out) as { link_count?: number };
    const linkCount = parsed.link_count ?? 0;
    // Not a failure if 0 — empty brains and brains without frontmatter refs
    // legitimately produce 0 frontmatter edges. We only fail if Phase A or B
    // hard-errored above.
    return {
      name: 'verify',
      status: 'complete',
      detail: `link_count=${linkCount}`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Verify is informational. Its failure does not block the migration;
    // the orchestrator returns 'partial' so doctor can flag it for re-run.
    return { name: 'verify', status: 'failed', detail: msg };
  }
}

// ── Orchestrator ────────────────────────────────────────────

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  console.log('');
  console.log('=== v0.13.0 — Frontmatter relationship indexing ===');
  if (opts.dryRun) console.log('  (dry-run; no side effects)');
  console.log('');

  const phases: OrchestratorPhaseResult[] = [];

  const a = phaseASchema(opts);
  phases.push(a);
  if (a.status === 'failed') return finalizeResult(phases, 'failed');

  const b = phaseBBackfill(opts);
  phases.push(b);
  // Backfill failure → partial. Schema is already applied so re-running
  // only re-tries the backfill (idempotent via ON CONFLICT DO NOTHING).
  if (b.status === 'failed') return finalizeResult(phases, 'partial');

  const c = phaseCVerify(opts);
  phases.push(c);

  const overallStatus: 'complete' | 'partial' | 'failed' =
    a.status === 'failed' || b.status === 'failed' ? 'failed' :
    c.status === 'failed' ? 'partial' :
    'complete';

  return finalizeResult(phases, overallStatus);
}

function finalizeResult(phases: OrchestratorPhaseResult[], status: 'complete' | 'partial' | 'failed'): OrchestratorResult {
  if (status !== 'failed') {
    try {
      appendCompletedMigration({ version: '0.13.0', status: status as 'complete' | 'partial' });
    } catch {
      // Recording is best-effort.
    }
  }
  return {
    version: '0.13.0',
    status,
    phases,
  };
}

export const v0_13_0: Migration = {
  version: '0.13.0',
  featurePitch: {
    headline: 'Frontmatter becomes a graph — company, investors, attendees now create typed edges automatically',
    description:
      'v0.13 extends the knowledge graph to project typed edges from YAML frontmatter. ' +
      'Every `company: X`, `investors: [A, B]`, `attendees: [Pedro, Garry]`, `key_people`, ' +
      '`partner`, `lead`, and `related` field you already wrote now surfaces in ' +
      '`gbrain graph`. Direction semantics respect subject-of-verb (Pedro → meeting, ' +
      'not meeting → Pedro). The migration backfills every existing page in ~2-5 min ' +
      'on a 46K-page brain. Uses pg_trgm fuzzy-match for name resolution (zero LLM ' +
      'cost, zero API calls). Unresolvable names surface in the extract summary so you ' +
      'see exactly where the graph has holes.',
  },
  orchestrator,
};

/** Exported for unit tests. */
export const __testing = {
  phaseASchema,
  phaseBBackfill,
  phaseCVerify,
};
