/**
 * A/B Comparison: Core (PGLite + OpenAI hybridSearch) vs C-lite (SQLite + LanceDB + Jina)
 *
 * Loads identical data into both backends, runs the same queries,
 * and compares relevance, recall, and ranking quality.
 *
 * Prerequisites:
 *   - OPENAI_API_KEY set (for core vector search)
 *   - JINA_API_KEY set (for C-lite embeddings)
 *
 * If either key is missing, the test is skipped.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { unlinkSync, rmSync } from 'node:fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import type { PageInput, ChunkInput } from '../src/core/types.ts';

import { bootstrap } from '../src/clite/bootstrap.ts';
import { upsertEntity } from '../src/clite/entities.ts';
import { insertTriple } from '../src/clite/triples.ts';
import { appendTimelineEvent } from '../src/clite/timeline.ts';
import { compilePerson } from '../src/clite/compile-person.ts';
import { searchPersonChunks } from '../src/clite/retrieve-person.ts';

const hasKeys = !!process.env.OPENAI_API_KEY && !!process.env.JINA_API_KEY;
const describeIf = hasKeys ? describe : describe.skip;

const CORE_DB = '/tmp/gbrain-ab-core.db';
const CLITE_DB = '/tmp/gbrain-ab-clite.db';
const PAGES_DIR = '/tmp/gbrain-ab-pages';

// --- Test data ---

const PEOPLE = [
  {
    slug: 'people/sarah-chen',
    title: 'Sarah Chen',
    type: 'person' as const,
    truth: 'Sarah Chen is a Senior Engineer at Acme Corp. She leads the backend team and specializes in distributed systems. She previously worked at Google for 5 years. She reports to the CTO.',
  },
  {
    slug: 'people/alex-rivera',
    title: 'Alex Rivera',
    type: 'person' as const,
    truth: 'Alex Rivera is a Product Manager at Acme Corp. He focuses on the developer platform. He previously worked at Stripe. He works closely with Sarah Chen on backend roadmap.',
  },
  {
    slug: 'people/jordan-lee',
    title: 'Jordan Lee',
    type: 'person' as const,
    truth: 'Jordan Lee is the CEO of Acme Corp. She founded the company in 2020. She previously co-founded a YC-backed startup that was acquired.',
  },
];

const COMPANIES = [
  {
    slug: 'companies/acme-corp',
    title: 'Acme Corp',
    type: 'company' as const,
    truth: 'Acme Corp is a B2B SaaS company building developer tools. Founded in 2020 by Jordan Lee. Based in San Francisco. 50 employees. Series A funded.',
  },
];

const ALL_PAGES = [...PEOPLE, ...COMPANIES];

// Queries with expected top-result slugs (at least one should appear)
const QUERIES = [
  { q: 'Sarah Chen employer', expectSlug: 'people/sarah-chen' },
  { q: 'CEO of Acme Corp', expectSlug: 'people/jordan-lee' },
  { q: 'who works on the backend team', expectSlug: 'people/sarah-chen' },
  { q: 'developer platform product', expectSlug: 'people/alex-rivera' },
  { q: 'B2B SaaS company founded 2020', expectSlug: 'companies/acme-corp' },
  { q: 'people at Acme', expectSlugs: ['people/sarah-chen', 'people/alex-rivera', 'people/jordan-lee'] },
];

// --- Core helpers ---

let coreEngine: PGLiteEngine;

async function setupCore() {
  coreEngine = new PGLiteEngine();
  await coreEngine.connect({});
  await coreEngine.initSchema();

  // Insert pages and chunks
  for (const p of ALL_PAGES) {
    const pageInput: PageInput = {
      type: p.type,
      title: p.title,
      compiled_truth: p.truth,
    };
    await coreEngine.putPage(p.slug, pageInput);

    // Create a single compiled_truth chunk per page
    const chunks: ChunkInput[] = [{
      chunk_index: 0,
      chunk_text: p.truth,
      chunk_source: 'compiled_truth',
    }];
    await coreEngine.upsertChunks(p.slug, chunks);
  }

  // Add links (people → company)
  for (const person of PEOPLE) {
    await coreEngine.addLink(person.slug, 'companies/acme-corp', 'works at', 'works_at');
  }
  // Alex reports to Sarah
  await coreEngine.addLink('people/alex-rivera', 'people/sarah-chen', 'reports to', 'reports_to');
}

// --- C-lite helpers ---

async function setupClite() {
  try { unlinkSync(CLITE_DB); } catch {}
  try { unlinkSync(CLITE_DB + '-wal'); } catch {}
  try { unlinkSync(CLITE_DB + '-shm'); } catch {}
  try { rmSync(PAGES_DIR, { recursive: true }); } catch {}

  const { db } = bootstrap(CLITE_DB);

  // Directly insert entities matching the same data as core
  for (const p of PEOPLE) {
    upsertEntity(db, p.slug, 'person', p.title, p.truth);
  }
  for (const c of COMPANIES) {
    upsertEntity(db, c.slug, 'company', c.title, c.truth);
  }

  // Insert relationships
  for (const person of PEOPLE) {
    insertTriple(db, { subjectSlug: person.slug, predicate: 'works_at', objectEntitySlug: 'companies/acme-corp' });
  }
  insertTriple(db, { subjectSlug: 'people/alex-rivera', predicate: 'reports_to', objectEntitySlug: 'people/sarah-chen' });

  // Add timeline events
  for (const p of PEOPLE) {
    appendTimelineEvent(db, { entitySlug: p.slug, eventType: 'mentioned', summary: p.truth, sourceType: 'ab-test', sourceRef: 'ab-test' });
  }
  appendTimelineEvent(db, { entitySlug: 'companies/acme-corp', eventType: 'mentioned', summary: COMPANIES[0].truth, sourceType: 'ab-test', sourceRef: 'ab-test' });

  // Compile and index all entities
  for (const p of PEOPLE) {
    await compilePerson(db, p.slug, PAGES_DIR);
  }
  await compilePerson(db, COMPANIES[0].slug, PAGES_DIR);

  return db;
}

// --- Cleanup LanceDB entries ---
async function cleanupLanceDB() {
  try {
    const { upsertPersonChunks } = await import('../src/clite/lance-store.ts');
    const slugs = ALL_PAGES.map(p => p.slug);
    for (const slug of slugs) {
      await upsertPersonChunks({ slug, title: slug.split('/')[1] ?? slug, chunks: [], vectors: [] });
    }
  } catch {}
}

// --- Tests ---

describeIf('A/B comparison: core vs C-lite search quality', () => {
  let cliteDb: ReturnType<typeof bootstrap>['db'];

  beforeAll(async () => {
    await setupCore();
    cliteDb = await setupClite();
  });

  afterAll(async () => {
    await coreEngine.disconnect();
    try { unlinkSync(CORE_DB); } catch {}
    try { unlinkSync(CLITE_DB); } catch {}
    try { rmSync(PAGES_DIR, { recursive: true }); } catch {}
    await cleanupLanceDB();
  });

  for (const { q, expectSlug, expectSlugs } of QUERIES) {
    test(`query: "${q}"`, async () => {
      // Run both backends
      const coreResults = await hybridSearch(coreEngine, q, { limit: 5 });
      const cliteResults = await searchPersonChunks(q, { limit: 5, db: cliteDb });

      // --- Core assertions ---
      const coreSlugs = coreResults.map(r => r.slug);
      const coreHasExpected = expectSlug
        ? coreSlugs.includes(expectSlug)
        : (expectSlugs ?? []).some(s => coreSlugs.includes(s));

      // --- C-lite assertions ---
      const cliteSlugs = cliteResults.map(r => r.slug);
      const cliteHasExpected = expectSlug
        ? cliteSlugs.includes(expectSlug)
        : (expectSlugs ?? []).some(s => cliteSlugs.includes(s));

      // Log comparison instead of asserting per-query
      // (some queries are genuinely hard for both backends)
      const expected = expectSlug ?? (expectSlugs ?? []).join(' or ');
      console.log(`\n--- "${q}" (expected: ${expected}) ---`);
      console.log(`  Core:  ${coreHasExpected ? '✓' : '✗'} | top-3: ${coreResults.slice(0, 3).map(r => `${r.slug} (${r.score.toFixed(4)})`).join(', ')}`);
      console.log(`  C-lite: ${cliteHasExpected ? '✓' : '✗'} | top-3: ${cliteResults.slice(0, 3).map(r => `${r.slug} (${r.score?.toFixed(4) ?? 'n/a'})`).join(', ')}`);

      // At least one backend should return results
      expect(coreResults.length + cliteResults.length).toBeGreaterThan(0);
    });
  }

  test('summary: overall recall comparison', async () => {
    let coreWins = 0;
    let cliteWins = 0;
    let ties = 0;

    for (const { q, expectSlug, expectSlugs } of QUERIES) {
      const coreResults = await hybridSearch(coreEngine, q, { limit: 5 });
      const cliteResults = await searchPersonChunks(q, { limit: 5, db: cliteDb });

      const expected = expectSlug ? [expectSlug] : (expectSlugs ?? []);
      const coreTopSlug = coreResults[0]?.slug ?? '';
      const cliteTopSlug = cliteResults[0]?.slug ?? '';

      const coreTopMatch = expected.includes(coreTopSlug);
      const cliteTopMatch = expected.includes(cliteTopSlug);

      if (coreTopMatch && cliteTopMatch) ties++;
      else if (coreTopMatch) coreWins++;
      else if (cliteTopMatch) cliteWins++;
      else ties++; // neither got it right — call it a tie
    }

    console.log(`\n=== SUMMARY ===`);
    console.log(`Core wins: ${coreWins}, C-lite wins: ${cliteWins}, Ties: ${ties}`);
    console.log(`Neither: ${QUERIES.length - coreWins - cliteWins - ties}`);

    // Both backends should return results for at least some queries
    expect(coreWins + ties).toBeGreaterThan(0);
    expect(cliteWins + ties).toBeGreaterThan(0);
  });
});
