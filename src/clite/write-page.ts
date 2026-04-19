/**
 * Write compiled entity pages to disk.
 *
 * First-slice: writes person pages as markdown files to a local pages directory.
 * Page path convention: `<pagesDir>/<entity-slug>.md`
 *   e.g. pagesDir="pages" → `pages/people/sarah-chen.md` (slug already encodes type prefix)
 *
 * This is the narrowest real local page-write path. It writes to the filesystem
 * and is designed to be swapped out later for memory-wiki ownership.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { RenderedPersonPage } from './render-person.ts';
import { markCompiled } from './freshness.ts';

export interface WritePageResult {
  /** Path of the written page */
  pagePath: string;
  /** Whether the file was actually written (false if content was identical) */
  written: boolean;
  /** Content hash of the page */
  contentHash: string;
}

/**
 * Write a rendered person page to disk.
 *
 * - Creates directories as needed.
 * - Skips write if existing file content is identical (idempotent).
 * - Calls markCompiled only after successful write.
 * - If writeFn throws, markCompiled is NOT called.
 *
 * @param pagesDir - root directory for pages (e.g. "pages")
 * @param page - rendered page from renderPersonPage
 * @param db - SQLite database (for markCompiled)
 * @param writeFn - override for testing (defaults to writeFileSync)
 */
export function writePersonPage(
  pagesDir: string,
  page: RenderedPersonPage,
  db: Database,
  writeFn: (path: string, content: string) => void = defaultWrite
): WritePageResult {
  const pagePath = join(pagesDir, `${page.entitySlug}.md`);

  // Check if existing content is identical
  let existing: string | null = null;
  try {
    existing = readFileSync(pagePath, 'utf-8');
  } catch {
    // File doesn't exist — will create
  }

  if (existing === page.content) {
    // Content unchanged — still mark compiled since we've confirmed it's current
    markCompiled(db, page.entitySlug);
    return { pagePath, written: false, contentHash: page.contentHash };
  }

  // Write the page
  writeFn(pagePath, page.content);

  // Mark compiled only after successful write
  markCompiled(db, page.entitySlug);

  return { pagePath, written: true, contentHash: page.contentHash };
}

/**
 * Default filesystem writer. Creates parent directories as needed.
 */
function defaultWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}
