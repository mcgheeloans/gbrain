import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { bootstrap } from '../src/clite/bootstrap.ts';
import { insertTriple, getTriplesForEntity } from '../src/clite/triples.ts';
import {
  parseTemporalFilter,
  tripleIsActiveDuring,
  traverseGraph,
  findPeopleLinkedToCompany,
  findCompaniesLinkedToPerson,
  type TemporalFilter,
} from '../src/clite/graph-query.ts';
import { detectQueryIntent, type QueryIntent } from '../src/clite/query-intent.ts';
import type { Database } from 'bun:sqlite';
import * as fs from 'fs';

const TEST_DB = '/tmp/gbrain-clite-graph-query-test.db';
let db: Database;

beforeEach(() => {
  try { fs.unlinkSync(TEST_DB); } catch {}
  const result = bootstrap(TEST_DB);
  db = result.db;

  // Seed entities
  db.exec("INSERT INTO entities (slug, type, title) VALUES ('people/alice', 'person', 'Alice Smith')");
  db.exec("INSERT INTO entities (slug, type, title) VALUES ('people/bob', 'person', 'Bob Jones')");
  db.exec("INSERT INTO entities (slug, type, title) VALUES ('people/carol', 'person', 'Carol White')");
  db.exec("INSERT INTO entities (slug, type, title) VALUES ('companies/acme', 'company', 'Acme Corp')");
  db.exec("INSERT INTO entities (slug, type, title) VALUES ('companies/forge', 'company', 'Forge Inc')");
});

afterEach(() => {
  db.close();
  try { fs.unlinkSync(TEST_DB); } catch {}
});

describe('parseTemporalFilter', () => {
  test('parses "in 2023"', () => {
    const filter = parseTemporalFilter('who worked at Acme in 2023?');
    expect(filter.at).toBe('2023');
  });

  test('parses "between 2022 and 2024"', () => {
    const filter = parseTemporalFilter('companies founded between 2022 and 2024');
    expect(filter.from).toBe('2022');
    expect(filter.to).toBe('2024');
  });

  test('parses "since 2023"', () => {
    const filter = parseTemporalFilter('who has been at Acme since 2023');
    expect(filter.from).toBe('2023');
  });

  test('returns empty for non-temporal query', () => {
    const filter = parseTemporalFilter('who works at Acme?');
    expect(filter.at).toBeUndefined();
    expect(filter.from).toBeUndefined();
    expect(filter.to).toBeUndefined();
  });

  test('parses "last year"', () => {
    const filter = parseTemporalFilter('companies founded last year');
    const currentYear = new Date().getFullYear();
    expect(filter.at).toBe(String(currentYear - 1));
  });
});

describe('tripleIsActiveDuring', () => {
  test('open triple is active at any time', () => {
    const triple = {
      valid_from: '2022-06-01 00:00:00',
      valid_to: null,
    } as any;
    expect(tripleIsActiveDuring(triple, { at: '2023' })).toBe(true);
    expect(tripleIsActiveDuring(triple, { at: '2025' })).toBe(true);
  });

  test('closed triple is active during its range', () => {
    const triple = {
      valid_from: '2022-01-01 00:00:00',
      valid_to: '2024-06-30 00:00:00',
    } as any;
    expect(tripleIsActiveDuring(triple, { at: '2023' })).toBe(true);
    expect(tripleIsActiveDuring(triple, { at: '2025' })).toBe(false);
  });

  test('no filter returns true', () => {
    const triple = {
      valid_from: '2022-01-01 00:00:00',
      valid_to: '2023-01-01 00:00:00',
    } as any;
    expect(tripleIsActiveDuring(triple, {})).toBe(true);
  });

  test('range filter with open triple', () => {
    const triple = {
      valid_from: '2022-01-01 00:00:00',
      valid_to: null,
    } as any;
    expect(tripleIsActiveDuring(triple, { from: '2023', to: '2024' })).toBe(true);
    expect(tripleIsActiveDuring(triple, { from: '2025', to: '2026' })).toBe(true);
  });
});

