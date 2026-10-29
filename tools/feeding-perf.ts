// Synthetic, reproducible benchmark of a facts-only start_run (quality-board) and a get_nodes page over a seedling root that
// carries a large compiled case set and a long feeding history. Temporary loopback PostgreSQL and scripted data only: no
// deployment, environment files, keychain or real content.
//   node tools/feeding-perf.ts <empty dir> [--root-cases 35772] [--documents 10] [--cases 101] [--runs 4] [--reader user|admin]
//     [--baseline <code tree>] [--stacks] [--profile] [--index]
//     [--phases start_run,view:counts,view:tags,view:placement,view:cases,usages,get_nodes,observe]
// The fixture is built once and cloned per measured code tree (CREATE DATABASE ... TEMPLATE), so a baseline tree (an export
// of an earlier commit with node_modules linked) and this tree measure identical data, each in a cold process. Each run
// reports wall time, CPU, SQL executions per statement and, with --stacks, per calling site, and the SHA-256 of every view
// the run bound; the comparison asserts that both trees bound the same bytes.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import type { DatabaseConfig } from '../hub/config/index.ts';

const HERE = fileURLToPath(new URL('..', import.meta.url));

interface Modules {
  records: typeof import('../hub/records/index.ts');
  config: typeof import('../hub/config/index.ts');
  db: typeof import('../hub/records/db.ts');
  api: typeof import('../hub/records/api.ts');
  runs: typeof import('../hub/runs/api.ts');
  runStore: typeof import('../hub/runs/engine/store.ts');
  knowledge: typeof import('../hub/knowledge/api.ts');
  seedling: typeof import('../hub/knowledge/seedling.ts');
  support: typeof import('../hub/knowledge/test-support.ts');
  parsers: typeof import('../hub/testing/parsers.ts');
  rules: typeof import('../hub/rules/api.ts');
  postgres: typeof import('../hub/testing/postgres.ts');
  runContract: typeof import('../contracts/src/run.ts');
  fixtures: typeof import('../contracts/src/fixtures.ts');
  knowledgeContract: typeof import('../contracts/src/knowledge.ts');
}

/** The Hub modules of one code tree; the worker of a baseline tree never loads this tree's modules. */
async function load(root: string): Promise<Modules> {
  const at = (path: string): string => pathToFileURL(join(root, path)).href;
  return {
    records: await import(at('hub/records/index.ts')),
    config: await import(at('hub/config/index.ts')),
    db: await import(at('hub/records/db.ts')),
    api: await import(at('hub/records/api.ts')),
    runs: await import(at('hub/runs/api.ts')),
    runStore: await import(at('hub/runs/engine/store.ts')),
    knowledge: await import(at('hub/knowledge/api.ts')),
    seedling: await import(at('hub/knowledge/seedling.ts')),
    support: await import(at('hub/knowledge/test-support.ts')),
    parsers: await import(at('hub/testing/parsers.ts')),
    rules: await import(at('hub/rules/api.ts')),
    postgres: await import(at('hub/testing/postgres.ts')),
    runContract: await import(at('contracts/src/run.ts')),
    fixtures: await import(at('contracts/src/fixtures.ts')),
    knowledgeContract: await import(at('contracts/src/knowledge.ts')),
  } as Modules;
}

export interface FeedingPerfOptions {
  /** Compiled case entries of the root (the facets and the index count them beside the fed cases). */
  rootCases: number;
  /** Fed mind map documents, each read once per run. */
  documents: number;
  /** Cases per fed document (at most the feeding row bound). */
  cases: number;
  /** Runs that read every fed document: each read appends one object, binding and usage record per case. */
  runs: number;
  reader: 'user' | 'admin';
}

export const DEFAULT_OPTIONS: FeedingPerfOptions = { rootCases: 35_772, documents: 10, cases: 101, runs: 4, reader: 'user' };

const BUILD = 'Rel_APV-zx-u_10_8_1_1';
const LINE = '10.8.0';
const MENUS = 40;
const ITEMS = 50;
const PER_DOCUMENT = 30;
const VIEWS = {
  counts: `knowledge:facets:apv:${BUILD}?kind=case&by=line,module,has_expected,negative,test_type_status`,
  tags: `knowledge:facets:apv:${BUILD}?kind=case&by=line,module,tags,resource_empty,tag_valid`,
  placement: `knowledge:facets:apv:${BUILD}?kind=case&by=commands`,
  cases: `knowledge:index:apv:${BUILD}?kind=case&key=case_location`,
};

