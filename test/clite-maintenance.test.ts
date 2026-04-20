import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { bootstrap } from '../src/clite/bootstrap.ts';
import { insertTriple } from '../src/clite/triples.ts';
import {
  runAllMaintenance,
  markStaleProjections,
  findOrphanEntities,
  checkTripleConsistency,
  reportUnresolvedLinks,
} from '../src/clite/maintenance.ts';
import type { Database } from 'bun:sqlite';
import * as fs from 'fs';

const TEST_DB = '/tmp/gbrain-clite-maintenance-test.db';
let db: Database;

beforeEach(() => {
  try { fs.unlinkSync(TEST_DB); } catch {}
  const result = bootstrap(TEST_DB);
  db = result.db;
});

afterEach(() => {
  db.close();
  try { fs.unlinkSync(TEST_DB); } catch {}
});

describe('markStaleProjections', () => {
  test('marks entities where canonical is newer than projection', () => {
    db.exec("INSERT INTO entities (slug, type, title) VALUES ('people/alice', 'person', 'Alice')");
    db.exec(`
      INSERT INTO entity_freshness (entity_slug, compiled_updated_at, page_projected_at, stale)
      VALUES ('people/alice', '2026-04-20 10:00:00', '2026-04-19 10:00:00', 0)
    `);

    const result = markStaleProjections(db);
    expect(result.status).toBe('ok');
    expect(result.details.staleCount).toBe(1);

    const row = db.query("SELECT stale FROM entity_freshness WHERE entity_slug = 'people/alice'").get() as any;
    expect(row.stale).toBe(1);
  });

  test('skips entities where projection is up to date', () => {
    db.exec("INSERT INTO entities (slug, type, title) VALUES ('people/bob', 'person', 'Bob')");
    db.exec(`
      INSERT INTO entity_freshness (entity_slug, compiled_updated_at, page_projected_at, stale)
      VALUES ('people/bob', '2026-04-19 10:00:00', '2026-04-20 10:00:00', 0)
    `);

    const result = markStaleProjections(db);
    expect(result.status).toBe('ok');
    expect(result.details.staleCount).toBe(0);
  });

  test('skips already-stale entities', () => {
    db.exec("INSERT INTO entities (slug, type, title) VALUES ('people/carol', 'person', 'Carol')");
    db.exec(`
      INSERT INTO entity_freshness (entity_slug, compiled_updated_at, page_projected_at, stale)
      VALUES ('people/carol', '2026-04-20 10:00:00', '2026-04-19 10:00:00', 1)
    `);

    const result = markStaleProjections(db);
    expect(result.details.staleCount).toBe(0);
  });
});

describe('findOrphanEntities', () => {
  test('finds entities with no pages, triples, or freshness', () => {
    db.exec("INSERT INTO entities (slug, type, title) VALUES ('people/orphan', 'person', 'Orphan Annie')");

    const result = findOrphanEntities(db);
    expect(result.status).toBe('ok');
    expect(result.details.orphanCount).toBe(1);
    expect(result.details.orphans[0].slug).toBe('people/orphan');
  });

  test('does not flag entities with triples', () => {
    db.exec("INSERT INTO entities (slug, type, title) VALUES ('people/alive', 'person', 'Alive Person')");
    db.exec("INSERT INTO entities (slug, type, title) VALUES ('companies/acme', 'company', 'Acme')");
    insertTriple(db, { subjectSlug: 'people/alive', predicate: 'works_at', objectEntitySlug: 'companies/acme' });

    const result = findOrphanEntities(db);
    // 'alive' has triples, 'acme' has triples — neither is orphan
    const orphans = (result.details.orphans as any[]) || [];
    expect(orphans.every((o: any) => !['people/alive', 'companies/acme'].includes(o.slug))).toBe(true);
  });

  test('returns empty when no orphans exist', () => {
    const result = findOrphanEntities(db);
    expect(result.details.orphanCount).toBe(0);
  });
});

describe('checkTripleConsistency', () => {
  test('reports broken subject references', () => {
    db.exec("INSERT INTO entities (slug, type, title) VALUES ('companies/acme', 'company', 'Acme')");
    // Disable FK checks to insert a triple referencing a non-existent entity
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`
      INSERT INTO triples (subject_entity_slug, predicate, object_entity_slug, status, valid_from)
      VALUES ('people/ghost', 'works_at', 'companies/acme', 'current', datetime('now'))
    `);
    db.exec('PRAGMA foreign_keys = ON');

    const result = checkTripleConsistency(db);
    expect(result.status).toBe('ok');
    expect(result.details.brokenSubjectCount).toBe(1);
    expect(result.details.brokenSlugs).toContain('people/ghost');
  });

  test('reports clean when all references are valid', () => {
    db.exec("INSERT INTO entities (slug, type, title) VALUES ('people/alice', 'person', 'Alice')");
    db.exec("INSERT INTO entities (slug, type, title) VALUES ('companies/acme', 'company', 'Acme')");
    insertTriple(db, { subjectSlug: 'people/alice', predicate: 'works_at', objectEntitySlug: 'companies/acme' });

    const result = checkTripleConsistency(db);
    expect(result.details.brokenSubjectCount).toBe(0);
    expect(result.details.brokenObjectCount).toBe(0);
  });
});

describe('runAllMaintenance', () => {
  test('runs all tasks and returns results', () => {
    const results = runAllMaintenance(db);
    expect(results.length).toBe(4);
    expect(results.every(r => r.status === 'ok')).toBe(true);

    const taskNames = results.map(r => r.task);
    expect(taskNames).toContain('markStaleProjections');
    expect(taskNames).toContain('findOrphanEntities');
    expect(taskNames).toContain('checkTripleConsistency');
    expect(taskNames).toContain('reportUnresolvedLinks');
  });

  test('each result includes duration', () => {
    const results = runAllMaintenance(db);
    for (const r of results) {
      expect(typeof r.durationMs).toBe('number');
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
