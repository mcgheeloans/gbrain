/**
 * Shared link/timeline extraction utilities.
 *
 * Used by:
 *   - src/commands/link-extract.ts        (batch DB extraction)
 *   - src/commands/timeline-extract.ts    (batch DB extraction)
 *   - src/commands/backlinks.ts           (filesystem walk, legacy)
 *   - src/core/operations.ts put_page     (auto-link post-hook)
 *
 * All functions are PURE (no DB access). The DB lives in the engine; these
 * utilities turn page content into candidates that callers persist via engine
 * methods. Auto-link config is the one impure helper (reads engine.getConfig).
 */

import type { BrainEngine } from './engine.ts';
import type { PageType } from './types.ts';

// ─── Entity references ──────────────────────────────────────────

export interface EntityRef {
  /** Display name from the markdown link, e.g. "Alice Chen". */
  name: string;
  /** Resolved page slug, e.g. "people/alice-chen". */
  slug: string;
  /** Top-level directory ("people" | "companies" | etc.). */
  dir: string;
}

/**
 * Match `[Name](path)` markdown links pointing to `people/` or `companies/`
 * (and other entity directories). Accepts both filesystem-relative format
 * (`[Name](../people/slug.md)`) AND engine-slug format (`[Name](people/slug)`).
 *
 * Captures: name, dir (people/companies/...), slug.
 *
 * The regex permits an optional `../` prefix (any number) and an optional
 * `.md` suffix so the same function works for both filesystem and DB content.
 */
const ENTITY_REF_RE = /\[([^\]]+)\]\((?:\.\.\/)*((?:people|companies|meetings|concepts|deal|civic|project|source|media|yc)\/([^)\s]+?))(?:\.md)?\)/g;

/**
 * Extract `[Name](path-to-people-or-company)` references from arbitrary content.
 * Both filesystem-relative paths (with `../` and `.md`) and bare engine-style
 * slugs (`people/slug`) are matched. Returns one EntityRef per match (no dedup
 * here; caller dedups).
 */
export function extractEntityRefs(content: string): EntityRef[] {
  const refs: EntityRef[] = [];
  let m: RegExpExecArray | null;
  // Fresh regex per call (g-flag state is per-instance).
  const re = new RegExp(ENTITY_REF_RE.source, ENTITY_REF_RE.flags);
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    const fullPath = m[2];
    const slug = fullPath; // dir/slug
    const dir = fullPath.split('/')[0];
    refs.push({ name, slug, dir });
  }
  return refs;
}

// ─── Link candidates (richer than EntityRef) ────────────────────

export interface LinkCandidate {
  /** Target page slug (no .md, no ../). */
  targetSlug: string;
  /** Inferred relationship type. */
  linkType: string;
  /** Surrounding text (up to ~80 chars) used for inference + storage. */
  context: string;
}

/**
 * Extract all link candidates from a page.
 *
 * Sources:
 *   1. Markdown entity refs in compiled_truth + timeline (extractEntityRefs).
 *   2. Bare slug references in text (people/slug, companies/slug).
 *   3. Frontmatter `source:` field (creates a 'source' link).
 *
 * Within-page dedup: multiple mentions of the same (targetSlug, linkType)
 * collapse to one candidate. The first occurrence's context wins.
 */
