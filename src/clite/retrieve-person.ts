/**
 * Thin retrieval reader for compiled C-lite person pages.
 *
 * Queries the shared LanceDB projection written by indexPersonPage() and returns
 * matching compiled chunks. This is intentionally narrow for v1:
 * - scope limited to gbrain:people
 * - vector search only
 * - returns chunk-level hits, not fused page-level ranking yet
 */

import type { Database } from 'bun:sqlite';
import { JinaEmbedder } from './embedder.ts';
import { getSharedTable } from './lance-store.ts';
import { parseMetadata, chunkKey, dedupResults, tokenize } from './search-dedup.ts';
import { cosineReScore, keywordScore, getBacklinkCounts, applyBacklinkBoost, normalizeChunkScores, COMPILED_TRUTH_BOOST } from './search-scoring.ts';
import { detectQueryIntent, pageIntentMultiplier } from './query-intent.ts';
import { applyGraphRerank } from './graph-rerank.ts';

const SCOPE = 'gbrain:entities';
const RRF_K = 60;
const DEFAULT_EXPANSION_LIMIT = 3;

const QUERY_EXPANSION_MAP: Record<string, string[]> = {
  works: ['work', 'job', 'role'],
  work: ['works', 'job', 'role'],
  job: ['work', 'works', 'role'],
  role: ['job', 'position', 'title'],
  company: ['organization', 'employer'],
  employer: ['company', 'organization'],
  partnership: ['partner', 'alliance', 'collaboration'],
  renewal: ['deadline', 'expires', 'expiration'],
  deadline: ['due', 'renewal', 'expires'],
  people: ['person', 'contact'],
  person: ['people', 'contact'],
};

export interface RetrievedEntityChunk {
  id: string;
  text: string;
  score?: number;
  slug: string;
  title: string;
  entityType?: string;
  chunkIndex?: number;
  chunkSource?: string;
  metadata: Record<string, unknown>;
  vector?: number[];
}

export interface RetrievedEntityPage {
  slug: string;
  title: string;
  entityType?: string;
  bestScore?: number;
  fusedScore: number;
  chunkCount: number;
  snippets: string[];
  chunks: RetrievedEntityChunk[];
}

function expandQueryTermsLocal(query: string, limit = DEFAULT_EXPANSION_LIMIT): string[] {
  const variants = new Set<string>([query.trim()]);
  const tokens = tokenize(query);

  for (const token of tokens) {
    const expansions = QUERY_EXPANSION_MAP[token] ?? [];
    for (const expansion of expansions) {
      variants.add(tokens.map((t) => (t === token ? expansion : t)).join(' '));
      if (variants.size >= limit + 1) {
        return [...variants].filter(Boolean).slice(0, limit + 1);
      }
    }
  }

  return [...variants].filter(Boolean).slice(0, limit + 1);
}

/**
 * LLM-powered expansion using memory-lancedb-pro's OAuth (gpt-5.4-mini, free tier).
 * Falls back to local term-map expansion on any failure.
 */
async function expandQueryTermsLlm(query: string, limit = DEFAULT_EXPANSION_LIMIT): Promise<string[]> {
  try {
    const { expandQueryWithLlm } = await import('./llm-expand.ts');
    const expanded = await expandQueryWithLlm(query, { maxVariants: limit });
    if (expanded.length > 1) return expanded;
    // LLM returned only the original — fall back to local
    return expandQueryTermsLocal(query, limit);
  } catch {
    return expandQueryTermsLocal(query, limit);
  }
}

async function ftsKeywordSearch(db: Database, query: string, limit: number): Promise<RetrievedEntityChunk[]> {
  // Use FTS5 for fast keyword matching instead of loading all chunks into memory.
  // Note: FTS5 MATCH does not support ? parameter binding in bun:sqlite, use interpolation.
  // FTS5 query syntax: tokens separated by space = AND, OR between groups with OR keyword.
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  // Sanitize FTS5 tokens: each token is double-quoted so FTS5 treats it as a
  // literal phrase. This neutralizes FTS5 operators (OR, NOT, NEAR, AND, *, ^).
  // The tokenizer already strips non-alphanumeric chars, but we additionally
  // escape double-quotes inside tokens for correctness.
  const ftsQuery = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');

  try {
    const rows = db.query(
      `SELECT slug, title, text, rank
       FROM person_chunks_fts
       WHERE person_chunks_fts MATCH '${ftsQuery}'
       ORDER BY rank
       LIMIT ${limit}`
    ).all() as Array<{ slug: string; title: string; text: string; rank: number }>;

    return rows
      .filter((row) => row.text != null)
      .map((row) => ({
        id: `fts:${row.slug}:${row.rank}`,
        text: row.text ?? '',
        slug: row.slug ?? '',
        title: row.title ?? '',
        score: row.rank != null ? -row.rank : 0,
        metadata: {},
      } satisfies RetrievedEntityChunk));
  } catch {
    return [];
  }
}

