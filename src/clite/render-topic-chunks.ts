/**
 * Topic-specific chunk rendering for entity pages.
 *
 * Instead of one monolithic compiled page, this produces multiple
 * topic-focused chunks per entity, each with unique vocabulary
 * that produces distinctive embeddings.
 *
 * Topic maps differ by entity type:
 *   - person: employment, skills, relationships, projects, education
 *   - company: founding, industry, location, products, team, info
 *   - project: status, timeline, technology, code, deliverables
 */

import type { EntityState } from './read-models.ts';
import type { TripleRow } from './triples.ts';

export interface TopicChunk {
  /** Topic category */
  topic: string;
  /** Human-readable topic label */
  label: string;
  /** Self-contained paragraph text */
  text: string;
  /** Priority for ranking (higher = more important) */
  priority: number;
}

// ── Predicate → topic maps by entity type ────────────────────────────

const PERSON_PREDICATE_TOPICS: Record<string, string> = {
  works_at: 'employment',
  role: 'employment',
  department: 'employment',
  title: 'employment',
  employment_type: 'employment',
  specializes_in: 'skills',
  knows: 'skills',
  certified_in: 'skills',
  expertise: 'skills',
  tech_stack: 'skills',
  manages: 'relationships',
  reports_to: 'relationships',
  collaborates_with: 'relationships',
  mentored_by: 'relationships',
  mentors: 'relationships',
  leads: 'projects',
  contributes_to: 'projects',
  owns: 'projects',
  founded: 'projects',
  created: 'projects',
  educated_at: 'education',
  degree: 'education',
  alumni_of: 'education',
};

const COMPANY_PREDICATE_TOPICS: Record<string, string> = {
  founded: 'founding',
  industry: 'industry',
  headquarters: 'location',
  products: 'products',
  employee_count: 'team',
  website: 'info',
  revenue: 'info',
  stage: 'info',
  description: 'info',
};

const PROJECT_PREDICATE_TOPICS: Record<string, string> = {
  status: 'status',
  started: 'timeline',
  deadline: 'timeline',
  tech_stack: 'technology',
  repo_url: 'code',
  deliverables: 'deliverables',
  priority: 'status',
  budget: 'info',
};

// ── Topic labels per entity type ────────────────────────────────────

const PERSON_TOPIC_LABELS: Record<string, string> = {
  employment: 'Employment',
  skills: 'Skills & Expertise',
  relationships: 'Relationships & Team',
  projects: 'Projects & Initiatives',
  education: 'Education & Background',
  background: 'Overview',
};

const COMPANY_TOPIC_LABELS: Record<string, string> = {
  founding: 'Founding',
  industry: 'Industry',
  location: 'Headquarters & Location',
  products: 'Products & Services',
  team: 'Team',
  info: 'Company Info',
  background: 'Overview',
};

const PROJECT_TOPIC_LABELS: Record<string, string> = {
  status: 'Status',
  timeline: 'Timeline',
  technology: 'Technology',
  code: 'Code & Repos',
  deliverables: 'Deliverables',
  info: 'Project Info',
  background: 'Overview',
};

// ── Topic priority ──────────────────────────────────────────────────

const PERSON_TOPIC_PRIORITY: Record<string, number> = {
  employment: 10,
  skills: 9,
  relationships: 8,
  projects: 7,
  education: 5,
  background: 3,
};

const COMPANY_TOPIC_PRIORITY: Record<string, number> = {
  founding: 9,
  industry: 8,
  products: 8,
  team: 7,
  location: 6,
  info: 4,
  background: 3,
};

const PROJECT_TOPIC_PRIORITY: Record<string, number> = {
  status: 10,
  timeline: 9,
  technology: 8,
  code: 7,
  deliverables: 7,
  info: 4,
  background: 3,
};

// ── Core rendering ─────────────────────────────────────────────────

/**
 * Get the predicate-topic map for a given entity type.
 */
function getPredicateMap(entityType: string): Record<string, string> {
  switch (entityType) {
    case 'company':
      return COMPANY_PREDICATE_TOPICS;
    case 'project':
      return PROJECT_PREDICATE_TOPICS;
    case 'person':
    default:
      return PERSON_PREDICATE_TOPICS;
  }
}

function getTopicLabels(entityType: string): Record<string, string> {
  switch (entityType) {
    case 'company':
      return COMPANY_TOPIC_LABELS;
    case 'project':
      return PROJECT_TOPIC_LABELS;
    case 'person':
    default:
      return PERSON_TOPIC_LABELS;
  }
}

function getTopicPriority(entityType: string): Record<string, number> {
  switch (entityType) {
    case 'company':
      return COMPANY_TOPIC_PRIORITY;
    case 'project':
      return PROJECT_TOPIC_PRIORITY;
    case 'person':
    default:
      return PERSON_TOPIC_PRIORITY;
  }
}

/**
 * Group triples by their inferred topic using the appropriate predicate map.
 */
