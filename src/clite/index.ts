/**
 * C-lite: lightweight SQLite bootstrap for GBrain.
 *
 * This is a standalone module that does NOT integrate with the existing
 * BrainEngine / engine-factory. It provides its own schema and bootstrap path
 * for the C-lite (slim) knowledge graph.
 *
 * See src/clite/README.md for usage.
 */

export { CLITE_SCHEMA_SQL } from './schema.ts';
export { bootstrap, open, verifySchema, listTables } from './bootstrap.ts';
export type { BootstrapResult } from './bootstrap.ts';

export {
  upsertEntity,
  getEntityBySlug,
  getEntityById,
  addAlias,
  resolveSlug,
  getAliases,
} from './entities.ts';
export type { EntityRow, AliasRow } from './entities.ts';

export {
  appendTimelineEvent,
  getTimelineEvents,
} from './timeline.ts';
export type { TimelineEventRow, AppendTimelineInput } from './timeline.ts';

export {
  insertTriple,
  getTriplesForEntity,
} from './triples.ts';
export type { TripleRow, InsertTripleInput } from './triples.ts';

export {
  recomputeFreshness,
  markCompiled,
} from './freshness.ts';
export type { FreshnessRow } from './freshness.ts';

export { getEntityState } from './read-models.ts';
export type { EntityState } from './read-models.ts';

export { renderPersonPage } from './render-person.ts';
export type { RenderedPersonPage } from './render-person.ts';

export { writePersonPage } from './write-page.ts';
export type { WritePageResult } from './write-page.ts';

export {
  ingestNote,
  extractFromDemoNote,
} from './ingest-note.ts';
export type { IngestNoteResult } from './ingest-note.ts';

export { compilePerson } from './compile-person.ts';

export { verifySlice, getLatestVerificationRun } from './verify-slice.ts';
export type { VerifySliceResult, CheckResult, CheckStatus } from './verify-slice.ts';

export { JinaEmbedder } from './embedder.ts';
export { upsertPersonChunks, hasEntriesForSlug, getSharedTable } from './lance-store.ts';
export { indexPersonPage, indexTopicChunks } from './index-person.ts';
export { renderTopicChunks } from './render-topic-chunks.ts';
export type { TopicChunk } from './render-topic-chunks.ts';
export { retrievePersonChunks, searchPersonChunks, retrievePersonPages } from './retrieve-person.ts';
export type { RetrievedPersonChunk, RetrievedPersonPage } from './retrieve-person.ts';
