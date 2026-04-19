import { mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { precisionAtK, recallAtK, mrr, ndcgAtK, type EvalQrel } from '../src/core/search/eval.ts';
import { bootstrap } from '../src/clite/bootstrap.ts';
import { upsertEntity, addAlias } from '../src/clite/entities.ts';
import { insertTriple } from '../src/clite/triples.ts';
import { appendTimelineEvent } from '../src/clite/timeline.ts';
import { compileEntity } from '../src/clite/compile-entity.ts';
import { retrieveEntityPages } from '../src/clite/retrieve-person.ts';
import { upsertPersonChunks } from '../src/clite/lance-store.ts';

const DATA_DIR = join(process.cwd(), 'eval/data/world-v1');
const CLITE_DB = '/tmp/gbrain-world-v1-ab-clite.db';
const PAGES_DIR = '/tmp/gbrain-world-v1-ab-pages';
const QRELS_OUT = join(process.cwd(), 'eval/world-v1-qrels-sample.json');
const K = 5;

type RecordDoc = {
  slug: string;
  type: string;
  title: string;
  compiled_truth?: string;
  timeline?: string;
  _facts?: Record<string, unknown>;
};

type ReportRow = {
  query: string;
  expected: string[];
  coreHits: string[];
  cliteHits: string[];
  coreTop: string;
  cliteTop: string;
  coreP: number;
  cliteP: number;
  coreR: number;
  cliteR: number;
  coreMRR: number;
  cliteMRR: number;
  coreNDCG: number;
  cliteNDCG: number;
};

function clean() {
  try { unlinkSync(CLITE_DB); } catch {}
  try { unlinkSync(CLITE_DB + '-wal'); } catch {}
  try { unlinkSync(CLITE_DB + '-shm'); } catch {}
  try { rmSync(PAGES_DIR, { recursive: true }); } catch {}
}

function stripMdLinks(s: string): string {
  return s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
}

function parseTimelineBullets(text?: string): string[] {
  if (!text) return [];
  return text.split('\n').map(s => s.trim()).filter(s => s.startsWith('- **'));
}

function loadSelectedDocs(): RecordDoc[] {
  const all = readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .map(f => join(DATA_DIR, f));

  const people = all.filter(f => f.includes('/people__')).slice(0, 20);
  const companies = all.filter(f => f.includes('/companies__')).slice(0, 20);
  return [...people, ...companies].map(f => JSON.parse(readFileSync(f, 'utf8')) as RecordDoc);
}

function buildQrels(docs: RecordDoc[]): EvalQrel[] {
  const selected = new Set(docs.map(d => d.slug));
  const out: EvalQrel[] = [];

  for (const doc of docs) {
    const facts = doc._facts ?? {};

    if (doc.type === 'company') {
      const companyName = doc.title.split(' - ')[0] ?? doc.title;
      const founders = ((facts.founders as unknown[]) ?? []).filter((s): s is string => typeof s === 'string' && selected.has(s));
      const investors = ((facts.investors as unknown[]) ?? []).filter((s): s is string => typeof s === 'string' && selected.has(s));
      const advisors = ((facts.advisors as unknown[]) ?? []).filter((s): s is string => typeof s === 'string' && selected.has(s));
      const employees = ((facts.employees as unknown[]) ?? []).filter((s): s is string => typeof s === 'string' && selected.has(s));

      if (founders.length) {
        out.push({ query: `who founded ${companyName}`, relevant: founders });
        out.push({ query: `founder of ${companyName}`, relevant: founders });
      }
      if (investors.length) {
        out.push({ query: `who invested in ${companyName}`, relevant: investors });
      }
      if (advisors.length) {
        out.push({ query: `advisor to ${companyName}`, relevant: advisors });
      }
      if (employees.length) {
        out.push({ query: `employee at ${companyName}`, relevant: employees });
      }
    }

    if (doc.type === 'person') {
      const personName = doc.title;
      const affiliation = facts.primary_affiliation;
      if (typeof affiliation === 'string' && selected.has(affiliation)) {
        out.push({ query: `${personName} company`, relevant: [affiliation] });
        out.push({ query: `where does ${personName} work`, relevant: [affiliation] });
      }
    }
  }

  return out;
}

function buildGradesMap(qrel: EvalQrel): Map<string, number> {
  if (qrel.grades && Object.keys(qrel.grades).length > 0) return new Map(Object.entries(qrel.grades));
  return new Map(qrel.relevant.map(slug => [slug, 1]));
}

async function cleanupLance(slugs: string[]) {
  for (const slug of slugs) {
    await upsertPersonChunks({ slug, title: slug.split('/').pop() ?? slug, chunks: [], vectors: [] });
  }
}

async function setupCore(docs: RecordDoc[]) {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  const selected = new Set(docs.map(d => d.slug));

  for (const doc of docs) {
    await engine.putPage(doc.slug, {
      type: doc.type as any,
      title: doc.title,
      compiled_truth: doc.compiled_truth ?? '',
      timeline: doc.timeline ?? '',
    });

    await engine.upsertChunks(doc.slug, [{
      chunk_index: 0,
      chunk_text: doc.compiled_truth ?? '',
      chunk_source: 'compiled_truth',
    }]);
  }

  for (const doc of docs) {
    const facts = doc._facts ?? {};
    for (const [key, value] of Object.entries(facts)) {
      if (key === 'slug' || key === 'type' || key === 'name') continue;
      const vals = Array.isArray(value) ? value : [value];
      for (const v of vals) {
        if (typeof v === 'string' && selected.has(v)) {
          await engine.addLink(doc.slug, v, key, key);
        }
      }
    }
  }

  return engine;
}

async function setupClite(docs: RecordDoc[]) {
  clean();
  mkdirSync(PAGES_DIR, { recursive: true });
  const { db } = bootstrap(CLITE_DB);

  for (const doc of docs) {
    const summary = stripMdLinks((doc.compiled_truth ?? '').split('\n\n')[0] ?? '');
    upsertEntity(db, doc.slug, doc.type, doc.title, summary);
    addAlias(db, doc.slug, doc.title, 'canonical');
  }

  const selected = new Set(docs.map(d => d.slug));

  for (const doc of docs) {
    const facts = doc._facts ?? {};
    for (const [key, value] of Object.entries(facts)) {
      if (key === 'slug' || key === 'type' || key === 'name') continue;
      if (Array.isArray(value)) {
        for (const v of value) {
          if (typeof v === 'string' && selected.has(v)) {
            insertTriple(db, { subjectSlug: doc.slug, predicate: key, objectEntitySlug: v, sourceType: 'world-v1', sourceRef: 'facts' });
          } else if (typeof v === 'string') {
            insertTriple(db, { subjectSlug: doc.slug, predicate: key, objectLiteral: v, sourceType: 'world-v1', sourceRef: 'facts' });
          }
        }
      } else if (typeof value === 'string') {
        if (selected.has(value)) {
          insertTriple(db, { subjectSlug: doc.slug, predicate: key, objectEntitySlug: value, sourceType: 'world-v1', sourceRef: 'facts' });
        } else {
          insertTriple(db, { subjectSlug: doc.slug, predicate: key, objectLiteral: value, sourceType: 'world-v1', sourceRef: 'facts' });
        }
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        insertTriple(db, { subjectSlug: doc.slug, predicate: key, objectLiteral: String(value), sourceType: 'world-v1', sourceRef: 'facts' });
      }
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

  for (const doc of docs) {
    await compileEntity(db, doc.slug, PAGES_DIR);
  }

  return db;
}

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  if (!process.env.JINA_API_KEY) throw new Error('JINA_API_KEY not set');

  const docs = loadSelectedDocs();
  const qrels = buildQrels(docs);
  writeFileSync(QRELS_OUT, JSON.stringify({ version: 1, queries: qrels }, null, 2));

  const core = await setupCore(docs);
  const db = await setupClite(docs);
  const rows: ReportRow[] = [];

  for (const qrel of qrels) {
    const coreResults = await hybridSearch(core, qrel.query, { limit: K, expansion: false });
    const cliteResults = await retrieveEntityPages(qrel.query, { limit: K, db, expansion: false });

    const coreHits = coreResults.map(r => r.slug);
    const cliteHits = cliteResults.map(r => r.slug);
    const relevantSet = new Set(qrel.relevant);
    const gradesMap = buildGradesMap(qrel);

    rows.push({
      query: qrel.query,
      expected: qrel.relevant,
      coreHits,
      cliteHits,
      coreTop: coreHits[0] ?? '',
      cliteTop: cliteHits[0] ?? '',
      coreP: precisionAtK(coreHits, relevantSet, K),
      cliteP: precisionAtK(cliteHits, relevantSet, K),
      coreR: recallAtK(coreHits, relevantSet, K),
      cliteR: recallAtK(cliteHits, relevantSet, K),
      coreMRR: mrr(coreHits, relevantSet),
      cliteMRR: mrr(cliteHits, relevantSet),
      coreNDCG: ndcgAtK(coreHits, gradesMap, K),
      cliteNDCG: ndcgAtK(cliteHits, gradesMap, K),
    });
  }

  const mean = (vals: number[]) => vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
  const summary = {
    queries: qrels.length,
    k: K,
    core: {
      mean_precision: mean(rows.map(r => r.coreP)),
      mean_recall: mean(rows.map(r => r.coreR)),
      mean_mrr: mean(rows.map(r => r.coreMRR)),
      mean_ndcg: mean(rows.map(r => r.coreNDCG)),
      top1_hits: rows.filter(r => r.expected.includes(r.coreTop)).length,
    },
    clite: {
      mean_precision: mean(rows.map(r => r.cliteP)),
      mean_recall: mean(rows.map(r => r.cliteR)),
      mean_mrr: mean(rows.map(r => r.cliteMRR)),
      mean_ndcg: mean(rows.map(r => r.cliteNDCG)),
      top1_hits: rows.filter(r => r.expected.includes(r.cliteTop)).length,
    },
    qrelsPath: QRELS_OUT,
    sampleRows: rows,
  };

  console.log(JSON.stringify(summary, null, 2));

  db.close();
  await core.disconnect();
  await cleanupLance(docs.map(d => d.slug));
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