/** Compiled cases of the root: one entry per synthetic mind map case, placed on a command or left at the root. */
const COMPILED_CASES = `export default function produce(input) {
  const entries = [];
  for (const doc of input.lists.cases) {
    const nodes = doc.model.nodes;
    const root = nodes[0].data;
    for (const node of nodes) {
      const data = node.data;
      if (!Array.isArray(data.resource) || data.priority === undefined) continue;
      const i = Number(String(data.id).slice(5));
      if (!Number.isFinite(i)) continue;
      const command = '/commands/m' + String(i % ${MENUS}).padStart(2, '0') + '/i' + String(Math.floor(i / ${MENUS}) % ${ITEMS}).padStart(3, '0');
      const placed = i % 9 !== 0;
      entries.push({ kind: 'case', path: placed ? command : null, statement: node.text,
        data: { document: String(root.id), node: 'node-' + i, line: '10.8', module: 'M' + (i % 23), has_expected: i % 7 !== 0, negative: i % 11 === 0,
          test_type_status: 'declared', tags: [i % 11 === 0 ? 'negative' : 'functional'], resource_empty: false, tag_valid: true,
          commands: placed ? [command] : [], case_location: 'src:' + doc.sha256 + '/kityminder@1/' + node.selector, steps: 'synthetic steps '.repeat(24) },
        fragments: [{ slot: 'cases', source: doc.sha256, parser: 'kityminder@1', selector: node.selector }], applicability: null });
    }
  }
  return { entries, warnings: [] };
}
`;

/** A command tree in the product's own grammar: the fed cases step on `system show`, the compiled ones on mNN/iNNN. */
function commandTree(): string {
  const menus = Array.from({ length: MENUS }, (_, m) => `<menu name="m${String(m).padStart(2, '0')}">${Array.from({ length: ITEMS }, (_, i) => `<item name="i${String(i).padStart(3, '0')}"><arguments/></item>`).join('')}</menu>`);
  return `<commands><menu name="system"><item name="show"><arguments/></item></menu>${menus.join('')}</commands>`;
}

/** A fed mind map in the agile structure the product's feeding projection reads. */
function fedDocument(d: number, cases: number): Uint8Array {
  const children = Array.from({ length: cases }, (_, i) => ({
    data: { id: `case-${i}`, autoid: `SYN-${d}-${i}`, text: `Synthetic fed case ${d}-${i} ${'说明'.repeat(40)}`, priority: 2, resource: [i % 13 === 0 ? 'negative' : 'functional'] },
    children: [{ data: { id: `step-${i}`, text: 'system show' }, children: [{ data: { id: `expect-${i}`, text: `Synthetic expected ${d}-${i}` }, children: [] }] }],
  }));
  return Buffer.from(JSON.stringify({ agile: { id: `SYN-DOC-${d}` }, root: { data: { id: 'root', text: 'Synthetic zx-u 10.8' }, children } }));
}

function productPack(): Parameters<Modules['runs']['writePack']>[1] {
  const apv = join(HERE, 'packs/product/apv');
  const manifest = JSON.parse(readFileSync(join(apv, 'pack.json'), 'utf8')) as { files: Array<{ path: string }> };
  const files: Record<string, string> = {};
  for (const file of manifest.files) if (file.path.startsWith('functions/')) files[file.path] = readFileSync(join(apv, file.path), 'utf8');
  files['functions/synthetic-tree.ts'] = "export {commandTree as default} from './producers.ts';\n";
  files['functions/synthetic-cases.ts'] = COMPILED_CASES;
  return {
    id: 'apv', version: '1.0.0', kind: 'product', title: '合成 APV 产品线', description: '性能基准用的合成产品包：真实喂入投影函数，合成的命令树与用例生产器',
    files: {
      ...files,
      'product.json': JSON.stringify({
        schema: 'product@1', id: 'apv', title: '合成 APV 产品线', names: ['APV', 'NSAE'],
        catalogs: [{ id: 'commands@1', entry_kind: 'definition', producer: 'command-tree', complete: true, case_sensitive: false }],
        producers: [
          { id: 'command-tree', title: '合成命令树', function: { module: 'functions/synthetic-tree.ts' }, inputs: { tree: { source: 'tree' } } },
          { id: 'cases', title: '合成用例', function: { module: 'functions/synthetic-cases.ts' }, inputs: { cases: { source: 'cases', many: true, batch: 60 } } },
        ],
        feeding: { project: { module: 'functions/feeding.ts' }, normalize_line: { module: 'functions/feeding.ts', export: 'normalizeLine' } },
      }),
    },
  };
}

