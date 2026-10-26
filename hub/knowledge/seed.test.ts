// The knowledge seed command and the feeding hang from a per-build root onto the line's current seedling.
// Synthetic only: loopback SVN, platform zx-u, version lines from 10.8, addresses in 192.0.2.0/24.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProductDeclaration, type Producer } from '../../contracts/src/product.ts';
import { SeedlingBody } from '../../contracts/src/knowledge.ts';
import { canonicalize } from '../records/api.ts';
import { manifestDigest } from '../runs/api.ts';
import { createConnectors, type Connectors } from '../connectors/api.ts';
import type { ResourceCatalogPort } from '../ports.ts';
import { addSyntheticResource, setSyntheticCredential } from '../connectors/testing/credentials.ts';
import { fakePacks } from '../connectors/testing/packs.ts';
import { startStub, text, type StubServer } from '../connectors/testing/api.ts';
import { createDefaultRegistry } from '../refs/api.ts';
import { readManifest, stagePack } from '../../packs/workflow/case-review/packaging.ts';
import { PACK_DIR } from '../../packs/system/svn/api.ts';
import { knowledgeCliCommand } from './cli.ts';
import { seedlingName } from './seedling.ts';
import { formatSeedReport, knowledgeSeed, parseKnowledgeSeedArgs, seedRoles } from './seed.ts';
import { catalogXml, makeWorld, sandboxIsolation, startPostgres, STATIC_PLAN_SOURCE, DEFAULT_SYNC, type World } from './test-support.ts';

const LINE = '10.8';
const BUILD = 'Synthetic_zx-u_10_8_1';
const PREFIX = '/repository';
const CLI_ID = 'svn:file:17/cli.adoc';
const APP_ID = 'svn:file:17/app.adoc';
const CLI_PATH = `${PREFIX}/!svn/rvr/17/cli.adoc`;
const APP_PATH = `${PREFIX}/!svn/rvr/17/app.adoc`;

const TREE = catalogXml({
  system: [{ name: 'reboot', params: [{ name: 'delay', type: 'int', min: 0, max: 600 }], help: 'restart the unit (192.0.2.10)' }],
});
const CLI = ['# CLI 手册 10.8', '', '## 命令 system reboot', '', '`system reboot <delay:int>` 重启 zx-u 设备。', '', '管理地址在 192.0.2.0/24。', ''].join('\n');
const APP = ['# APP 手册 10.8', '', '## 首页', '', '登录 zx-u 后进入首页。', ''].join('\n');

const MANUALS = `
export function cli(input: any): unknown {
  const slot = input.slots.cli;
  if (slot === null) return { entries: [], warnings: ['没有 CLI 手册'] };
  return manualEntries(slot.model, 'cli');
}
export function app(input: any): unknown {
  const slot = input.slots.app;
  if (slot === null) return { entries: [], warnings: ['没有 APP 手册'] };
  return manualEntries(slot.model, 'app');
}
function manualEntries(model: any, book: string): unknown {
  const entries: any[] = [];
  for (const block of model.blocks) {
    if (block.kind !== 'paragraph' || block.selector === null) continue;
    const path = block.path.map((p: any) => p.toLowerCase().replace(/ /g, '%20').replace(/\\//g, '%2F')).join('/');
    const anchor = new RegExp('\\x60([a-z][a-z0-9 ]*(?: <[a-z]+:[a-z]+>)*)\\x60').exec(block.text);
    entries.push(anchor === null
      ? { kind: 'definition', path: '/manual/' + book + '/' + path, statement: block.text, data: {}, fragments: [{ slot: book, parser: 'markdown@1', selector: block.selector }], applicability: null }
      : { kind: 'behaviour', path: '/commands/' + anchor[1].split(' <')[0].split(' ').join('/'), statement: block.text, data: { signature: anchor[1] }, fragments: [{ slot: book, parser: 'markdown@1', selector: block.selector }], applicability: null });
  }
  return { entries, warnings: [] };
}
`;

const FN = { module: 'functions/manuals.ts' };
function manualProducer(id: string, family: string): Producer {
  return {
    id, title: id, function: FN, params: { family },
    inputs: {
      tree: { source: 'tree' },
      cli: { external: 'manual:cli:{line}', optional: true },
      app: { external: 'manual:app:{line}', optional: true },
    },
  };
}

function declared(producers: Producer[], catalogs: Array<{ id: string; producer?: string }> = [{ id: 'commands@1', producer: 'command-tree' }]) {
  return ProductDeclaration.parse({
    schema: 'product@1', id: 'acme', title: '合成产品', names: ['ACME', 'FAMX', 'FAMY'], catalogs: catalogs.map((catalog) => ({ entry_kind: 'definition', complete: true, case_sensitive: false, ...catalog })), producers,
  });
}

test('seed arguments and pack roles', async () => {
  assert.deepEqual(parseKnowledgeSeedArgs(['--product', 'ACME', '--line', LINE, '--build', BUILD, '--basis', '补上 10.8 的树苗', '--dry-run']), {
    product: 'ACME', line: LINE, build: BUILD, basis: '补上 10.8 的树苗', dryRun: true,
  });
  assert.throws(() => parseKnowledgeSeedArgs(['--product', 'ACME', '--line', LINE]), /--basis/);
  assert.throws(() => parseKnowledgeSeedArgs(['--product', 'ACME', '--line', LINE, '--basis', '第一行\n第二行']), /一行/);
  const command = knowledgeCliCommand(async () => { throw new Error('不应打开服务'); });
  const err: string[] = [];
  const code = await command.run(['seed', '--product', 'ACME'], { io: { stdout() {}, stderr(line) { err.push(line); } }, actingAdmin: async () => { throw new Error('不应要管理员'); } });
  assert.equal(code, 2);
  assert.match(err.join('\n'), /--basis/);

  const product = declared([
    manualProducer('manual-famy', 'FAMY'),
    manualProducer('manual-famx', 'FAMX'),
    { id: 'command-tree', title: '命令树', function: { module: 'functions/commands.ts' }, inputs: { tree: { source: 'tree' } } },
  ]);
  const famx = seedRoles(product, 'FAMX');
  assert.deepEqual(famx.gaps, []);
  assert.equal(famx.bindings['command-tree']?.producer, 'command-tree');
  assert.equal(famx.bindings['cli-manual']?.producer, 'manual-famx');
  assert.equal(famx.bindings['cli-manual']?.slot, 'cli');
  assert.equal(famx.bindings['app-manual']?.producer, 'manual-famx');
  const waiting = seedRoles(product, null);
  assert.equal(waiting.bindings['command-tree']?.producer, 'command-tree');
  assert.match(waiting.gaps.map((item) => item.role).join(','), /cli-manual/);
  assert.match(waiting.gaps.map((item) => item.next).join('\n'), /--build/);
  const missing = seedRoles(declared([{ id: 'command-tree', title: '命令树', function: { module: 'functions/commands.ts' }, inputs: { tree: { source: 'tree' } } }]), 'ACME');
  assert.match(missing.gaps.find((item) => item.role === 'cli-manual')?.detail ?? '', /没有声明/);
  assert.match(missing.gaps.find((item) => item.role === 'cli-manual')?.next ?? '', /重新发布产品包/);
  const catalog = seedRoles(declared([
    { id: 'commands', title: '命令', function: { module: 'functions/commands.ts' }, inputs: { tree: { source: 'tree' }, cli: { external: 'manual:cli:fixed' }, app: { external: 'manual:app:fixed' } } },
  ], [{ id: 'commands@1', producer: 'commands' }]), 'ACME');
  assert.equal(catalog.bindings['command-tree']?.producer, 'commands');
  assert.equal(catalog.bindings['cli-manual']?.slot, 'cli');
});