/** Fallback: load all scope chunks from LanceDB (used when no SQLite db is available). */
async function fetchScopeChunksFallback(): Promise<RetrievedEntityChunk[]> {
  const table = await getSharedTable();
  const rows = await table
    .query()
    .where(`scope = '${SCOPE}'`)
    .select(['id', 'text', 'metadata', 'vector'])
    .toArray();

  return rows.map((row: any) => {
    const metadata = parseMetadata(row.metadata);
    return {
      id: row.id,
      text: row.text,
      slug: typeof metadata.slug === 'string' ? metadata.slug : '',
      title: typeof metadata.title === 'string' ? metadata.title : '',
      entityType: typeof metadata.entity_type === 'string' ? metadata.entity_type : undefined,
      chunkIndex: typeof metadata.chunk_index === 'number' ? metadata.chunk_index : undefined,
      chunkSource: typeof metadata.chunk_source === 'string' ? metadata.chunk_source : undefined,
      metadata,
      vector: Array.isArray(row.vector) ? row.vector : undefined,
    } satisfies RetrievedEntityChunk;
  });
}

async function retrieveEntityChunksWithVector(
  query: string,
  queryVector: number[],
  options: { limit?: number } = {},
): Promise<RetrievedEntityChunk[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const limit = options.limit ?? 5;
  const table = await getSharedTable();

  const rows = await table
    .query()
    .nearestTo(queryVector)
    .where(`scope = '${SCOPE}'`)
    .limit(limit)
    .select(['id', 'text', 'metadata', 'vector', '_distance'])
    .toArray();

  return normalizeChunkScores(rows.map((row: any) => {
    const metadata = parseMetadata(row.metadata);
    return {
      id: row.id,
      text: row.text,
      score: typeof row._distance === 'number' ? row._distance : undefined,
      slug: typeof metadata.slug === 'string' ? metadata.slug : '',
      title: typeof metadata.title === 'string' ? metadata.title : '',
      entityType: typeof metadata.entity_type === 'string' ? metadata.entity_type : undefined,
      chunkIndex: typeof metadata.chunk_index === 'number' ? metadata.chunk_index : undefined,
      chunkSource: typeof metadata.chunk_source === 'string' ? metadata.chunk_source : undefined,
      metadata,
      vector: Array.isArray(row.vector) ? row.vector : undefined,
    } satisfies RetrievedEntityChunk;
  }));
}

export async function retrieveEntityChunks(
  query: string,
  options: { limit?: number } = {},
): Promise<RetrievedEntityChunk[]> {
  const embedder = new JinaEmbedder();
  const queryVector = await embedder.embedQuery(query.trim());
  return retrieveEntityChunksWithVector(query, queryVector, options);
}

export async function searchEntityChunks(
  query: string,
  options: { limit?: number; keywordLimit?: number; vectorLimit?: number; db?: Database; expansion?: boolean; expansionLimit?: number; graphRerank?: boolean } = {},
): Promise<RetrievedEntityChunk[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const limit = options.limit ?? 8;
  const vectorLimit = options.vectorLimit ?? Math.max(limit * 2, 8);
  const keywordLimit = options.keywordLimit ?? Math.max(limit * 3, 12);
  const queries = options.expansion === false ? [trimmed] : await expandQueryTermsLlm(trimmed, options.expansionLimit);
  const intent = detectQueryIntent(trimmed);

  const embedder = new JinaEmbedder();
  const queryVector = await embedder.embedQuery(trimmed);

  const vectorLists: RetrievedEntityChunk[][] = [];
  for (const q of queries) {
    const qVector = q === trimmed ? queryVector : await embedder.embedQuery(q);
    vectorLists.push(await retrieveEntityChunksWithVector(q, qVector, { limit: vectorLimit }));
  }

  // Keyword search via FTS5 when db is available, otherwise fall back to in-memory scoring
  const keywordLists: RetrievedEntityChunk[][] = [];
  if (options.db) {
    for (const q of queries) {
      keywordLists.push(await ftsKeywordSearch(options.db, q, keywordLimit));
    }
  } else {
    const lexicalPool = await fetchScopeChunksFallback();
    for (const q of queries) {
      keywordLists.push(lexicalPool
        .map((chunk) => ({ ...chunk, score: keywordScore(q, chunk.text, chunk.title) }))
        .filter((chunk) => (chunk.score ?? 0) > 0)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, keywordLimit));
    }
  }

  const fused = new Map<string, RetrievedEntityChunk>();
  const vectorByKey = new Map(vectorLists.flat().map((chunk) => [chunkKey(chunk), chunk]));
  const applyRrf = (chunks: RetrievedEntityChunk[], source: 'vector' | 'keyword') => {
    chunks.forEach((chunk, index) => {
      const key = chunkKey(chunk);
      const existing = fused.get(key);
      const rrf = 1 / (RRF_K + index + 1);
      if (!existing) {
        fused.set(key, { ...chunk, score: rrf });
        return;
      }
      existing.score = (existing.score ?? 0) + rrf;
      if (source === 'vector' && vectorByKey.has(key)) {
        existing.text = chunk.text;
      }
    });
  };

  for (const vectorChunks of vectorLists) applyRrf(vectorChunks, 'vector');
  for (const keywordChunks of keywordLists) applyRrf(keywordChunks, 'keyword');

  let results = [...fused.values()].map((chunk) => {
    let score = chunk.score ?? 0;
    if (chunk.chunkSource === 'compiled_truth') {
      score *= COMPILED_TRUTH_BOOST;
    }
    // Topic priority boost: employment/skills/relationships get a bump
    const topicPriority = typeof chunk.metadata?.priority === 'number' ? chunk.metadata.priority as number : 5;
    if (topicPriority >= 8) {
      score *= 1.2; // 20% boost for high-priority topics
    }
    return { ...chunk, score };
  });

  results = cosineReScore(results, queryVector);

  // Graph reranking: entity-intent and mention multipliers.
  // Toggleable via options.graphRerank (default: true when db is provided).
  const useGraphRerank = options.db !== undefined && (options.graphRerank ?? true);
  if (useGraphRerank && options.db) {
    results = applyGraphRerank(results, options.db, trimmed, intent);
  }

  if (options.db) {
    const counts = getBacklinkCounts(options.db, [...new Set(results.map((r) => r.slug))]);
    results = applyBacklinkBoost(results, counts);
  }

  return dedupResults(results).slice(0, limit);
}

