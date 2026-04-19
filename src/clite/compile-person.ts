/**
 * Compile a person: render wiki page + topic-specific LanceDB chunks.
 *
 * Pipeline:
 *   1. Read entity state from SQLite
 *   2. Render wiki page markdown (for memory-wiki / Obsidian)
 *   3. Render topic-specific chunks (for LanceDB embedding diversity)
 *   4. Write wiki page to disk
 *   5. Index topic chunks in LanceDB (awaited)
 *   6. Mark compiled (freshness)
 *
 * The wiki page and LanceDB chunks serve different purposes:
 *   - Wiki page: human-readable, deterministic markdown for Obsidian/memory-wiki
 *   - Topic chunks: embedding-optimized paragraphs for vector search diversity
 */

import type { Database } from 'bun:sqlite';
import type { WritePageResult } from './write-page.ts';
import { getEntityState, resolveEntityTitles } from './read-models.ts';
import { renderPersonPage } from './render-person.ts';
import { renderTopicChunks } from './render-topic-chunks.ts';
import { writePersonPage } from './write-page.ts';
import { indexTopicChunks } from './index-person.ts';

export async function compilePerson(
  db: Database,
  entitySlug: string,
  pagesDir: string = 'pages',
  writeFn?: (path: string, content: string) => void
): Promise<WritePageResult | null> {
  const state = getEntityState(db, entitySlug);
  if (!state) return null;
  if (state.entity.type !== 'person') return null;

  const slugTitleMap = buildSlugTitleMap(db, state);

  // Wiki page: deterministic markdown for human reading
  const page = renderPersonPage(state, slugTitleMap);
  const result = writePersonPage(pagesDir, page, db, writeFn);
  if (!result) return null;

  // Topic chunks: embedding-optimized paragraphs for LanceDB
  const topicChunks = renderTopicChunks(state, slugTitleMap);

  try {
    await indexTopicChunks(entitySlug, state.entity.title ?? state.entity.slug, topicChunks, { db });
  } catch (err) {
    console.warn(`[clite] LanceDB indexing failed for "${entitySlug}": ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  return result;
}

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

// Re-export types needed by consumers
export type { EntityState } from './read-models.ts';
