/**
 * Triple adapter: insert and query knowledge-graph triples.
 */
import type { Database } from 'bun:sqlite';

export interface TripleRow {
  id: number;
  subject_entity_slug: string;
  predicate: string;
  object_entity_slug: string | null;
  object_literal: string | null;
  valid_from: string;
  valid_to: string | null;
  status: string;
  context: string | null;
  confidence: number;
  source_type: string;
  source_ref: string;
  created_at: string;
  updated_at: string;
}

export interface InsertTripleInput {
  subjectSlug: string;
  predicate: string;
  objectEntitySlug?: string;
  objectLiteral?: string;
  sourceType?: string;
  sourceRef?: string;
  confidence?: number;
  context?: string;
}

/**
 * Insert a triple. For the first slice, we handle dedup via the unique index.
 * If an identical current triple exists, bumps updated_at instead of erroring.
 */
export function insertTriple(
  db: Database,
  input: InsertTripleInput
): TripleRow {
  const {
    subjectSlug,
    predicate,
    objectEntitySlug = null,
    objectLiteral = null,
    sourceType = 'user',
    sourceRef = '',
    confidence = 1.0,
    context = null,
  } = input;

  if (!objectEntitySlug && !objectLiteral) {
    throw new Error('Triple must have either objectEntitySlug or objectLiteral — neither provided');
  }

  if (objectEntitySlug && objectLiteral) {
    throw new Error('Triple must have either objectEntitySlug or objectLiteral — both provided, which is ambiguous');
  }

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Supersede any existing current triple with the same subject+predicate+object+status
  // For first slice: just insert. Dedup index handles conflicts via ON CONFLICT.
  db.prepare(
    `INSERT INTO triples (subject_entity_slug, predicate, object_entity_slug, object_literal,
       status, confidence, source_type, source_ref, context, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'current', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(subject_entity_slug, predicate, COALESCE(object_entity_slug, ''),
                 COALESCE(object_literal, ''), status, COALESCE(valid_to, ''))
     DO UPDATE SET
       confidence = excluded.confidence,
       source_type = excluded.source_type,
       source_ref = excluded.source_ref,
       context = CASE WHEN excluded.context IS NOT NULL THEN excluded.context ELSE triples.context END,
       updated_at = excluded.updated_at`
  ).run(subjectSlug, predicate, objectEntitySlug, objectLiteral,
        confidence, sourceType, sourceRef, context, now, now);

  return getLatestTriple(db, subjectSlug, predicate)!;
}

function getLatestTriple(db: Database, subjectSlug: string, predicate: string): TripleRow | null {
  return db.query(
    `SELECT * FROM triples
     WHERE subject_entity_slug = ? AND predicate = ? AND status = 'current' AND valid_to IS NULL
     ORDER BY updated_at DESC LIMIT 1`
  ).get(subjectSlug, predicate) as TripleRow | null;
}

/**
 * Get all current triples involving an entity (as subject or object).
 */
export function getTriplesForEntity(
  db: Database,
  entitySlug: string,
  role: 'subject' | 'object' | 'both' = 'both'
): TripleRow[] {
  if (role === 'subject') {
    return db.query(
      `SELECT * FROM triples WHERE subject_entity_slug = ? AND status = 'current' AND valid_to IS NULL
       ORDER BY predicate`
    ).all(entitySlug) as TripleRow[];
  }
  if (role === 'object') {
    return db.query(
      `SELECT * FROM triples WHERE object_entity_slug = ? AND status = 'current' AND valid_to IS NULL
       ORDER BY predicate`
    ).all(entitySlug) as TripleRow[];
  }
  return db.query(
    `SELECT * FROM triples
     WHERE (subject_entity_slug = ? OR object_entity_slug = ?)
       AND status = 'current' AND valid_to IS NULL
     ORDER BY predicate`
  ).all(entitySlug, entitySlug) as TripleRow[];
}
