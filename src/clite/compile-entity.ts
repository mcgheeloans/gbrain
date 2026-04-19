/**
 * Compile an entity: render wiki page + topic-specific LanceDB chunks.
 *
 * Factory dispatch by entity type:
 *   - person  → renderPersonPage + person topic chunks
 *   - company → renderCompanyPage + company topic chunks
 *   - project → renderProjectPage + project topic chunks
 *
 * Pipeline:
 *   1. Read entity state from SQLite
 *   2. Render wiki page markdown (for memory-wiki / Obsidian)
 *   3. Render topic-specific chunks (for LanceDB embedding diversity)
 *   4. Write wiki page to disk
 *   5. Index topic chunks in LanceDB (awaited)
 *   6. Mark compiled (freshness)
 */

import type { Database } from 'bun:sqlite';
import type { WritePageResult } from './write-page.ts';
import { getEntityState, resolveEntityTitles, type EntityState } from './read-models.ts';
import { renderPersonPage } from './render-person.ts';
import { renderCompanyPage } from './render-company-page.ts';
import { renderProjectPage } from './render-project-page.ts';
import { renderTopicChunks } from './render-topic-chunks.ts';
import { writePersonPage } from './write-page.ts';
import { indexTopicChunks } from './index-person.ts';

export type { EntityState };

/**
 * Compile any entity type to a wiki page + LanceDB chunks.
 *
 * Returns null if the entity doesn't exist or has an unsupported type.
 */
export async function compileEntity(
  db: Database,
  entitySlug: string,
  pagesDir: string = 'pages',
  writeFn?: (path: string, content: string) => void
): Promise<WritePageResult | null> {
  const state = getEntityState(db, entitySlug);
  if (!state) return null;

  const slugTitleMap = buildSlugTitleMap(db, state);
  const entityType = state.entity.type;

  // ── Render wiki page by entity type ──────────────────────────────
  let page: { entitySlug: string; content: string; contentHash: string };

  switch (entityType) {
    case 'person':
      page = renderPersonPage(state, slugTitleMap);
      break;
    case 'company':
      page = renderCompanyPage(state, slugTitleMap);
      break;
    case 'project':
      page = renderProjectPage(state, slugTitleMap);
      break;
    default:
      // Unknown type — skip compilation
      return null;
  }

  // ── Write wiki page ──────────────────────────────────────────────
  const result = writePersonPage(pagesDir, page as any, db, writeFn);
  if (!result) return null;

  // ── Topic chunks + LanceDB indexing ───────────────────────────────
  // Pass entityType so renderTopicChunks uses the right predicate-topic map
  const topicChunks = renderTopicChunks(state, slugTitleMap, entityType);

  try {
    await indexTopicChunks(
      entitySlug,
      state.entity.title ?? state.entity.slug,
      topicChunks,
      { db, entityType }
    );
  } catch (err) {
    console.warn(`[clite] LanceDB indexing failed for "${entitySlug}": ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  return result;
}

/**
 * Backward-compatibility alias for person-only compile.
 * Use compileEntity for all entity types.
 */
export const compilePerson = compileEntity;

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Collect object_entity_slug values from triples and resolve them to titles.
 */
function buildSlugTitleMap(db: Database, state: EntityState): Map<string, string> {
  const slugs = new Set<string>();
  for (const t of state.triples) {
    if (t.object_entity_slug) slugs.add(t.object_entity_slug);
    if (t.subject_entity_slug) slugs.add(t.subject_entity_slug);
  }
  return slugs.size > 0 ? resolveEntityTitles(db, slugs) : new Map();
}
