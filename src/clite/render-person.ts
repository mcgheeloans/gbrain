/**
 * Render a person page from EntityState.
 *
 * First-slice: deterministic, narrow template for person entities.
 * Output is plain markdown with two sections:
 *   1. Compiled truth — current triples rendered as readable key-value pairs
 *   2. Timeline — recent events as a reverse-chronological list
 */

import type { EntityState } from './read-models.ts';

export interface RenderedPersonPage {
  /** Entity slug this page was rendered from */
  entitySlug: string;
  /** Full page content (markdown) */
  content: string;
  /** SHA-256 hex digest of content, for idempotency check */
  contentHash: string;
}

/**
 * Render a person page from composed entity state.
 * Deterministic: same input always produces same output.
 */
export function renderPersonPage(state: EntityState, slugTitleMap?: Map<string, string>): RenderedPersonPage {
  const { entity, triples, recentTimeline } = state;

  const lines: string[] = [];

  // ── Title ─────────────────────────────────────────────────────────
  lines.push(`# ${entity.title}`);
  lines.push('');

  if (entity.summary) {
    lines.push(entity.summary);
    lines.push('');
  }

  // ── Compiled truth ────────────────────────────────────────────────
  // Only triples where this entity is the subject.
  // Triples where entity is the object (e.g. "someone works here" for a company)
  // are excluded for person pages — they'd show up on the other entity's page.
  const subjectTriples = triples.filter(
    t => t.subject_entity_slug === entity.slug
  );

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

  // ── Timeline ──────────────────────────────────────────────────────
  if (recentTimeline.length > 0) {
    lines.push('## Timeline');
    lines.push('');

    for (const evt of recentTimeline) {
      lines.push(`- **${evt.date}**: ${evt.summary}`);
    }
    lines.push('');
  }

  const content = lines.join('\n');
  const contentHash = hashContent(content);

  return { entitySlug: entity.slug, content, contentHash };
}

/**
 * Simple SHA-256 hash of the content for idempotency checks.
 */
function hashContent(content: string): string {
  // Bun's crypto is synchronous and fast
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(content);
  return hasher.digest('hex');
}

/**
 * Convert a predicate slug to a human-readable label.
 * e.g. "works_at" → "Works at", "role" → "Role"
 */
function humanizePredicate(predicate: string): string {
  return predicate
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