interface Loop {
  w: World;
  server: StubServer;
  authorization: string;
  close: () => Promise<void>;
}

async function loopback(t: { after: (fn: () => Promise<void> | void) => void }, options: { app?: boolean; resource?: boolean } = {}): Promise<Loop & { resources: ResourceCatalogPort }> {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const build = { name: BUILD, base: BUILD, family: 'ACME', line: LINE, platform: 'zx-u', built_at: '2026-10-01T00:00:00.000Z', released_at: '2026-10-02T00:00:00.000Z', sources: { tree: 'site:tree:10_8' } };
  const w = await makeWorld(pg, { pack: { functions: { 'manuals.ts': MANUALS, 'plan.ts': STATIC_PLAN_SOURCE }, declaration: { sync: { ...DEFAULT_SYNC, options: { builds: [build] } }, catalogs: [], producers: [
    { id: 'command-tree', title: '命令树', function: { module: 'functions/commands.ts' }, inputs: { tree: { source: 'tree' } } },
    { id: 'cli-manual', title: 'CLI 手册', function: { module: 'functions/manuals.ts', export: 'cli' }, inputs: { cli: { external: CLI_ID } } },
    { id: 'app-manual', title: 'APP 手册', function: { module: 'functions/manuals.ts', export: 'app' }, inputs: { app: { external: APP_ID } } },
  ] } } });
  t.after(() => w.close());
  w.external.set('site:tree:10_8', { bytes: TREE, mediaType: 'application/xml' });
  const authorization = `Basic ${randomBytes(24).toString('base64')}`;
  const server = await startStub((request) => {
    if (request.headers.authorization !== authorization) return text('Unauthorized', 'text/plain', 401);
    if (request.method === 'GET' && request.path === CLI_PATH) return text(CLI, 'text/markdown');
    if (request.method === 'GET' && request.path === APP_PATH) return options.app === false ? text('Absent', 'text/plain', 404) : text(APP, 'text/markdown');
    return text('Absent', 'text/plain', 404);
  });
  t.after(() => server.close());
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-seed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = await stagePack(PACK_DIR, join(root, 'svn'));
  const manifest = await readManifest(directory);
  const svnPacks = fakePacks([{ id: manifest.id, version: manifest.version, kind: manifest.kind, digest: manifestDigest(manifest), directory }]);
  const connectors: Connectors = createConnectors({
    records: w.kit, packs: svnPacks, sandbox: { requireOsIsolation: await sandboxIsolation() }, parsers: createDefaultRegistry(), resourceCacheMs: 0,
  });
  const original = w.external.read.bind(w.external);
  w.external.read = (id, readContext) => id.startsWith('svn:') ? connectors.reader.read(id, readContext) : original(id, readContext);
  if (options.resource !== false) {
    const resource = (await addSyntheticResource(w.kit, svnPacks, connectors, w.admin, { system_pack: 'svn', name: '合成仓库', environment: 'test', origins: { svn: `${server.origin}${PREFIX}` }, allow_plaintext: [server.origin], settings: { repository_path: PREFIX } })).id;
    await setSyntheticCredential(w.kit, connectors, w.admin, resource, 'authorization', authorization);
  }
  return { w, server, authorization, resources: options.resource === false ? { list: async () => [] } : connectors.catalog, close: async () => {} };
}

test('seed reads the three sources over loopback SVN and records the revision', { timeout: 120000 }, async (t) => {
  const loop = await loopback(t);
  const synced = await loop.w.knowledge.syncProduct(loop.w.product, { by: loop.w.admin });
  assert.equal(synced.error, null, synced.error ?? undefined);
  const dry = await knowledgeSeed(loop.w.knowledge, loop.w.packs, loop.w.admin, parseKnowledgeSeedArgs(['--product', 'ACME', '--line', LINE, '--basis', '先看 10.8 的三份来源', '--dry-run']), loop.resources);
  const dryText = formatSeedReport(dry);
  assert.equal(dry.ok, true, dryText);
  assert.match(dryText, /试运行不写树苗，读取仍留审计/);
  assert.match(dryText, /修订 17/);
  assert.equal(await loop.w.kit.pointers.get(seedlingName(loop.w.product.id, LINE)), null);
  const seeded = await knowledgeSeed(loop.w.knowledge, loop.w.packs, loop.w.admin, parseKnowledgeSeedArgs(['--product', 'ACME', '--line', LINE, '--build', BUILD, '--basis', '育 10.8 的树苗']), loop.resources);
  const text = formatSeedReport(seeded);
  assert.equal(seeded.ok, true, text);
  assert.match(text, /组成/);
  assert.match(text, /来源/);
  assert.match(text, /修订 17/);
  assert.match(text, /指针/);
  assert.equal(text.includes(loop.authorization), false);
  assert.equal(text.includes('127.0.0.1'), false);
  assert.equal(text.includes('http:'), false);
  assert.equal(seeded.pointer?.moved, true);
  assert.equal(seeded.pointer?.to, seeded.root);
  const composed = await loop.w.knowledge.store.composition(seeded.composition!);
  const svn = (composed?.sources ?? []).filter((source) => source.external.startsWith('svn:'));
  assert.deepEqual(svn.map((source) => source.revision).sort(), ['17', '17']);
  const record = await loop.w.knowledge.store.records.get(seeded.seedling!);
  const body = SeedlingBody.parse(record?.body);
  assert.equal(body.origin.find((source) => source.role === 'cli-manual')?.revision, '17');
  assert.equal(body.origin.find((source) => source.role === 'app-manual')?.revision, '17');
  assert.equal(body.origin.find((source) => source.role === 'command-tree')?.revision, null);
  assert.equal(await loop.w.kit.pointers.get(seedlingName(loop.w.product.id, LINE)).then((pointer) => pointer?.target), seeded.root);
});

test('a missing manual is named and does not write a seedling', { timeout: 120000 }, async (t) => {
  const loop = await loopback(t, { app: false });
  await loop.w.knowledge.syncProduct(loop.w.product, { by: loop.w.admin });
  const seeded = await knowledgeSeed(loop.w.knowledge, loop.w.packs, loop.w.admin, parseKnowledgeSeedArgs(['--product', 'acme', '--line', LINE, '--basis', 'APP 手册缺了']), loop.resources);
  const text = formatSeedReport(seeded);
  assert.equal(seeded.ok, false);
  assert.match(text, /缺 APP 手册（app-manual）/);
  assert.match(text, /app\.adoc/);
  assert.match(text, /下一步：/);
  assert.equal(await loop.w.kit.pointers.get(seedlingName(loop.w.product.id, LINE)), null);
});

