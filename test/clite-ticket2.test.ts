/**
 * Tests for C-lite Ticket 2: core adapters + single-note ingest.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { bootstrap } from '../src/clite/bootstrap.ts';
import {
  upsertEntity,
  getEntityBySlug,
  addAlias,
  resolveSlug,
} from '../src/clite/entities.ts';
import { appendTimelineEvent, getTimelineEvents } from '../src/clite/timeline.ts';
import { insertTriple, getTriplesForEntity } from '../src/clite/triples.ts';
import { recomputeFreshness, markCompiled } from '../src/clite/freshness.ts';
import { getEntityState } from '../src/clite/read-models.ts';
import { ingestNote, extractFromDemoNote } from '../src/clite/ingest-note.ts';
import type { Database } from 'bun:sqlite';

let db: Database;

beforeEach(() => {
  const result = bootstrap(':memory:');
  db = result.db;
});

// ── Entity upsert ───────────────────────────────────────────────────

describe('upsertEntity', () => {
  test('creates a new entity', () => {
    const e = upsertEntity(db, 'people/sarah-chen', 'person', 'Sarah Chen', 'VP Engineering');
    expect(e.slug).toBe('people/sarah-chen');
    expect(e.type).toBe('person');
    expect(e.title).toBe('Sarah Chen');
    expect(e.summary).toBe('VP Engineering');
  });

  test('updates existing entity on conflict', () => {
    upsertEntity(db, 'people/sarah-chen', 'person', 'Sarah Chen');
    const e = upsertEntity(db, 'people/sarah-chen', 'person', 'Sarah Chen', 'VP Engineering');
    expect(e.summary).toBe('VP Engineering');
    // Should not duplicate
    const count = db.query("SELECT COUNT(*) as c FROM entities WHERE slug = 'people/sarah-chen'").get() as any;
    expect(count.c).toBe(1);
  });

  test('does not blank out summary on upsert with empty summary', () => {
    upsertEntity(db, 'people/sarah-chen', 'person', 'Sarah Chen', 'VP Engineering');
    const e = upsertEntity(db, 'people/sarah-chen', 'person', 'Sarah Chen', '');
    expect(e.summary).toBe('VP Engineering');
  });
});

// ── Alias add / resolve ─────────────────────────────────────────────

describe('aliases', () => {
  test('addAlias and resolveSlug', () => {
    upsertEntity(db, 'people/sarah-chen', 'person', 'Sarah Chen');
    addAlias(db, 'people/sarah-chen', 'Sarah');
    addAlias(db, 'people/sarah-chen', 'schen');

    expect(resolveSlug(db, 'Sarah')).toBe('people/sarah-chen');
    expect(resolveSlug(db, 'schen')).toBe('people/sarah-chen');
    expect(resolveSlug(db, 'people/sarah-chen')).toBe('people/sarah-chen');
    expect(resolveSlug(db, 'unknown')).toBeNull();
  });

  test('addAlias deduplicates', () => {
    upsertEntity(db, 'people/sarah-chen', 'person', 'Sarah Chen');
    addAlias(db, 'people/sarah-chen', 'Sarah');
    addAlias(db, 'people/sarah-chen', 'Sarah'); // no error
    const count = db.query("SELECT COUNT(*) as c FROM entity_aliases WHERE alias = 'Sarah'").get() as any;
    expect(count.c).toBe(1);
  });
});

// ── Timeline events ─────────────────────────────────────────────────

describe('timeline', () => {
  test('appendTimelineEvent creates event', () => {
    upsertEntity(db, 'people/sarah-chen', 'person', 'Sarah Chen');
    const evt = appendTimelineEvent(db, {
      entitySlug: 'people/sarah-chen',
      summary: 'Discussed the GraphQL migration',
    });
    expect(evt.entity_slug).toBe('people/sarah-chen');
    expect(evt.summary).toBe('Discussed the GraphQL migration');
    expect(evt.event_type).toBe('note');
  });

  test('getTimelineEvents returns events in order', () => {
    upsertEntity(db, 'people/sarah-chen', 'person', 'Sarah Chen');
    appendTimelineEvent(db, { entitySlug: 'people/sarah-chen', summary: 'First event', date: '2026-04-17' });
    appendTimelineEvent(db, { entitySlug: 'people/sarah-chen', summary: 'Second event', date: '2026-04-18' });
    const events = getTimelineEvents(db, 'people/sarah-chen');
    expect(events).toHaveLength(2);
    // Most recent first
    expect(events[0].date).toBe('2026-04-18');
  });
});

// ── Triples ─────────────────────────────────────────────────────────

describe('triples', () => {
  test('entity-to-entity triple', () => {
    upsertEntity(db, 'people/sarah-chen', 'person', 'Sarah Chen');
    upsertEntity(db, 'companies/acme-corp', 'company', 'Acme Corp');
    const t = insertTriple(db, {
      subjectSlug: 'people/sarah-chen',
      predicate: 'works_at',
      objectEntitySlug: 'companies/acme-corp',
    });
    expect(t.subject_entity_slug).toBe('people/sarah-chen');
    expect(t.predicate).toBe('works_at');
    expect(t.object_entity_slug).toBe('companies/acme-corp');
    expect(t.object_literal).toBeNull();
  });

  test('entity-to-literal triple', () => {
    upsertEntity(db, 'people/sarah-chen', 'person', 'Sarah Chen');
    const t = insertTriple(db, {
      subjectSlug: 'people/sarah-chen',
      predicate: 'role',
      objectLiteral: 'VP Engineering',
    });
    expect(t.object_literal).toBe('VP Engineering');
    expect(t.object_entity_slug).toBeNull();
  });

  test('getTriplesForEntity returns both subject and object', () => {
    upsertEntity(db, 'people/sarah-chen', 'person', 'Sarah Chen');
    upsertEntity(db, 'companies/acme-corp', 'company', 'Acme Corp');
    insertTriple(db, {
      subjectSlug: 'people/sarah-chen',
      predicate: 'works_at',
      objectEntitySlug: 'companies/acme-corp',
    });

    const personTriples = getTriplesForEntity(db, 'people/sarah-chen');
    expect(personTriples).toHaveLength(1);

    const companyTriples = getTriplesForEntity(db, 'companies/acme-corp');
    expect(companyTriples).toHaveLength(1);
  });

  test('rejects triple with neither objectEntitySlug nor objectLiteral', () => {
    upsertEntity(db, 'people/sarah-chen', 'person', 'Sarah Chen');
    expect(() =>
      insertTriple(db, { subjectSlug: 'people/sarah-chen', predicate: 'broken' })
    ).toThrow('must have either');
  });

  test('rejects triple with BOTH objectEntitySlug and objectLiteral', () => {
    upsertEntity(db, 'people/sarah-chen', 'person', 'Sarah Chen');
    upsertEntity(db, 'companies/acme-corp', 'company', 'Acme Corp');
    expect(() =>
      insertTriple(db, {
        subjectSlug: 'people/sarah-chen',
        predicate: 'works_at',
        objectEntitySlug: 'companies/acme-corp',
        objectLiteral: 'also a literal',
      })
    ).toThrow('not both');
  });

  test('deduplicates on identical insert', () => {
    upsertEntity(db, 'people/sarah-chen', 'person', 'Sarah Chen');
    insertTriple(db, { subjectSlug: 'people/sarah-chen', predicate: 'role', objectLiteral: 'VP Engineering' });
    insertTriple(db, { subjectSlug: 'people/sarah-chen', predicate: 'role', objectLiteral: 'VP Engineering' });
    const triples = getTriplesForEntity(db, 'people/sarah-chen');
    expect(triples).toHaveLength(1);
  });
});

// ── Freshness ───────────────────────────────────────────────────────

describe('freshness', () => {
  test('entity with events but never compiled is stale', () => {
    upsertEntity(db, 'people/sarah-chen', 'person', 'Sarah Chen');
    appendTimelineEvent(db, { entitySlug: 'people/sarah-chen', summary: 'Met Sarah' });
    const f = recomputeFreshness(db, 'people/sarah-chen');
    expect(f.stale).toBe(1);
    expect(f.freshness_reason).toBe('never compiled');
  });

  test('entity is fresh after compile', () => {
    upsertEntity(db, 'people/sarah-chen', 'person', 'Sarah Chen');
    appendTimelineEvent(db, { entitySlug: 'people/sarah-chen', summary: 'Met Sarah' });
    recomputeFreshness(db, 'people/sarah-chen');
    markCompiled(db, 'people/sarah-chen');
    const f = recomputeFreshness(db, 'people/sarah-chen');
    expect(f.stale).toBe(0);
  });

  test('becomes stale after new event post-compile', () => {
    upsertEntity(db, 'people/sarah-chen', 'person', 'Sarah Chen');
    // Create event in the past
    appendTimelineEvent(db, { entitySlug: 'people/sarah-chen', summary: 'First meeting', date: '2026-04-10' });
    recomputeFreshness(db, 'people/sarah-chen');
    markCompiled(db, 'people/sarah-chen');

    // New event with a future date — use raw SQL to set created_at in the future
    // to avoid same-second ambiguity
    db.prepare(
      "INSERT INTO timeline_events (entity_slug, event_type, date, summary, created_at) VALUES (?, 'note', '2026-04-20', 'Follow-up', datetime('now', '+1 hour'))"
    ).run('people/sarah-chen');

    const f = recomputeFreshness(db, 'people/sarah-chen');
    expect(f.stale).toBe(1);
    expect(f.freshness_reason).toContain('timeline events');
  });
});

// ── Read models (getEntityState) ────────────────────────────────────

describe('getEntityState', () => {
  test('returns full composed state', () => {
    upsertEntity(db, 'people/sarah-chen', 'person', 'Sarah Chen', 'VP Engineering');
    upsertEntity(db, 'companies/acme-corp', 'company', 'Acme Corp');
    addAlias(db, 'people/sarah-chen', 'Sarah');
    appendTimelineEvent(db, { entitySlug: 'people/sarah-chen', summary: 'Met Sarah' });
    insertTriple(db, {
      subjectSlug: 'people/sarah-chen',
      predicate: 'works_at',
      objectEntitySlug: 'companies/acme-corp',
    });
    recomputeFreshness(db, 'people/sarah-chen');

    const state = getEntityState(db, 'people/sarah-chen');
    expect(state).not.toBeNull();
    expect(state!.entity.title).toBe('Sarah Chen');
    expect(state!.aliases).toHaveLength(1);
    expect(state!.triples).toHaveLength(1);
    expect(state!.recentTimeline).toHaveLength(1);
    expect(state!.freshness).not.toBeNull();
  });

  test('returns null for unknown entity', () => {
    expect(getEntityState(db, 'people/nope')).toBeNull();
  });
});

// ── Ingest transaction ──────────────────────────────────────────────

describe('ingestNote', () => {
  const DEMO_NOTE = 'Met Sarah Chen after the Acme sync. She is VP Engineering at Acme Corp. We discussed the GraphQL migration.';

  test('creates Sarah Chen and Acme Corp entities', () => {
    const result = ingestNote(db, DEMO_NOTE);
    expect(result.entities.length).toBeGreaterThanOrEqual(2);

    const slugs = result.entities.map(e => e.slug);
    expect(slugs).toContain('people/sarah-chen');
    expect(slugs).toContain('companies/acme-corp');

    const sarah = getEntityBySlug(db, 'people/sarah-chen');
    expect(sarah).not.toBeNull();
    expect(sarah!.type).toBe('person');

    const acme = getEntityBySlug(db, 'companies/acme-corp');
    expect(acme).not.toBeNull();
    expect(acme!.type).toBe('company');
  });

  test('creates works_at and role triples', () => {
    const result = ingestNote(db, DEMO_NOTE);
    expect(result.triples.length).toBeGreaterThanOrEqual(2);

    const worksAt = result.triples.find(t => t.predicate === 'works_at');
    expect(worksAt).toBeDefined();
    expect(worksAt!.subject).toBe('people/sarah-chen');
    expect(worksAt!.object).toBe('companies/acme-corp');

    const role = result.triples.find(t => t.predicate === 'role');
    expect(role).toBeDefined();
    expect(role!.object).toBe('VP Engineering');
  });

  test('appends timeline event for Sarah', () => {
    const result = ingestNote(db, DEMO_NOTE);
    expect(result.timelineEvents.length).toBeGreaterThanOrEqual(1);
    expect(result.timelineEvents[0].entitySlug).toBe('people/sarah-chen');
  });

  test('recomputes freshness and reports stale', () => {
    const result = ingestNote(db, DEMO_NOTE);
    expect(result.freshness.length).toBeGreaterThan(0);
    const sarahFresh = result.freshness.find(f => f.entitySlug === 'people/sarah-chen');
    expect(sarahFresh).toBeDefined();
    expect(sarahFresh!.stale).toBe(true);
  });

  test('explicitly reports skipped features', () => {
    const result = ingestNote(db, DEMO_NOTE);
    expect(result.skipped.wikiCompile).toBe(true);
    expect(result.skipped.retrievalRefresh).toBe(true);
    expect(result.skipped.verification).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.includes('Wiki compile'))).toBe(true);
    expect(result.warnings.some(w => w.includes('Retrieval refresh'))).toBe(true);
  });

  test('is idempotent on second ingest', () => {
    ingestNote(db, DEMO_NOTE);
    ingestNote(db, DEMO_NOTE);

    const entities = db.query('SELECT COUNT(*) as c FROM entities').get() as any;
    expect(entities.c).toBe(2); // still only 2 entities
  });

  test('getEntityState returns full composed state after ingest', () => {
    ingestNote(db, DEMO_NOTE);

    const state = getEntityState(db, 'people/sarah-chen');
    expect(state).not.toBeNull();
    expect(state!.entity.type).toBe('person');
    expect(state!.triples.length).toBeGreaterThanOrEqual(2);
    expect(state!.recentTimeline.length).toBeGreaterThanOrEqual(1);
  });

  test('warns when extraction yields zero entities', () => {
    const result = ingestNote(db, 'random gibberish that matches nothing');
    expect(result.entities).toHaveLength(0);
    expect(result.triples).toHaveLength(0);
    expect(result.warnings.some(w => w.includes('zero entities'))).toBe(true);
  });
});
