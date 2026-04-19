import type { SearchResult } from '../types.ts';
import type { GBrainConfig } from '../config.ts';
import { open as openClite } from '../../clite/bootstrap.ts';
import { retrieveEntityPages } from '../../clite/retrieve-person.ts';

function toPageType(entityType?: string): SearchResult['type'] {
  switch (entityType) {
    case 'person':
    case 'company':
    case 'deal':
    case 'yc':
    case 'civic':
    case 'project':
    case 'concept':
    case 'source':
    case 'media':
      return entityType;
    default:
      return 'person';
  }
}

export async function cliteQuerySearch(
  config: GBrainConfig,
  query: string,
  opts: { limit?: number; offset?: number; expansion?: boolean } = {},
): Promise<SearchResult[]> {
  if (!config.clite_database_path) {
    throw new Error('C-lite query backend requested but clite_database_path is not configured');
  }

  const db = openClite(config.clite_database_path);
  try {
    const pageLimit = Math.max((opts.limit ?? 20) + (opts.offset ?? 0), 8);
    const pages = await retrieveEntityPages(query, {
      limit: pageLimit,
      db,
      expansion: opts.expansion,
    });

    return pages
      .slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 20))
      .map((page, index) => ({
        slug: page.slug,
        page_id: 0,
        title: page.title,
        type: toPageType(page.entityType),
        chunk_text: page.snippets[0] ?? '',
        chunk_source: 'compiled_truth',
        chunk_id: -(index + 1),
        chunk_index: 0,
        score: page.fusedScore,
        stale: false,
      }));
  } finally {
    db.close();
  }
}
