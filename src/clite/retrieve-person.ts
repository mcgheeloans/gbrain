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

const SCOPE = 'gbrain:people';
const RRF_K = 60;
const COMPILED_TRUTH_BOOST = 2.0;
const BACKLINK_BOOST_COEF = 0.05;
const MAX_TYPE_RATIO = 0.6;
const MAX_PER_PAGE = 2;
const JACCARD_THRESHOLD = 0.85;
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

export interface RetrievedPersonChunk {
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

export interface RetrievedPersonPage {
  slug: string;
  title: string;
  entityType?: string;
  bestScore?: number;
  fusedScore: number;
  chunkCount: number;
  snippets: string[];
  chunks: RetrievedPersonChunk[];
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function expandQueryTerms(query: string, limit = DEFAULT_EXPANSION_LIMIT): string[] {
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

function keywordScore(query: string, text: string, title = ''): number {
  const q = tokenize(query);
  if (q.length === 0) return 0;

  const textLower = text.toLowerCase();
  const titleLower = title.toLowerCase();
  const unique = [...new Set(q)];

  let score = 0;
  for (const token of unique) {
    if (titleLower.includes(token)) score += 2.0;
    if (textLower.includes(token)) score += 1.0;
  }

  const phrase = query.trim().toLowerCase();
  if (phrase && (textLower.includes(phrase) || titleLower.includes(phrase))) {
    score += 3.0;
  }

  return score;
}

function chunkKey(chunk: RetrievedPersonChunk): string {
  return `${chunk.slug}:${chunk.chunkIndex ?? chunk.id}`;
}

function jaccardSimilarity(a: string, b: string): number {
  const aSet = new Set(tokenize(a));
  const bSet = new Set(tokenize(b));
  if (aSet.size === 0 && bSet.size === 0) return 1;
  const intersection = [...aSet].filter((t) => bSet.has(t)).length;
  const union = new Set([...aSet, ...bSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function dedupBySource(results: RetrievedPersonChunk[]): RetrievedPersonChunk[] {
  const byPage = new Map<string, RetrievedPersonChunk[]>();
  for (const r of results) {
    const list = byPage.get(r.slug) ?? [];
    list.push(r);
    byPage.set(r.slug, list);
  }

  return [...byPage.values()]
    .flatMap((chunks) => chunks.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 3))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function dedupByTextSimilarity(results: RetrievedPersonChunk[]): RetrievedPersonChunk[] {
  const kept: RetrievedPersonChunk[] = [];
  for (const r of results) {
    const tooSimilar = kept.some((k) => jaccardSimilarity(r.text, k.text) > JACCARD_THRESHOLD);
    if (!tooSimilar) kept.push(r);
  }
  return kept;
}

function enforceTypeDiversity(results: RetrievedPersonChunk[], maxRatio = MAX_TYPE_RATIO): RetrievedPersonChunk[] {
  const maxPerType = Math.max(1, Math.ceil(results.length * maxRatio));
  const counts = new Map<string, number>();
  const kept: RetrievedPersonChunk[] = [];

  for (const r of results) {
    const type = r.entityType ?? 'unknown';
    const count = counts.get(type) ?? 0;
    if (count < maxPerType) {
      kept.push(r);
      counts.set(type, count + 1);
    }
  }

  return kept;
}

function capPerPage(results: RetrievedPersonChunk[], maxPerPage = MAX_PER_PAGE): RetrievedPersonChunk[] {
  const counts = new Map<string, number>();
  const kept: RetrievedPersonChunk[] = [];
  for (const r of results) {
    const count = counts.get(r.slug) ?? 0;
    if (count < maxPerPage) {
      kept.push(r);
      counts.set(r.slug, count + 1);
    }
  }
  return kept;
}

function guaranteeCompiledTruth(results: RetrievedPersonChunk[], preDedup: RetrievedPersonChunk[]): RetrievedPersonChunk[] {
  const output = [...results];
  const pages = [...new Set(results.map((r) => r.slug))];

  for (const slug of pages) {
    const pageResults = output.filter((r) => r.slug === slug);
    if (pageResults.some((r) => r.chunkSource === 'compiled_truth')) continue;

    const candidate = preDedup
      .filter((r) => r.slug === slug && r.chunkSource === 'compiled_truth')
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];

    if (!candidate) continue;

    const lowestIndex = output.reduce((minIdx, r, idx) => {
      if (r.slug !== slug) return minIdx;
      if (minIdx === -1) return idx;
      return (r.score ?? 0) < (output[minIdx]!.score ?? 0) ? idx : minIdx;
    }, -1);

    if (lowestIndex >= 0) output[lowestIndex] = candidate;
  }

  return output;
}

function dedupResults(results: RetrievedPersonChunk[]): RetrievedPersonChunk[] {
  const preDedup = [...results];
  let deduped = dedupBySource(results);
  deduped = dedupByTextSimilarity(deduped);
  deduped = enforceTypeDiversity(deduped);
  deduped = capPerPage(deduped);
  deduped = guaranteeCompiledTruth(deduped, preDedup);
  return deduped.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function cosineReScore(results: RetrievedPersonChunk[], queryVector: number[]): RetrievedPersonChunk[] {
  if (results.length === 0) return results;
  const maxRrf = Math.max(...results.map((r) => r.score ?? 0));

  return results
    .map((r) => {
      const cosine = r.vector ? cosineSimilarity(queryVector, r.vector) : 0;
      const normRrf = maxRrf > 0 ? (r.score ?? 0) / maxRrf : 0;
      return {
        ...r,
        score: 0.7 * normRrf + 0.3 * cosine,
      };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function getBacklinkCounts(db: Database, slugs: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (slugs.length === 0) return counts;

  const placeholders = slugs.map(() => '?').join(', ');
  const rows = db.query(
    `SELECT object_entity_slug as slug, COUNT(*) as backlink_count
     FROM triples
     WHERE object_entity_slug IN (${placeholders})
       AND status = 'current' AND valid_to IS NULL
     GROUP BY object_entity_slug`
  ).all(...slugs) as Array<{ slug: string; backlink_count: number }>;

  for (const slug of slugs) counts.set(slug, 0);
  for (const row of rows) counts.set(row.slug, row.backlink_count);
  return counts;
}

function applyBacklinkBoost(results: RetrievedPersonChunk[], counts: Map<string, number>): RetrievedPersonChunk[] {
  return results
    .map((r) => {
      const count = counts.get(r.slug) ?? 0;
      if (count <= 0) return r;
      return {
        ...r,
        score: (r.score ?? 0) * (1 + BACKLINK_BOOST_COEF * Math.log(1 + count)),
      };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function normalizeChunkScores(chunks: RetrievedPersonChunk[]): RetrievedPersonChunk[] {
  if (chunks.length === 0) return [];
  const scored = chunks.filter((c) => typeof c.score === 'number') as Array<RetrievedPersonChunk & { score: number }>;
  if (scored.length === 0) return chunks;

  const min = Math.min(...scored.map((c) => c.score));
  const max = Math.max(...scored.map((c) => c.score));
  return chunks.map((chunk) => {
    if (typeof chunk.score !== 'number') return chunk;
    const normalized = max === min ? 1 : 1 - ((chunk.score - min) / (max - min));
    return { ...chunk, score: normalized };
  });
}

async function ftsKeywordSearch(db: Database, query: string, limit: number): Promise<RetrievedPersonChunk[]> {
  // Use FTS5 for fast keyword matching instead of loading all chunks into memory.
  // Note: FTS5 MATCH does not support ? parameter binding in bun:sqlite, use interpolation.
  // FTS5 query syntax: tokens separated by space = AND, OR between groups with OR keyword.
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
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
      } satisfies RetrievedPersonChunk));
  } catch {
    return [];
  }
}

/** Fallback: load all scope chunks from LanceDB (used when no SQLite db is available). */
async function fetchScopeChunksFallback(): Promise<RetrievedPersonChunk[]> {
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
    } satisfies RetrievedPersonChunk;
  });
}

async function retrievePersonChunksWithVector(
  query: string,
  queryVector: number[],
  options: { limit?: number } = {},
): Promise<RetrievedPersonChunk[]> {
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
    } satisfies RetrievedPersonChunk;
  }));
}

export async function retrievePersonChunks(
  query: string,
  options: { limit?: number } = {},
): Promise<RetrievedPersonChunk[]> {
  const embedder = new JinaEmbedder();
  const queryVector = await embedder.embedQuery(query.trim());
  return retrievePersonChunksWithVector(query, queryVector, options);
}

export async function searchPersonChunks(
  query: string,
  options: { limit?: number; keywordLimit?: number; vectorLimit?: number; db?: Database; expansion?: boolean; expansionLimit?: number } = {},
): Promise<RetrievedPersonChunk[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const limit = options.limit ?? 8;
  const vectorLimit = options.vectorLimit ?? Math.max(limit * 2, 8);
  const keywordLimit = options.keywordLimit ?? Math.max(limit * 3, 12);
  const queries = options.expansion === false ? [trimmed] : expandQueryTerms(trimmed, options.expansionLimit);

  const embedder = new JinaEmbedder();
  const queryVector = await embedder.embedQuery(trimmed);

  const vectorLists: RetrievedPersonChunk[][] = [];
  for (const q of queries) {
    const qVector = q === trimmed ? queryVector : await embedder.embedQuery(q);
    vectorLists.push(await retrievePersonChunksWithVector(q, qVector, { limit: vectorLimit }));
  }

  // Keyword search via FTS5 when db is available, otherwise fall back to in-memory scoring
  const keywordLists: RetrievedPersonChunk[][] = [];
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

  const fused = new Map<string, RetrievedPersonChunk>();
  const vectorByKey = new Map(vectorLists.flat().map((chunk) => [chunkKey(chunk), chunk]));
  const applyRrf = (chunks: RetrievedPersonChunk[], source: 'vector' | 'keyword') => {
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
    return { ...chunk, score };
  });