interface Fixture {
  postgres: { config: DatabaseConfig };
  database: string;
  dataDir: string;
  keyPath: string;
  admin: { id: string; name: string; role: 'admin' | 'user' };
  reader: { id: string; name: string; role: 'admin' | 'user' };
  root: string;
  composition: string;
  /** The runs that read the fed documents (each holds a usage per fed object). */
  runs: string[];
  /** The fed documents: bytes digest, capture record and directory metadata digest. */
  fed: Array<{ sha: string; record: string; meta: string }>;
  counts: Record<string, number>;
  setupMs: number;
}

async function buildFixture(dir: string, postgres: Awaited<ReturnType<Modules['postgres']['startPostgres']>>, options: FeedingPerfOptions): Promise<Fixture> {
  const started = performance.now();
  const m = await load(HERE);
  const dataDir = join(dir, 'data');
  const database = await postgres.createDatabase('feeding_fixture');
  const keyProvider = new m.records.FileKeyProvider(join(dataDir, 'test-vault.key'));
  await mkdir(dataDir, { recursive: true });
  await keyProvider.initKey();
  const kit = await m.records.openRecords({ dataDir, logDir: join(dataDir, 'logs'), database, limits: { ...m.config.DEFAULT_LIMITS } }, { keyProvider });
  try {
    const requireOsIsolation = await m.rules.osIsolationAvailable();
    const { user: admin } = await kit.principals.bootstrapAdmin('管理员');
    await kit.authorizations.grantPublishRight(admin, admin.id);
    const reader = options.reader === 'admin' ? await kit.principals.createUser(admin, '评审管理员', 'admin') : await kit.principals.createUser(admin, '评审人');
    const registry = m.runs.createPackRegistry({ records: kit, extractDir: join(dir, 'extracted'), sandbox: { requireOsIsolation } });
    const publish = async (directory: string): Promise<void> => {
      const outcome = await registry.publish(admin, directory);
      if (!outcome.ok) throw new Error(`pack not published: ${JSON.stringify(outcome.problems).slice(0, 2000)}`);
    };
    await publish((await m.runs.writePack(join(dir, 'pack-apv'), productPack())).dir);
    await registry.activate(admin, 'apv');
    const { stage } = await import(pathToFileURL(join(HERE, 'packs/workflow/quality-board/pack-files.ts')).href) as typeof import('../packs/workflow/quality-board/pack-files.ts');
    await publish(await stage(join(dir, 'pack-quality-board')));
    // A workflow bound to the product's command catalog makes the product readable to an assigned user.
    await publish((await m.runs.writePack(join(dir, 'pack-binding'), m.runs.workflowPack({ id: 'synthetic-review' }))).dir);
    await registry.assign(admin, reader.id, 'quality-board');
    await registry.assign(admin, reader.id, 'synthetic-review');
    const packs = m.runs.createPacksPort(registry);
    const external = new m.support.FakeExternal(kit);
    const knowledge = m.knowledge.createKnowledge({ records: kit, parsers: m.parsers.createTestParserRegistry(), packs, external, sandbox: { requireOsIsolation }, admin });
    const product = await packs.productById('apv');
    assert.ok(product, 'the synthetic product is active');

    external.set('site:tree:synthetic', { bytes: commandTree(), mediaType: 'application/xml' });
    const documents: string[] = [];
    for (let d = 0, first = 0; first < options.rootCases; d++, first += PER_DOCUMENT) {
      const id = `store:mindmap:compiled-${d}`;
      documents.push(id);
      const cases = Array.from({ length: Math.min(PER_DOCUMENT, options.rootCases - first) }, (_, c) => ({ id: `case-${first + c}`, text: `合成用例 ${first + c} ${'描述'.repeat(40)}`, expected: (first + c) % 7 === 0 ? [] : [`返回 ${first + c}`] }));
      external.set(id, { bytes: m.support.mindMap({ id: `compiled-document-${String(d).padStart(5, '0')}`, line: '10.8' }, cases), mediaType: 'application/json' });
    }
    const produced = await knowledge.produceTree({ product, build: { name: BUILD, base: BUILD, family: 'APV', line: LINE, platform: 'zx-u', built_at: '2026-10-01T00:00:00.000Z', released_at: '2026-10-02T00:00:00.000Z', sources: { tree: 'site:tree:synthetic', cases: documents }, root: null }, by: admin });
    assert.equal(produced.ok, true, produced.reason ?? '');
    const root = produced.root!, composition = produced.composition!;
    const body = await knowledge.store.composition(composition);
    assert.ok(body);
    const tree = body.sources.find(source => source.producer === 'command-tree');
    assert.ok(tree, 'the root keeps its command tree source');
    const seed = m.knowledgeContract.SeedlingBody.parse({ product: 'apv', line: LINE, root, composition, build: BUILD, origin: [{ role: 'command-tree', producer: tree.producer, slot: tree.slot, external: tree.external, sha256: tree.sha256, revision: null }], parent: null, basis: 'Synthetic seed' });
    const seeded = await knowledge.store.putClaim('seedling@1', 'projected', seed, [{ key: 'knowledge.seedling', value: `apv/${LINE}` }, { key: 'knowledge.seedling.root', value: `apv/${root}` }]);
    await kit.pointers.move({ name: m.seedling.seedlingName('apv', LINE), expected: null, next: seeded.digest, by: admin, run: null, component: 'synthetic.feeding@1' });

    const layer = knowledge.feeding!;
    const visibility = { readers: [reader.id], admins: true, packs: [], shareable: false };
    const fed: Array<{ sha: string; record: string; meta: string }> = [];
    for (let d = 0; d < options.documents; d++) {
      const original = await kit.artifacts.ingest({ bytes: fedDocument(d, options.cases), mediaType: 'application/json', origin: { read: { object: `agile:mindmap:SYN-DOC-${d}` } }, author: { user: null }, provenanceType: 'observed', visibility, readTier: 'model_readable' });
      const meta = await kit.artifacts.ingest({ bytes: Buffer.from(JSON.stringify({ id: `SYN-DOC-${d}`, title: `Synthetic doc ${d}`, ancestors: ['rel_apv_10_8'], root: { id: 'synthetic-root', title: 'APV' } })), mediaType: 'application/json', origin: { read: { object: `agile:mindmap:SYN-DOC-${d}` } }, author: { user: null }, provenanceType: 'observed', visibility, readTier: 'model_readable' });
      fed.push({ sha: original.body.sha256, record: original.digest, meta: meta.body.sha256 });
    }
    const items = Array.from({ length: 100 }, (_, k) => ({ id: `doc-${k}:n${k}`, label: `合成条目 ${k} ${'标签'.repeat(20)}`, location: `src:${'a'.repeat(64)}/kityminder@1/n/case-${k}`, fields: { priority: 1 }, digest: 'b'.repeat(64) }));
    const runs: string[] = [];
    for (let r = 0; r < options.runs; r++) {
      const run = m.api.newId('run');
      runs.push(run);
      await m.runStore.putRun(kit.store, m.runContract.RunRecord.parse({ ...m.fixtures.runRecord, run, runner: reader.id, product: 'apv', items }), new Date().toISOString());
      for (const document of fed) {
        const receipt = await layer.observeSource(reader, document.sha, { product: 'apv', root, composition, sourceRecord: document.record, metaSource: document.meta, run });
        assert.equal(receipt.objects.length, options.cases, JSON.stringify(receipt.pending).slice(0, 2000));
      }
    }
    await layer.drain();
    const db = new pg.Client({ ...database });
    await db.connect();
    const counts: Record<string, number> = {};
    try {
      for (const [name, sql] of Object.entries({
        records: 'SELECT count(*)::int AS n FROM records',
        fed_product_records: "SELECT count(*)::int AS n FROM record_index WHERE key='knowledge.feeding.product' AND value='apv'",
        fed_bindings: "SELECT count(*)::int AS n FROM record_index WHERE key='knowledge.feeding.binding'",
        fed_usages: "SELECT count(*)::int AS n FROM record_index WHERE key='knowledge.feeding.usage.object'",
      })) counts[name] = (await db.query(sql)).rows[0].n;
    } finally { await db.end(); }
    counts.root_entries = produced.entries + produced.unplaced;
    return { postgres: { config: postgres.config }, database: database.database, dataDir, keyPath: keyProvider.path, admin: { id: admin.id, name: admin.name, role: admin.role }, reader: { id: reader.id, name: reader.name, role: reader.role }, root, composition, runs, fed, counts, setupMs: Math.round(performance.now() - started) };
  } finally {
    await kit.close();
  }
}

