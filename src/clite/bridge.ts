/**
 * Bridge module: accepts structured input, commits canonical truth to the
 * SQLite sidecar, and optionally triggers projection (compile + index).
 *
 * Key invariant: projection failure must NEVER roll back canonical writes.
 *
 * ## put_page routing decision (Phase 3)
 *
 * Entity-shaped content (people/..., companies/..., projects/...):
 *   → This bridge: canonical commit + compile + index
 *   → compileEntity returns WritePageResult or null for unknown types
 *
 * Non-entity content (meetings/..., notes/..., etc.):
 *   → Core put_page operation (importFromContent): chunk + embed + reconcile
 *   → Does NOT go through this bridge — no canonical truth, no projection
 *   → Stored as compatibility pages with standard search indexing
 *
 * This split exists because canonical truth requires entity-shaped data
 * (triples, timeline, structured aliases). Non-entity pages don't have
 * that structure and don't need canonical projection.
 */

import type { Database } from 'bun:sqlite';
import { upsertEntity, addAlias, getEntityBySlug } from './entities.ts';
import { insertTriple } from './triples.ts';
import { appendTimelineEvent } from './timeline.ts';
import { recomputeFreshness } from './freshness.ts';
import { compileEntity } from './compile-entity.ts';
import { extractFrontmatterLinks } from './frontmatter-links.ts';
import { removeFrontmatterTriples } from './triples.ts';

// ── Public types ───────────────────────────────────────────────────────

export interface BridgeEntityInput {
  slug: string;
  type: string;
  title: string;
  summary?: string;
  aliases?: string[];
}

export interface BridgeTripleInput {
  subjectSlug: string;
  predicate: string;
  objectEntitySlug?: string;
  objectLiteral?: string;
}

export interface BridgeTimelineInput {
  entitySlug: string;
  date: string;
  summary: string;
  eventType?: string;
}

export interface BridgeInput {
  entities: BridgeEntityInput[];
  triples: BridgeTripleInput[];
  timeline: BridgeTimelineInput[];
  frontmatter?: Record<string, unknown>;
  sourceSlug?: string;
  sourceRef?: string;
}

export interface BridgeProjectionStatus {
  attempted: boolean;
  succeeded: string[];
  failed: Array<{ slug: string; error: string }>;
}

export interface BridgeResult {
  canonical: {
    committed: boolean;
    entitySlugs: string[];
    tripleCount: number;
    timelineCount: number;
    frontmatterLinks: number;
    unresolved: Array<{ name: string; field: string; dirHint: string }>;
    error?: string;
  };
  projections: {
    compiled: BridgeProjectionStatus;
    retrieval: BridgeProjectionStatus;
  };
}

export interface BridgeOptions {
  compile?: boolean;   // Run compile after canonical commit. Default: false
  index?: boolean;     // Run retrieval indexing. Default: same as compile
  pagesDir?: string;   // Pages output directory. Default: 'pages'
}

// ── Page routing (Phase 3) ───────────────────────────────────────────

const ENTITY_TYPE_PREFIXES = ['people/', 'companies/', 'projects/'] as const;

/**
 * Determine whether a page slug should be routed through the entity bridge
 * or handled by the generic put_page path.
 *
 * Entity slugs: people/*, companies/*, projects/* → canonical + projection
 * Non-entity slugs: everything else → generic put_page (chunk + embed)
 */
export function isEntitySlug(slug: string): boolean {
  return ENTITY_TYPE_PREFIXES.some((prefix) => slug.startsWith(prefix));
}

// ── Empty result helpers ───────────────────────────────────────────────

function emptyProjectionStatus(): BridgeProjectionStatus {
  return { attempted: false, succeeded: [], failed: [] };
}

function emptyResult(): BridgeResult {
  return {
    canonical: {
      committed: false,
      entitySlugs: [],
      tripleCount: 0,
      timelineCount: 0,
      frontmatterLinks: 0,
      unresolved: [],
    },
    projections: {
      compiled: emptyProjectionStatus(),
      retrieval: emptyProjectionStatus(),
    },
  };
}

// ── Main entry point ───────────────────────────────────────────────────

/**
 * Bridge: commit canonical truth and optionally project.
 *
 * Stage 1 runs inside a single db.transaction(). If it fails, we return
 * early with committed=false.
 *
 * Stage 2 (projection) runs outside the transaction so a compile failure
 * cannot roll back canonical writes. Each entity compiles independently.
 */