test('no enabled svn resource names the resource command and sends nothing', { timeout: 120000 }, async (t) => {
  const loop = await loopback(t, { resource: false });
  await loop.w.knowledge.syncProduct(loop.w.product, { by: loop.w.admin });
  const before = loop.server.requests.length;
  const seeded = await knowledgeSeed(loop.w.knowledge, loop.w.packs, loop.w.admin, parseKnowledgeSeedArgs(['--product', 'acme', '--line', LINE, '--basis', '还没有仓库']), loop.resources);
  const text = formatSeedReport(seeded);
  assert.equal(loop.server.requests.length, before);
  assert.equal(before, 0);
  assert.match(text, /没有启用的 svn 系统包资源/);
  assert.match(text, /circle-hub resource add svn/);
  assert.equal(seeded.ok, false);
  assert.equal(await loop.w.kit.pointers.get(seedlingName(loop.w.product.id, LINE)), null);
});

const PROJECT = `export default function project(input:any){const m=input.model;if(input.source.system!=='plm'||m.kind!=='bug')return {rows:[]};const fields=m.fields;return {rows:[{body:{schema:'fed-defect@1',product:input.product,root:input.root,path:null,source:{system:'plm',ticket:input.source.key,revision:null,bytes:input.source.bytes},id:m.id,status:fields.status,affected_lines:fields.affected_lines,resolved_lines:[],fix_builds:[]},identity:{id:m.id,fields},lines:fields.affected_lines,selector:'p',grammar:'synthetic-defect@1',conflict:false}]};}`;

test('a locked per-build root hangs on the current seedling of its version line', { timeout: 120000 }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const first = { name: BUILD, base: BUILD, family: 'ACME', line: LINE, platform: 'zx-u', built_at: '2026-10-01T00:00:00.000Z', released_at: '2026-10-02T00:00:00.000Z', sources: { tree: 'site:tree:10_8' } };
  const second = { ...first, name: 'Synthetic_zx-u_10_8_2', base: 'Synthetic_zx-u_10_8_2', sources: { tree: 'site:tree:10_8_b' } };
  const w = await makeWorld(pg, { pack: { functions: { 'feeding.ts': PROJECT, 'plan.ts': STATIC_PLAN_SOURCE }, declaration: { sync: { ...DEFAULT_SYNC, options: { builds: [first] } }, feeding: { project: { module: 'functions/feeding.ts' } } } } });
  t.after(() => w.close());
  w.external.set('site:tree:10_8', { bytes: catalogXml({ system: [{ name: 'show', params: [] }] }), mediaType: 'application/xml' });
  w.external.set('site:tree:10_8_b', { bytes: catalogXml({ system: [{ name: 'reboot', params: [] }] }), mediaType: 'application/xml' });
  await w.knowledge.syncProduct(w.product, { by: w.admin });
  await w.knowledge.syncProduct(w.product, { by: w.admin, options: { builds: [second] } });
  const older = await w.knowledge.rootOfBuild(w.product.id, first.name);
  const newer = await w.knowledge.rootOfBuild(w.product.id, second.name);
  assert.ok(older && newer);
  assert.notEqual(older.root, newer.root);
  const composition = await w.knowledge.store.composition(newer.composition);
  assert.ok(composition);
  const original = composition.sources[0];
  const body = SeedlingBody.parse({ product: w.product.id, line: LINE, root: newer.root, composition: newer.composition, build: second.name, origin: [{ role: 'command-tree', producer: original.producer, slot: original.slot, external: original.external, sha256: original.sha256, revision: null }], parent: null, basis: '合成树苗挂在后一个构建上' });
  const rec = await w.knowledge.store.putClaim('seedling@1', 'projected', body, [{ key: 'knowledge.seedling.root', value: `${w.product.id}/${newer.root}` }, { key: 'knowledge.seedling', value: `${w.product.id}/${LINE}` }]);
  await w.kit.pointers.move({ name: seedlingName(w.product.id, LINE), expected: null, next: rec.digest, by: w.admin, run: null, component: 'synthetic.feeding@1' });
  const artifact = await w.kit.artifacts.ingest({ bytes: Buffer.from(JSON.stringify({ kind: 'bug', id: 'SYN-HANG', fields: { status: 'open', affected_lines: [LINE] } })), mediaType: 'application/json', origin: { read: { object: 'plm:bug:SYN-HANG' } }, author: { user: null }, provenanceType: 'observed', visibility: { readers: [w.user.id], admins: true, packs: [], shareable: false }, readTier: 'model_readable' });
  const receipt = await w.knowledge.feeding!.observeSource(w.user, artifact.body.sha256, { product: w.product.id, root: older.root, composition: older.composition, line: LINE });
  assert.equal(receipt.objects.length, 1, JSON.stringify(receipt.pending));
  const view = (await w.knowledge.feeding!.entries(w.user, w.product.id)).find((row) => row.body.schema === 'fed-defect@1');
  assert.ok(view);
  const data = view.claim.statement.data as { seedling_attachment?: { locked_root: string; seedling_root: string; seedling_composition: string; line: string } };
  assert.equal(data.seedling_attachment?.locked_root, older.root);
  assert.equal(data.seedling_attachment?.seedling_root, newer.root);
  assert.equal(data.seedling_attachment?.seedling_composition, newer.composition);
  assert.equal(data.seedling_attachment?.line, LINE);
  assert.ok(view.claim.validity.bound.includes(newer.composition));
  assert.ok(view.claim.validity.bound.includes(newer.root));
});

const BOOK = '192.0.2.32 book page';
const APP_PAGE = '192.0.2.33 app page';
const MARKDOWN_CLI = '192.0.2.31 markdown page';
const MARKDOWN_APP = '192.0.2.34 markdown app';
const DIR = 'synthetic/10.8';
const META_ID = `svn:directory:${encodeURIComponent(DIR)}`;
const fileId = (name: string): string => `svn:file:17/${encodeURIComponent(`${DIR}/${name}`)}`;
const BOOK_ID = fileId('book.adoc');
const APP_ID_ADOC = fileId('app.adoc');

const DIRECTORY_MANUAL = `
export default function produce(input: any): unknown {
  if (input.params.root === null) {
    const entries: any[] = [];
    for (const book of ['cli', 'app']) {
      const slot = input.slots[book];
      if (!slot || !Array.isArray(slot.model?.blocks)) continue;
      for (const block of slot.model.blocks) {
        if (block.kind !== 'paragraph' || block.selector === null) continue;
        entries.push({ kind: 'definition', path: '/manual/' + book + '/page', statement: block.text, data: {}, fragments: [{ slot: book, parser: 'markdown@1', selector: block.selector }], applicability: null });
      }
    }
    return { entries, warnings: [] };
  }
  if (!input.batch || input.batch.of !== 1) throw new Error('split batch');
  const meta = input.slots.meta;
  if (!meta || meta.parser !== 'json@1' || !Array.isArray(meta.model?.members)) throw new Error('missing meta');
  const files = input.lists?.files ?? [];
  const expected = meta.model.members.filter((member: any) => member.directory !== true).map((member: any) => member.external);
  const given = files.map((file: any) => file.external);
  if (expected.length !== given.length || expected.some((id: string) => !given.includes(id)) || given.some((id: string) => !expected.includes(id))) throw new Error('incomplete group');
  return {
    entries: files.map((file: any, index: number) => ({
      kind: 'definition', path: '/manual/files/n' + String(index), statement: file.model.raw_utf8, data: {},
      fragments: [{ slot: 'files', source: file.sha256, parser: 'text@1', selector: 'l/1' }], applicability: null,
    })),
    warnings: [],
  };
}
`;

