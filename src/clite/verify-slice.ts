/**
 * Verify the first C-lite slice (Sarah/Acme demo scenario).
 *
 * Runs a set of targeted checks against the database and filesystem,
 * returns a structured pass/warn/fail result, and persists the run
 * in verification_runs.
 *
 * Retrieval is explicitly NOT verified — it is reported as skipped/warned.
 */

import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hasEntriesForSlug } from './lance-store.ts';

// ── Types ───────────────────────────────────────────────────────────

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface VerifySliceResult {
  /** Overall status: 'passed' if all checks pass (warns allowed), 'failed' if any fail */
  overall: 'passed' | 'failed';
  checks: CheckResult[];
  /** Total number of checks */
  checksRun: number;
  /** Number of checks that passed */
  checksPass: number;
  /** Number of checks that warned */
  checksWarn: number;
  /** Number of checks that failed */
  checksFail: number;
}

// ── Slice config ────────────────────────────────────────────────────

/** First-slice entity slugs — hardcoded for the demo scenario. */
const SLICE = {
  personSlug: 'people/sarah-chen',
  companySlug: 'companies/acme-corp',
  worksAtPredicate: 'works_at',
} as const;

// ── Verification ────────────────────────────────────────────────────

/**
 * Verify the first C-lite slice.
 *
 * Checks:
 * 1. Sarah entity exists
 * 2. Acme entity exists
 * 3. At least one timeline event for Sarah
 * 4. An active works_at triple for Sarah → Acme
 * 5. Sarah page file exists at the given pagesDir
 * 6. Sarah freshness is not stale (i.e. compiled after last data change)
 * 7. LanceDB indexing: at least one entry exists for Sarah in the shared LanceDB
 *
 * @param db - C-lite SQLite database
 * @param pagesDir - root directory for compiled pages
 * @returns structured verification result (also persisted to verification_runs)
 */
export async function verifySlice(db: Database, pagesDir: string = 'pages'): Promise<VerifySliceResult> {
  const checks: CheckResult[] = [];

  // 1. Sarah entity exists
  const sarah = db.query('SELECT * FROM entities WHERE slug = ?').get(SLICE.personSlug) as any;
  checks.push(
    sarah
      ? { name: 'sarah-entity', status: 'pass', message: 'Sarah entity exists' }
      : { name: 'sarah-entity', status: 'fail', message: `Entity not found: ${SLICE.personSlug}` }
  );

  // 2. Acme entity exists
  const acme = db.query('SELECT * FROM entities WHERE slug = ?').get(SLICE.companySlug) as any;
  checks.push(
    acme
      ? { name: 'acme-entity', status: 'pass', message: 'Acme entity exists' }
      : { name: 'acme-entity', status: 'fail', message: `Entity not found: ${SLICE.companySlug}` }
  );

  // 3. At least one timeline event for Sarah
  const evtCount = (db.query(
    'SELECT COUNT(*) as c FROM timeline_events WHERE entity_slug = ?'
  ).get(SLICE.personSlug) as any)?.c ?? 0;
  checks.push(
    evtCount > 0
      ? { name: 'sarah-timeline', status: 'pass', message: `Sarah has ${evtCount} timeline event(s)` }
      : { name: 'sarah-timeline', status: 'fail', message: 'No timeline events for Sarah' }
  );

  // 4. Active works_at triple Sarah → Acme
  const worksAt = db.query(
    `SELECT * FROM triples
     WHERE subject_entity_slug = ? AND predicate = ? AND object_entity_slug = ?
       AND status = 'current' AND valid_to IS NULL
     LIMIT 1`
  ).get(SLICE.personSlug, SLICE.worksAtPredicate, SLICE.companySlug) as any;
  checks.push(
    worksAt
      ? { name: 'works-at-triple', status: 'pass', message: 'Active works_at triple exists' }
      : { name: 'works-at-triple', status: 'fail', message: 'No active works_at triple for Sarah → Acme' }
  );

  // 5. Sarah page file exists
  const pagePath = join(pagesDir, `${SLICE.personSlug}.md`);
  checks.push(
    existsSync(pagePath)
      ? { name: 'sarah-page-file', status: 'pass', message: `Page file exists at ${pagePath}` }
      : { name: 'sarah-page-file', status: 'fail', message: `Page file missing: ${pagePath}` }
  );

  // 6. Sarah freshness is not stale
  const freshness = db.query(
    'SELECT stale, freshness_reason FROM entity_freshness WHERE entity_slug = ?'
  ).get(SLICE.personSlug) as any;
  if (!freshness) {
    checks.push({ name: 'sarah-freshness', status: 'fail', message: 'No freshness row for Sarah' });
  } else if (freshness.stale === 1) {
    checks.push({
      name: 'sarah-freshness',
      status: 'fail',
      message: `Sarah is stale: ${freshness.freshness_reason || 'unknown reason'}`,
    });
  } else {
    checks.push({ name: 'sarah-freshness', status: 'pass', message: 'Sarah is fresh' });
  }

  // 7. LanceDB indexing: entry exists for Sarah in shared LanceDB
  let retrievalStatus: CheckStatus = 'fail';
  let retrievalMessage = '';
  try {
    const hasEntries = await hasEntriesForSlug(SLICE.personSlug);
    if (hasEntries) {
      retrievalStatus = 'pass';
      retrievalMessage = 'LanceDB indexing verified for Sarah';
    } else {
      retrievalMessage = 'No LanceDB entries found for Sarah (indexing not yet run)';
    }
  } catch (err) {
    retrievalMessage = `LanceDB check failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  checks.push({ name: 'retrieval-status', status: retrievalStatus, message: retrievalMessage });

  // ── Aggregate ─────────────────────────────────────────────────────
  const checksPass = checks.filter(c => c.status === 'pass').length;
  const checksWarn = checks.filter(c => c.status === 'warn').length;
  const checksFail = checks.filter(c => c.status === 'fail').length;
  const overall: 'passed' | 'failed' = checksFail === 0 ? 'passed' : 'failed';

  const result: VerifySliceResult = {
    overall,
    checks,
    checksRun: checks.length,
    checksPass,
    checksWarn,
    checksFail,
  };

  // ── Persist ───────────────────────────────────────────────────────
  persistVerificationRun(db, result);

  return result;
}

// ── Persistence ─────────────────────────────────────────────────────

function persistVerificationRun(db: Database, result: VerifySliceResult): void {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  db.prepare(
    `INSERT INTO verification_runs (status, checks_run, checks_pass, detail, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    result.overall,
    result.checksRun,
    result.checksPass,
    JSON.stringify(result.checks),
    now,
    now
  );
}

/**
 * Get the most recent verification run.
 */
export function getLatestVerificationRun(db: Database): any | null {
  return db.query(
    'SELECT * FROM verification_runs ORDER BY id DESC LIMIT 1'
  ).get() as any;
}
