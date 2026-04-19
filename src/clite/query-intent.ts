import type { Database } from 'bun:sqlite';
import type { RetrievedEntityChunk } from './retrieve-person.ts';

export function detectQueryIntent(query: string): 'person_relation' | 'company_affiliation' | 'neutral' {
  const q = query.toLowerCase();
  const asksForPerson = /\b(who|founder|founded|invested|investor|advisor|employee|employees|works on|team)\b/.test(q);
  const asksForCompany = /\b(company|employer|organization|where does .* work|where .* works)\b/.test(q);

  if (asksForCompany) return 'company_affiliation';
  if (asksForPerson) return 'person_relation';
  return 'neutral';
}

export function pageIntentMultiplier(entityType: string | undefined, intent: 'person_relation' | 'company_affiliation' | 'neutral'): number {
  if (!entityType || intent === 'neutral') return 1;
  if (intent === 'person_relation') {
    if (entityType === 'person') return 1.35;
    if (entityType === 'company') return 0.82;
  }
  if (intent === 'company_affiliation') {
    if (entityType === 'company') return 1.35;
    if (entityType === 'person') return 0.82;
  }
  return 1;
}

export function chunkIntentMultiplier(chunk: RetrievedEntityChunk, intent: 'person_relation' | 'company_affiliation' | 'neutral'): number {
  if (intent === 'neutral') return 1;

  const entityType = chunk.entityType;
  const topic = typeof chunk.metadata?.topic === 'string' ? String(chunk.metadata.topic) : '';
  const text = chunk.text.toLowerCase();
  let mult = 1;

  if (intent === 'person_relation') {
    if (entityType === 'person') mult *= 1.45;
    if (entityType === 'company') mult *= 0.7;

    if (topic === 'relationships' || topic === 'team' || topic === 'employment' || topic === 'founding') mult *= 1.2;
    if (chunk.chunkSource === 'compiled_truth' && entityType === 'company') mult *= 0.75;
    if (/\b(founded by|invested by|advisor|employee|team|works at|reports to|manages)\b/.test(text)) mult *= 1.15;
  }

  if (intent === 'company_affiliation') {
    if (entityType === 'company') mult *= 1.45;
    if (entityType === 'person') mult *= 0.72;

    if (topic === 'employment' || topic === 'info' || topic === 'location' || topic === 'industry') mult *= 1.15;
    if (chunk.chunkSource === 'compiled_truth' && entityType === 'company') mult *= 1.15;
    if (/\b(company|organization|employer|works at|headquarters|industry)\b/.test(text)) mult *= 1.1;
  }

  return mult;
}

export function detectRelationPredicates(query: string, intent: 'person_relation' | 'company_affiliation' | 'neutral'): string[] {
  const q = query.toLowerCase();
  if (intent === 'person_relation') {
    if (/\b(founder|founded)\b/.test(q)) return ['founders', 'founded_by', 'founded'];
    if (/\b(invested|investor)\b/.test(q)) return ['investors', 'invested_in'];
    if (/\b(advisor|advisors)\b/.test(q)) return ['advisors', 'advisor_to'];
    if (/\b(employee|employees|team|works on)\b/.test(q)) return ['employees', 'works_at', 'primary_affiliation'];
  }
  if (intent === 'company_affiliation') {
    if (/\b(company|employer|organization|where does .* work|where .* works)\b/.test(q)) {
      return ['works_at', 'primary_affiliation'];
    }
  }
  return [];
}

export function inferReferencedEntitySlugs(db: Database, query: string): Array<{ slug: string; type: string; title: string }> {
  const q = query.toLowerCase();
  const entities = db.query(
    `SELECT slug, type, title FROM entities ORDER BY length(title) DESC`
  ).all() as Array<{ slug: string; type: string; title: string }>;

  return entities.filter((e) => {
    const title = e.title.toLowerCase();
    return title.length >= 3 && q.includes(title);
  });
}

export function exactEntityMentionMultiplier(
  chunk: RetrievedEntityChunk,
  mentioned: Array<{ slug: string; type: string; title: string }>,
  intent: 'person_relation' | 'company_affiliation' | 'neutral',
  predicates: string[],
): number {
  if (mentioned.length === 0 || intent === 'neutral') return 1;

  const text = `${chunk.title} ${chunk.text}`.toLowerCase();
  let mult = 1;

  if (intent === 'person_relation') {
    const companies = mentioned.filter((e) => e.type === 'company');
    for (const company of companies) {
      const companyTitle = company.title.toLowerCase();
      if (companyTitle.length < 3) continue;
      if (text.includes(companyTitle)) mult *= 1.35;
      else if (chunk.entityType === 'person') mult *= 0.88;

      if (predicates.includes('investors') || predicates.includes('invested_in')) {
        if (/\b(invested|investor|backed|led the|portfolio)\b/.test(text) && text.includes(companyTitle)) mult *= 1.2;
      }
      if (predicates.includes('founders') || predicates.includes('founded_by') || predicates.includes('founded')) {
        if (/\b(founder|founded|co-founded)\b/.test(text) && text.includes(companyTitle)) mult *= 1.2;
      }
      if (predicates.includes('advisors') || predicates.includes('advisor_to')) {
        if (/\b(advisor|advises|advising)\b/.test(text) && text.includes(companyTitle)) mult *= 1.2;
      }
    }
  }

  if (intent === 'company_affiliation') {
    const people = mentioned.filter((e) => e.type === 'person');
    for (const person of people) {
      const personTitle = person.title.toLowerCase();
      if (personTitle.length < 3) continue;
      if (text.includes(personTitle)) mult *= 1.2;
    }
  }

  return mult;
}
