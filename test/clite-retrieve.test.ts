import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { unlinkSync, rmSync } from 'node:fs';
import { bootstrap } from '../src/clite/bootstrap.ts';
import { ingestNote } from '../src/clite/ingest-note.ts';
import { compilePerson } from '../src/clite/compile-person.ts';
import { retrievePersonChunks, searchPersonChunks, retrievePersonPages } from '../src/clite/retrieve-person.ts';
import { upsertEntity } from '../src/clite/entities.ts';
import { insertTriple } from '../src/clite/triples.ts';
const SHARED_SCOPE = 'gbrain:people';

const TEST_DB = '/tmp/gbrain-clite-retrieve-test.db';
const PAGES_DIR = '/tmp/gbrain-clite-retrieve-test-pages';
const DEMO_NOTE = 'Met Sarah Chen after the conference. She is a Senior Account Executive at Acme Corp. We discussed Q3 partnership expansion and she mentioned the renewal deadline is August 15th.';

async function cleanupAsync() {
  try { unlinkSync(TEST_DB); } catch {}
  try { unlinkSync(TEST_DB + '-wal'); } catch {}
  try { unlinkSync(TEST_DB + '-shm'); } catch {}
  try { rmSync(PAGES_DIR, { recursive: true }); } catch {}
  if (process.env.JINA_API_KEY) {
    try {
      const { upsertPersonChunks } = await import('../src/clite/lance-store.ts');
      await upsertPersonChunks({ slug: 'people/sarah-chen', title: 'Sarah Chen', chunks: [], vectors: [] });
      await upsertPersonChunks({ slug: 'companies/acme-corp', title: 'Acme Corp', chunks: [], vectors: [] });
    } catch {}
  }
}

beforeEach(async () => {
  await cleanupAsync();
});

afterAll(async () => {
  await cleanupAsync();
});

