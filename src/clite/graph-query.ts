/**
 * Temporal and multi-entity graph queries.
 *
 * Phase 6: extends the retrieval pipeline to handle:
 *   1. Temporal queries: "who worked at Acme in 2023?"
 *   2. Multi-entity traversal: "show me all companies Alice invested in"
 *   3. Aggregate queries: "how many employees does Acme have?"
 *
 * These queries use the triples table's temporal model (valid_from/valid_to)
 * and graph structure rather than just vector/keyword search.
 */

import type { Database } from 'bun:sqlite';
import type { TripleRow } from './triples.ts';

// ── Temporal filtering ──────────────────────────────────────────────

export interface TemporalFilter {
  /** ISO date string or year like "2023" */
  at?: string;
  /** ISO date range start */
  from?: string;
  /** ISO date range end */
  to?: string;
}

/**
 * Parse temporal hints from a natural language query.
 *
 * "in 2023" → { at: "2023" }
 * "since January" → { from: "2025-01" }
 * "between 2022 and 2024" → { from: "2022", to: "2024" }
 * "currently" → {} (no filter — already the default behavior)
 */
export function parseTemporalFilter(query: string): TemporalFilter {
  const q = query.toLowerCase();

  // "between X and Y"
  const betweenMatch = q.match(/between\s+(\d{4})\s+and\s+(\d{4})/);
  if (betweenMatch) {
    return { from: betweenMatch[1], to: betweenMatch[2] };
  }

  // "since Month Year" or "since Year"
  const sinceMatch = q.match(/since\s+((?:january|february|march|april|may|june|july|august|september|october|november|december)\s+)?(\d{4})/);
  if (sinceMatch) {
    const month = sinceMatch[1] ? monthToISO(sinceMatch[1].trim()) : '';
    const year = sinceMatch[2];
    return { from: month ? `${year}-${month}` : year };
  }

  // "in YYYY"
  const inYearMatch = q.match(/\bin\s+(\d{4})\b/);
  if (inYearMatch && !q.includes('in ' + inYearMatch[1] + ' ')) {
    return { at: inYearMatch[1] };
  }

  // "last year", "this year"
  const now = new Date();
  const currentYear = now.getFullYear();
  if (q.includes('last year')) return { at: String(currentYear - 1) };
  if (q.includes('this year')) return { at: String(currentYear) };

  // "currently", "now", "present" → no filter (default behavior)
  if (/\b(currently|now|present|these days)\b/.test(q)) {
    return {};
  }

  return {};
}

/**
 * Check if a triple was active during the given temporal window.
 */
export function tripleIsActiveDuring(triple: TripleRow, filter: TemporalFilter): boolean {
  if (!filter.at && !filter.from && !filter.to) return true;

  const validFrom = triple.valid_from;
  const validTo = triple.valid_to;

  if (filter.at) {
    // Triple must have been active at some point during this year/period
    const atDate = normalizeDate(filter.at);
    const from = normalizeDate(validFrom);
    // Triple starts before or during the period
    if (from > atDate + '-12-31') return false;
    // Triple ends after or during the period (or is still open)
    if (validTo && normalizeDate(validTo) < atDate + '-01-01') return false;
    return true;
  }

  if (filter.from || filter.to) {
    const fromDate = filter.from ? normalizeDate(filter.from) : '0000';
    const toDate = filter.to ? normalizeDate(filter.to) : '9999';

    const tripleFrom = normalizeDate(validFrom);
    if (tripleFrom > toDate + '-12-31') return false;

    if (validTo) {
      const tripleTo = normalizeDate(validTo);
      if (tripleTo < fromDate + '-01-01') return false;
    }

    return true;
  }

  return true;
}

function normalizeDate(d: string): string {
  // Already a full date: "2023-04-15 10:30:00" or "2023-04-15"
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  // Year only: "2023"
  if (/^\d{4}$/.test(d)) return d;
  // Year-month: "2023-04"
  if (/^\d{4}-\d{2}$/.test(d)) return d;
  return d;
}

function monthToISO(month: string): string {
  const months: Record<string, string> = {
    january: '01', february: '02', march: '03', april: '04',
    may: '05', june: '06', july: '07', august: '08',
    september: '09', october: '10', november: '11', december: '12',
  };
  return months[month.toLowerCase()] ?? '01';
}

// ── Graph traversal ──────────────────────────────────────────────────

export interface GraphQuery {
  /** Starting entity slugs */
  seeds: string[];
  /** Predicates to follow (empty = all) */
  predicates?: string[];
  /** Direction: outgoing (subject→object), incoming (object→subject), or both */
  direction?: 'outgoing' | 'incoming' | 'both';
  /** Max hops from seed */
  maxHops?: number;
  /** Temporal filter */
  temporal?: TemporalFilter;
  /** Limit results */
  limit?: number;
}

export interface GraphTraversalResult {
  /** Reached entity slugs */
  entities: Array<{
    slug: string;
    predicates: string[];
    hops: number;
    via: string; // the seed that reached this entity
  }>;
  /** Total triples traversed */
  triplesExplored: number;
}

/**
 * Traverse the graph from seed entities.
 *
 * For each seed, follows triples matching the given predicates and direction,
 * optionally filtering by temporal window. Returns reached entities with
 * metadata about how they were reached.
 */
