/**
 * Convenience: compile a person page from SQLite state and write it.
 *
 * 1. Read entity state from SQLite
 * 2. Render person page markdown
 * 3. Write page to disk
 * 4. Index in LanceDB (retrieval projection) — awaited
 * 5. Mark compiled (freshness)
 *
 * Steps 4 and 5 are downstream projections — failure of either does NOT
 * invalidate the canonical SQLite truth record or wiki file.
 * Step 5 (mark compiled) is updated only after the LanceDB write succeeds,
 * so that a stale freshness record will trigger retry on next compile.
 *
 * Returns null if entity not found or not a person type.
 */

import type { Database } from 'bun:sqlite';
import type { WritePageResult } from './write-page.ts';
import { getEntityState, resolveEntityTitles } from './read-models.ts';
import { renderPersonPage } from './render-person.ts';
import { writePersonPage } from './write-page.ts';
import { indexPersonPage } from './index-person.ts';

export async function compilePerson(
  db: Database,
  entitySlug: string,
  pagesDir: string = 'pages',
  writeFn?: (path: string, content: string) => void
): Promise<WritePageResult | null> {
  const state = getEntityState(db, entitySlug);
  if (!state) return null;
  if (state.entity.type !== 'person') return null;

  const page = renderPersonPage(state, buildSlugTitleMap(db, state));
  const result = writePersonPage(pagesDir, page, db, writeFn);
  if (!result) return null;

  // Index compiled page in LanceDB (downstream retrieval projection)
  // Failure here does NOT roll back the canonical write.
  try {
    await indexPersonPage(entitySlug, state.entity.title ?? state.entity.slug, page.content, { db });
  } catch (err) {
    console.warn(`[clite] LanceDB indexing failed for "${entitySlug}": ${err instanceof Error ? err.message : String(err)}`);
    // Leave entity_freshness stale so retry fires on next compile
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
  }
  return slugs.size > 0 ? resolveEntityTitles(db, slugs) : new Map();
}
