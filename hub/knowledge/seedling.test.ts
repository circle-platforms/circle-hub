// Tests of the initial seedling production (the kb-seedling task, docs/hub-r4-tasks/kb-seedling.md): one tree per
// product × version line, merged from exactly three fixed synthetic sources (a command-tree XML of the line's released
// build, a CLI manual and an APP manual, lines 10.6+, addresses 192.0.2.0/24 only), mounted by structure alone, same
// inputs giving the same bytes, with the seedling record and the compare-and-set current-seedling pointer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeWorld, catalogXml, STATIC_PLAN_SOURCE, DEFAULT_SYNC, type World } from './test-support.ts';
import { produceSeedling, seedlingName, currentSeedling, type SeedlingRoles } from './seedling.ts';
import { SeedlingBody } from '../../contracts/src/knowledge.ts';
import type { BuildInfo } from '../../contracts/src/product.ts';

const LINE = '10.6';

const TREE = catalogXml({
  system: [{ name: 'reboot', params: [{ name: 'delay', type: 'int', min: 0, max: 600 }], help: 'restart the unit (192.0.2.10)' }],
  net: [{ name: 'ping', params: [{ name: 'host', type: 'string' }], help: 'send echo requests to 192.0.2.0/24' }],
});

// A CLI manual in markdown: one paragraph carries an exact `system reboot` signature anchor (it mounts on the command
// node); one paragraph has no signature (it stays under the CLI subtree by its section path). No keywords decide anything.
const CLI = [
  '# CLI 手册 10.6',
  '',
  '## 命令 system reboot',
  '',
  '`system reboot <delay:int>` 重启设备，延迟 0 到 600 秒。',
  '',
  '## 运行前提',
  '',
  '手册适用于 10.6 版本线的设备，管理地址在 192.0.2.0/24。',
  '',
].join('\n');

const APP = ['# APP 手册 10.6', '', '## 首页', '', '登录后进入首页。', ''].join('\n');

