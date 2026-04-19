/**
 * Single-note ingest transaction for the first C-lite slice.
 *
 * This is a deliberately narrow implementation:
 * - Parses structured entities and relationships from a predefined note shape.
 * - For the first slice, the "parsing" is hardcoded for the demo scenario.
 * - Real LLM-based extraction will replace this in a later ticket.
 *
 * What this does NOT do (and explicitly reports as skipped):
 * - Memory-wiki compile
 * - Retrieval refresh
 * - Queue infrastructure
 */

import type { Database } from 'bun:sqlite';
import { upsertEntity, addAlias } from './entities.ts';
import { appendTimelineEvent } from './timeline.ts';
import { insertTriple } from './triples.ts';
import { recomputeFreshness } from './freshness.ts';

// ── Types ───────────────────────────────────────────────────────────

export interface ExtractedPerson {
  slug: string;
  title: string;
  summary: string;
  aliases: string[];
}

export interface ExtractedCompany {
  slug: string;
  title: string;
  summary: string;
  aliases: string[];
}

export interface ExtractedRelationship {
  subjectSlug: string;
  predicate: string;
  objectEntitySlug?: string;
  objectLiteral?: string;
}

export interface IngestNoteResult {
  /** Raw note text that was ingested */
  sourceNote: string;
  /** Entities created or updated */
  entities: Array<{ slug: string; type: string; title: string }>;
  /** Aliases added */
  aliases: Array<{ entitySlug: string; alias: string }>;
  /** Timeline events appended */
  timelineEvents: Array<{ entitySlug: string; summary: string }>;
  /** Triples inserted */
  triples: Array<{ subject: string; predicate: string; object: string }>;
  /** Freshness results */
  freshness: Array<{ entitySlug: string; stale: boolean; reason: string }>;
  /** Explicitly skipped features */
  skipped: {
    wikiCompile: true;
    retrievalRefresh: true;
    verification: true;
  };
  warnings: string[];
}

// ── First-slice "parser" ────────────────────────────────────────────

/**
 * Extract structured data from the demo note.
 * First slice: hardcoded for the Sarah Chen / Acme Corp scenario.
 * Returns extraction results ready for commit.
 */
export function extractFromDemoNote(note: string): {
  persons: ExtractedPerson[];
  companies: ExtractedCompany[];
  relationships: ExtractedRelationship[];
  timelineSummary: string;
  timelineDate: string;
} {
  // First slice: parse the demo scenario.
  // In a real implementation, this would call an LLM.
  // For now, detect the expected pattern or throw.

  // Extract person name (simple heuristic for first slice)
  const personMatch = note.match(/Met\s+(.+?)(?:\s+after|\s*\.\s)/);
  const roleMatch = note.match(/(?:She|He|They)\s+(?:is|are)\s+(.+?)\s+at\s+(.+?)(?:\.|$)/i);

  if (!personMatch) {
    // Generic fallback: return empty extraction
    return {
      persons: [],
      companies: [],
      relationships: [],
      timelineSummary: note,
      timelineDate: new Date().toISOString().slice(0, 10),
    };
  }

  const personName = personMatch[1].trim();
  const role = roleMatch ? roleMatch[1].trim() : '';
  const companyRef = roleMatch ? roleMatch[2].trim().replace(/\.$/, '') : '';

  // Build slug from name
  const personSlug = `people/${personName.toLowerCase().replace(/\s+/g, '-')}`;

  // Try to find company name in the note
  const companyMatch = note.match(/(?:at\s+)?(\w[\w\s]*?)(?:\s+Corp|\s+Inc|\s+LLC|\s+Ltd)?(?:\s*[\.,]|\s+We\s)/i)
    || (companyRef ? { [1]: companyRef.replace(/\s*(Corp|Inc|LLC|Ltd)\.?$/i, '') } : null);

  let companySlug = '';
  let companyTitle = '';

  if (companyMatch || companyRef) {
    companyTitle = companyRef || (companyMatch?.[1]?.trim() ?? '');
    if (companyTitle) {
      companySlug = `companies/${companyTitle.toLowerCase().replace(/\s+/g, '-')}`;
    }
  }

  const persons: ExtractedPerson[] = [{
    slug: personSlug,
    title: personName,
    summary: role ? `${role} at ${companyTitle}` : '',
    aliases: [personName, personName.toLowerCase()],
  }];

  const companies: ExtractedCompany[] = companySlug ? [{
    slug: companySlug,
    title: companyTitle,
    summary: '',
    aliases: [companyTitle, companyTitle.toLowerCase()],
  }] : [];

  const relationships: ExtractedRelationship[] = [];

  if (companySlug) {
    relationships.push({
      subjectSlug: personSlug,
      predicate: 'works_at',
      objectEntitySlug: companySlug,
    });
  }

  if (role) {
    relationships.push({
      subjectSlug: personSlug,
      predicate: 'role',
      objectLiteral: role,
    });
  }

  // Extract timeline summary (everything after the role statement, or the full note)
  const afterRole = note.match(/(?:She|He|They)\s+(?:is|are)\s+.+?(?:\.\s*)(.+)$/s);
  const timelineSummary = afterRole ? afterRole[1].trim() : note;

  return {
    persons,
    companies,
    relationships,
    timelineSummary,
    timelineDate: new Date().toISOString().slice(0, 10),
  };
}

