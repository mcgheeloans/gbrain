import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { unlinkSync, rmSync } from 'node:fs';
import { bootstrap } from '../src/clite/bootstrap.ts';
import { ingestNote } from '../src/clite/ingest-note.ts';
import { compilePerson } from '../src/clite/compile-person.ts';
import { operationsByName } from '../src/core/operations.ts';

const TEST_DB = '/tmp/gbrain-clite-query-op.db';
const PAGES_DIR = '/tmp/gbrain-clite-query-op-pages';
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

describe('clite query operation adapter', () => {
  test('query operation can route through clite backend', async () => {
    if (!process.env.JINA_API_KEY) {
      expect(true).toBe(true);
      return;
    }

    const { db } = bootstrap(TEST_DB);
    ingestNote(db, DEMO_NOTE);
    await compilePerson(db, 'people/sarah-chen', PAGES_DIR);
    db.close();

    const op = operationsByName.query;
    const results = await op.handler({
      engine: {} as any,
      config: {
        engine: 'pglite',
        query_backend: 'clite',
        clite_database_path: TEST_DB,
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: false,
    }, {
      query: 'Who is Sarah Chen\'s employer?',
      limit: 5,
      expand: true,
    }) as any[];

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.slug).toBe('people/sarah-chen');
    expect(results[0]!.title).toBe('Sarah Chen');
    expect(results[0]!.chunk_source).toBe('compiled_truth');
  });
});