  results = cosineReScore(results, queryVector);

  if (options.db) {
    const counts = getBacklinkCounts(options.db, [...new Set(results.map((r) => r.slug))]);
    results = applyBacklinkBoost(results, counts);
  }

  return dedupResults(results).slice(0, limit);
}

export async function retrievePersonPages(
  query: string,
  options: { limit?: number; chunkLimit?: number; snippetsPerPage?: number; db?: Database; expansion?: boolean; expansionLimit?: number } = {},
): Promise<RetrievedPersonPage[]> {
  const pageLimit = options.limit ?? 5;
  const chunkLimit = options.chunkLimit ?? Math.max(pageLimit * 4, 8);
  const snippetsPerPage = options.snippetsPerPage ?? 2;

  const chunks = await searchPersonChunks(query, { limit: chunkLimit, db: options.db, expansion: options.expansion, expansionLimit: options.expansionLimit });
  if (chunks.length === 0) return [];

  const grouped = new Map<string, RetrievedPersonPage>();

  chunks.forEach((chunk, index) => {
    const key = chunk.slug || chunk.id;
    const existing = grouped.get(key);
    const reciprocalRank = 1 / (index + 1);

    if (!existing) {
      grouped.set(key, {
        slug: chunk.slug,
        title: chunk.title,
        entityType: chunk.entityType,
        bestScore: chunk.score,
        fusedScore: reciprocalRank,
        chunkCount: 1,
        snippets: [chunk.text],
        chunks: [chunk],
      });
      return;
    }

    existing.fusedScore += reciprocalRank;
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

  return [...grouped.values()]
    .sort((a, b) => {
      if (b.fusedScore !== a.fusedScore) return b.fusedScore - a.fusedScore;
      const aScore = typeof a.bestScore === 'number' ? a.bestScore : Number.POSITIVE_INFINITY;
      const bScore = typeof b.bestScore === 'number' ? b.bestScore : Number.POSITIVE_INFINITY;
      return aScore - bScore;
    })
    .slice(0, pageLimit);
}
