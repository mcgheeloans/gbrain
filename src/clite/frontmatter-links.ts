/**
 * Frontmatter link extraction: maps YAML frontmatter fields to graph edges.
 *
 * Inspired by gbrain v0.13's FRONTMATTER_LINK_MAP. Each field maps to
 * a predicate type with direction hints so that `company: Acme` on a
 * person page becomes a `works_at` edge from the person to the company.
 */

import type { Database } from 'bun:sqlite';

// ── Link map ──────────────────────────────────────────────────────────

export interface FieldMapping {
  predicate: string;
  /** 'outgoing' = subject→object, 'incoming' = object→subject */
  direction: 'outgoing' | 'incoming';
  /** Hint for resolving names to slugs */
  dirHint: string;
  /** Whether the field can be an array */
  multi: boolean;
}

/**
 * Maps frontmatter YAML fields to edge predicates.
 *
 * Direction semantics:
 *   outgoing = the page's entity is the subject, the referenced entity is the object
 *   incoming = the referenced entity is the subject, the page's entity is the object
 *
 * Example: `company: Acme` on `people/jane` page
 *   → direction: outgoing → jane (subject) works_at acme (object)
 *
 * Example: `key_people: [Alice, Bob]` on `companies/acme` page
 *   → direction: incoming → alice (subject) works_at acme (object)
 */
export const FRONTMATTER_LINK_MAP: Record<string, FieldMapping> = {
  // Person pages
  company:      { predicate: 'works_at',        direction: 'outgoing', dirHint: 'companies', multi: false },
  companies:    { predicate: 'works_at',        direction: 'outgoing', dirHint: 'companies', multi: true },
  employer:     { predicate: 'works_at',        direction: 'outgoing', dirHint: 'companies', multi: false },
  advisor_to:   { predicate: 'advisor_to',      direction: 'outgoing', dirHint: 'companies', multi: true },
  reports_to:   { predicate: 'reports_to',      direction: 'outgoing', dirHint: 'people',    multi: false },

  // Company pages
  key_people:   { predicate: 'works_at',        direction: 'incoming', dirHint: 'people',    multi: true },
  founders:     { predicate: 'founded',         direction: 'incoming', dirHint: 'people',    multi: true },
  investors:    { predicate: 'invested_in',     direction: 'incoming', dirHint: 'people',    multi: true },
  partner:      { predicate: 'partner_of',      direction: 'incoming', dirHint: 'companies', multi: false },

  // Meeting pages
  attendees:    { predicate: 'attended',         direction: 'incoming', dirHint: 'people',    multi: true },

  // Any pages
  sources:      { predicate: 'cites',           direction: 'outgoing', dirHint: '',           multi: true },
  source:       { predicate: 'cites',           direction: 'outgoing', dirHint: '',           multi: false },
  related:      { predicate: 'related_to',      direction: 'outgoing', dirHint: '',           multi: true },
  see_also:     { predicate: 'related_to',      direction: 'outgoing', dirHint: '',           multi: true },
};

// ── Resolver ──────────────────────────────────────────────────────────

export interface ResolvedLink {
  subjectSlug: string;
  predicate: string;
  objectSlug: string;
  originField: string;
}

export interface UnresolvedName {
  name: string;
  field: string;
  dirHint: string;
}

/**
 * Resolve a frontmatter value to an entity slug.
 *
 * Fallback chain: exact slug match → dirHint/slug construction → title fuzzy match
 */
function resolveToSlug(
  db: Database,
  name: string,
  dirHint: string,
): string | null {
  // 1. Exact slug match (e.g. "acme" matches existing slug)
  const normalized = name.toLowerCase().replace(/\s+/g, '-');

  const exact = db.query(
    `SELECT slug FROM entities WHERE slug = ? LIMIT 1`
  ).get(normalized) as { slug: string } | null;
  if (exact) return exact.slug;

  // 2. Try with dirHint prefix (e.g. "acme" → "companies/acme")
  if (dirHint) {
    const prefixed = `${dirHint}/${normalized}`;
    const prefixedResult = db.query(
      `SELECT slug FROM entities WHERE slug = ? LIMIT 1`
    ).get(prefixed) as { slug: string } | null;
    if (prefixedResult) return prefixedResult.slug;
  }

  // 3. Title match (exact, case-insensitive)
  const titleMatch = db.query(
    `SELECT slug FROM entities WHERE LOWER(title) = ? LIMIT 1`
  ).get(name.toLowerCase()) as { slug: string } | null;
  if (titleMatch) return titleMatch.slug;

  // 4. Title match with dirHint type filter
  if (dirHint) {
    const typedMatch = db.query(
      `SELECT slug FROM entities WHERE LOWER(title) = ? AND type = ? LIMIT 1`
    ).get(name.toLowerCase(), dirHint.replace(/s$/, '')) as { slug: string } | null;
    if (typedMatch) return typedMatch.slug;
  }

  return null;
}

/**
 * Extract graph edges from frontmatter.
 *
 * @param pageSlug - The slug of the page being processed
 * @param frontmatter - Parsed YAML frontmatter (string or string[] values)
 * @param db - Database for slug resolution
 * @returns resolved links and unresolved names
 */
export function extractFrontmatterLinks(
  pageSlug: string,
  frontmatter: Record<string, unknown>,
  db: Database,
): { resolved: ResolvedLink[]; unresolved: UnresolvedName[] } {
  const resolved: ResolvedLink[] = [];
  const unresolved: UnresolvedName[] = [];

  for (const [field, value] of Object.entries(frontmatter)) {
    const mapping = FRONTMATTER_LINK_MAP[field];
    if (!mapping) continue;

    // Normalize value to string array
    const names: string[] = [];
    if (typeof value === 'string') {
      names.push(value);
    } else if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === 'string') names.push(v);
      }
    }
    // Skip non-multi fields with multiple values
    if (!mapping.multi && names.length > 1) {
      names.length = 1;
    }

    for (const name of names) {
      const objectSlug = resolveToSlug(db, name, mapping.dirHint);

      if (!objectSlug || objectSlug === pageSlug) {
        unresolved.push({ name, field, dirHint: mapping.dirHint });
        continue;
      }

      if (mapping.direction === 'outgoing') {
        resolved.push({
          subjectSlug: pageSlug,
          predicate: mapping.predicate,
          objectSlug,
          originField: field,
        });
      } else {
        // Incoming: the referenced entity is the subject
        resolved.push({
          subjectSlug: objectSlug,
          predicate: mapping.predicate,
          objectSlug: pageSlug,
          originField: field,
        });
      }
    }
  }

  return { resolved, unresolved };
}
