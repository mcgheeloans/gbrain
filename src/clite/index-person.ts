/**
 * Compile-to-retrieval pipeline.
 *
 * After compilePerson() writes a compiled wiki page, call indexPersonPage()
 * to chunk it, embed with Jina, and upsert to the shared LanceDB.
 *
 * Chunking: simple recursive character chunking (500 char target, 50 char overlap).
 * All chunks tagged with chunk_source: "compiled_truth".
 */

import type { PersonChunk } from './lance-store.ts';
import { JinaEmbedder } from './embedder.ts';
import { upsertPersonChunks } from './lance-store.ts';
import type { Database } from 'bun:sqlite';

const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 50;

/**
 * Split text into overlapping character chunks.
 */
function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): PersonChunk[] {
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
 * Index a compiled person page into LanceDB.
 *
 * 1. Split compiled markdown into chunks
 * 2. Embed chunks with Jina v5
 * 3. Upsert to shared LanceDB
 *
 * Returns the number of chunks indexed.
 *
 * Throws if embedding or LanceDB write fails. Canonical write (SQLite + wiki file)
 * is NOT rolled back — caller is responsible for handling partial failures.
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

  await upsertPersonChunks({ slug, title, chunks, vectors });

  // Sync to FTS5 for keyword search
  if (options?.db) {
    syncFtsChunks(options.db, slug, title, chunks);
  }

  return chunks.length;
}

/**
 * Replace FTS entries for a slug with fresh chunks.
 */
function syncFtsChunks(db: Database, slug: string, title: string, chunks: PersonChunk[]): void {
  const del = db.query("DELETE FROM person_chunks_fts WHERE slug = ?");
  const ins = db.query("INSERT INTO person_chunks_fts (slug, title, text) VALUES (?, ?, ?)");
  del.run(slug);
  for (const chunk of chunks) {
    ins.run(slug, title, chunk.text);
  }
}
