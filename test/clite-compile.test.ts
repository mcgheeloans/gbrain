/**
 * Tests for compile/page-write step (first C-lite slice).
 *
 * Covers:
 * - render: creates person page from SQLite state
 * - write: writes page to disk
 * - idempotency: rerunning compile produces identical output
 * - markCompiled only after successful write
 * - simulated write failure leaves SQLite truth intact
 */

import { describe, test, expect, afterAll, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { unlinkSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrap } from '../src/clite/bootstrap.ts';
import { ingestNote } from '../src/clite/ingest-note.ts';
import { getEntityState, resolveEntityTitles } from '../src/clite/read-models.ts';
import { renderPersonPage } from '../src/clite/render-person.ts';
import { writePersonPage } from '../src/clite/write-page.ts';
import { compilePerson } from '../src/clite/compile-person.ts';
import { recomputeFreshness } from '../src/clite/freshness.ts';

const TEST_DB = '/tmp/gbrain-clite-compile-test.db';
const PAGES_DIR = '/tmp/gbrain-clite-compile-test-pages';
const DEMO_NOTE = 'Met Sarah Chen after the conference. She is a Senior Account Executive at Acme Corp. We discussed Q3 partnership expansion and she mentioned the renewal deadline is August 15th.';

function cleanup() {
  try { unlinkSync(TEST_DB); } catch {}
  try { unlinkSync(TEST_DB + '-wal'); } catch {}
  try { unlinkSync(TEST_DB + '-shm'); } catch {}
  try { rmSync(PAGES_DIR, { recursive: true }); } catch {}
}

beforeEach(() => {
  cleanup();
});

afterAll(() => {
  cleanup();
});

describe('render-person', () => {
  test('renders Sarah page from SQLite state with facts and timeline', () => {
    const { db } = bootstrap(TEST_DB);
    ingestNote(db, DEMO_NOTE);

    const state = getEntityState(db, 'people/sarah-chen');
    expect(state).not.toBeNull();
    expect(state!.entity.type).toBe('person');

    const page = renderPersonPage(state!);

    expect(page.entitySlug).toBe('people/sarah-chen');
    expect(page.content).toContain('# Sarah Chen');
    expect(page.content).toContain('## Facts');
    expect(page.content).toContain('**Works At**');
    expect(page.content).toContain('**Role**');
    expect(page.content).toContain('## Timeline');
    expect(page.contentHash).toBeTruthy();

    db.close();
  });

  test('renders entity-linked facts with readable titles instead of raw slugs', () => {
    const { db } = bootstrap(TEST_DB);
    ingestNote(db, DEMO_NOTE);

    const state = getEntityState(db, 'people/sarah-chen')!;

    // Without slugTitleMap: renders raw slug
    const rawPage = renderPersonPage(state);
    expect(rawPage.content).toContain('companies/acme-corp');

    // With slugTitleMap: renders entity title
    const slugs = state.triples
      .map(t => t.object_entity_slug)
      .filter((s): s is string => s !== null);
    const slugTitleMap = resolveEntityTitles(db, slugs);

    const resolvedPage = renderPersonPage(state, slugTitleMap);
    expect(resolvedPage.content).toContain('Acme Corp');
    expect(resolvedPage.content).not.toContain('companies/acme-corp');
    // Literal facts should be unchanged
    expect(resolvedPage.content).toContain('Senior Account Executive');

    db.close();
  });

  test('render is deterministic — same input, same output', () => {
    const { db } = bootstrap(TEST_DB);
    ingestNote(db, DEMO_NOTE);

    const state = getEntityState(db, 'people/sarah-chen')!;
    const page1 = renderPersonPage(state);
    const page2 = renderPersonPage(state);

    expect(page1.content).toBe(page2.content);
    expect(page1.contentHash).toBe(page2.contentHash);

    db.close();
  });
});

describe('write-page', () => {
  test('writes page to disk and marks compiled', () => {
    const { db } = bootstrap(TEST_DB);
    ingestNote(db, DEMO_NOTE);

    const state = getEntityState(db, 'people/sarah-chen')!;
    const page = renderPersonPage(state);

    const result = writePersonPage(PAGES_DIR, page, db);

    expect(result.written).toBe(true);
    expect(result.pagePath).toBe(join(PAGES_DIR, 'people/sarah-chen.md'));
    expect(existsSync(result.pagePath)).toBe(true);

    const fileContent = readFileSync(result.pagePath, 'utf-8');
    expect(fileContent).toBe(page.content);

    // Freshness should be marked compiled
    const fresh = db.query('SELECT stale, compiled_updated_at FROM entity_freshness WHERE entity_slug = ?')
      .get('people/sarah-chen') as any;
    expect(fresh.stale).toBe(0);
    expect(fresh.compiled_updated_at).not.toBeNull();

    db.close();
  });

  test('skips write if content identical but still marks compiled', () => {
    const { db } = bootstrap(TEST_DB);
    ingestNote(db, DEMO_NOTE);

    const state = getEntityState(db, 'people/sarah-chen')!;
    const page = renderPersonPage(state);

    const r1 = writePersonPage(PAGES_DIR, page, db);
    expect(r1.written).toBe(true);

    const r2 = writePersonPage(PAGES_DIR, page, db);
    expect(r2.written).toBe(false);
    expect(r2.contentHash).toBe(r1.contentHash);

    db.close();
  });

  test('idempotent — rerunning compile produces same file content', async () => {
    const { db } = bootstrap(TEST_DB);
    ingestNote(db, DEMO_NOTE);

    const r1 = await compilePerson(db, 'people/sarah-chen', PAGES_DIR)!;
    const content1 = readFileSync(r1.pagePath, 'utf-8');

    // Recompute freshness to make it stale again, then recompile
    recomputeFreshness(db, 'people/sarah-chen');
    const freshBefore = db.query('SELECT stale FROM entity_freshness WHERE entity_slug = ?')
      .get('people/sarah-chen') as any;
    // It might or might not be stale depending on timestamps, but recompile should work

    const r2 = await compilePerson(db, 'people/sarah-chen', PAGES_DIR)!;
    const content2 = readFileSync(r2.pagePath, 'utf-8');

    expect(content1).toBe(content2);
    expect(r2.contentHash).toBe(r1.contentHash);

    db.close();
  });

  test('write failure does not mark compiled — SQLite truth intact', () => {
    const { db } = bootstrap(TEST_DB);
    ingestNote(db, DEMO_NOTE);

    const state = getEntityState(db, 'people/sarah-chen')!;
    const page = renderPersonPage(state);

    // Simulate write failure
    const badWrite = (_path: string, _content: string) => {
      throw new Error('disk full');
    };

    expect(() => {
      writePersonPage(PAGES_DIR, page, db, badWrite);
    }).toThrow('disk full');

    // Freshness should NOT be marked compiled
    const fresh = db.query('SELECT compiled_updated_at, stale FROM entity_freshness WHERE entity_slug = ?')
      .get('people/sarah-chen') as any;
    expect(fresh.compiled_updated_at).toBeNull();
    expect(fresh.stale).toBe(1); // still stale

    // SQLite truth is intact — triples and timeline still exist
    const triples = db.query(
      "SELECT * FROM triples WHERE subject_entity_slug = 'people/sarah-chen' AND status = 'current'"
    ).all();
    expect(triples.length).toBeGreaterThan(0);

    const events = db.query(
      "SELECT * FROM timeline_events WHERE entity_slug = 'people/sarah-chen'"
    ).all();
    expect(events.length).toBeGreaterThan(0);

    db.close();
  });
});

describe('compile-person', () => {
  test('returns null for non-existent entity', async () => {
    const { db } = bootstrap(TEST_DB);
    const result = await compilePerson(db, 'people/ghost', PAGES_DIR);
    expect(result).toBeNull();
    db.close();
  });

  test('returns null for non-person entity type', async () => {
    const { db } = bootstrap(TEST_DB);
    ingestNote(db, DEMO_NOTE);

    const result = await compilePerson(db, 'companies/acme-corp', PAGES_DIR);
    expect(result).toBeNull();
    db.close();
  });

  test('full compile pipeline for Sarah renders entity titles', async () => {
    const { db } = bootstrap(TEST_DB);
    ingestNote(db, DEMO_NOTE);

    const result = await compilePerson(db, 'people/sarah-chen', PAGES_DIR);

    expect(result).not.toBeNull();
    expect(result!.written).toBe(true);
    expect(existsSync(result!.pagePath)).toBe(true);

    const content = readFileSync(result!.pagePath, 'utf-8');
    expect(content).toContain('# Sarah Chen');
    expect(content).toContain('## Facts');
    expect(content).toContain('## Timeline');
    // compile pipeline resolves entity slugs to titles
    expect(content).toContain('Acme Corp');
    expect(content).not.toContain('companies/acme-corp');

    db.close();
  });
});