function davRow(href: string, revision = '17', directory = true, size = '12'): string {
  return `<D:response xmlns:D="DAV:"><D:href>${href}</D:href><D:propstat><D:prop><D:resourcetype>${directory ? '<D:collection/>' : ''}</D:resourcetype><D:version-name>${revision}</D:version-name>${directory ? '' : `<D:getcontentlength>${size}</D:getcontentlength>`}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}
function davMulti(...rows: string[]): string {
  return `<D:multistatus xmlns:D="DAV:">${rows.join('')}</D:multistatus>`;
}

async function statementsOf(w: World, composition: string): Promise<string[]> {
  const body = await w.knowledge.store.composition(composition);
  const entries = await w.knowledge.store.entries((body?.composition ?? []).map((row) => row.entry));
  return [...entries.values()].map((entry) => entry.statement);
}

async function directoryWorld(t: { after: (fn: () => Promise<void> | void) => void }, options: { root: string | null; missing?: string; declaredParser?: string; octet?: boolean; markdownMissing?: boolean }): Promise<Loop & { resources: ResourceCatalogPort }> {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const build = { name: BUILD, base: BUILD, family: 'FAMX', line: LINE, platform: 'zx-u', built_at: '2026-10-01T00:00:00.000Z', released_at: '2026-10-02T00:00:00.000Z', sources: { tree: 'site:tree:10_8' } };
  const w = await makeWorld(pg, { pack: { id: 'famx', names: ['FAMX'], functions: { 'manuals.ts': DIRECTORY_MANUAL, 'plan.ts': STATIC_PLAN_SOURCE }, declaration: {
    names: ['FAMX'], catalogs: [{ id: 'commands@1', entry_kind: 'definition', producer: 'command-tree', complete: true, case_sensitive: false }],
    sync: { ...DEFAULT_SYNC, options: { builds: [build] } },
    variables: [{ name: 'FAMX_ADOC_ROOT', description: 'Synthetic directory template', schema: { type: ['string', 'null'] }, default: null }],
    producers: [
      { id: 'command-tree', title: '命令树', function: { module: 'functions/commands.ts' }, inputs: { tree: { source: 'tree' } } },
      { id: 'manual-famx', title: 'FAMX 手册', function: { module: 'functions/manuals.ts' }, params: { family: 'FAMX', root: '${var:FAMX_ADOC_ROOT}' }, inputs: {
        tree: { source: 'tree' },
        cli: { external: 'manual:cli:{line}', optional: true },
        app: { external: 'manual:app:{line}', optional: true },
        meta: { source: 'adoc_famx_meta', optional: true },
        files: { source: 'adoc_famx_files', many: true, batch: 1, optional: true, ...(options.declaredParser === undefined ? {} : { parser: options.declaredParser }) },
      } },
    ],
  } } });
  t.after(() => w.close());
  w.external.set('site:tree:10_8', { bytes: TREE, mediaType: 'application/xml' });
  if (options.markdownMissing !== true) {
    w.external.set('manual:cli:10.8', { bytes: `${MARKDOWN_CLI}\n`, mediaType: 'text/markdown' });
    w.external.set('manual:app:10.8', { bytes: `${MARKDOWN_APP}\n`, mediaType: 'text/markdown' });
  }
  await w.kit.variables.setVariable(w.admin, 'FAMX_ADOC_ROOT', options.root, '合成目录');
  const authorization = `Basic ${randomBytes(24).toString('base64')}`;
  const prefix = '/repository';
  const base = `${prefix}/!svn/rvr/17/${DIR}/`;
  const listing = davMulti(davRow(base), davRow(`${base}app.adoc`, '16', false, String(Buffer.byteLength(APP_PAGE))), davRow(`${base}book.adoc`, '16', false, String(Buffer.byteLength(BOOK))));
  const server = await startStub((request) => {
    if (request.headers.authorization !== authorization) return text('Unauthorized', 'text/plain', 401);
    const path = decodeURIComponent(request.path);
    if (request.method === 'PROPFIND' && path === `${prefix}/${DIR}/`) return text(davMulti(davRow(path)), 'application/xml', 207);
    if (request.method === 'PROPFIND' && path === base) return text(listing, 'application/xml', 207);
    const adocType = options.octet === true ? 'application/octet-stream' : 'text/plain';
    if (request.method === 'GET' && path === `${prefix}/!svn/rvr/17/${DIR}/book.adoc`) return text(BOOK, adocType);
    if (request.method === 'GET' && path === `${prefix}/!svn/rvr/17/${DIR}/app.adoc`) return options.missing === 'app.adoc' ? text('Absent', 'text/plain', 404) : text(APP_PAGE, adocType);
    return text('Absent', 'text/plain', 404);
  });
  t.after(() => server.close());
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-seed-adoc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = await stagePack(PACK_DIR, join(root, 'svn'));
  const manifest = await readManifest(directory);
  const svnPacks = fakePacks([{ id: manifest.id, version: manifest.version, kind: manifest.kind, digest: manifestDigest(manifest), directory }]);
  const connectors: Connectors = createConnectors({
    records: w.kit, packs: svnPacks, sandbox: { requireOsIsolation: await sandboxIsolation() }, parsers: createDefaultRegistry(), resourceCacheMs: 0,
  });
  const original = w.external.read.bind(w.external);
  w.external.read = (id, readContext) => id.startsWith('svn:') ? connectors.reader.read(id, readContext) : original(id, readContext);
  const resource = (await addSyntheticResource(w.kit, svnPacks, connectors, w.admin, { system_pack: 'svn', name: '合成仓库', environment: 'test', origins: { svn: `${server.origin}${prefix}` }, allow_plaintext: [server.origin], settings: { repository_path: prefix } })).id;
  await setSyntheticCredential(w.kit, connectors, w.admin, resource, 'authorization', authorization);
  const synced = await w.knowledge.syncProduct(w.product, { by: w.admin });
  assert.equal(synced.error, null, synced.error ?? undefined);
  return { w, server, authorization, resources: connectors.catalog, close: async () => {} };
}

test('an adoc root seeds one revision of the whole directory and a second run is the same bytes', { timeout: 120000 }, async (t) => {
  const loop = await directoryWorld(t, { root: 'synthetic/{line}' });
  const args = ['--product', 'FAMX', '--line', LINE, '--build', BUILD, '--basis', '育合成目录'];
  const first = await knowledgeSeed(loop.w.knowledge, loop.w.packs, loop.w.admin, parseKnowledgeSeedArgs(args), loop.resources);
  assert.equal(first.ok, true, formatSeedReport(first));
  assert.equal(first.pointer?.moved, true);
  const again = await knowledgeSeed(loop.w.knowledge, loop.w.packs, loop.w.admin, parseKnowledgeSeedArgs(args), loop.resources);
  assert.equal(again.ok, true, formatSeedReport(again));
  assert.equal(again.root, first.root);
  const firstNode = await loop.w.knowledge.store.node(first.root!);
  const againNode = await loop.w.knowledge.store.node(again.root!);
  assert.deepEqual(Buffer.from(canonicalize(firstNode)), Buffer.from(canonicalize(againNode)));
  const texts = await statementsOf(loop.w, first.composition!);
  assert.deepEqual(texts.filter((statement) => statement === BOOK || statement === APP_PAGE).sort(), [BOOK, APP_PAGE].sort());
  assert.equal(texts.includes(MARKDOWN_CLI), false);
  assert.equal(texts.includes(MARKDOWN_APP), false);
  assert.deepEqual(first.composition_revisions.map((source) => source.external).sort(), [APP_ID_ADOC, BOOK_ID, META_ID].sort());
  assert.deepEqual(first.composition_revisions.map((source) => source.revision), first.composition_revisions.map(() => '17'));
  assert.equal(formatSeedReport(first).includes(loop.authorization), false);
  assert.equal(formatSeedReport(first).includes('127.0.0.1'), false);
  assert.equal(formatSeedReport(first).includes('http:'), false);
});

test('a server labelling the adoc files octet-stream still seeds when the producer declares text@1', { timeout: 120000 }, async (t) => {
  const loop = await directoryWorld(t, { root: 'synthetic/{line}', declaredParser: 'text@1', octet: true });
  const seeded = await knowledgeSeed(loop.w.knowledge, loop.w.packs, loop.w.admin, parseKnowledgeSeedArgs(['--product', 'FAMX', '--line', LINE, '--build', BUILD, '--basis', '按声明的解析器育目录']), loop.resources);
  const text = formatSeedReport(seeded);
  assert.equal(seeded.ok, true, text);
  assert.equal(seeded.pointer?.moved, true);
  const texts = await statementsOf(loop.w, seeded.composition!);
  assert.deepEqual(texts.filter((statement) => statement === BOOK || statement === APP_PAGE).sort(), [BOOK, APP_PAGE].sort());
});

test('with an adoc root configured an unreachable markdown manual is reported, not blocking', { timeout: 120000 }, async (t) => {
  const loop = await directoryWorld(t, { root: 'synthetic/{line}', markdownMissing: true });
  const seeded = await knowledgeSeed(loop.w.knowledge, loop.w.packs, loop.w.admin, parseKnowledgeSeedArgs(['--product', 'FAMX', '--line', LINE, '--build', BUILD, '--basis', 'adoc 根已配置，markdown 可选']), loop.resources);
  const text = formatSeedReport(seeded);
  assert.equal(seeded.ok, true, text);
  assert.equal(seeded.missing.length, 0, text);
  assert.deepEqual(seeded.notes.filter((note) => note.includes('manual:cli:10.8') || note.includes('manual:app:10.8')).length, 2, text);
  assert.match(text, /可选来源 manual:cli:10.8 未读到/);
  assert.match(text, /手册按已声明的 adoc 根 synthetic\/\{line\} 生产/);
  const texts = await statementsOf(loop.w, seeded.composition!);
  assert.deepEqual(texts.filter((statement) => statement === BOOK || statement === APP_PAGE).sort(), [BOOK, APP_PAGE].sort());
  assert.equal(texts.includes(MARKDOWN_CLI), false);
});

test('without an adoc root an unreachable markdown manual still fails the seed', { timeout: 120000 }, async (t) => {
  const loop = await directoryWorld(t, { root: null, markdownMissing: true });
  const seeded = await knowledgeSeed(loop.w.knowledge, loop.w.packs, loop.w.admin, parseKnowledgeSeedArgs(['--product', 'FAMX', '--line', LINE, '--build', BUILD, '--basis', '没有 adoc 根时 markdown 是唯一手册']), loop.resources);
  const text = formatSeedReport(seeded);
  assert.equal(seeded.ok, false, text);
  assert.ok(seeded.missing.some((item) => item.role === 'cli-manual' && item.detail.includes('manual:cli:10.8')), text);
  assert.equal(seeded.root, null);
  assert.equal(await loop.w.kit.pointers.get(seedlingName(loop.w.product.id, LINE)), null);
});

test('a directory whose file is absent is refused and the seedling pointer stays', { timeout: 120000 }, async (t) => {
  const loop = await directoryWorld(t, { root: 'synthetic/{line}', missing: 'app.adoc' });
  const seeded = await knowledgeSeed(loop.w.knowledge, loop.w.packs, loop.w.admin, parseKnowledgeSeedArgs(['--product', 'FAMX', '--line', LINE, '--build', BUILD, '--basis', '缺一页']), loop.resources);
  assert.equal(seeded.ok, false, formatSeedReport(seeded));
  assert.equal(seeded.root, null);
  assert.equal(seeded.pointer, null);
  assert.equal(seeded.missing.some((item) => item.detail.includes(APP_ID_ADOC) && item.next.startsWith('circle-hub knowledge seed ')), true, formatSeedReport(seeded));
  assert.equal(await loop.w.kit.pointers.get(seedlingName(loop.w.product.id, LINE)), null);
});

test('a null adoc root still seeds the markdown manuals', { timeout: 120000 }, async (t) => {
  const loop = await directoryWorld(t, { root: null });
  const before = loop.server.requests.length;
  const seeded = await knowledgeSeed(loop.w.knowledge, loop.w.packs, loop.w.admin, parseKnowledgeSeedArgs(['--product', 'FAMX', '--line', LINE, '--build', BUILD, '--basis', '空目录仍用手册']), loop.resources);
  assert.equal(seeded.ok, true, formatSeedReport(seeded));
  assert.deepEqual(loop.server.requests.slice(before).filter((request) => request.method === 'PROPFIND'), []);
  assert.deepEqual(seeded.composition_revisions, []);
  const texts = await statementsOf(loop.w, seeded.composition!);
  assert.equal(texts.includes(MARKDOWN_CLI), true, JSON.stringify(texts));
  assert.equal(texts.includes(MARKDOWN_APP), true);
  assert.equal(texts.includes(BOOK), false);
  assert.equal(texts.includes(APP_PAGE), false);
});

const CLI_BOOK = '192.0.2.35 cli book';
const CLI_CHAPTER = '192.0.2.36 cli chapter';
const APP_BOOK = '192.0.2.37 app book';
const bookFile = (name: string): string => `svn:file:17/${encodeURIComponent(`${DIR}/${name}`)}`;
const bookDir = (name: string): string => `svn:directory-at:17/${encodeURIComponent(`${DIR}/${name}`)}`;
const CLI_DIR = bookDir('cli');
const CHAPTERS_DIR = bookDir('cli/chapters');
const APP_DIR = bookDir('app');
const CLI_FILE = bookFile('cli/book.adoc');
const CHAPTER_FILE = bookFile('cli/chapters/body.adoc');
const APP_FILE = bookFile('app/app.adoc');

const BOOK_DIRECTORY_MANUAL = `
export default function produce(input: any): unknown {
  if (!input.batch || input.batch.of !== 1) throw new Error('split batch');
  const files = (input.lists?.files ?? []).filter((file: any) => file.parser === 'text@1');
  return {
    entries: files.map((file: any, index: number) => ({
      kind: 'definition', path: '/manual/files/n' + String(index), statement: file.model.raw_utf8, data: {},
      fragments: [{ slot: 'files', source: file.sha256, parser: 'text@1', selector: 'l/1' }], applicability: null,
    })),
    warnings: [],
  };
}
`;

async function bookWorld(t: { after: (fn: () => Promise<void> | void) => void }, options: { missing?: string } = {}): Promise<Loop & { resources: ResourceCatalogPort }> {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const build = { name: BUILD, base: BUILD, family: 'FAMX', line: LINE, platform: 'zx-u', built_at: '2026-10-01T00:00:00.000Z', released_at: '2026-10-02T00:00:00.000Z', sources: { tree: 'site:tree:10_8' } };
  const w = await makeWorld(pg, { pack: { id: 'famx', names: ['FAMX'], functions: { 'manuals.ts': BOOK_DIRECTORY_MANUAL, 'plan.ts': STATIC_PLAN_SOURCE }, declaration: {
    names: ['FAMX'], catalogs: [{ id: 'commands@1', entry_kind: 'definition', producer: 'command-tree', complete: true, case_sensitive: false }],
    sync: { ...DEFAULT_SYNC, options: { builds: [build] } },
    variables: [
      { name: 'FAMX_ADOC_ROOT', description: 'Synthetic directory template', schema: { type: ['string', 'null'] }, default: null },
      { name: 'FAMX_ADOC_MAIN', description: 'Synthetic CLI main file', schema: { type: 'string', minLength: 1 }, default: 'book.adoc' },
      { name: 'FAMX_ADOC_APP_MAIN', description: 'Synthetic APP main file', schema: { type: 'string', minLength: 1 }, default: 'app.adoc' },
    ],
    producers: [
      { id: 'command-tree', title: '命令树', function: { module: 'functions/commands.ts' }, inputs: { tree: { source: 'tree' } } },
      { id: 'manual-famx', title: 'FAMX 手册', function: { module: 'functions/manuals.ts' }, params: { family: 'FAMX', root: '${var:FAMX_ADOC_ROOT}', main: '${var:FAMX_ADOC_MAIN}', app_main: '${var:FAMX_ADOC_APP_MAIN}' }, inputs: {
        tree: { source: 'tree' },
        cli: { external: 'manual:cli:{line}', optional: true },
        app: { external: 'manual:app:{line}', optional: true },
        meta: { source: 'adoc_famx_meta', optional: true },
        files: { source: 'adoc_famx_files', many: true, batch: 1, optional: true },
      } },
    ],
  } } });
  t.after(() => w.close());
  w.external.set('site:tree:10_8', { bytes: TREE, mediaType: 'application/xml' });
  w.external.set('manual:cli:10.8', { bytes: `${MARKDOWN_CLI}\n`, mediaType: 'text/markdown' });
  w.external.set('manual:app:10.8', { bytes: `${MARKDOWN_APP}\n`, mediaType: 'text/markdown' });
  await w.kit.variables.setVariable(w.admin, 'FAMX_ADOC_ROOT', 'synthetic/{line}', '合成目录');
  await w.kit.variables.setVariable(w.admin, 'FAMX_ADOC_MAIN', 'cli/book.adoc', '合成 CLI 主文件');
  await w.kit.variables.setVariable(w.admin, 'FAMX_ADOC_APP_MAIN', 'app/app.adoc', '合成 APP 主文件');
  const authorization = `Basic ${randomBytes(24).toString('base64')}`;
  const prefix = '/repository';
  const rvr = `${prefix}/!svn/rvr/17/${DIR}`;
  const directoryListing = (dir: string, children: string[]): string => davMulti(davRow(dir === '' ? `${rvr}/` : `${rvr}/${dir}/`), ...children);
  const fileRow = (path: string, bytes: string): string => davRow(`${rvr}/${path}`, '16', false, String(Buffer.byteLength(bytes)));
  const rootListing = directoryListing('', [davRow(`${rvr}/app/`, '16'), davRow(`${rvr}/cli/`, '16'), davRow(`${rvr}/notes/`, '16'), davRow(`${rvr}/pictures/`, '16'), davRow(`${rvr}/wide/`, '16')]);
  const cliListing = directoryListing('cli', [fileRow('cli/book.adoc', CLI_BOOK), davRow(`${rvr}/cli/chapters/`, '16')]);
  const chapterListing = directoryListing('cli/chapters', [fileRow('cli/chapters/body.adoc', CLI_CHAPTER)]);
  const appListing = directoryListing('app', [fileRow('app/app.adoc', APP_BOOK)]);
  const wideListing = directoryListing('wide', Array.from({ length: 129 }, (_, index) => fileRow(`wide/w${index}.adoc`, 'x')));
  const pages: Record<string, string> = { '': rootListing, cli: cliListing, 'cli/chapters': chapterListing, app: appListing, wide: wideListing };
  const bodies: Record<string, string> = { 'cli/book.adoc': CLI_BOOK, 'cli/chapters/body.adoc': CLI_CHAPTER, 'app/app.adoc': APP_BOOK };
  const server = await startStub((request) => {
    if (request.headers.authorization !== authorization) return text('Unauthorized', 'text/plain', 401);
    const path = decodeURIComponent(request.path);
    if (request.method === 'PROPFIND' && path === `${prefix}/${DIR}/`) return text(davMulti(davRow(path)), 'application/xml', 207);
    if (request.method === 'PROPFIND' && path.startsWith(`${rvr}/`)) {
      const relative = path.slice(`${rvr}/`.length).replace(/\/$/, '');
      const listing = pages[relative];
      return listing === undefined ? text('Absent', 'text/plain', 404) : text(listing, 'application/xml', 207);
    }
    if (request.method === 'GET' && path.startsWith(`${rvr}/`)) {
      const relative = path.slice(`${rvr}/`.length);
      if (options.missing === relative) return text('Absent', 'text/plain', 404);
      const body = bodies[relative];
      return body === undefined ? text('Absent', 'text/plain', 404) : text(body, 'text/plain');
    }
    return text('Absent', 'text/plain', 404);
  });
  t.after(() => server.close());
  const home = await mkdtemp(join(tmpdir(), 'circle-hub-seed-books-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = await stagePack(PACK_DIR, join(home, 'svn'));
  const manifest = await readManifest(directory);
  const svnPacks = fakePacks([{ id: manifest.id, version: manifest.version, kind: manifest.kind, digest: manifestDigest(manifest), directory }]);
  const connectors: Connectors = createConnectors({
    records: w.kit, packs: svnPacks, sandbox: { requireOsIsolation: await sandboxIsolation() }, parsers: createDefaultRegistry(), resourceCacheMs: 0,
  });
  const original = w.external.read.bind(w.external);
  w.external.read = (id, readContext) => id.startsWith('svn:') ? connectors.reader.read(id, readContext) : original(id, readContext);
  const resource = (await addSyntheticResource(w.kit, svnPacks, connectors, w.admin, { system_pack: 'svn', name: '合成仓库', environment: 'test', origins: { svn: `${server.origin}${prefix}` }, allow_plaintext: [server.origin], settings: { repository_path: prefix } })).id;
  await setSyntheticCredential(w.kit, connectors, w.admin, resource, 'authorization', authorization);
  const synced = await w.knowledge.syncProduct(w.product, { by: w.admin });
  assert.equal(synced.error, null, synced.error ?? undefined);
  return { w, server, authorization, resources: connectors.catalog, close: async () => {} };
}

test('seeding binds each book directory and does not read sibling directories', { timeout: 120000 }, async (t) => {
  const loop = await bookWorld(t);
  const args = ['--product', 'FAMX', '--line', LINE, '--build', BUILD, '--basis', '育两本书'];
  const first = await knowledgeSeed(loop.w.knowledge, loop.w.packs, loop.w.admin, parseKnowledgeSeedArgs(args), loop.resources);
  assert.equal(first.ok, true, formatSeedReport(first));
  const again = await knowledgeSeed(loop.w.knowledge, loop.w.packs, loop.w.admin, parseKnowledgeSeedArgs(args), loop.resources);
  assert.equal(again.ok, true, formatSeedReport(again));
  assert.equal(again.root, first.root);
  const firstNode = await loop.w.knowledge.store.node(first.root!);
  const againNode = await loop.w.knowledge.store.node(again.root!);
  assert.deepEqual(Buffer.from(canonicalize(firstNode)), Buffer.from(canonicalize(againNode)));
  const propfinds = loop.server.requests.filter((request) => request.method === 'PROPFIND').map((request) => decodeURIComponent(request.path));
  assert.deepEqual(propfinds.filter((path) => path.includes('/wide') || path.includes('/notes') || path.includes('/pictures')), []);
  const texts = await statementsOf(loop.w, first.composition!);
  assert.deepEqual(texts.filter((statement) => statement === CLI_BOOK || statement === CLI_CHAPTER || statement === APP_BOOK).sort(), [APP_BOOK, CLI_BOOK, CLI_CHAPTER].sort());
  const composed = await loop.w.knowledge.store.composition(first.composition!);
  const svn = (composed?.sources ?? []).filter((source) => source.external.startsWith('svn:'));
  assert.deepEqual(svn.map((source) => source.external).sort(), [APP_DIR, APP_FILE, CHAPTERS_DIR, CHAPTER_FILE, CLI_DIR, CLI_FILE, META_ID].sort());
  assert.deepEqual(svn.map((source) => source.revision), svn.map(() => '17'));
  const digest = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');
  const byExternal = new Map(svn.map((source) => [source.external, source.sha256]));
  assert.equal(byExternal.get(CLI_FILE), digest(CLI_BOOK));
  assert.equal(byExternal.get(CHAPTER_FILE), digest(CLI_CHAPTER));
  assert.equal(byExternal.get(APP_FILE), digest(APP_BOOK));
});

// A real-shaped family manual producer: many files input, meta from the directory, throws its own structured error
// (code + message + next action) when the files list does not match the meta members.
const FAMILY_MANUAL_THROWING = `
export default function familyManual(input) {
  if (input.params.root === null) return { entries: [], warnings: [] };
  // This producer always refuses the group it is handed, with its own structured error shape.
  const e = new Error('需要目录里的全部 adoc，不能拆批、漏文件或混入其他目录；下一步：核对本族 ROOT、MAIN 和同修订号 SVN 原件后重跑同步');
  e.code = 'famx.adoc.incomplete_group';
  throw e;
}
`;
const FAMILY_MANUAL_SUCCEEDING = `
export default function familyManual(input) {
  if (input.params.root === null) return { entries: [], warnings: [] };
  const meta = input.slots.meta;
  if (!meta || meta.parser !== 'json@1') { const e = new Error('缺少固定修订号的目录清单；下一步：核对 SVN 资源和 ADOC_ROOT 后重跑同步'); e.code = 'famx.adoc.directory_unreadable'; throw e; }
  const given = input.lists?.files ?? [];
  const members = (meta.model?.members ?? []).filter((m) => m.directory !== true);
  if (given.length !== members.length) { const e = new Error('需要目录里的全部 adoc，不能拆批、漏文件或混入其他目录；下一步：核对本族 ROOT、MAIN 和同修订号 SVN 原件后重跑同步'); e.code = 'famx.adoc.incomplete_group'; throw e; }
  return { entries: given.map((file, index) => ({ kind: 'definition', path: '/manual/files/n' + index, statement: file.model.raw_utf8, data: {}, fragments: [{ slot: 'files', source: file.sha256, parser: 'text@1', selector: 'l/1' }], applicability: null })), warnings: [] };
}
`;

interface FamilyLoop extends Loop { files: string[]; resources: ResourceCatalogPort }

/** A real-shaped world: one family producer over a declared adoc directory with a multi-batch file group (batch 2, 5 files). */
async function familyWorld(t: { after: (fn: () => Promise<void> | void) => void }, options: { throwing: boolean }): Promise<FamilyLoop> {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const build = { name: BUILD, base: BUILD, family: 'FAMY', line: LINE, platform: 'zx-u', built_at: '2026-10-01T00:00:00.000Z', released_at: '2026-10-02T00:00:00.000Z', sources: { tree: 'site:tree:10_8' } };
  const files = ['f1.adoc', 'f2.adoc', 'f3.adoc', 'f4.adoc', 'f5.adoc'];
  const bodies = new Map(files.map((name, i) => [name, `192.0.2.${i + 10} family file ${name}\n`]));
  const w = await makeWorld(pg, { pack: { id: 'famx', names: ['FAMX', 'FAMY'], functions: { 'family-manual.ts': options.throwing ? FAMILY_MANUAL_THROWING : FAMILY_MANUAL_SUCCEEDING, 'plan.ts': STATIC_PLAN_SOURCE }, declaration: {
    names: ['FAMX', 'FAMY'], catalogs: [{ id: 'commands@1', entry_kind: 'definition', producer: 'command-tree', complete: true, case_sensitive: false }],
    sync: { ...DEFAULT_SYNC, options: { builds: [build] } },
    variables: [{ name: 'FAMX_ADOC_ROOT', description: 'Synthetic directory template', schema: { type: ['string', 'null'] }, default: null }],
    producers: [
      { id: 'command-tree', title: '命令树', function: { module: 'functions/commands.ts' }, inputs: { tree: { source: 'tree' } } },
      { id: 'manual-famy', title: 'FAMY 手册', function: { module: 'functions/family-manual.ts' }, params: { family: 'FAMY', root: '\${var:FAMX_ADOC_ROOT}' }, inputs: {
        tree: { source: 'tree' }, cli: { external: 'manual:cli:{line}', optional: true }, app: { external: 'manual:app:{line}', optional: true },
        meta: { source: 'adoc_famy_meta', optional: true }, files: { source: 'adoc_famy_files', parser: 'text@1', many: true, batch: 2, optional: true },
      } },
    ],
  } } });
  t.after(() => w.close());
  w.external.set('site:tree:10_8', { bytes: TREE, mediaType: 'application/xml' });
  await w.kit.variables.setVariable(w.admin, 'FAMX_ADOC_ROOT', 'synthetic/{line}', '合成目录');
  const member = (name: string) => ({ name, directory: false, external: `svn:file:17/${encodeURIComponent(`${DIR}/${name}`)}`, size: Buffer.byteLength(bodies.get(name) ?? ''), revision: '17' });
  const metaDoc = JSON.stringify({ schema: 'svn-directory@1', identity: { path: DIR, revision: '17' }, revision: '17', members: [{ name: DIR, directory: true, external: `svn:directory:${encodeURIComponent(DIR)}`, revision: '17' }, ...files.map(member)] });
  const authorization = `Basic ${randomBytes(24).toString('base64')}`;
  const prefix = '/repository';
  const base = `${prefix}/!svn/rvr/17/${DIR}/`;
  const davRow = (href: string, rev = '17', dir = true, size = '12'): string => `<D:response xmlns:D="DAV:"><D:href>${href}</D:href><D:propstat><D:prop><D:resourcetype>${dir ? '<D:collection/>' : ''}</D:resourcetype><D:version-name>${rev}</D:version-name>${dir ? '' : `<D:getcontentlength>${size}</D:getcontentlength>`}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  const listing = `<D:multistatus xmlns:D="DAV:">${davRow(base)}${files.map((n) => davRow(`${base}${n}`, '17', false, String(Buffer.byteLength(bodies.get(n) ?? '')))).join('')}</D:multistatus>`;
  const server = await startStub((request) => {
    if (request.headers.authorization !== authorization) return text('Unauthorized', 'text/plain', 401);
    const path = decodeURIComponent(request.path);
    if (request.method === 'PROPFIND' && path === `${prefix}/${DIR}/`) return text(`<D:multistatus xmlns:D="DAV:">${davRow(path)}</D:multistatus>`, 'application/xml', 207);
    if (request.method === 'PROPFIND' && path === base) return text(listing, 'application/xml', 207);
    const m = path.match(new RegExp(`^${prefix}/!svn/rvr/17/${DIR}/(.+)$`));
    if (request.method === 'GET' && m) {
      const name = decodeURIComponent(m[1]);
      if (name === '.directory.json') return text(metaDoc, 'application/json');
      if (bodies.has(name)) return text(bodies.get(name) ?? '', 'text/plain');
    }
    return text('Absent', 'text/plain', 404);
  });
  t.after(() => server.close());
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-seed-family-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = await stagePack(PACK_DIR, join(root, 'svn'));
  const manifest = await readManifest(directory);
  const svnPacks = fakePacks([{ id: manifest.id, version: manifest.version, kind: manifest.kind, digest: manifestDigest(manifest), directory }]);
  const connectors: Connectors = createConnectors({ records: w.kit, packs: svnPacks, sandbox: { requireOsIsolation: await sandboxIsolation() }, parsers: createDefaultRegistry(), resourceCacheMs: 0 });
  const original = w.external.read.bind(w.external);
  w.external.read = (id, readContext) => id.startsWith('svn:') ? connectors.reader.read(id, readContext) : original(id, readContext);
  const resource = (await addSyntheticResource(w.kit, svnPacks, connectors, w.admin, { system_pack: 'svn', name: '合成仓库', environment: 'test', origins: { svn: `${server.origin}${prefix}` }, allow_plaintext: [server.origin], settings: { repository_path: prefix } })).id;
  await setSyntheticCredential(w.kit, connectors, w.admin, resource, 'authorization', authorization);
  const synced = await w.knowledge.syncProduct(w.product, { by: w.admin });
  assert.equal(synced.error, null, synced.error ?? undefined);
  return { w, server, authorization, files, resources: connectors.catalog, close: async () => {} };
}