/** The two manual producers of the seedling pack: paragraphs of the model, each on its section path. */
const MANUALS_SOURCE = `
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

const ROLES: SeedlingRoles = {
  'command-tree': { producer: 'tree', slot: 'tree' },
  'cli-manual': { producer: 'cli', slot: 'cli' },
  'app-manual': { producer: 'app', slot: 'app' },
};

async function seedlingWorld(postgres: unknown, options: { tree?: string; cli?: string; app?: string } = {}): Promise<World> {
  const build: BuildInfo = {
    name: 'Synthetic_10_6_1', base: 'Synthetic_10_6_1', family: 'ACME', line: LINE, platform: null,
    built_at: '2026-10-01T00:00:00.000Z', released_at: '2026-10-02T00:00:00.000Z',
    sources: { tree: 'site:tree:10_6' },
  };
  const w = await makeWorld(postgres as never, {
    pack: {
      functions: { 'manuals.ts': MANUALS_SOURCE, 'plan.ts': STATIC_PLAN_SOURCE },
      declaration: {
        sync: { ...DEFAULT_SYNC, options: { builds: [build] } },
        catalogs: [],
        producers: [
          { id: 'tree', title: '命令树', function: { module: 'functions/commands.ts' }, inputs: { tree: { source: 'tree' } } },
          { id: 'cli', title: 'CLI 手册', function: { module: 'functions/manuals.ts', export: 'cli' }, inputs: { cli: { external: 'manual:cli:10_6' } } },
          { id: 'app', title: 'APP 手册', function: { module: 'functions/manuals.ts', export: 'app' }, inputs: { app: { external: 'manual:app:10_6' } } },
          { id: 'noise', title: '喂入层的资料不走这条生产', function: { module: 'functions/extra.ts' }, inputs: { tree: { source: 'tree' } }, params: { entries: [] } },
        ],
      },
    },
  });
  w.external.set('site:tree:10_6', { bytes: options.tree ?? TREE, mediaType: 'application/xml' });
  w.external.set('manual:cli:10_6', { bytes: options.cli ?? CLI, mediaType: 'text/markdown' });
  w.external.set('manual:app:10_6', { bytes: options.app ?? APP, mediaType: 'text/markdown' });
  await w.knowledge.syncProduct(w.product, { by: w.admin });
  return w;
}

test('a seedling merges the three fixed sources into one per-line tree and moves its pointer', async t => {
  const pg = await (await import('./test-support.ts')).startPostgres();
  t.after(() => pg.stop());
  const w = await seedlingWorld(pg);
  t.after(() => w.close());

  const result = await produceSeedling(await contextOf(w), w.knowledge, w.product, {
    line: LINE, by: w.admin, basis: '合成初始树苗', roles: ROLES, revisions: { cli: '4213', app: '4213' },
  });
  assert.equal(result.ok, true, result.reason ?? undefined);
  assert.equal(result.build, 'Synthetic_10_6_1');
  assert.equal(result.parent, null);
  assert.equal(result.pointer?.moved, true, result.pointer?.reason);

  // The three fixed sources, with the original digests and the fixed adoc revision.
  assert.deepEqual(result.origin.map((source) => [source.role, source.producer + '.' + source.slot, source.revision]).sort(), [
    ['app-manual', 'app.app', '4213'],
    ['cli-manual', 'cli.cli', '4213'],
    ['command-tree', 'tree.tree', null],
  ]);
  for (const source of result.origin) assert.match(source.sha256, /^[0-9a-f]{64}$/);

  // The seedling record parses as seedling@1 and the pointer names the produced root.
  const record = await w.knowledge.store.records.get(result.seedling!);
  assert.equal(record?.schema, 'seedling@1');
  const body = SeedlingBody.parse(record?.body);
  assert.equal(body.root, result.root);
  assert.equal(body.line, LINE);
  assert.equal(body.parent, null);
  assert.equal(await currentSeedling(await contextOf(w), 'acme', LINE), result.root);

  // The command skeleton is there, the CLI signature section hangs on the command node, the unmatched CLI section and
  // the APP book stay in their own subtrees, and get_nodes reads them by path.
  const nodes = await w.knowledge.getNodes({ root: result.root!, paths: ['/'], depth: 3 }, w.user);
  const paths = nodes!.nodes.map((node) => node.path).sort();
  assert.ok(paths.includes('/commands/system/reboot'), paths.join(','));
  assert.ok(paths.includes('/commands/net/ping'), paths.join(','));
  assert.ok(paths.includes('/manual/app'), paths.join(','));
  const reboot = await w.knowledge.getNodes({ root: result.root!, paths: ['/commands/system/reboot'], depth: 0 }, w.user);
  assert.equal(reboot!.nodes[0]!.entries.length, 2, '命令骨架条目 + 挂上的 CLI 章节');
  assert.ok(reboot!.nodes[0]!.entries.every((entry) => entry.statement.length > 0));
  // The CLI section without a signature stays in the CLI subtree by its section path.
  const cliTree = await w.knowledge.getNodes({ root: result.root!, paths: ['/manual'], depth: 4 }, w.user);
  const cliPaths = cliTree!.nodes.map((node) => node.path).join(',');
  assert.ok(cliPaths.includes('/manual/cli'), cliPaths);
  assert.ok(cliPaths.includes('运行前提'), cliPaths);
});

test('same inputs, same bytes: producing the same seedling twice gives the same root', async t => {
  const pg = await (await import('./test-support.ts')).startPostgres();
  t.after(() => pg.stop());
  const w = await seedlingWorld(pg);
  t.after(() => w.close());
  const context = await contextOf(w);
  const first = await produceSeedling(context, w.knowledge, w.product, { line: LINE, by: w.admin, basis: '第一次', roles: ROLES });
  const second = await produceSeedling(context, w.knowledge, w.product, { line: LINE, by: w.admin, basis: '第二次', roles: ROLES });
  assert.equal(first.ok, true, first.reason ?? undefined);
  assert.equal(second.ok, true, second.reason ?? undefined);
  assert.equal(second.root, first.root, '同输入同字节：根摘要一致');
  assert.equal(second.parent, first.seedling, '第二次的血缘指着第一次的树苗记录');
  // The pointer already names this root: the compare-and-set move is refused, nothing breaks.
  assert.equal(second.pointer?.moved, false);
  assert.equal(await currentSeedling(context, 'acme', LINE), first.root);
});

test('a different command tree gives a different seedling; the pointer follows the new root', async t => {
  const pg = await (await import('./test-support.ts')).startPostgres();
  t.after(() => pg.stop());
  const w = await seedlingWorld(pg);
  t.after(() => w.close());
  const context = await contextOf(w);
  const first = await produceSeedling(context, w.knowledge, w.product, { line: LINE, by: w.admin, basis: '初版', roles: ROLES });
  assert.equal(first.ok, true, first.reason ?? undefined);

  // A new released build of the same line with a changed tree.
  const next = 'Synthetic_10_6_2';
  await w.knowledge.syncProduct(w.product, { by: w.admin, options: { builds: [{
    name: next, base: next, family: 'ACME', line: LINE, platform: null,
    built_at: '2026-10-10T00:00:00.000Z', released_at: '2026-10-11T00:00:00.000Z',
    sources: { tree: 'site:tree:10_6_b' },
  }] } });
  w.external.set('site:tree:10_6_b', { bytes: catalogXml({ system: [{ name: 'shutdown', help: 'power off' }] }), mediaType: 'application/xml' });

  const second = await produceSeedling(context, w.knowledge, w.product, { line: LINE, by: w.admin, basis: '新构建', roles: ROLES });
  assert.equal(second.ok, true, second.reason ?? undefined);
  assert.equal(second.build, next, '命令树取版本线当前已发布的构建');
  assert.notEqual(second.root, first.root);
  assert.equal(second.parent, first.seedling);
  assert.equal(second.pointer?.moved, true, second.pointer?.reason);
  assert.equal(await currentSeedling(context, 'acme', LINE), second.root);
  assert.equal(seedlingName('acme', LINE), `seedling/${'acme'}/${LINE}`);
});

test('a line without a released build, and roles that do not match the pack, fail without a tree', async t => {
  const pg = await (await import('./test-support.ts')).startPostgres();
  t.after(() => pg.stop());
  const w = await seedlingWorld(pg);
  t.after(() => w.close());
  const context = await contextOf(w);
  const empty = await produceSeedling(context, w.knowledge, w.product, { line: '10.9', by: w.admin, basis: '无构建', roles: ROLES });
  assert.equal(empty.ok, false);
  assert.match(empty.reason ?? '', /没有已发布的构建/);
  const wrongRoles = { ...ROLES, 'command-tree': { producer: 'tree', slot: 'nope' } };
  const wrong = await produceSeedling(context, w.knowledge, w.product, { line: LINE, by: w.admin, basis: '角色对不上', roles: wrongRoles });
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason ?? '', /没有 nope 输入/);
});

/** The KnowledgeContext of a made world: the service exposes it as __context for this package's flows and tests. */
async function contextOf(w: World): Promise<Parameters<typeof produceSeedling>[0]> {
  return (w.knowledge as unknown as { __context: Parameters<typeof produceSeedling>[0] }).__context;
}
