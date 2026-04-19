/**
 * Compile-to-retrieval pipeline.
 *
 * Two indexing modes:
 *   1. Topic-chunk indexing (recommended): takes TopicChunk[] from render-topic-chunks,
 *      embeds each topic paragraph separately, tags with topic metadata.
 *   2. Legacy page indexing: splits a compiled page into character chunks.
 *
 * Topic chunks produce more distinctive embeddings because each paragraph
 * focuses on a specific aspect of the entity (employment, skills, relationships, etc.)
 */

import type { EntityChunk } from './lance-store.ts';
import type { TopicChunk } from './render-topic-chunks.ts';
import { JinaEmbedder } from './embedder.ts';
import { upsertEntityChunks } from './lance-store.ts';
import type { Database } from 'bun:sqlite';

const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 50;

/**
 * Index topic-specific chunks into LanceDB.
 *
 * Each TopicChunk becomes its own LanceDB entry with topic metadata.
 * Returns the number of chunks indexed.
 */
export async function indexTopicChunks(
  slug: string,
  title: string,
  topicChunks: TopicChunk[],
  options?: { db?: Database; entityType?: string },
): Promise<number> {
  if (topicChunks.length === 0) return 0;

  // Serialize embedding requests (Jina has 2-request concurrency limit)
  const embedder = new JinaEmbedder();
  const allVectors: number[][] = [];

  for (const chunk of topicChunks) {
    const vecs = await embedder.embed([chunk.text]);
    allVectors.push(...vecs);
  }

  // Convert TopicChunks to EntityChunks for LanceDB storage
  const chunks: EntityChunk[] = topicChunks.map((tc, i) => ({
    index: i,
    text: tc.text,
  }));

  // Upsert with topic metadata
  await upsertEntityChunks({
    slug,
    title,
    entityType: options?.entityType ?? 'person',
    chunks,
    vectors: allVectors,
    // Extra metadata per chunk
    chunkMetadata: topicChunks.map(tc => ({
      topic: tc.topic,
      label: tc.label,
      priority: tc.priority,
    })),
  });

  // Sync to FTS5 for keyword search
  if (options?.db) {
    syncFtsChunks(options.db, slug, title, topicChunks.map((tc, i) => ({ index: i, text: tc.text })));
  }

  return chunks.length;
}

/**
 * Legacy: index a compiled person page into LanceDB using character chunking.
 *
 * 1. Split compiled markdown into chunks
 * 2. Embed chunks with Jina v5
 * 3. Upsert to shared LanceDB
 */
export async function indexPersonPage(
  slug: string,
  title: string,
  compiledMarkdown: string,
  options?: { db?: Database },
): Promise<number> {
  const chunks = chunkText(compiledMarkdown);
  if (chunks.length === 0) return 0;

  const embedder = new JinaEmbedder();
  const vectors = await embedder.embed(chunks.map((c) => c.text));

  await upsertEntityChunks({ slug, title, chunks, vectors });

  // Sync to FTS5 for keyword search
  if (options?.db) {
    syncFtsChunks(options.db, slug, title, chunks);
  }

  return chunks.length;
}

/**
 * Split text into overlapping character chunks.
 */
function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): EntityChunk[] {
  if (!text || text.length === 0) return [];

  const chunks: PersonChunk[] = [];
  let position = 0;
  let index = 0;

  while (position < text.length) {
    const end = Math.min(position + size, text.length);
    chunks.push({ index, text: text.slice(position, end) });
    position += size - overlap;
    index++;
  }

  return chunks;
}

/**
 * Replace FTS entries for a slug with fresh chunks.
 */
function syncFtsChunks(db: Database, slug: string, title: string, chunks: { index: number; text: string }[]): void {
  const del = db.query("DELETE FROM person_chunks_fts WHERE slug = ?");
  const ins = db.query("INSERT INTO person_chunks_fts (slug, title, text) VALUES (?, ?, ?)");
  del.run(slug);
  for (const chunk of chunks) {
    ins.run(slug, title, chunk.text);
  }
}