test('a multi-batch adoc file group seeds the whole family manual', { timeout: 180000 }, async (t) => {
  const loop = await familyWorld(t, { throwing: false });
  const args = ['--product', 'FAMY', '--line', LINE, '--build', BUILD, '--basis', '多批文件组'];
  const dry = await knowledgeSeed(loop.w.knowledge, loop.w.packs, loop.w.admin, parseKnowledgeSeedArgs([...args, '--dry-run']), loop.resources);
  assert.equal(dry.ok, true, formatSeedReport(dry));
  assert.equal(dry.pointer?.moved, false);
  assert.equal(await loop.w.kit.pointers.get(seedlingName(loop.w.product.id, LINE)), null, '试运行不移动指针');
  const seeded = await knowledgeSeed(loop.w.knowledge, loop.w.packs, loop.w.admin, parseKnowledgeSeedArgs(args), loop.resources);
  const text = formatSeedReport(seeded);
  assert.equal(seeded.ok, true, text);
  assert.equal(seeded.pointer?.moved, true);
  const texts = await statementsOf(loop.w, seeded.composition!);
  assert.deepEqual(texts.filter((statement) => statement.startsWith('192.0.2.')).sort(), loop.files.map((name, i) => `192.0.2.${i + 10} family file ${name}`).sort(), '五个文件都进了树苗');
});

