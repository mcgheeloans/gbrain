/**
 * LanceDB write adapter for C-lite.
 *
 * Writes compiled page chunks to the shared LanceDB at
 * ~/.openclaw/memory/lancedb-pro/memories, which is also used by memory-lancedb-pro.
 *
 * Note: File locking is NOT used because:
 * - Bun is single-threaded — no concurrent process access within the same process
 * - LanceDB handles its own consistency (append-only, MVCC)
 *
 * Schema (per memory-lancedb-pro store.ts):
 * { id, text, vector, category, scope, importance, timestamp, metadata }
 *
 * Category must be one of: "preference" | "fact" | "decision" | "entity" | "other" | "reflection"
 * Importance is required (0.0-1.0)
 * Timestamp is required (epoch ms)
 * metadata is a JSON string
 */

import * as lancedb from '@lancedb/lancedb';

const LANCEDB_PATH = `${process.env.HOME}/.openclaw/memory/lancedb-pro`;
const TABLE_NAME = 'memories';
const SCOPE = 'gbrain:people';

// ---------------------------------------------------------------------------
// LanceDB connection (lazy singleton per process)
// ---------------------------------------------------------------------------

let _table: ReturnType<ReturnType<typeof lancedb.connect>['then']['catch'] extends Promise<infer T> ? T extends { openTable: (name: string) => infer U } ? U : never : never> | null = null;

async function getTable() {
  if (_table) return _table;

  const db = await lancedb.connect(LANCEDB_PATH);
  _table = await db.openTable(TABLE_NAME);
  return _table;
}

export async function getSharedTable() {
  return getTable();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PersonChunk {
  index: number;
  text: string;
}

export interface ChunkMetadata {
  topic?: string;
  label?: string;
  priority?: number;
}

export interface UpsertPersonOptions {
  /** Entity slug, e.g. "sarah-chen" */
  slug: string;
  /** Page title, e.g. "Sarah Chen" */
  title: string;
  /** Entity type, e.g. "person" */
  entityType?: string;
  /** Compiled markdown chunks for this page */
  chunks: PersonChunk[];
  /** Jina embeddings for each chunk (same order) */
  vectors: number[][];
  /** Optional per-chunk metadata (topic, label, priority) */
  chunkMetadata?: ChunkMetadata[];
}

/**
 * Upsert compiled person chunks to the shared LanceDB.
 *
 * Delete-then-add pattern: removes any existing chunks for this slug,
 * then adds the new ones. This ensures re-compiling replaces old entries
 * rather than duplicating them.
 */
export async function upsertPersonChunks(
  options: UpsertPersonOptions,
): Promise<void> {
  const { slug, title, entityType = 'person', chunks, vectors } = options;

  if (chunks.length !== vectors.length) {
    throw new Error(
      `upsertPersonChunks: chunk count (${chunks.length}) != vector count (${vectors.length})`,
    );
  }

  const table = await getTable();

  // Delete existing chunks for this slug
  await table.delete(`id LIKE '${slug}:%'`);

  // Build entries with correct MemoryEntry schema
  const now = Date.now();
  const entries = chunks.map((chunk, i) => {
    const meta = options.chunkMetadata?.[i];
    return {
      id: `${slug}:${chunk.index}`,
      text: chunk.text,
      vector: vectors[i],
      category: 'entity' as const,
      scope: SCOPE,
      importance: Math.max(0.5, Math.min(1.0, 0.5 + (meta?.priority ?? 5) * 0.05)),
      timestamp: now,
      metadata: JSON.stringify({
        slug,
        title,
        entity_type: entityType,
        chunk_index: chunk.index,
        chunk_source: 'compiled_truth',
        source: 'gbrain-c-lite',
        topic: meta?.topic ?? 'general',
        topic_label: meta?.label ?? '',
        priority: meta?.priority ?? 5,
      }),
    };
  });

  if (entries.length > 0) {
    await table.add(entries);
  }
}

/**
 * Check whether any entries exist in LanceDB for a given slug.
 * Used by verify-slice.ts to confirm indexing succeeded.
 */
export async function hasEntriesForSlug(slug: string): Promise<boolean> {
  const table = await getTable();
  const results = await table.query()
    .where(`id LIKE '${slug}:%'`)
    .limit(1)
    .toArray();
  return results.length > 0;
}
