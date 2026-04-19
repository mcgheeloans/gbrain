import type { Database } from 'bun:sqlite';
import type { RetrievedEntityChunk } from './retrieve-person.ts';
import { tokenize } from './search-dedup.ts';

export const BACKLINK_BOOST_COEF = 0.05;
export const COMPILED_TRUTH_BOOST = 2.0;

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

export function cosineReScore(results: RetrievedEntityChunk[], queryVector: number[]): RetrievedEntityChunk[] {
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

export function keywordScore(query: string, text: string, title = ''): number {
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

export function getBacklinkCounts(db: Database, slugs: string[]): Map<string, number> {
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

export function applyBacklinkBoost(results: RetrievedEntityChunk[], counts: Map<string, number>): RetrievedEntityChunk[] {
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

export function normalizeChunkScores(chunks: RetrievedEntityChunk[]): RetrievedEntityChunk[] {
  if (chunks.length === 0) return [];
  const scored = chunks.filter((c) => typeof c.score === 'number') as Array<RetrievedEntityChunk & { score: number }>;
  if (scored.length === 0) return chunks;

  const min = Math.min(...scored.map((c) => c.score));
  const max = Math.max(...scored.map((c) => c.score));
  return chunks.map((chunk) => {
    if (typeof chunk.score !== 'number') return chunk;
    const normalized = max === min ? 1 : 1 - ((chunk.score - min) / (max - min));
    return { ...chunk, score: normalized };
  });
}

export { cosineSimilarity };
