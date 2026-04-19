/**
 * Topic-specific chunk rendering for person entities.
 *
 * Instead of one monolithic compiled page, this produces multiple
 * topic-focused chunks per person, each with unique vocabulary
 * that produces distinctive embeddings.
 *
 * Topics are derived from the structured triples in the SQLite sidecar:
 *   - employment: works_at, role, department
 *   - skills/expertise: specializes_in, knows, certified_in
 *   - relationships: manages, reports_to, collaborates_with, mentored_by
 *   - projects: leads, contributes_to, owns
 *   - education: educated_at, degree
 *   - background: anything else (summary, aliases, generic triples)
 *
 * Each topic chunk is a self-contained paragraph that includes
 * the person's name and enough context to be meaningful on its own.
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

// Predicate → topic mapping
const PREDICATE_TOPICS: Record<string, string> = {
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

const TOPIC_LABELS: Record<string, string> = {
  employment: 'Employment',
  skills: 'Skills & Expertise',
  relationships: 'Relationships & Team',
  projects: 'Projects & Initiatives',
  education: 'Education & Background',
  background: 'Overview',
};

const TOPIC_PRIORITY: Record<string, number> = {
  employment: 10,
  skills: 9,
  relationships: 8,
  projects: 7,
  education: 5,
  background: 3,
};

/**
 * Group triples by their inferred topic.
 */
function groupByTopic(triples: TripleRow[]): Map<string, TripleRow[]> {
  const groups = new Map<string, TripleRow[]>();
  for (const t of triples) {
    const topic = PREDICATE_TOPICS[t.predicate] ?? 'background';
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

  const label = TOPIC_LABELS[topic] ?? topic;
  const joined = parts.join('. ');

  switch (topic) {
    case 'employment':
      return `${name} — Employment: ${joined}.`;
    case 'skills':
      return `${name} — Skills & Expertise: ${name} ${joined}.`;
    case 'relationships':
      return `${name} — Relationships: ${name} ${joined}.`;
    case 'projects':
      return `${name} — Projects: ${name} ${joined}.`;
    case 'education':
      return `${name} — Education: ${name} ${joined}.`;
    default:
      return `${name}: ${joined}.`;
  }
}

/**
 * Render topic-specific chunks for a person entity.
 *
 * Returns one TopicChunk per topic that has at least one triple,
 * plus a background/overview chunk with the entity summary and aliases.
 */
export function renderTopicChunks(
  state: EntityState,
  slugTitleMap?: Map<string, string>,
): TopicChunk[] {
  const { entity, triples, aliases } = state;
  const name = entity.title ?? entity.slug;
  const chunks: TopicChunk[] = [];

  // Group subject triples by topic
  const subjectTriples = triples.filter(t => t.subject_entity_slug === entity.slug);
  const topicGroups = groupByTopic(subjectTriples);

  // Render each topic group
  for (const [topic, topicTriples] of topicGroups) {
    chunks.push({
      topic,
      label: TOPIC_LABELS[topic] ?? topic,
      text: renderTopicParagraph(name, topic, topicTriples, slugTitleMap),
      priority: TOPIC_PRIORITY[topic] ?? 1,
    });
  }

  // Background/overview chunk: summary + aliases
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
      label: 'Overview',
      text: `${name}. ${backgroundParts.join('. ')}.`,
      priority: TOPIC_PRIORITY.background,
    });
  }

  // Ensure at least one chunk exists
  if (chunks.length === 0) {
    chunks.push({
      topic: 'background',
      label: 'Overview',
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
