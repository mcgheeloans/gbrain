/**
 * Timeline adapter: append and query timeline events.
 */
import type { Database } from 'bun:sqlite';

export interface TimelineEventRow {
  id: number;
  entity_slug: string;
  event_type: string;
  date: string;
  source_type: string;
  source_ref: string;
  confidence: number;
  summary: string;
  detail: string;
  created_at: string;
}

export interface AppendTimelineInput {
  entitySlug: string;
  eventType?: string;
  date?: string;           // ISO date YYYY-MM-DD, defaults to today
  sourceType?: string;
  sourceRef?: string;
  confidence?: number;
  summary: string;
  detail?: string;
}

/**
 * Append a timeline event. Returns the inserted row.
 */
export function appendTimelineEvent(
  db: Database,
  input: AppendTimelineInput
): TimelineEventRow {
  const {
    entitySlug,
    eventType = 'note',
    date = new Date().toISOString().slice(0, 10),
    sourceType = 'user',
    sourceRef = '',
    confidence = 1.0,
    summary,
    detail = '',
  } = input;

  db.prepare(
    `INSERT INTO timeline_events (entity_slug, event_type, date, source_type, source_ref, confidence, summary, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_slug, date, event_type, summary) DO UPDATE SET
       detail = CASE WHEN excluded.detail != '' THEN excluded.detail ELSE timeline_events.detail END,
       confidence = excluded.confidence,
       source_type = excluded.source_type`
  ).run(entitySlug, eventType, date, sourceType, sourceRef, confidence, summary, detail);

  return getLatestEvent(db, entitySlug)!;
}

function getLatestEvent(db: Database, entitySlug: string): TimelineEventRow | null {
  return db.query(
    'SELECT * FROM timeline_events WHERE entity_slug = ? ORDER BY created_at DESC LIMIT 1'
  ).get(entitySlug) as TimelineEventRow | null;
}

/**
 * Get recent timeline events for an entity.
 */
export function getTimelineEvents(
  db: Database,
  entitySlug: string,
  limit: number = 20
): TimelineEventRow[] {
  return db.query(
    'SELECT * FROM timeline_events WHERE entity_slug = ? ORDER BY date DESC, created_at DESC LIMIT ?'
  ).all(entitySlug, limit) as TimelineEventRow[];
}