// ── Ingest transaction ──────────────────────────────────────────────

/**
 * Ingest a single note into the C-lite knowledge graph.
 *
 * Runs as a single SQLite transaction. Commits canonical structured truth.
 * Explicitly does NOT perform wiki compile, retrieval refresh, or verification.
 */
export function ingestNote(db: Database, note: string): IngestNoteResult {
  const result: IngestNoteResult = {
    sourceNote: note,
    entities: [],
    aliases: [],
    timelineEvents: [],
    triples: [],
    freshness: [],
    skipped: {
      wikiCompile: true,
      retrievalRefresh: true,
      verification: true,
    },
    warnings: [
      'Wiki compile is the caller\'s responsibility after ingest — call compilePerson() separately.',
      'Retrieval refresh not yet implemented — search index not updated.',
    ],
  };

  const extraction = extractFromDemoNote(note);

  // Warn when extraction yields nothing meaningful
  const hasEntities = extraction.persons.length > 0 || extraction.companies.length > 0;
  if (!hasEntities) {
    result.warnings.push(
      'Extraction produced zero entities — note may not match the expected pattern. Nothing was committed.'
    );
  }

  // Run everything in a transaction
  const tx = db.transaction(() => {
    // Upsert persons
    for (const person of extraction.persons) {
      const entity = upsertEntity(db, person.slug, 'person', person.title, person.summary);
      result.entities.push({ slug: entity.slug, type: entity.type, title: entity.title });

      for (const alias of person.aliases) {
        addAlias(db, person.slug, alias);
        result.aliases.push({ entitySlug: person.slug, alias });
      }
    }

    // Upsert companies
    for (const company of extraction.companies) {
      const entity = upsertEntity(db, company.slug, 'company', company.title, company.summary);
      result.entities.push({ slug: entity.slug, type: entity.type, title: entity.title });

      for (const alias of company.aliases) {
        addAlias(db, company.slug, alias);
        result.aliases.push({ entitySlug: company.slug, alias });
      }
    }

    // Append timeline event for each person
    for (const person of extraction.persons) {
      if (extraction.timelineSummary) {
        const evt = appendTimelineEvent(db, {
          entitySlug: person.slug,
          date: extraction.timelineDate,
          summary: extraction.timelineSummary,
        });
        result.timelineEvents.push({ entitySlug: person.slug, summary: evt.summary });
      }
    }

    // Insert triples
    for (const rel of extraction.relationships) {
      insertTriple(db, rel);
      const obj = rel.objectEntitySlug || rel.objectLiteral || '';
      result.triples.push({ subject: rel.subjectSlug, predicate: rel.predicate, object: obj });
    }

    // Recompute freshness for all touched entities
    const touchedSlugs = new Set<string>([
      ...extraction.persons.map(p => p.slug),
      ...extraction.companies.map(c => c.slug),
    ]);
    for (const slug of touchedSlugs) {
      const f = recomputeFreshness(db, slug);
      result.freshness.push({
        entitySlug: f.entity_slug,
        stale: f.stale === 1,
        reason: f.freshness_reason,
      });
    }
  });

  if (hasEntities) {
    tx();
  }
  return result;
}
