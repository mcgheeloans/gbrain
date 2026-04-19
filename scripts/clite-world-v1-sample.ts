import { bootstrap } from '../src/clite/bootstrap.ts';
import { upsertEntity, addAlias } from '../src/clite/entities.ts';
import { insertTriple } from '../src/clite/triples.ts';
import { appendTimelineEvent } from '../src/clite/timeline.ts';
import { compileEntity } from '../src/clite/compile-entity.ts';
import { searchPersonChunks } from '../src/clite/retrieve-person.ts';
import { upsertPersonChunks } from '../src/clite/lance-store.ts';
import { readdirSync, readFileSync, rmSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(process.cwd(), 'eval/data/world-v1');
const DB = '/tmp/gbrain-clite-world-v1.db';
const PAGES = '/tmp/gbrain-clite-world-v1-pages';

type RecordDoc = {
  slug: string;
  type: string;
  title: string;
  compiled_truth?: string;
  timeline?: string;
  _facts?: Record<string, unknown>;
};

function clean() {
  try { unlinkSync(DB); } catch {}
  try { unlinkSync(DB + '-wal'); } catch {}
  try { unlinkSync(DB + '-shm'); } catch {}
  try { rmSync(PAGES, { recursive: true }); } catch {}
}

function parseTimelineBullets(text?: string): string[] {
  if (!text) return [];
  return text.split('\n').map(s => s.trim()).filter(s => s.startsWith('- **'));
}

function stripMdLinks(s: string): string {
  return s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
}

function extractLinks(text?: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const re = /\[[^\]]+\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(text))) out.add(m[1]!);
  return [...out];
}

function pickFiles(): string[] {
  const all = readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .map(f => join(DATA_DIR, f));

  const people = all.filter(f => f.includes('/people__')).slice(0, 20);
  const companies = all.filter(f => f.includes('/companies__')).slice(0, 20);
  return [...people, ...companies];
}

function titleFromSlug(slug: string): string {
  const base = slug.split('/').pop() ?? slug;
  return base
    .replace(/-\d+$/, '')
    .split('-')
    .filter(Boolean)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

function typeFromSlug(slug: string): string {
  if (slug.startsWith('people/')) return 'person';
  if (slug.startsWith('companies/')) return 'company';
  if (slug.startsWith('projects/')) return 'project';
  if (slug.startsWith('meetings/')) return 'meeting';
  if (slug.startsWith('concepts/')) return 'concept';
  return 'entity';
}

async function main() {
  if (!process.env.JINA_API_KEY) throw new Error('JINA_API_KEY not set');

  clean();
  mkdirSync(PAGES, { recursive: true });
  const { db } = bootstrap(DB);
  const files = pickFiles();

  const docs: RecordDoc[] = files.map(f => JSON.parse(readFileSync(f, 'utf8')));
  const slugs = docs.map(d => d.slug);

  for (const slug of slugs) {
    await upsertPersonChunks({ slug, title: slug.split('/')[1] ?? slug, chunks: [], vectors: [] });
  }

  const referencedSlugs = new Set<string>();
  for (const doc of docs) {
    for (const target of extractLinks(doc.compiled_truth)) referencedSlugs.add(target);
    for (const v of Object.values(doc._facts ?? {})) {
      if (Array.isArray(v)) {
        for (const item of v) if (typeof item === 'string' && item.includes('/')) referencedSlugs.add(item);
      } else if (typeof v === 'string' && v.includes('/')) {
        referencedSlugs.add(v);
      }
    }
  }

  for (const doc of docs) {
    const summary = stripMdLinks((doc.compiled_truth ?? '').split('\n\n')[0] ?? '');
    upsertEntity(db, doc.slug, doc.type, doc.title, summary);
    addAlias(db, doc.slug, doc.title, 'canonical');
  }

  for (const slug of referencedSlugs) {
    if (slugs.includes(slug)) continue;
    upsertEntity(db, slug, typeFromSlug(slug), titleFromSlug(slug), '');
  }

  for (const doc of docs) {
    const facts = doc._facts ?? {};
    for (const [k, v] of Object.entries(facts)) {
      if (k === 'slug' || k === 'type' || k === 'name') continue;
      if (Array.isArray(v)) {
        for (const item of v) {
          if (typeof item === 'string') {
            if (item.includes('/')) {
              insertTriple(db, { subjectSlug: doc.slug, predicate: k, objectEntitySlug: item, sourceType: 'world-v1', sourceRef: 'facts' });
            } else {
              insertTriple(db, { subjectSlug: doc.slug, predicate: k, objectLiteral: item, sourceType: 'world-v1', sourceRef: 'facts' });
            }
          }
        }
      } else if (typeof v === 'string') {
        if (v.includes('/')) {
          insertTriple(db, { subjectSlug: doc.slug, predicate: k, objectEntitySlug: v, sourceType: 'world-v1', sourceRef: 'facts' });
        } else {
          insertTriple(db, { subjectSlug: doc.slug, predicate: k, objectLiteral: v, sourceType: 'world-v1', sourceRef: 'facts' });
        }
      } else if (typeof v === 'number' || typeof v === 'boolean') {
        insertTriple(db, { subjectSlug: doc.slug, predicate: k, objectLiteral: String(v), sourceType: 'world-v1', sourceRef: 'facts' });
      }
    }

    for (const target of extractLinks(doc.compiled_truth)) {
      insertTriple(db, { subjectSlug: doc.slug, predicate: 'mentions', objectEntitySlug: target, sourceType: 'world-v1', sourceRef: 'compiled_truth' });
    }

    for (const line of parseTimelineBullets(doc.timeline)) {
      const m = line.match(/^- \*\*(\d{4}-\d{2}-\d{2})\*\* \| (.+)$/);
      appendTimelineEvent(db, {
        entitySlug: doc.slug,
        date: m?.[1] ?? new Date().toISOString().slice(0, 10),
        eventType: 'mentioned',
        sourceType: 'world-v1',
        sourceRef: 'timeline',
        summary: stripMdLinks(m?.[2] ?? line),
      });
    }
  }

  let compiled = 0;
  for (const doc of docs) {
    const res = await compileEntity(db, doc.slug, PAGES);
    if (res) compiled++;
  }

  const queries = [
    'founder of Forge',
    'fintech startup real-time payment reconciliation',
    'who invested in Quantum',
    'crypto infrastructure founder long-term thinker',
    'Austin startup payment analytics',
  ];

  const results: Record<string, unknown> = {};
  for (const q of queries) {
    const found = await searchPersonChunks(q, { limit: 5, db, expansion: false });
    results[q] = found.slice(0, 5).map(r => ({ slug: r.slug, title: r.title, entityType: r.entityType, score: r.score, source: r.chunkSource }));
  }

  console.log(JSON.stringify({
    filesLoaded: files.length,
    compiled,
    db: DB,
    pagesDir: PAGES,
    queries: results,
  }, null, 2));

  db.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
