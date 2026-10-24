// The knowledge seed command and the feeding hang from a per-build root onto the line's current seedling.
// Synthetic only: loopback SVN, platform zx-u, version lines from 10.8, addresses in 192.0.2.0/24.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProductDeclaration, type Producer } from '../../contracts/src/product.ts';
import { SeedlingBody } from '../../contracts/src/knowledge.ts';
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
    schema: 'product@1', id: 'acme', title: '合成产品', names: ['ACME', 'APV', 'NSAE'], catalogs: catalogs.map((catalog) => ({ entry_kind: 'definition', complete: true, case_sensitive: false, ...catalog })), producers,
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
    manualProducer('manual-nsae', 'NSAE'),
    manualProducer('manual-apv', 'APV'),
    { id: 'command-tree', title: '命令树', function: { module: 'functions/commands.ts' }, inputs: { tree: { source: 'tree' } } },
  ]);
  const apv = seedRoles(product, 'APV');
  assert.deepEqual(apv.gaps, []);
  assert.equal(apv.bindings['command-tree']?.producer, 'command-tree');
  assert.equal(apv.bindings['cli-manual']?.producer, 'manual-apv');
  assert.equal(apv.bindings['cli-manual']?.slot, 'cli');
  assert.equal(apv.bindings['app-manual']?.producer, 'manual-apv');
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