export async function retrieveEntityPages(
  query: string,
  options: { limit?: number; chunkLimit?: number; snippetsPerPage?: number; db?: Database; expansion?: boolean; expansionLimit?: number; graphRerank?: boolean } = {},
): Promise<RetrievedEntityPage[]> {
  const pageLimit = options.limit ?? 5;
  const chunkLimit = options.chunkLimit ?? Math.max(pageLimit * 4, 8);
  const snippetsPerPage = options.snippetsPerPage ?? 2;
  const intent = detectQueryIntent(query);
  const useGraphRerank = options.graphRerank ?? true;

  // Pass graphRerank through to chunk-level search so graph boosting is controlled
  // from a single toggle. The old code applied graph boosts at BOTH chunk and page
  // level, causing a compounding ~4.75x effective ratio. Now graph boosting happens
  // only at chunk level via applyGraphRerank, which is toggleable.
  const chunks = await searchEntityChunks(query, { limit: chunkLimit, db: options.db, expansion: options.expansion, expansionLimit: options.expansionLimit, graphRerank: useGraphRerank });
  if (chunks.length === 0) return [];

  const grouped = new Map<string, RetrievedEntityPage>();

  chunks.forEach((chunk, index) => {
    const key = chunk.slug || chunk.id;
    const existing = grouped.get(key);
    const reciprocalRank = 1 / (index + 1);
    const weightedRank = reciprocalRank * pageIntentMultiplier(chunk.entityType, intent);

    if (!existing) {
      grouped.set(key, {
        slug: chunk.slug,
        title: chunk.title,
        entityType: chunk.entityType,
        bestScore: chunk.score,
        fusedScore: weightedRank,
        chunkCount: 1,
        snippets: [chunk.text],
        chunks: [chunk],
      });
      return;
    }

    existing.fusedScore += weightedRank;
    existing.chunkCount += 1;
    existing.chunks.push(chunk);
    if (typeof chunk.score === 'number') {
      existing.bestScore = typeof existing.bestScore === 'number'
        ? Math.min(existing.bestScore, chunk.score)
        : chunk.score;
    }
    if (existing.snippets.length < snippetsPerPage && !existing.snippets.includes(chunk.text)) {
      existing.snippets.push(chunk.text);
    }
  });

  // NOTE: Page-level graph boost removed (Phase 0a fix).
  // Graph reranking now happens only at chunk level via applyGraphRerank(),
  // controlled by the graphRerank toggle. The old code applied graph boosts
  // at both chunk and page level, causing a compounding ~4.75x effective ratio
  // that masked retrieval quality problems by brute-forcing graph answers to the top.
  let pages = [...grouped.values()];

  return pages
    .sort((a, b) => {
      if (b.fusedScore !== a.fusedScore) return b.fusedScore - a.fusedScore;
      const aScore = typeof a.bestScore === 'number' ? a.bestScore : Number.POSITIVE_INFINITY;
      const bScore = typeof b.bestScore === 'number' ? b.bestScore : Number.POSITIVE_INFINITY;
      return aScore - bScore;
    })
    .slice(0, pageLimit);
}

// Backward compat aliases
/** @deprecated use retrieveEntityChunks */
export const retrievePersonChunks = retrieveEntityChunks;
/** @deprecated use searchEntityChunks */
export const searchPersonChunks = searchEntityChunks;
/** @deprecated use retrieveEntityPages */
export const retrievePersonPages = retrieveEntityPages;