describe('findPeopleLinkedToCompany', () => {
  test('finds people who work at a company', () => {
    insertTriple(db, {
      subjectSlug: 'people/alice',
      predicate: 'works_at',
      objectEntitySlug: 'companies/acme',
    });

    const people = findPeopleLinkedToCompany(db, 'companies/acme');
    expect(people.length).toBe(1);
    expect(people[0].slug).toBe('people/alice');
    expect(people[0].predicates).toContain('works_at');
  });

  test('finds founders and investors', () => {
    insertTriple(db, { subjectSlug: 'people/alice', predicate: 'founded', objectEntitySlug: 'companies/acme' });
    insertTriple(db, { subjectSlug: 'people/bob', predicate: 'invested_in', objectEntitySlug: 'companies/acme' });

    const people = findPeopleLinkedToCompany(db, 'companies/acme');
    expect(people.length).toBe(2);
    const slugs = people.map(p => p.slug).sort();
    expect(slugs).toEqual(['people/alice', 'people/bob']);
  });

  test('respects temporal filter', () => {
    // Alice founded Acme (inserted just now, so valid_from is 2026)
    insertTriple(db, { subjectSlug: 'people/alice', predicate: 'founded', objectEntitySlug: 'companies/acme' });

    // Bob invested in Acme but that relationship ended in 2022
    db.prepare(
      `INSERT INTO triples (subject_entity_slug, predicate, object_entity_slug, status, valid_from, valid_to)
       VALUES ('people/bob', 'invested_in', 'companies/acme', 'current', '2021-01-01', '2022-06-30')`
    ).run();

    const allPeople = findPeopleLinkedToCompany(db, 'companies/acme');
    expect(allPeople.length).toBe(1); // Only Alice (Bob's ended)

    // In 2026 (Alice's triple is active, Bob's has ended)
    const filtered2026 = findPeopleLinkedToCompany(db, 'companies/acme', { at: '2026' });
    expect(filtered2026.length).toBe(1);
    expect(filtered2026[0].slug).toBe('people/alice');

    // In 2021 (Bob's triple was active, Alice's didn't exist yet)
    const filtered2021 = findPeopleLinkedToCompany(db, 'companies/acme', { at: '2021' });
    expect(filtered2021.length).toBe(1);
    expect(filtered2021[0].slug).toBe('people/bob');
  });
});

describe('findCompaniesLinkedToPerson', () => {
  test('finds companies linked to a person', () => {
    insertTriple(db, { subjectSlug: 'people/alice', predicate: 'works_at', objectEntitySlug: 'companies/acme' });
    insertTriple(db, { subjectSlug: 'people/alice', predicate: 'advisor_to', objectEntitySlug: 'companies/forge' });

    const companies = findCompaniesLinkedToPerson(db, 'people/alice');
    expect(companies.length).toBe(2);
    const slugs = companies.map(c => c.slug).sort();
    expect(slugs).toEqual(['companies/acme', 'companies/forge']);
  });
});

describe('traverseGraph', () => {
  test('1-hop traversal finds connected entities', () => {
    insertTriple(db, { subjectSlug: 'people/alice', predicate: 'works_at', objectEntitySlug: 'companies/acme' });
    insertTriple(db, { subjectSlug: 'people/bob', predicate: 'works_at', objectEntitySlug: 'companies/acme' });

    const result = traverseGraph(db, {
      seeds: ['people/alice'],
      direction: 'outgoing',
      maxHops: 1,
    });

    expect(result.entities.length).toBe(1);
    expect(result.entities[0].slug).toBe('companies/acme');
  });

  test('2-hop traversal finds co-workers', () => {
    insertTriple(db, { subjectSlug: 'people/alice', predicate: 'works_at', objectEntitySlug: 'companies/acme' });
    insertTriple(db, { subjectSlug: 'people/bob', predicate: 'works_at', objectEntitySlug: 'companies/acme' });

    const result = traverseGraph(db, {
      seeds: ['people/alice'],
      direction: 'both',
      maxHops: 2,
    });

    const slugs = result.entities.map(e => e.slug);
    expect(slugs).toContain('companies/acme');
    expect(slugs).toContain('people/bob');
  });

  test('respects predicate filter', () => {
    insertTriple(db, { subjectSlug: 'people/alice', predicate: 'works_at', objectEntitySlug: 'companies/acme' });
    insertTriple(db, { subjectSlug: 'people/alice', predicate: 'advisor_to', objectEntitySlug: 'companies/forge' });

    const result = traverseGraph(db, {
      seeds: ['people/alice'],
      predicates: ['works_at'],
      direction: 'outgoing',
      maxHops: 1,
    });

    expect(result.entities.length).toBe(1);
    expect(result.entities[0].slug).toBe('companies/acme');
  });

  test('respects limit', () => {
    insertTriple(db, { subjectSlug: 'people/alice', predicate: 'works_at', objectEntitySlug: 'companies/acme' });
    insertTriple(db, { subjectSlug: 'people/alice', predicate: 'founded', objectEntitySlug: 'companies/forge' });

    const result = traverseGraph(db, {
      seeds: ['people/alice'],
      direction: 'outgoing',
      maxHops: 1,
      limit: 1,
    });

    expect(result.entities.length).toBe(1);
  });

  test('empty seeds returns nothing', () => {
    const result = traverseGraph(db, { seeds: [], maxHops: 2 });
    expect(result.entities.length).toBe(0);
  });
});

describe('detectQueryIntent extended', () => {
  test('detects temporal intent', () => {
    expect(detectQueryIntent('who worked at Acme in 2023?')).toBe('temporal');
    expect(detectQueryIntent('companies founded since 2022')).toBe('temporal');
  });

  test('detects aggregate intent', () => {
    expect(detectQueryIntent('how many employees does Acme have?')).toBe('aggregate');
    expect(detectQueryIntent('count all investors in Forge')).toBe('aggregate');
  });

  test('still detects person_relation for non-temporal', () => {
    expect(detectQueryIntent('who founded Acme?')).toBe('person_relation');
  });

  test('still detects company_affiliation', () => {
    expect(detectQueryIntent('where does Alice work?')).toBe('company_affiliation');
  });
});