export function extractPageLinks(
  content: string,
  frontmatter: Record<string, unknown>,
  pageType: PageType,
): LinkCandidate[] {
  const candidates: LinkCandidate[] = [];

  // 1. Markdown entity refs.
  for (const ref of extractEntityRefs(content)) {
    const idx = content.indexOf(ref.name);
    const context = idx >= 0 ? excerpt(content, idx, 80) : ref.name;
    candidates.push({
      targetSlug: ref.slug,
      linkType: inferLinkType(pageType, context),
      context,
    });
  }

  // 2. Bare slug references (e.g. "see people/alice-chen for context").
  // Limited to the same entity directories ENTITY_REF_RE covers.
  const bareRe = /\b((?:people|companies|meetings|concepts|deal|civic|project|source|media|yc)\/[a-z0-9][a-z0-9-]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = bareRe.exec(content)) !== null) {
    // Skip matches that are part of a markdown link (already handled above).
    const charBefore = m.index > 0 ? content[m.index - 1] : '';
    if (charBefore === '/' || charBefore === '(') continue;
    const context = excerpt(content, m.index, 80);
    candidates.push({
      targetSlug: m[1],
      linkType: inferLinkType(pageType, context),
      context,
    });
  }

  // 3. Frontmatter source field.
  const source = frontmatter.source;
  if (typeof source === 'string' && source.length > 0 && /^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(source)) {
    candidates.push({
      targetSlug: source,
      linkType: 'source',
      context: `frontmatter source: ${source}`,
    });
  }

  // Within-page dedup: same (targetSlug, linkType) collapses to one entry.
  // First occurrence wins (preserves the most natural/earliest context).
  const seen = new Set<string>();
  const result: LinkCandidate[] = [];
  for (const c of candidates) {
    const key = `${c.targetSlug}\u0000${c.linkType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(c);
  }
  return result;
}

/** Excerpt a window of `width` chars around `idx`, collapsed to one line. */
function excerpt(s: string, idx: number, width: number): string {
  const half = Math.floor(width / 2);
  const start = Math.max(0, idx - half);
  const end = Math.min(s.length, idx + half);
  return s.slice(start, end).replace(/\s+/g, ' ').trim();
}

// ─── Relationship type inference (deterministic, zero LLM) ──────

// Match phrases that strongly indicate employment, not bare nouns.
// "founder" alone is too loose — matches "frank-founder" slugs etc.
// Require employment context: position + at/of, or explicit work verbs.
const WORKS_AT_RE = /\b(?:CEO of|CTO of|COO of|CFO of|VP at|VP of|works at|worked at|working at|employed by|joined as|engineer at|engineer for|director at|director of|head of)\b/i;
const INVESTED_RE = /\b(?:invested in|invested|backed by|funding from|led by|participated in|wrote a check)\b/i;
const FOUNDED_RE = /\b(?:founded|co-?founded)\b/i;
const ADVISES_RE = /\b(?:advises|advisor to|board member|on the board|sits on the board)\b/i;

/**
 * Infer link_type from page context. Deterministic regex heuristics, no LLM.
 *
 * Precedence (most specific first):
 *   1. Frontmatter source -> 'source' (handled in extractPageLinks; never here).
 *   2. Meeting page referencing any entity -> 'attended'.
 *   3. Founded > advises > invested_in > works_at (strongest verbs first).
 *   4. Default 'mentions'.
 */
export function inferLinkType(pageType: PageType, context: string): string {
  if (pageType === 'media') {
    // Media (book, video, etc.) referencing a person/company is a mention,
    // not an attendance event.
    return 'mentions';
  }
  // Meeting page type takes precedence over verb-based inference. A meeting
  // page's links to attendees are always 'attended', regardless of what words
  // happen to appear in the meeting body or in attendee slugs (e.g. a slug like
  // "frank-founder" shouldn't make the link work_at).
  // String-typed comparison: 'meeting' is a valid PageType but the union narrows
  // oddly across versions; compare as string for resilience.
  if ((pageType as string) === 'meeting') return 'attended';
  // Per-edge verb rules for non-meeting pages.
  if (FOUNDED_RE.test(context)) return 'founded';
  if (ADVISES_RE.test(context)) return 'advises';
  if (INVESTED_RE.test(context)) return 'invested_in';
  if (WORKS_AT_RE.test(context)) return 'works_at';
  return 'mentions';
}

// ─── Timeline parsing ───────────────────────────────────────────

export interface TimelineCandidate {
  /** ISO date YYYY-MM-DD. */
  date: string;
  /** First-line summary. */
  summary: string;
  /** Optional detail (subsequent lines until next entry/heading). */
  detail: string;
}

// Match: `- **YYYY-MM-DD** | summary` or `- **YYYY-MM-DD** -- summary`
// or `- **YYYY-MM-DD** - summary` or just `**YYYY-MM-DD** | summary`.
const TIMELINE_LINE_RE = /^\s*-?\s*\*\*(\d{4}-\d{2}-\d{2})\*\*\s*[|\-–—]+\s*(.+?)\s*$/;

/**
 * Parse timeline entries from content. Looks at:
 *   - The full content (most pages have a top-level "## Timeline" heading).
 *   - Free-form `- **DATE** | text` lines anywhere.
 *
 * Skips dates that don't represent valid calendar dates (e.g. 2026-13-45).
 * Multi-line entries: a date line followed by indented or blank-then-text
 * lines until the next date line or section heading.
 */
export function parseTimelineEntries(content: string): TimelineCandidate[] {
  const result: TimelineCandidate[] = [];
  const lines = content.split('\n');

  let i = 0;
  while (i < lines.length) {
    const m = TIMELINE_LINE_RE.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    const date = m[1];
    const summary = m[2].trim();
    if (!isValidDate(date) || summary.length === 0) {
      i++;
      continue;
    }

    // Collect optional detail lines (indented, until next date or heading).
    const detailLines: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];
      if (TIMELINE_LINE_RE.test(next)) break;
      if (/^#{1,6}\s/.test(next)) break;
      if (next.trim().length === 0 && detailLines.length === 0) {
        // skip leading blank line; if we hit a blank after detail content
        // and still no new entry, treat detail as ended.
        j++;
        continue;
      }
      if (next.trim().length === 0 && detailLines.length > 0) break;
      // Indented continuation lines are detail; flush-left non-list lines too.
      if (/^\s+/.test(next) || (!next.startsWith('-') && !next.startsWith('*') && !next.startsWith('#'))) {
        detailLines.push(next.trim());
        j++;
        continue;
      }
      break;
    }
    result.push({ date, summary, detail: detailLines.join(' ').trim() });
    i = j;
  }
  return result;
}

/** Validate date string represents a real calendar date in ISO YYYY-MM-DD form. */
function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, mo, d] = s.split('-').map(Number);
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > 31) return false;
  // Use Date object as final check (catches 2026-02-30 etc.)
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// ─── Auto-link config ───────────────────────────────────────────

/**
 * Read the auto_link config flag. Defaults to TRUE (auto-link is on by default).
 *
 * Accepts as falsy: 'false', '0', 'no', 'off' (case-insensitive, whitespace-trimmed).
 * Anything else (including null, '', 'true', '1', 'yes', garbage) -> true.
 *
 * The config is stored as a string via engine.setConfig/getConfig.
 */
export async function isAutoLinkEnabled(engine: BrainEngine): Promise<boolean> {
  const val = await engine.getConfig('auto_link');
  if (val == null) return true;
  const normalized = val.trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(normalized);
}
