import type { RetrievedEntityChunk } from './retrieve-person.ts';

export const MAX_TYPE_RATIO = 0.6;
export const MAX_PER_PAGE = 2;
export const JACCARD_THRESHOLD = 0.85;

export function parseMetadata(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function chunkKey(chunk: RetrievedEntityChunk): string {
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

function dedupBySource(results: RetrievedEntityChunk[]): RetrievedEntityChunk[] {
  const byPage = new Map<string, RetrievedEntityChunk[]>();
  for (const r of results) {
    const list = byPage.get(r.slug) ?? [];
    list.push(r);
    byPage.set(r.slug, list);
  }

  return [...byPage.values()]
    .flatMap((chunks) => chunks.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 3))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function dedupByTextSimilarity(results: RetrievedEntityChunk[]): RetrievedEntityChunk[] {
  const kept: RetrievedEntityChunk[] = [];
  for (const r of results) {
    const tooSimilar = kept.some((k) => jaccardSimilarity(r.text, k.text) > JACCARD_THRESHOLD);
    if (!tooSimilar) kept.push(r);
  }
  return kept;
}

function enforceTypeDiversity(results: RetrievedEntityChunk[], maxRatio = MAX_TYPE_RATIO): RetrievedEntityChunk[] {
  const maxPerType = Math.max(1, Math.ceil(results.length * maxRatio));
  const counts = new Map<string, number>();
  const kept: RetrievedEntityChunk[] = [];

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

function capPerPage(results: RetrievedEntityChunk[], maxPerPage = MAX_PER_PAGE): RetrievedEntityChunk[] {
  const counts = new Map<string, number>();
  const kept: RetrievedEntityChunk[] = [];
  for (const r of results) {
    const count = counts.get(r.slug) ?? 0;
    if (count < maxPerPage) {
      kept.push(r);
      counts.set(r.slug, count + 1);
    }
  }
  return kept;
}

function guaranteeCompiledTruth(results: RetrievedEntityChunk[], preDedup: RetrievedEntityChunk[]): RetrievedEntityChunk[] {
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

export function dedupResults(results: RetrievedEntityChunk[]): RetrievedEntityChunk[] {
  const preDedup = [...results];
  let deduped = dedupBySource(results);
  deduped = dedupByTextSimilarity(deduped);
  deduped = enforceTypeDiversity(deduped);
  deduped = capPerPage(deduped);
  deduped = guaranteeCompiledTruth(deduped, preDedup);
  return deduped.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

export { jaccardSimilarity, dedupBySource, dedupByTextSimilarity, enforceTypeDiversity, capPerPage, guaranteeCompiledTruth };