async function cloneDatabase(config: DatabaseConfig, from: string, to: string): Promise<void> {
  const client = new pg.Client({ ...config });
  await client.connect();
  try { await client.query(`CREATE DATABASE ${client.escapeIdentifier(to)} TEMPLATE ${client.escapeIdentifier(from)}`); } finally { await client.end(); }
}

interface WorkerInput {
  tree: string;
  fixture: Fixture;
  database: string;
  directory: string;
  stacks: boolean;
  phases: string[];
  /** Also bind the optional same-root case index (`cases` slot). */
  index: boolean;
}

export interface PhaseResult {
  wallMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  queries: number;
  sql: Array<{ text: string; count: number; ms: number }>;
  sites?: Array<{ count: number; text: string; site: string }>;
  detail: Record<string, unknown>;
}

export interface MeasureResult { tree: string; maxRSSKiB: number; phases: Record<string, PhaseResult> }

const SHAPE = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 220);

async function worker(input: WorkerInput): Promise<void> {
  const m = await load(input.tree);
  const fixture = input.fixture;
  const database = { ...fixture.postgres.config, database: input.database };
  const kit = await m.records.openRecords({ dataDir: fixture.dataDir, logDir: join(input.directory, 'logs'), database, limits: { ...m.config.DEFAULT_LIMITS } }, { migrate: false, keyProvider: new m.records.FileKeyProvider(fixture.keyPath) });
  const requireOsIsolation = await m.rules.osIsolationAvailable();
  const registry = m.runs.createPackRegistry({ records: kit, extractDir: await mkdtemp(join(input.directory, 'extracted-')), sandbox: { requireOsIsolation } });
  const packs = m.runs.createPacksPort(registry);
  const external = new m.support.FakeExternal(kit);
  const admin = { ...fixture.admin }, reader = { ...fixture.reader };
  const knowledge = m.knowledge.createKnowledge({ records: kit, parsers: m.parsers.createTestParserRegistry(), packs, external, sandbox: { requireOsIsolation }, admin });
  const notes: string[] = [];
  const runs = m.runs.createRunsService({ records: kit, workflows: m.runs.createWorkflowStore(registry), packs, knowledge, external: m.knowledge.routeKnowledgeViews(m.knowledge.createKnowledgeReader(knowledge), external), sandbox: { requireOsIsolation }, adminLog: entry => notes.push(`${entry.what}: ${entry.detail}`.slice(0, 400)) });

  let current: { queries: number; sql: Map<string, { count: number; ms: number }>; sites: Map<string, { count: number; text: string; site: string }> } | null = null;
  const prefix = pathToFileURL(input.tree).href.replace(/\/?$/, '/');
  const siteOf = (stack: string): string => {
    const frames: string[] = [];
    for (const line of stack.split('\n').slice(1)) {
      const match = /\((file:\/\/[^)]+)\)|at (?:async )?(file:\/\/\S+)/.exec(line);
      const url = match?.[1] ?? match?.[2];
      if (!url?.startsWith(prefix) || url.includes('/node_modules/') || url.includes('/hub/records/db.ts') || url.includes('/tools/feeding-perf.ts')) continue;
      const fn = /at (?:async )?([^\s(]+) \(/.exec(line)?.[1] ?? '';
      frames.push(`${url.slice(prefix.length).replace(/:\d+$/, '')}${fn ? ` ${fn}` : ''}`);
      if (frames.length === 7) break;
    }
    return frames.join(' < ');
  };
  // Every SQL execution is counted at the driver; the calling site is taken where the records layer issues the statement,
  // before the pool's callback loses the awaiting callers.
  const original = pg.Client.prototype.query;
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
    const stats = current;
    if (stats === null) return Reflect.apply(original, this, args);
    const text = SHAPE(typeof args[0] === 'string' ? args[0] : ((args[0] as { text?: string })?.text ?? 'unknown'));
    const stat = stats.sql.get(text) ?? { count: 0, ms: 0 };
    stats.sql.set(text, stat); stat.count++; stats.queries++;
    const start = performance.now();
    const callback = args.at(-1);
    if (typeof callback === 'function') { args[args.length - 1] = function (this: unknown, ...values: unknown[]) { stat.ms += performance.now() - start; return Reflect.apply(callback, this, values); }; }
    const promise = Reflect.apply(original, this, args);
    if (promise && typeof promise.finally === 'function') return promise.finally(() => { stat.ms += performance.now() - start; });
    return promise;
  } as typeof original;
  const issue = m.db.Database.prototype.query;
  if (input.stacks) m.db.Database.prototype.query = function (this: InstanceType<Modules['db']['Database']>, ...args: Parameters<typeof issue>) {
    const stats = current;
    if (stats !== null) {
      const holder: { stack?: string } = {};
      const limit = Error.stackTraceLimit; Error.stackTraceLimit = 60; Error.captureStackTrace(holder); Error.stackTraceLimit = limit;
      const text = SHAPE(args[0]), site = siteOf(holder.stack ?? ''), key = `${text}\0${site}`;
      const entry = stats.sites.get(key) ?? { count: 0, text, site };
      stats.sites.set(key, entry); entry.count++;
    }
    return Reflect.apply(issue, this, args);
  } as typeof issue;
  const phases: Record<string, PhaseResult> = {};
  const phase = async (name: string, body: () => Promise<Record<string, unknown>>): Promise<void> => {
    current = { queries: 0, sql: new Map(), sites: new Map() };
    const cpu = process.cpuUsage();
    const start = performance.now();
    let detail: Record<string, unknown>;
    try { detail = await body(); } catch (error) { detail = { error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 2000) : String(error) }; }
    const wallMs = Math.round(performance.now() - start);
    const used = process.cpuUsage(cpu);
    const stats = current;
    current = null;
    // Reads queue bounded feeding observations; they finish here, outside every measured window.
    await knowledge.feeding?.drain();
    phases[name] = {
      wallMs, cpuUserMs: Math.round(used.user / 1000), cpuSystemMs: Math.round(used.system / 1000), queries: stats.queries,
      sql: [...stats.sql.entries()].map(([text, stat]) => ({ text, count: stat.count, ms: Math.round(stat.ms) })).sort((a, b) => b.count - a.count).slice(0, 25),
      ...(input.stacks ? { sites: [...stats.sites.values()].sort((a, b) => b.count - a.count).slice(0, 40) } : {}),
      detail,
    };
  };
  let feedingOffset: unknown = undefined;
  try {
    if (input.phases.includes('start_run')) await phase('start_run', async () => {
      const inputs = { facets: [{ external: VIEWS.counts }, { external: VIEWS.tags }], placement: { external: VIEWS.placement }, ...(input.index ? { cases: { external: VIEWS.cases } } : {}) };
      const answer = await runs.startRun(reader, { pack: 'quality-board', inputs } as never, { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', sessionId: 'feeding-perf' });
      const out = answer as unknown as { call_result?: string; run?: { run: string }; result?: { counts?: unknown }; errors?: unknown[] };
      const stored = out.run ? await m.runs.runById(kit.store, out.run.run) : null;
      feedingOffset = stored?.body.feeding_offset;
      return {
        call_result: out.call_result ?? null,
        errors: (out.errors ?? []).map(error => JSON.stringify(error).slice(0, 600)),
        counts: out.result?.counts ?? null,
        bound: (stored?.body.sources ?? []).map(source => ({ slot: source.slot ?? null, external: source.external ?? null, reference: source.reference })),
        notes: notes.slice(0, 20),
      };
    });
    // Each bound view on its own, through the same knowledge reader the run engine uses, at the run's frozen offset.
    for (const [name, id] of Object.entries(VIEWS)) if (input.phases.includes(`view:${name}`)) await phase(`view:${name}`, async () => {
      const offset = feedingOffset ?? await knowledge.feeding!.freeze(reader, m.api.newId('run'), null);
      const context = { principal: reader, run: m.api.newId('run'), feeding_offset: offset as never, purpose: `运行输入 ${name}`, composition: null };
      const read = await m.api.withRequestPermissions(kit.artifacts, reader, () => m.knowledge.createKnowledgeReader(knowledge).read(id, context));
      if (!read.ok) return { ok: false, reason: read.reason.slice(0, 600) };
      const chosen = read.artifacts.find(artifact => artifact.name === 'original')!;
      const bytes = await kit.artifacts.trustedBytes(chosen.artifact.body.sha256);
      const view = JSON.parse(Buffer.from(bytes!).toString('utf8')) as { total?: number; total_entries?: number; truncated?: boolean; next?: string | null; rows?: unknown[]; notes?: string[] };
      return { ok: true, sha256: chosen.artifact.body.sha256, bytes: bytes!.byteLength, total: view.total ?? view.total_entries ?? null, rows: view.rows?.length ?? null, truncated: view.truncated ?? null, next: view.next !== null && view.next !== undefined, notes: (view.notes ?? []).map(note => note.slice(0, 300)) };
    });
    // What every tool reply on a run adds (feeding_objects, feeding_pending): here for a run that used every fed object.
    if (input.phases.includes('usages')) await phase('usages', async () => {
      const run = fixture.runs[0]!;
      const objects = await m.api.withRequestPermissions(kit.artifacts, reader, async () => ({ objects: await knowledge.feeding!.usages(reader, run), pending: await knowledge.feeding!.pending(reader, run) }));
      return { objects: objects.objects.length, pending: objects.pending.length, sha256: m.api.sha256Hex(Buffer.from(m.api.canonicalize([...objects.objects].sort()))) };
    });
    if (input.phases.includes('get_nodes')) await phase('get_nodes', async () => {
      const offset = feedingOffset ?? await knowledge.feeding!.freeze(reader, m.api.newId('run'), fixture.root);
      const page = await m.api.withRequestPermissions(kit.artifacts, reader, () => knowledge.getNodes({ root: fixture.root, feeding_offset: offset as never, paths: ['/'], depth: 1 }, reader));
      const bytes = Buffer.from(m.api.canonicalize(page));
      const objects = (page?.nodes ?? []).reduce((n, node) => n + ((node as { feeding_objects?: unknown[] }).feeding_objects?.length ?? 0), 0);
      return { nodes: page?.nodes.length ?? null, feeding_objects: objects, complete: page?.coverage.complete ?? null, sha256: m.api.sha256Hex(bytes), bytes: bytes.byteLength };
    });
    // The bounded observation every bound read queues: one more run reading one fed document (its projection is cached).
    // It appends records, so it runs last.
    if (input.phases.includes('observe')) await phase('observe', async () => {
      const run = m.api.newId('run'), document = fixture.fed[0]!;
      await m.runStore.putRun(kit.store, m.runContract.RunRecord.parse({ ...m.fixtures.runRecord, run, runner: reader.id, product: 'apv' }), new Date().toISOString());
      const receipt = await knowledge.feeding!.observeSource(reader, document.sha, { product: 'apv', root: fixture.root, composition: fixture.composition, sourceRecord: document.record, metaSource: document.meta, run });
      return { objects: receipt.objects.length, pending: receipt.pending.length };
    });
  } finally {
    pg.Client.prototype.query = original;
    m.db.Database.prototype.query = issue;
    await knowledge.feeding?.drain().catch(() => {});
    await kit.close();
  }
  // Disconnect only once the answer is flushed: a large message is dropped by an immediate disconnect.
  process.send?.({ tree: relative(HERE, input.tree) || '.', maxRSSKiB: process.resourceUsage().maxRSS, phases } satisfies MeasureResult, undefined, {}, () => process.disconnect?.());
}

function measure(input: WorkerInput, profile: boolean): Promise<MeasureResult> {
  return new Promise<MeasureResult>((resolveResult, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ['--worker'], { execArgv: profile ? ['--cpu-prof', `--cpu-prof-dir=${input.directory}`] : [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let answer: MeasureResult | undefined;
    child.on('message', message => { answer = message as MeasureResult; });
    child.on('error', reject);
    child.on('exit', code => (code === 0 && answer ? resolveResult(answer) : reject(new Error(`feeding benchmark worker exit ${code}`))));
    child.send(input);
  });
}

/** Builds the fixture, measures each tree on its own clone and checks that every tree bound the same view bytes. */
export async function benchmarkFeeding(directory: string, options: Partial<FeedingPerfOptions> & { trees?: string[]; stacks?: boolean; profile?: boolean; phases?: string[]; index?: boolean } = {}): Promise<{ fixture: Omit<Fixture, 'postgres' | 'keyPath' | 'dataDir'>; results: MeasureResult[] }> {
  const settings = { ...DEFAULT_OPTIONS, ...options };
  await mkdir(directory, { recursive: true });
  const m = await load(HERE);
  const postgres = await m.postgres.startPostgres({ private: true, maxConnections: 80, sharedBuffers: '256MB' });
  try {
    const fixture = await buildFixture(directory, postgres, settings);
    const results: MeasureResult[] = [];
    for (const [k, tree] of (options.trees ?? [HERE]).entries()) {
      const database = `feeding_measure_${k}`;
      await cloneDatabase(fixture.postgres.config, fixture.database, database);
      const run = resolve(directory, `measure-${k}`);
      await mkdir(run, { recursive: true });
      results.push(await measure({ tree: resolve(tree), fixture, database, directory: run, stacks: options.stacks === true, phases: options.phases ?? ['start_run', 'get_nodes'], index: options.index === true }, options.profile === true));
    }
    const bound = results.map(result => JSON.stringify((result.phases.start_run?.detail.bound ?? null)));
    if (results.length > 1) assert.ok(bound.every(value => value === bound[0]), `the trees bound different views:\n${bound.join('\n')}`);
    for (const name of ['usages', ...Object.keys(VIEWS).map(view => `view:${view}`)]) {
      const answers = results.map(result => result.phases[name]?.detail.sha256 ?? null);
      if (results.length > 1) assert.ok(answers.every(value => value === answers[0]), `the trees answered ${name} differently: ${answers.join(', ')}`);
    }
    const pages = results.map(result => result.phases.get_nodes?.detail.sha256 ?? null);
    if (results.length > 1) assert.ok(pages.every(value => value === pages[0]), `the trees read different node pages: ${pages.join(', ')}`);
    const { postgres: _p, keyPath: _k, dataDir: _d, ...shown } = fixture;
    return { fixture: shown, results };
  } finally {
    await postgres.stop();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--worker') process.once('message', message => void worker(message as WorkerInput).catch(error => { console.error(error); process.exitCode = 1; process.disconnect?.(); }));
  else {
    const args = process.argv.slice(2);
    const value = (name: string): string | undefined => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
    const number = (name: string, fallback: number): number => { const raw = value(name); return raw === undefined ? fallback : Number(raw); };
    const directory = resolve(args[0] ?? '');
    if (!args[0] || args[0].startsWith('--')) throw new Error('usage: node tools/feeding-perf.ts <empty dir> [options]');
    const baseline = value('--baseline');
    const result = await benchmarkFeeding(directory, {
      rootCases: number('--root-cases', DEFAULT_OPTIONS.rootCases), documents: number('--documents', DEFAULT_OPTIONS.documents), cases: number('--cases', DEFAULT_OPTIONS.cases), runs: number('--runs', DEFAULT_OPTIONS.runs),
      reader: value('--reader') === 'admin' ? 'admin' : 'user', trees: baseline ? [baseline, HERE] : [HERE], stacks: args.includes('--stacks'), profile: args.includes('--profile'), index: args.includes('--index'),
      ...(value('--phases') ? { phases: value('--phases')!.split(',') } : {}),
    });
    await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
    for (const measured of result.results) for (const [name, phase] of Object.entries(measured.phases)) console.log(JSON.stringify({ tree: measured.tree, phase: name, wallMs: phase.wallMs, cpuUserMs: phase.cpuUserMs, queries: phase.queries, detail: { ...phase.detail, bound: undefined, notes: undefined } }));
    console.log(JSON.stringify({ fixture: result.fixture }));
  }
}
