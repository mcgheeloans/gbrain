import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { bootstrap } from '../src/clite/bootstrap.ts';
import { bridge, commitCanonical } from '../src/clite/bridge.ts';
import { extractFrontmatterLinks } from '../src/clite/frontmatter-links.ts';
import { getTriplesForEntity } from '../src/clite/triples.ts';
import type { Database } from 'bun:sqlite';

const TEST_DB = '/tmp/gbrain-clite-frontmatter-test.db';
let db: Database;

beforeEach(() => {
  const { execSync } = require('child_process');
  try { require('fs').unlinkSync(TEST_DB); } catch {}
  const result = bootstrap(TEST_DB);
  db = result.db;
});

afterEach(() => {
  db.close();
  try { require('fs').unlinkSync(TEST_DB); } catch {}
});

describe('frontmatter-links', () => {
  test('extracts works_at from company field on person page', () => {
    // Create person + company entities
    db.exec(`INSERT INTO entities (slug, type, title) VALUES ('people/jane', 'person', 'Jane Doe')`);
    db.exec(`INSERT INTO entities (slug, type, title) VALUES ('companies/acme', 'company', 'Acme Corp')`);

    const { resolved, unresolved } = extractFrontmatterLinks(
      'people/jane',
      { company: 'Acme Corp' },
      db,
    );

    expect(resolved.length).toBe(1);
    expect(resolved[0].subjectSlug).toBe('people/jane');
    expect(resolved[0].predicate).toBe('works_at');
    expect(resolved[0].objectSlug).toBe('companies/acme');
    expect(unresolved.length).toBe(0);
  });

  test('extracts invested_in from investors field on company page', () => {
    db.exec(`INSERT INTO entities (slug, type, title) VALUES ('companies/acme', 'company', 'Acme Corp')`);
    db.exec(`INSERT INTO entities (slug, type, title) VALUES ('people/alice', 'person', 'Alice Smith')`);

    // investors has direction 'incoming': alice (subject) invested_in acme (object)
    const { resolved, unresolved } = extractFrontmatterLinks(
      'companies/acme',
      { investors: ['Alice Smith'] },
      db,
    );

    expect(resolved.length).toBe(1);
    expect(resolved[0].subjectSlug).toBe('people/alice');
    expect(resolved[0].predicate).toBe('invested_in');
    expect(resolved[0].objectSlug).toBe('companies/acme');
  });

  test('reports unresolved names', () => {
    db.exec(`INSERT INTO entities (slug, type, title) VALUES ('people/jane', 'person', 'Jane Doe')`);

    const { resolved, unresolved } = extractFrontmatterLinks(
      'people/jane',
      { company: 'Unknown Corp' },
      db,
    );

    expect(resolved.length).toBe(0);
    expect(unresolved.length).toBe(1);
    expect(unresolved[0].name).toBe('Unknown Corp');
    expect(unresolved[0].field).toBe('company');
  });

  test('bridge creates frontmatter triples via commitCanonical', async () => {
    // Create entities first
    db.exec(`INSERT INTO entities (slug, type, title) VALUES ('people/jane', 'person', 'Jane Doe')`);
    db.exec(`INSERT INTO entities (slug, type, title) VALUES ('companies/acme', 'company', 'Acme Corp')`);

    const result = await commitCanonical(db, {
      entities: [],
      triples: [],
      timeline: [],
      sourceSlug: 'people/jane',
      frontmatter: { company: 'Acme Corp' },
    });

    expect(result.canonical.committed).toBe(true);
    expect(result.canonical.frontmatterLinks).toBe(1);
    expect(result.canonical.unresolved.length).toBe(0);

    // Verify the triple exists
    const triples = getTriplesForEntity(db, 'people/jane', 'subject');
    expect(triples.length).toBe(1);
    expect(triples[0].predicate).toBe('works_at');
    expect(triples[0].object_entity_slug).toBe('companies/acme');
    expect(triples[0].link_source).toBe('frontmatter');
    expect(triples[0].origin_slug).toBe('people/jane');
    expect(triples[0].origin_field).toBe('company');
  });

  test('bridge reconciliation removes stale frontmatter edges', async () => {
    db.exec(`INSERT INTO entities (slug, type, title) VALUES ('people/jane', 'person', 'Jane Doe')`);
    db.exec(`INSERT INTO entities (slug, type, title) VALUES ('companies/acme', 'company', 'Acme Corp')`);
    db.exec(`INSERT INTO entities (slug, type, title) VALUES ('companies/forge', 'company', 'Forge Inc')`);

    // First: jane works at acme
    await commitCanonical(db, {
      entities: [], triples: [], timeline: [],
      sourceSlug: 'people/jane',
      frontmatter: { company: 'Acme Corp' },
    });

    // Second: jane now works at forge (should remove old acme edge)
    await commitCanonical(db, {
      entities: [], triples: [], timeline: [],
      sourceSlug: 'people/jane',
      frontmatter: { company: 'Forge Inc' },
    });

    const triples = getTriplesForEntity(db, 'people/jane', 'subject');
    expect(triples.length).toBe(1);
    expect(triples[0].object_entity_slug).toBe('companies/forge');
  });

  test('skips unknown frontmatter fields', () => {
    db.exec(`INSERT INTO entities (slug, type, title) VALUES ('people/jane', 'person', 'Jane Doe')`);

    const { resolved, unresolved } = extractFrontmatterLinks(
      'people/jane',
      { favorite_color: 'blue' },
      db,
    );

    expect(resolved.length).toBe(0);
    expect(unresolved.length).toBe(0);
  });

  test('extracts founded from person page (outgoing)', () => {
    db.exec(`INSERT INTO entities (slug, type, title) VALUES ('people/jane', 'person', 'Jane Doe')`);
    db.exec(`INSERT INTO entities (slug, type, title) VALUES ('companies/acme', 'company', 'Acme Corp')`);

    // founded: outgoing — jane (subject) founded acme (object)
    const { resolved, unresolved } = extractFrontmatterLinks(
      'people/jane',
      { founded: 'Acme Corp' },
      db,
    );

    expect(resolved.length).toBe(1);
    expect(resolved[0].subjectSlug).toBe('people/jane');
    expect(resolved[0].predicate).toBe('founded');
    expect(resolved[0].objectSlug).toBe('companies/acme');
    expect(resolved[0].originSlug).toBe('people/jane');
    expect(unresolved.length).toBe(0);
  });

  test('extracts led_round from deal page (incoming)', () => {
    db.exec(`INSERT INTO entities (slug, type, title) VALUES ('deals/acme-seed', 'deal', 'Acme Seed Round')`);
    db.exec(`INSERT INTO entities (slug, type, title) VALUES ('people/bob', 'person', 'Bob Wilson')`);

    // lead: incoming — bob (subject) led_round deals/acme-seed (object)
    const { resolved, unresolved } = extractFrontmatterLinks(
      'deals/acme-seed',
      { lead: 'Bob Wilson' },
      db,
    );

    expect(resolved.length).toBe(1);
    expect(resolved[0].subjectSlug).toBe('people/bob');
    expect(resolved[0].predicate).toBe('led_round');
    expect(resolved[0].objectSlug).toBe('deals/acme-seed');
    expect(resolved[0].originSlug).toBe('deals/acme-seed');
    expect(unresolved.length).toBe(0);
  });

  test('partner maps to yc_partner predicate', () => {
    db.exec(`INSERT INTO entities (slug, type, title) VALUES ('companies/acme', 'company', 'Acme Corp')`);
    db.exec(`INSERT INTO entities (slug, type, title) VALUES ('people/sarah', 'person', 'Sarah Chen')`);

    // partner: incoming — sarah (subject) yc_partner acme (object)
    const { resolved } = extractFrontmatterLinks(
      'companies/acme',
      { partner: 'Sarah Chen' },
      db,
    );

    expect(resolved.length).toBe(1);
    expect(resolved[0].predicate).toBe('yc_partner');
    expect(resolved[0].subjectSlug).toBe('people/sarah');
    expect(resolved[0].objectSlug).toBe('companies/acme');
  });
});
