/**
 * Render a company page from EntityState.
 *
 * Company pages differ from person pages:
 * - Show BOTH subject triples (company attributes) and inbound object triples
 *   (people who work here, manage it, founded it)
 * - Organized into Facts (subject), Team (inbound works_at/manages), and
 *   optionally Products/Services
 */

import type { EntityState } from './read-models.ts';
import type { TripleRow } from './triples.ts';

export interface RenderedCompanyPage {
  entitySlug: string;
  content: string;
  contentHash: string;
}

/**
 * Render a company page from composed entity state.
 * Deterministic: same input always produces same output.
 */
export function renderCompanyPage(
  state: EntityState,
  slugTitleMap?: Map<string, string>,
): RenderedCompanyPage {
  const { entity, triples } = state;

  const lines: string[] = [];

  // ── Title ─────────────────────────────────────────────────────────
  lines.push(`# ${entity.title}`);
  lines.push('');

  if (entity.summary) {
    lines.push(entity.summary);
    lines.push('');
  }

  // ── Separate subject vs object triples ──────────────────────────
  const subjectTriples = triples.filter(t => t.subject_entity_slug === entity.slug);
  const objectTriples = triples.filter(t => t.object_entity_slug === entity.slug);

  // Subject triples: company attributes (founded, industry, products, etc.)
  const subjectMap = groupByPredicate(subjectTriples);

  // Object triples: people who work here / manage it / founded it
  const worksAt = objectTriples.filter(t => t.predicate === 'works_at');
  const manages = objectTriples.filter(t => t.predicate === 'manages');
  const foundedBy = objectTriples.filter(t => t.predicate === 'founded_by');
  const allTeam = [...manages, ...foundedBy, ...worksAt];

  // ── Facts (subject triples) ─────────────────────────────────────
  if (subjectTriples.length > 0) {
    lines.push('## Facts');
    lines.push('');

    for (const [predicate, tList] of subjectMap) {
      const values = tList.map(t =>
        t.object_entity_slug
          ? (slugTitleMap?.get(t.object_entity_slug) ?? t.object_entity_slug)
          : (t.object_literal ?? '')
      ).filter(Boolean);

      if (values.length > 0) {
        lines.push(`- **${humanizePredicate(predicate)}**: ${values.join(', ')}`);
      }
    }
    lines.push('');
  }

  // ── Team (inbound object triples) ───────────────────────────────
  if (allTeam.length > 0) {
    lines.push('## Team');
    lines.push('');

    const uniquePeople = new Map<string, { name: string; roles: string[] }>();
    for (const t of allTeam) {
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

function groupByPredicate(triples: TripleRow[]): Map<string, TripleRow[]> {
  const map = new Map<string, TripleRow[]>();
  for (const t of triples) {
    if (!map.has(t.predicate)) map.set(t.predicate, []);
    map.get(t.predicate)!.push(t);
  }
  return map;
}

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