describe('retrieve-person', () => {
  test('returns indexed compiled chunks for a relevant query', async () => {
    if (!process.env.JINA_API_KEY) {
      expect(true).toBe(true);
      return;
    }

    const { db } = bootstrap(TEST_DB);
    ingestNote(db, DEMO_NOTE);
    await compilePerson(db, 'people/sarah-chen', PAGES_DIR);

    const results = await retrievePersonChunks('Where does Sarah Chen work?', { limit: 3 });

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.slug === 'people/sarah-chen')).toBe(true);
    expect(results.some((r) => r.title === 'Sarah Chen')).toBe(true);
    expect(results.some((r) => /Acme Corp|Senior Account Executive|Sarah Chen/.test(r.text))).toBe(true);

    db.close();
  });

  test('hybrid chunk search ranks compiled truth hits for a relevant query', async () => {
    if (!process.env.JINA_API_KEY) {
      expect(true).toBe(true);
      return;
    }

    const { db } = bootstrap(TEST_DB);
    ingestNote(db, DEMO_NOTE);
    await compilePerson(db, 'people/sarah-chen', PAGES_DIR);

    const results = await searchPersonChunks('Sarah Chen Acme Corp partnership', { limit: 5 });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.slug).toBe('people/sarah-chen');
    expect(results.some((r) => r.chunkSource === 'compiled_truth')).toBe(true);
    expect((results[0]!.score ?? 0)).toBeGreaterThan(0);
    expect(results.every((r) => typeof r.score === 'number')).toBe(true);

    db.close();
  });

  test('hybrid chunk search caps chunks per page and keeps compiled truth represented', async () => {
    if (!process.env.JINA_API_KEY) {
      expect(true).toBe(true);
      return;
    }

    const { db } = bootstrap(TEST_DB);
    ingestNote(db, DEMO_NOTE);
    await compilePerson(db, 'people/sarah-chen', PAGES_DIR);

    const results = await searchPersonChunks('Sarah Chen Acme Corp August 15 partnership expansion', { limit: 8 });
    const sarahResults = results.filter((r) => r.slug === 'people/sarah-chen');

    expect(sarahResults.length).toBeLessThanOrEqual(2);
    expect(sarahResults.some((r) => r.chunkSource === 'compiled_truth')).toBe(true);

    db.close();
  });

  test('backlink boost uses graph evidence when db is provided', async () => {
    if (!process.env.JINA_API_KEY) {
      expect(true).toBe(true);
      return;
    }

    const { db } = bootstrap(TEST_DB);
    ingestNote(db, DEMO_NOTE);
    upsertEntity(db, 'people/alex-rivera', 'person', 'Alex Rivera');
    upsertEntity(db, 'people/jordan-lee', 'person', 'Jordan Lee');
    insertTriple(db, { subjectSlug: 'people/alex-rivera', predicate: 'reports_to', objectEntitySlug: 'people/sarah-chen' });
    insertTriple(db, { subjectSlug: 'people/jordan-lee', predicate: 'works_with', objectEntitySlug: 'people/sarah-chen' });
    await compilePerson(db, 'people/sarah-chen', PAGES_DIR);

    const results = await searchPersonChunks('Sarah Chen Acme Corp partnership', { limit: 5, db });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.slug).toBe('people/sarah-chen');
    expect((results[0]!.score ?? 0)).toBeGreaterThan(0);

    db.close();
  });

  test('type diversity cap limits domination by one entity type', async () => {
    if (!process.env.JINA_API_KEY) {
      expect(true).toBe(true);
      return;
    }

    const { db } = bootstrap(TEST_DB);
    ingestNote(db, DEMO_NOTE);
    await compilePerson(db, 'people/sarah-chen', PAGES_DIR);

    const { getSharedTable } = await import('../src/clite/lance-store.ts');
    const table = await getSharedTable();
    const now = Date.now();
    await table.add([
      {
        id: 'companies/acme-corp:0',
        text: 'Acme Corp is the company where Sarah Chen works and manages partnerships.',
        vector: new Array(1024).fill(0.001),
        category: 'entity',
        scope: SHARED_SCOPE,
        importance: 0.7,
        timestamp: now,
        metadata: JSON.stringify({ slug: 'companies/acme-corp', title: 'Acme Corp', entity_type: 'company', chunk_index: 0, chunk_source: 'compiled_truth', source: 'test' }),
      },
      {
        id: 'companies/acme-corp:1',
        text: 'Acme Corp partnership planning includes Sarah Chen account leadership.',
        vector: new Array(1024).fill(0.001),
        category: 'entity',
        scope: SHARED_SCOPE,
        importance: 0.7,
        timestamp: now,
        metadata: JSON.stringify({ slug: 'companies/acme-corp', title: 'Acme Corp', entity_type: 'company', chunk_index: 1, chunk_source: 'compiled_truth', source: 'test' }),
      },
    ]);

    const results = await searchPersonChunks('Sarah Chen Acme Corp partnership', { limit: 5, db });
    const types = new Set(results.map((r) => r.entityType));

    expect(results.length).toBeGreaterThan(0);
    expect(types.has('person')).toBe(true);
    expect(types.has('company')).toBe(true);

    db.close();
  });

  test('query expansion helps alternate phrasing match compiled content', async () => {
    if (!process.env.JINA_API_KEY) {
      expect(true).toBe(true);
      return;
    }

    const { db } = bootstrap(TEST_DB);
    ingestNote(db, DEMO_NOTE);
    await compilePerson(db, 'people/sarah-chen', PAGES_DIR);

    const withoutExpansion = await searchPersonChunks('Who is Sarah Chen\'s employer?', {
      limit: 5,
      db,
      expansion: false,
    });
    const withExpansion = await searchPersonChunks('Who is Sarah Chen\'s employer?', {
      limit: 5,
      db,
      expansion: true,
    });

    expect(withExpansion.length).toBeGreaterThan(0);
    expect(withExpansion.some((r) => r.slug === 'people/sarah-chen')).toBe(true);
    expect(withExpansion.length).toBeGreaterThanOrEqual(withoutExpansion.length);

    db.close();
  });

  test('returns fused page-level results for a relevant query', async () => {
    if (!process.env.JINA_API_KEY) {
      expect(true).toBe(true);
      return;
    }

    const { db } = bootstrap(TEST_DB);
    ingestNote(db, DEMO_NOTE);
    await compilePerson(db, 'people/sarah-chen', PAGES_DIR);

    const results = await retrievePersonPages('Where does Sarah Chen work?', { limit: 3, db });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.slug).toBe('people/sarah-chen');
    expect(results[0]!.title).toBe('Sarah Chen');
    expect(results[0]!.chunkCount).toBeGreaterThan(0);
    expect(results[0]!.snippets.length).toBeGreaterThan(0);
    expect(results[0]!.snippets.some((s) => /Acme Corp|Senior Account Executive|Sarah Chen/.test(s))).toBe(true);

    db.close();
  });

  test('returns empty array for blank query', async () => {
    const chunkResults = await retrievePersonChunks('   ');
    expect(chunkResults).toEqual([]);

    const pageResults = await retrievePersonPages('   ');
    expect(pageResults).toEqual([]);
  });
});
