import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { bootstrap } from '../src/clite/bootstrap.ts';
import { bridge, commitCanonical, commitAndProject, isEntitySlug } from '../src/clite/bridge.ts';
import type { BridgeInput } from '../src/clite/bridge.ts';
import { getEntityBySlug } from '../src/clite/entities.ts';
import { getTriplesForEntity } from '../src/clite/triples.ts';
import { getTimelineEvents } from '../src/clite/timeline.ts';
import type { Database } from 'bun:sqlite';

const TEST_DB = '/tmp/gbrain-clite-bridge-test.db';

function cleanup() {
  try { unlinkSync(TEST_DB); } catch {}
  try { unlinkSync(TEST_DB + '-wal'); } catch {}
  try { unlinkSync(TEST_DB + '-shm'); } catch {}
}

beforeEach(() => {
  cleanup();
});

afterAll(() => {
  cleanup();
});

function makeDb(): Database {
  return bootstrap(TEST_DB).db;
}

function emptyInput(): BridgeInput {
  return { entities: [], triples: [], timeline: [] };
}

describe('bridge', () => {
  // 1. Empty input returns early
  test('empty input returns early with committed=false and empty slugs', async () => {
    const db = makeDb();
    const result = await bridge(db, emptyInput());

    expect(result.canonical.committed).toBe(false);
    expect(result.canonical.entitySlugs).toEqual([]);
    expect(result.canonical.tripleCount).toBe(0);
    expect(result.canonical.timelineCount).toBe(0);
    expect(result.projections.compiled.attempted).toBe(false);
    expect(result.projections.retrieval.attempted).toBe(false);

    db.close();
  });

  // 2. Canonical commit with entities
  test('canonical commit with entities writes rows and sets committed=true', async () => {
    const db = makeDb();
    const input: BridgeInput = {
      entities: [
        { slug: 'people/alice', type: 'person', title: 'Alice Smith', summary: 'Engineer at Acme' },
        { slug: 'companies/acme', type: 'company', title: 'Acme Corp' },
      ],
      triples: [],
      timeline: [],
    };

    const result = await bridge(db, input);

    expect(result.canonical.committed).toBe(true);
    expect(result.canonical.entitySlugs).toContain('people/alice');
    expect(result.canonical.entitySlugs).toContain('companies/acme');

    const alice = getEntityBySlug(db, 'people/alice');
    expect(alice).not.toBeNull();
    expect(alice!.title).toBe('Alice Smith');
    expect(alice!.type).toBe('person');

    const acme = getEntityBySlug(db, 'companies/acme');
    expect(acme).not.toBeNull();
    expect(acme!.title).toBe('Acme Corp');

    db.close();
  });

  // 3. Canonical commit with triples
  test('canonical commit with triples writes rows and both slugs appear in affectedSlugs', async () => {
    const db = makeDb();
    // Pre-create entities so triples reference existing slugs
    const input: BridgeInput = {
      entities: [
        { slug: 'people/bob', type: 'person', title: 'Bob Jones' },
        { slug: 'companies/widgetco', type: 'company', title: 'WidgetCo' },
      ],
      triples: [
        { subjectSlug: 'people/bob', predicate: 'works_at', objectEntitySlug: 'companies/widgetco' },
      ],
      timeline: [],
    };

    const result = await bridge(db, input);

    expect(result.canonical.committed).toBe(true);
    expect(result.canonical.tripleCount).toBe(1);
    expect(result.canonical.entitySlugs).toContain('people/bob');
    expect(result.canonical.entitySlugs).toContain('companies/widgetco');

    const triples = getTriplesForEntity(db, 'people/bob', 'subject');
    expect(triples.length).toBe(1);
    expect(triples[0].predicate).toBe('works_at');
    expect(triples[0].object_entity_slug).toBe('companies/widgetco');

    db.close();
  });

  // 4. Canonical commit with timeline
  test('canonical commit with timeline appends events for existing entities', async () => {
    const db = makeDb();
    const input: BridgeInput = {
      entities: [
        { slug: 'people/carol', type: 'person', title: 'Carol White' },
      ],
      triples: [],
      timeline: [
        { entitySlug: 'people/carol', date: '2025-03-15', summary: 'Joined the team' },
      ],
    };

    const result = await bridge(db, input);

    expect(result.canonical.committed).toBe(true);
    expect(result.canonical.timelineCount).toBe(1);
    expect(result.canonical.entitySlugs).toContain('people/carol');

    const events = getTimelineEvents(db, 'people/carol');
    expect(events.length).toBe(1);
    expect(events[0].summary).toBe('Joined the team');
    expect(events[0].date).toBe('2025-03-15');

    db.close();
  });

  // 5. Full input: entities + triples + timeline
  test('full input commits entities, triples, and timeline in one call', async () => {
    const db = makeDb();
    const input: BridgeInput = {
      entities: [
        { slug: 'people/dave', type: 'person', title: 'Dave Lee' },
        { slug: 'companies/megacorp', type: 'company', title: 'MegaCorp' },
      ],
      triples: [
        { subjectSlug: 'people/dave', predicate: 'founded', objectEntitySlug: 'companies/megacorp' },
      ],
      timeline: [
        { entitySlug: 'people/dave', date: '2024-01-10', summary: 'Founded MegaCorp' },
      ],
      sourceRef: 'test-full-input',
    };

    const result = await bridge(db, input);

    expect(result.canonical.committed).toBe(true);
    expect(result.canonical.entitySlugs.length).toBeGreaterThanOrEqual(2);
    expect(result.canonical.tripleCount).toBe(1);
    expect(result.canonical.timelineCount).toBe(1);

    // Verify all three are in the DB
    expect(getEntityBySlug(db, 'people/dave')).not.toBeNull();
    expect(getEntityBySlug(db, 'companies/megacorp')).not.toBeNull();
    expect(getTriplesForEntity(db, 'people/dave', 'subject').length).toBe(1);
    expect(getTimelineEvents(db, 'people/dave').length).toBe(1);

    db.close();
  });

  // 6. Idempotent double-commit
  test('idempotent double-commit produces same canonical state without errors', async () => {
    const db = makeDb();
    const input: BridgeInput = {
      entities: [
        { slug: 'people/eve', type: 'person', title: 'Eve Adams', summary: 'Researcher' },
      ],
      triples: [
        { subjectSlug: 'people/eve', predicate: 'role', objectLiteral: 'Lead Researcher' },
      ],
      timeline: [
        { entitySlug: 'people/eve', date: '2025-06-01', summary: 'Published paper' },
      ],
    };

    const r1 = await bridge(db, input);
    const r2 = await bridge(db, input);

    expect(r1.canonical.committed).toBe(true);
    expect(r2.canonical.committed).toBe(true);

    // Entity still exists and is the same
    const eve = getEntityBySlug(db, 'people/eve');
    expect(eve).not.toBeNull();
    expect(eve!.title).toBe('Eve Adams');

    // Only one triple (ON CONFLICT dedup)
    const triples = getTriplesForEntity(db, 'people/eve', 'subject');
    expect(triples.length).toBe(1);

    // Timeline dedup via ON CONFLICT(entity_slug, date, event_type, summary)
    const events = getTimelineEvents(db, 'people/eve');
    expect(events.length).toBe(1);

    db.close();
  });

  // 7. Affected slugs include triple object targets
  test('affected slugs include triple objectEntitySlug targets', async () => {
    const db = makeDb();
    const input: BridgeInput = {
      entities: [
        { slug: 'people/frank', type: 'person', title: 'Frank Oz' },
        { slug: 'companies/puppets-inc', type: 'company', title: 'Puppets Inc' },
      ],
      triples: [
        { subjectSlug: 'people/frank', predicate: 'advises', objectEntitySlug: 'companies/puppets-inc' },
      ],
      timeline: [],
    };

    const result = await bridge(db, input);

    expect(result.canonical.entitySlugs).toContain('companies/puppets-inc');
    expect(result.canonical.entitySlugs).toContain('people/frank');

    db.close();
  });

  // 8. Projection skipped by default
  test('projection is skipped by default (compile=false)', async () => {
    const db = makeDb();
    const input: BridgeInput = {
      entities: [
        { slug: 'people/grace', type: 'person', title: 'Grace Hopper' },
      ],
      triples: [],
      timeline: [],
    };

    const result = await bridge(db, input);

    expect(result.canonical.committed).toBe(true);
    expect(result.projections.compiled.attempted).toBe(false);
    expect(result.projections.retrieval.attempted).toBe(false);
    expect(result.projections.compiled.succeeded).toEqual([]);
    expect(result.projections.compiled.failed).toEqual([]);

    db.close();
  });

  // 9. Projection failure does not roll back canonical
  test('projection failure does not roll back canonical writes', async () => {
    if (!process.env.JINA_API_KEY) {
      // compileEntity requires LanceDB which needs JINA_API_KEY
      // Without it, compileEntity will throw, which is what we want to test
      // But the import itself may fail. Let's test with compile=true and expect
      // the canonical to succeed even if projection fails.
    }

    const db = makeDb();
    const input: BridgeInput = {
      entities: [
        { slug: 'people/hank', type: 'person', title: 'Hank Williams' },
      ],
      triples: [],
      timeline: [],
    };

    const result = await bridge(db, input, { compile: true });

    // Canonical MUST succeed regardless of projection outcome
    expect(result.canonical.committed).toBe(true);
    expect(result.canonical.entitySlugs).toContain('people/hank');

    // Entity must be in DB (not rolled back)
    const hank = getEntityBySlug(db, 'people/hank');
    expect(hank).not.toBeNull();
    expect(hank!.title).toBe('Hank Williams');

    // Projection was attempted
    expect(result.projections.compiled.attempted).toBe(true);

    db.close();
  });

  // 10. commitCanonical convenience
  test('commitCanonical works same as bridge with compile=false', async () => {
    const db = makeDb();
    const input: BridgeInput = {
      entities: [
        { slug: 'people/ida', type: 'person', title: 'Ida Lovelace' },
      ],
      triples: [],
      timeline: [],
    };

    const result = await commitCanonical(db, input);

    expect(result.canonical.committed).toBe(true);
    expect(result.canonical.entitySlugs).toContain('people/ida');
    expect(result.projections.compiled.attempted).toBe(false);

    const ida = getEntityBySlug(db, 'people/ida');
    expect(ida).not.toBeNull();

    db.close();
  });

  // 11. commitAndProject convenience (guarded)
  test('commitAndProject works same as bridge with compile=true', async () => {
    if (!process.env.JINA_API_KEY) {
      expect(true).toBe(true);
      return;
    }

    const db = makeDb();
    const input: BridgeInput = {
      entities: [
        { slug: 'people/jane', type: 'person', title: 'Jane Doe' },
      ],
      triples: [],
      timeline: [],
    };

    const result = await commitAndProject(db, input);

    expect(result.canonical.committed).toBe(true);
    expect(result.projections.compiled.attempted).toBe(true);

    db.close();
  });

  // 12. Freshness is recomputed for affected entities
  test('freshness is recomputed and stale=1 for never-compiled entities', async () => {
    const db = makeDb();
    const input: BridgeInput = {
      entities: [
        { slug: 'people/karl', type: 'person', title: 'Karl Marx' },
      ],
      triples: [
        { subjectSlug: 'people/karl', predicate: 'wrote', objectLiteral: 'Das Kapital' },
      ],
      timeline: [
        { entitySlug: 'people/karl', date: '1867-09-14', summary: 'Published Das Kapital' },
      ],
    };

    const result = await bridge(db, input);
    expect(result.canonical.committed).toBe(true);

    // Check entity_freshness row exists and stale=1 (never compiled)
    const freshness = db.query(
      'SELECT * FROM entity_freshness WHERE entity_slug = ?'
    ).get('people/karl') as any;

    expect(freshness).not.toBeNull();
    expect(freshness.stale).toBe(1);
    expect(freshness.compiled_updated_at).toBeNull();
    expect(freshness.freshness_reason).toBe('never compiled');

    db.close();
  });

  test('isEntitySlug routes entity vs non-entity pages correctly', () => {
    // Entity slugs → true
    expect(isEntitySlug('people/sarah-chen')).toBe(true);
    expect(isEntitySlug('companies/acme-corp')).toBe(true);
    expect(isEntitySlug('projects/rebrand-2024')).toBe(true);

    // Non-entity slugs → false
    expect(isEntitySlug('meetings/board-q1')).toBe(false);
    expect(isEntitySlug('notes/something')).toBe(false);
    expect(isEntitySlug('random-page')).toBe(false);
    expect(isEntitySlug('people')).toBe(false); // prefix but not a slug
  });
});
