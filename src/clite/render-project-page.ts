/**
 * Render a project page from EntityState.
 *
 * Project pages show:
 * - Facts (subject triples): status, tech_stack, started, deadline, repo, etc.
 * - Team (inbound object triples): people linked via leads/contributes_to/owns
 */

import type { EntityState } from './read-models.ts';
import type { TripleRow } from './triples.ts';

export interface RenderedProjectPage {
  entitySlug: string;
  content: string;
  contentHash: string;
}

/**
 * Render a project page from composed entity state.
 * Deterministic: same input always produces same output.
 */
export function renderProjectPage(
  state: EntityState,
  slugTitleMap?: Map<string, string>,
): RenderedProjectPage {
  const { entity, triples } = state;

  const lines: string[] = [];

  // ── Title ─────────────────────────────────────────────────────────
  lines.push(`# ${entity.title}`);
  lines.push('');

  if (entity.summary) {
    lines.push(entity.summary);
    lines.push('');
  }

  // ── Subject triples (project attributes) ──────────────────────────
  const subjectTriples = triples.filter(t => t.subject_entity_slug === entity.slug);
  if (subjectTriples.length > 0) {
    lines.push('## Facts');
    lines.push('');

    for (const t of subjectTriples) {
      let obj: string;
      if (t.object_entity_slug) {
        obj = slugTitleMap?.get(t.object_entity_slug) ?? t.object_entity_slug;
      } else {
        obj = t.object_literal ?? '';
      }
      lines.push(`- **${humanizePredicate(t.predicate)}**: ${obj}`);
    }
    lines.push('');
  }

  // ── Team (inbound object triples: leads/contributes_to/owns) ────
  const objectTriples = triples.filter(t => t.object_entity_slug === entity.slug);
  if (objectTriples.length > 0) {
    lines.push('## Team');
    lines.push('');

    const uniquePeople = new Map<string, { name: string; roles: string[] }>();
    for (const t of objectTriples) {
      const personSlug = t.subject_entity_slug;
      const personName = slugTitleMap?.get(personSlug) ?? personSlug.replace(/-/g, ' ');
      if (!uniquePeople.has(personSlug)) {
        uniquePeople.set(personSlug, { name: personName, roles: [] });
      }
      uniquePeople.get(personSlug)!.roles.push(humanizePredicate(t.predicate));
    }

    for (const [, { name, roles }] of uniquePeople) {
      lines.push(`- **${name}**: ${roles.join(', ')}`);
    }
    lines.push('');
  }

  const content = lines.join('\n');
  return { entitySlug: entity.slug, content, contentHash: hashContent(content) };
}

// ── Helpers ─────────────────────────────────────────────────────────

function humanizePredicate(predicate: string): string {
  return predicate
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function hashContent(content: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(content);
  return hasher.digest('hex');
}