export async function bridge(
  db: Database,
  input: BridgeInput,
  options?: BridgeOptions
): Promise<BridgeResult> {
  const { entities, triples, timeline } = input;

  // Early return for empty input (but not if frontmatter is provided)
  if (entities.length === 0 && triples.length === 0 && timeline.length === 0 && !input.frontmatter) {
    return emptyResult();
  }

  // ── Stage 1: canonical commit ──────────────────────────────────────
  const result = emptyResult();
  const affectedSlugs = new Set<string>();

  try {
    db.transaction(() => {
      // Upsert entities
      for (const e of entities) {
        upsertEntity(db, e.slug, e.type, e.title, e.summary ?? '');
        affectedSlugs.add(e.slug);

        // Add aliases
        if (e.aliases) {
          for (const alias of e.aliases) {
            addAlias(db, e.slug, alias);
          }
        }
      }

      // Insert triples
      for (const t of triples) {
        insertTriple(db, {
          subjectSlug: t.subjectSlug,
          predicate: t.predicate,
          objectEntitySlug: t.objectEntitySlug,
          objectLiteral: t.objectLiteral,
          sourceRef: input.sourceRef ?? '',
        });
        affectedSlugs.add(t.subjectSlug);
        if (t.objectEntitySlug) affectedSlugs.add(t.objectEntitySlug);
      }

      // Append timeline events
      for (const te of timeline) {
        appendTimelineEvent(db, {
          entitySlug: te.entitySlug,
          date: te.date,
          summary: te.summary,
          eventType: te.eventType,
          sourceRef: input.sourceRef ?? '',
        });
        affectedSlugs.add(te.entitySlug);
      }

      // Frontmatter link extraction (v0.13)
      // Reconcile: remove old frontmatter edges for this page, then insert new ones
      const sourceSlug = input.sourceSlug ?? (entities.length > 0 ? entities[0].slug : undefined);
      if (sourceSlug && input.frontmatter) {
        removeFrontmatterTriples(db, sourceSlug);
        const { resolved, unresolved } = extractFrontmatterLinks(
          sourceSlug, input.frontmatter, db
        );
        for (const link of resolved) {
          insertTriple(db, {
            subjectSlug: link.subjectSlug,
            predicate: link.predicate,
            objectEntitySlug: link.objectSlug,
            linkSource: 'frontmatter',
            originSlug: sourceSlug,
            originField: link.originField,
            sourceRef: input.sourceRef ?? 'frontmatter',
          });
          affectedSlugs.add(link.subjectSlug);
          affectedSlugs.add(link.objectSlug);
        }
        result.canonical.frontmatterLinks = resolved.length;
        result.canonical.unresolved = unresolved;
      }

      // Recompute freshness for all affected slugs that exist in the DB
      for (const slug of affectedSlugs) {
        if (getEntityBySlug(db, slug)) {
          recomputeFreshness(db, slug);
        }
      }
    })();

    result.canonical.committed = true;
    result.canonical.entitySlugs = [...affectedSlugs];
    result.canonical.tripleCount = triples.length;
    result.canonical.timelineCount = timeline.length;
  } catch (err) {
    result.canonical.committed = false;
    result.canonical.error = err instanceof Error ? err.message : String(err);
    return result;
  }

  // ── Stage 2: projection (outside transaction) ──────────────────────
  const shouldCompile = options?.compile ?? false;
  const shouldIndex = options?.index ?? shouldCompile;
  const pagesDir = options?.pagesDir ?? 'pages';

  if (!shouldCompile && !shouldIndex) {
    return result;
  }

  result.projections.compiled.attempted = true;
  result.projections.retrieval.attempted = true;

  for (const slug of affectedSlugs) {
    try {
      const compiled = await compileEntity(db, slug, pagesDir);
      if (compiled) {
        // compileEntity handles both wiki page + LanceDB indexing internally
        result.projections.compiled.succeeded.push(slug);
        result.projections.retrieval.succeeded.push(slug);
      }
      // null return means unsupported type — not an error, just not compiled
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      result.projections.compiled.failed.push({ slug, error: errorMsg });
      result.projections.retrieval.failed.push({ slug, error: errorMsg });
    }
  }

  return result;
}

/**
 * Commit canonical truth only (no projection).
 */
export async function commitCanonical(
  db: Database,
  input: BridgeInput
): Promise<BridgeResult> {
  return bridge(db, input, { compile: false });
}

/**
 * Commit canonical truth and run projection.
 */
export async function commitAndProject(
  db: Database,
  input: BridgeInput,
  pagesDir?: string
): Promise<BridgeResult> {
  return bridge(db, input, { compile: true, pagesDir });
}