function groupByTopic(triples: TripleRow[], predicateMap: Record<string, string>): Map<string, TripleRow[]> {
  const groups = new Map<string, TripleRow[]>();
  for (const t of triples) {
    const topic = predicateMap[t.predicate] ?? 'background';
    if (!groups.has(topic)) groups.set(topic, []);
    groups.get(topic)!.push(t);
  }
  return groups;
}

/**
 * Render a single topic chunk as a self-contained paragraph.
 */
function renderTopicParagraph(
  name: string,
  topic: string,
  triples: TripleRow[],
  slugTitleMap?: Map<string, string>,
): string {
  const parts: string[] = [];

  for (const t of triples) {
    let obj: string;
    if (t.object_entity_slug) {
      obj = slugTitleMap?.get(t.object_entity_slug) ?? t.object_entity_slug.replace(/-/g, ' ');
    } else {
      obj = t.object_literal ?? '';
    }
    const pred = humanizePredicate(t.predicate);
    parts.push(`${pred} ${obj}`);
  }

  switch (topic) {
    case 'employment':
      return `${name} — Employment: ${parts.join('. ')}.`;
    case 'skills':
      return `${name} — Skills & Expertise: ${name} ${parts.join('. ')}.`;
    case 'relationships':
      return `${name} — Relationships: ${name} ${parts.join('. ')}.`;
    case 'projects':
      return `${name} — Projects: ${name} ${parts.join('. ')}.`;
    case 'education':
      return `${name} — Education: ${name} ${parts.join('. ')}.`;
    case 'founding':
      return `${name} — Founded: ${parts.join('. ')}.`;
    case 'industry':
      return `${name} — Industry: ${parts.join('. ')}.`;
    case 'products':
      return `${name} — Products & Services: ${parts.join('. ')}.`;
    case 'team':
      return `${name} — Team: ${parts.join('. ')}.`;
    case 'location':
      return `${name} — Location: ${parts.join('. ')}.`;
    case 'status':
      return `${name} — Status: ${parts.join('. ')}.`;
    case 'timeline':
      return `${name} — Timeline: ${parts.join('. ')}.`;
    case 'technology':
      return `${name} — Technology: ${parts.join('. ')}.`;
    case 'code':
      return `${name} — Code: ${parts.join('. ')}.`;
    case 'deliverables':
      return `${name} — Deliverables: ${parts.join('. ')}.`;
    default:
      return `${name}: ${parts.join('. ')}.`;
  }
}

/**
 * Render topic-specific chunks for an entity.
 *
 * @param state - composed entity state from getEntityState
 * @param slugTitleMap - optional map of entity slugs to display titles
 * @param entityType - entity type ('person', 'company', 'project'); defaults to state.entity.type
 */
export function renderTopicChunks(
  state: EntityState,
  slugTitleMap?: Map<string, string>,
  entityType?: string,
): TopicChunk[] {
  const { entity, triples, aliases } = state;
  const type = entityType ?? entity.type ?? 'person';
  const name = entity.title ?? entity.slug;
  const chunks: TopicChunk[] = [];

  const predicateMap = getPredicateMap(type);
  const topicLabels = getTopicLabels(type);
  const topicPriority = getTopicPriority(type);

  // Group subject triples by topic
  const subjectTriples = triples.filter(t => t.subject_entity_slug === entity.slug);
  const topicGroups = groupByTopic(subjectTriples, predicateMap);

  // Render each topic group
  for (const [topic, topicTriples] of topicGroups) {
    chunks.push({
      topic,
      label: topicLabels[topic] ?? topic,
      text: renderTopicParagraph(name, topic, topicTriples, slugTitleMap),
      priority: topicPriority[topic] ?? 1,
    });
  }

  // Background/overview chunk: summary + aliases + inbound context
  const backgroundParts: string[] = [];
  if (entity.summary) backgroundParts.push(entity.summary);
  if (aliases.length > 0) {
    backgroundParts.push(`Also known as: ${aliases.map(a => a.alias).join(', ')}`);
  }

  // Include inbound triples (where this entity is the object) as context
  const inboundTriples = triples.filter(t => t.object_entity_slug === entity.slug);
  if (inboundTriples.length > 0) {
    const inboundParts = inboundTriples.map(t => {
      const subj = slugTitleMap?.get(t.subject_entity_slug) ?? t.subject_entity_slug.replace(/-/g, ' ');
      return `${subj} ${humanizePredicate(t.predicate)} ${name}`;
    });
    backgroundParts.push(`Referenced by: ${inboundParts.join('. ')}`);
  }

  if (backgroundParts.length > 0) {
    chunks.push({
      topic: 'background',
      label: topicLabels.background ?? 'Overview',
      text: `${name}. ${backgroundParts.join('. ')}.`,
      priority: topicPriority.background ?? 1,
    });
  }

  // Ensure at least one chunk exists
  if (chunks.length === 0) {
    chunks.push({
      topic: 'background',
      label: topicLabels.background ?? 'Overview',
      text: `${name}.`,
      priority: 1,
    });
  }

  return chunks;
}

/**
 * Convert a predicate slug to a human-readable label.
 */
function humanizePredicate(predicate: string): string {
  return predicate
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