test('a producer refusing the group surfaces its own code, message and next action, in dry run and seed alike', { timeout: 180000 }, async (t) => {
  const loop = await familyWorld(t, { throwing: true });
  const args = ['--product', 'FAMY', '--line', LINE, '--build', BUILD, '--basis', '生产器拒绝文件组'];
  const dry = await knowledgeSeed(loop.w.knowledge, loop.w.packs, loop.w.admin, parseKnowledgeSeedArgs([...args, '--dry-run']), loop.resources);
  const dryText = formatSeedReport(dry);
  assert.equal(dry.ok, false, dryText);
  assert.match(dryText, /生产器 manual-famy 运行失败 \[famx\.adoc\.incomplete_group\]/);
  assert.match(dryText, /不能拆批、漏文件或混入其他目录/);
  assert.match(dryText, /核对本族 ROOT、MAIN 和同修订号 SVN 原件后重跑同步/);
  assert.match(dryText, /试运行不写树苗/);
  const seeded = await knowledgeSeed(loop.w.knowledge, loop.w.packs, loop.w.admin, parseKnowledgeSeedArgs(args), loop.resources);
  const seededText = formatSeedReport(seeded);
  assert.equal(seeded.ok, false, seededText);
  assert.match(seededText, /\[famx\.adoc\.incomplete_group\]/);
  assert.equal(seeded.root, null);
  assert.equal(await loop.w.kit.pointers.get(seedlingName(loop.w.product.id, LINE)), null);
});

test('a missing file inside one book directory is refused and the seedling pointer stays', { timeout: 120000 }, async (t) => {
  const loop = await bookWorld(t, { missing: 'cli/chapters/body.adoc' });
  const seeded = await knowledgeSeed(loop.w.knowledge, loop.w.packs, loop.w.admin, parseKnowledgeSeedArgs(['--product', 'FAMX', '--line', LINE, '--build', BUILD, '--basis', '缺一章']), loop.resources);
  assert.equal(seeded.ok, false, formatSeedReport(seeded));
  assert.equal(seeded.root, null);
  assert.equal(seeded.pointer, null);
  assert.equal(seeded.missing.some((item) => item.detail.includes(CHAPTER_FILE) && item.next.startsWith('circle-hub knowledge seed ')), true, formatSeedReport(seeded));
  assert.equal(await loop.w.kit.pointers.get(seedlingName(loop.w.product.id, LINE)), null);
});
