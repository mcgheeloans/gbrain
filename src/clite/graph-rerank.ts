import type { Database } from 'bun:sqlite';
import type { RetrievedEntityChunk } from './retrieve-person.ts';
import { chunkIntentMultiplier, detectRelationPredicates, exactEntityMentionMultiplier, inferReferencedEntitySlugs } from './query-intent.ts';

export function getGraphLinkedSlugs(
  db: Database,
  query: string,
  intent: 'person_relation' | 'company_affiliation' | 'neutral',
): Set<string> {
  const predicates = detectRelationPredicates(query, intent);
  if (predicates.length === 0) return new Set();

  const mentioned = inferReferencedEntitySlugs(db, query);
  if (mentioned.length === 0) return new Set();

  const referencedPeople = mentioned.filter((e) => e.type === 'person').map((e) => e.slug);
  const referencedCompanies = mentioned.filter((e) => e.type === 'company').map((e) => e.slug);
  const linked = new Set<string>();

  if (intent === 'person_relation' && referencedCompanies.length > 0) {
    const placeholdersA = referencedCompanies.map(() => '?').join(', ');
    const placeholdersB = predicates.map(() => '?').join(', ');
    const rows = db.query(
      `SELECT object_entity_slug as slug
       FROM triples
       WHERE subject_entity_slug IN (${placeholdersA})
         AND predicate IN (${placeholdersB})
         AND object_entity_slug IS NOT NULL
         AND status = 'current' AND valid_to IS NULL`
    ).all(...referencedCompanies, ...predicates) as Array<{ slug: string | null }>;
    for (const row of rows) {
      if (row.slug) linked.add(row.slug);
    }
  }

  if (intent === 'company_affiliation' && referencedPeople.length > 0) {
    const placeholdersA = referencedPeople.map(() => '?').join(', ');
    const placeholdersB = predicates.map(() => '?').join(', ');
    const rows = db.query(
      `SELECT object_entity_slug as slug
       FROM triples
       WHERE subject_entity_slug IN (${placeholdersA})
         AND predicate IN (${placeholdersB})
         AND object_entity_slug IS NOT NULL
         AND status = 'current' AND valid_to IS NULL`
    ).all(...referencedPeople, ...predicates) as Array<{ slug: string | null }>;
    for (const row of rows) {
      if (row.slug) linked.add(row.slug);
    }
  }

  return linked;
}

export function applyGraphRerank(
  results: RetrievedEntityChunk[],
  db: Database,
  query: string,
  intent: 'person_relation' | 'company_affiliation' | 'neutral',
): RetrievedEntityChunk[] {
  const predicates = detectRelationPredicates(query, intent);
  const mentioned = inferReferencedEntitySlugs(db, query);

  return results
    .map((chunk) => {
      let score = chunk.score ?? 0;
      score *= chunkIntentMultiplier(chunk, intent);
      score *= exactEntityMentionMultiplier(chunk, mentioned, intent, predicates);
      return { ...chunk, score };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}