export function traverseGraph(
  db: Database,
  query: GraphQuery,
): GraphTraversalResult {
  const { seeds, predicates, direction = 'both', maxHops = 2, temporal, limit = 50 } = query;

  const results: GraphTraversalResult = { entities: [], triplesExplored: 0 };
  const visited = new Set<string>(seeds);
  const entityMap = new Map<string, { slug: string; predicates: Set<string>; hops: number; via: string }>();

  let frontier = seeds.map(s => ({ slug: s, hops: 0 }));

  for (let hop = 0; hop < maxHops; hop++) {
    const nextFrontier: Array<{ slug: string; hops: number }> = [];

    for (const node of frontier) {
      let triples: TripleRow[] = [];

      if (direction === 'outgoing' || direction === 'both') {
        // Follow subject→object edges
        const predFilter = predicates?.length
          ? `AND predicate IN (${predicates.map(() => '?').join(', ')})`
          : '';
        const params = predicates?.length
          ? [node.slug, ...predicates!]
          : [node.slug];

        triples = db.query(
          `SELECT * FROM triples
           WHERE subject_entity_slug = ? ${predFilter}
             AND object_entity_slug IS NOT NULL
             AND status = 'current' AND valid_to IS NULL`
        ).all(...params) as TripleRow[];
      }

      if (direction === 'incoming' || direction === 'both') {
        const predFilter = predicates?.length
          ? `AND predicate IN (${predicates.map(() => '?').join(', ')})`
          : '';
        const params = predicates?.length
          ? [node.slug, ...predicates!]
          : [node.slug];

        const incoming = db.query(
          `SELECT * FROM triples
           WHERE object_entity_slug = ? ${predFilter}
             AND status = 'current' AND valid_to IS NULL`
        ).all(...params) as TripleRow[];
        triples = [...triples, ...incoming];
      }

      results.triplesExplored += triples.length;

      for (const triple of triples) {
        // Apply temporal filter
        if (temporal && !tripleIsActiveDuring(triple, temporal)) continue;

        const reachedSlug = triple.subject_entity_slug === node.slug
          ? triple.object_entity_slug!
          : triple.subject_entity_slug;

        if (!reachedSlug || visited.has(reachedSlug)) continue;

        visited.add(reachedSlug);
        nextFrontier.push({ slug: reachedSlug, hops: node.hops + 1 });

        const existing = entityMap.get(reachedSlug);
        if (existing) {
          existing.predicates.add(triple.predicate);
          if (node.hops + 1 < existing.hops) {
            existing.hops = node.hops + 1;
            existing.via = node.slug;
          }
        } else {
          entityMap.set(reachedSlug, {
            slug: reachedSlug,
            predicates: new Set([triple.predicate]),
            hops: node.hops + 1,
            via: node.slug,
          });
        }
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  // Convert to array and sort by hops then predicate count
  results.entities = [...entityMap.values()]
    .map(e => ({
      slug: e.slug,
      predicates: [...e.predicates],
      hops: e.hops,
      via: e.via,
    }))
    .sort((a, b) => a.hops - b.hops || b.predicates.length - a.predicates.length)
    .slice(0, limit);

  return results;
}

// ── High-level query helpers ─────────────────────────────────────────

/**
 * "Who worked at X?" — find people linked to a company via works_at/founded/etc.
 */
export function findPeopleLinkedToCompany(
  db: Database,
  companySlug: string,
  temporal?: TemporalFilter,
): Array<{ slug: string; predicates: string[] }> {
  const predicates = ['works_at', 'founded', 'advisor_to', 'invested_in'];
  const predPlaceholders = predicates.map(() => '?').join(', ');

  let triples: TripleRow[];
  if (temporal) {
    triples = db.query(
      `SELECT * FROM triples WHERE object_entity_slug = ? AND predicate IN (${predPlaceholders}) AND status = 'current'`
    ).all(companySlug, ...predicates) as TripleRow[];
    triples = triples.filter(t => tripleIsActiveDuring(t, temporal));
  } else {
    triples = db.query(
      `SELECT * FROM triples WHERE object_entity_slug = ? AND predicate IN (${predPlaceholders}) AND status = 'current' AND valid_to IS NULL`
    ).all(companySlug, ...predicates) as TripleRow[];
  }

  const peopleMap = new Map<string, Set<string>>();
  for (const t of triples) {
    if (!t.subject_entity_slug) continue;
    const existing = peopleMap.get(t.subject_entity_slug) ?? new Set();
    existing.add(t.predicate);
    peopleMap.set(t.subject_entity_slug, existing);
  }

  return [...peopleMap.entries()].map(([slug, preds]) => ({
    slug,
    predicates: [...preds],
  }));
}

/**
 * "What companies is X connected to?" — find companies linked to a person.
 */
export function findCompaniesLinkedToPerson(
  db: Database,
  personSlug: string,
  temporal?: TemporalFilter,
): Array<{ slug: string; predicates: string[] }> {
  const predicates = ['works_at', 'founded', 'advisor_to', 'invested_in'];
  const predPlaceholders = predicates.map(() => '?').join(', ');

  let triples: TripleRow[];
  if (temporal) {
    triples = db.query(
      `SELECT * FROM triples WHERE subject_entity_slug = ? AND predicate IN (${predPlaceholders}) AND object_entity_slug IS NOT NULL AND status = 'current'`
    ).all(personSlug, ...predicates) as TripleRow[];
    triples = triples.filter(t => tripleIsActiveDuring(t, temporal));
  } else {
    triples = db.query(
      `SELECT * FROM triples WHERE subject_entity_slug = ? AND predicate IN (${predPlaceholders}) AND object_entity_slug IS NOT NULL AND status = 'current' AND valid_to IS NULL`
    ).all(personSlug, ...predicates) as TripleRow[];
  }

  const companyMap = new Map<string, Set<string>>();
  for (const t of triples) {
    if (!t.object_entity_slug) continue;
    const existing = companyMap.get(t.object_entity_slug) ?? new Set();
    existing.add(t.predicate);
    companyMap.set(t.object_entity_slug, existing);
  }

  return [...companyMap.entries()].map(([slug, preds]) => ({
    slug,
    predicates: [...preds],
  }));
}
