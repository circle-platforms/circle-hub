import {createTestParserRegistry as createDefaultRegistry} from '../../../../hub/testing/parsers.ts';
// The famx manual producer through the real knowledge production (K01): the same sources produce the same root twice;
// a tree change in a command the manual never names leaves the manual subtree byte-identical (the node digest of
// /manual/cli), while the /commands subtree changes; editing one section of the same source changes only that node and its ancestors. Synthetic sources only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { ProductDeclaration, type KnownBuild } from '../../../../contracts/src/product.ts';
import { osIsolationAvailable } from '../../../../hub/connectors/api.ts';
import { createKnowledge, type Knowledge } from '../../../../hub/knowledge/api.ts';
import { FakeExternal, FakePacks } from '../../../../hub/knowledge/test-support.ts';
import type { ProductHandle } from '../../../../hub/ports.ts';

import { canonicalBytes, type Principal } from '../../../../hub/records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../../hub/testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../../../../hub/testing/records.ts';

const MANUAL = [
  '# 概述',
  '',
  '本手册为合成。命令字面见 `demo pool add`。',
  '',
  '## 命令',
  '',
  '本章列出生成命令，说明见各条。',
  '',
  '**demo pool add** *\\<name\\>*',
  '',
  '该命令用于添加成员。',
  '',
  '**demo probe** *\\<name\\>*',
  '',
  '该命令用于探测，仅 sy-k 平台支持。',
  '',
  '| 命令 | 说明 |',
  '| --- | --- |',
  '| **demo pool add** *\\<name\\>* | 添加成员 |',
  '| **demo route static** *\\<net\\>* | 静态路由 |',
  '',
  '# 独立章节',
  '',
  '这一章的合成正文保持不变。',
  '',
  '## 附录',
  '',
  '附录的合成正文也保持不变。',
].join('\n');

// The same manual with one sentence of the 概述 section edited (the 命令 section untouched).
const MANUAL_EDITED = MANUAL.replace('本手册为合成。', '本手册为合成，第二版。');

// The trees hold EVERY command the manual names (demo probe included: closure c3 item 9 — a digest compared as
// null on both sides proves nothing about the node it names).
const TREE_A =
  '<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add" help_string="a"><arguments></arguments></item></menu>' +
  '<menu name="route"><item name="static" help_string="s"><arguments></arguments></item></menu>' +
  '<item name="probe" help_string="p"><arguments></arguments></item></menu></scope></commands>';
// TREE_B adds one command the manual never names.
const TREE_B =
  '<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add" help_string="a"><arguments></arguments></item></menu>' +
  '<menu name="route"><item name="static" help_string="s"><arguments></arguments></item></menu>' +
  '<item name="probe" help_string="p"><arguments></arguments></item>' +
  '<item name="other" help_string="o"><arguments></arguments></item></menu></scope></commands>';

/** The FakeExternal of the knowledge tests, plus the manual-store external ids. */
class ManualExternal extends FakeExternal {
  override async accepts(id: string): Promise<boolean> {
    return (await super.accepts(id)) || id.startsWith('manual:');
  }
}

let postgres: TemporaryPostgres;
let kit: TestRecordsKit;
let admin: Principal;
let knowledge: Knowledge;
let external: ManualExternal;
let product: ProductHandle;

before(async () => {
  postgres = await startPostgres();
  let clock = Date.parse('2026-10-23T08:00:00.000Z');
  const now = (): Date => new Date((clock += 7));
  kit = await openTestRecords({ postgres, now });
  admin = ((): Principal => {
    return { id: '', name: '', role: 'admin' };
  })();
  const boot = await kit.principals.bootstrapAdmin('管理员');
  admin = { id: boot.user.id, name: boot.user.name, role: 'admin' };
  const directory = fileURLToPath(new URL('..', import.meta.url));
  const declaration = ProductDeclaration.parse(JSON.parse(readFileSync(join(directory, 'product.json'), 'utf8')));
  for(const variable of declaration.variables??[])await kit.variables.setVariable(admin,variable.name,variable.default,'合成空闭集');
  const packJson = JSON.parse(readFileSync(join(directory, 'pack.json'), 'utf8')) as { version: string };
  const digest = createHash('sha256').update(readFileSync(join(directory, 'pack.json'))).update(readFileSync(join(directory, 'product.json'))).digest('hex');
  product = { id: 'famx', version: packJson.version, digest, kind: 'product', directory, product: declaration };
  for(const variable of declaration.variables??[])await kit.variables.setVariable(admin,variable.name,variable.default,'合成手册测试显式部署设置');
  const packs = new FakePacks();
  packs.add(product);
  external = new ManualExternal(kit);
  external.set('manual:cli:10.6.1', { bytes: MANUAL, mediaType: 'text/markdown' });
  external.set('site:tree:a', { bytes: TREE_A, mediaType: 'application/xml' });
  external.set('site:tree:b', { bytes: TREE_B, mediaType: 'application/xml' });
  knowledge = createKnowledge({
    records: kit,
    parsers: createDefaultRegistry(),
    packs,
    external,
    jev: null,
    sandbox: { requireOsIsolation: await osIsolationAvailable() },
    clock: now,
    admin,
  });
});

after(async () => {
  await kit?.close();
  await postgres?.stop();
});

function build(name: string, tree: string, line = '10.6.1'): KnownBuild {
  return {
    name,
    family: 'FAMX',
    line,
    base: name,
    platform: null,
    built_at: '2026-05-12T10:20:30Z',
    released_at: '2026-05-14T00:00:00Z',
    sources: { tree },
    root: null,
  };
}

async function nodeDigest(root: string, names: string[]): Promise<string | null> {
  let digest: string | null = root;
  for (const name of names) {
    if (digest === null) return null;
    const node = await knowledge.store.node(digest);
    digest = node?.children.find((child) => child.name === name)?.digest ?? null;
  }
  return digest;
}

describe('production with the real manual producer', () => {
  test('the same sources give the same root twice; an unrelated tree command leaves the manual subtree untouched', async () => {
    // The frozen known-build inventory is the plan's build list (K01: a declared input, never accumulated records);
    // a production outside a sync freezes the build it is producing alone.
    const PLAN = ['Rel_FAMX_10_6_1_8', 'Rel_FAMX_10_6_1_9'];
    const first = await knowledge.produceTree({ product, build: build('Rel_FAMX_10_6_1_8', 'site:tree:a'), planBuilds: PLAN, by: admin });
    assert.ok(first.ok, first.reason ?? '');
    const again = await knowledge.produceTree({ product, build: build('Rel_FAMX_10_6_1_8', 'site:tree:a'), planBuilds: PLAN, by: admin });
    assert.ok(again.ok, again.reason ?? '');
    assert.equal(again.root, first.root, 'byte-identical reproduction (K01)');
    assert.ok((await nodeDigest(first.root as string, ['manual', 'cli'])) !== null, 'the manual namespace hangs in the root');
    // Every production namespace the manual producer fills has a non-null digest (closure finding 22): commands
    // because the tree names them, manual because the namespaces hang in the root above.
    assert.ok((await nodeDigest(first.root as string, ['commands', 'demo', 'pool', 'add'])) !== null, 'the named command hangs in /commands');
    const warning = JSON.stringify(again);
    assert.ok(!warning.includes('内部错误'), warning);

    const second = await knowledge.produceTree({ product, build: build('Rel_FAMX_10_6_1_9', 'site:tree:b'), planBuilds: PLAN, by: admin });
    assert.ok(second.ok, second.reason ?? '');
    assert.notEqual(second.root, first.root);
    assert.equal(
      await nodeDigest(second.root as string, ['manual', 'cli']),
      await nodeDigest(first.root as string, ['manual', 'cli']),
      'the manual subtree is shared by the two builds (the manual never names the added command)',
    );
    assert.notEqual(await nodeDigest(second.root as string, ['commands']), await nodeDigest(first.root as string, ['commands']));
  });


  test('renaming a chapter heading leaves every /commands node digest unchanged (a heading is no entry data)', async () => {
    external.set('manual:cli:10.6.1', { bytes: MANUAL, mediaType: 'text/markdown' });
    const before = await knowledge.produceTree({ product, build: build('Rel_FAMX_10_6_1_8', 'site:tree:a'), by: admin });
    assert.ok(before.ok, before.reason ?? '');
    // A chapter inserted before 命令 renumbers it: 3 命令 would become 4 命令 in the heading chain.
    const renumbered = MANUAL.replace('# 命令', '# 4 命令');
    assert.notEqual(renumbered, MANUAL);
    external.set('manual:cli:10.6.1', { bytes: renumbered, mediaType: 'text/markdown' });
    const after = await knowledge.produceTree({ product, build: build('Rel_FAMX_10_6_1_9', 'site:tree:a'), by: admin });
    assert.ok(after.ok, after.reason ?? '');
    for (const names of [['commands', 'demo', 'pool', 'add'], ['commands', 'demo', 'probe'], ['commands', 'demo', 'route', 'static']]) {
      const beforeDigest = await nodeDigest(before.root as string, names);
      const afterDigest = await nodeDigest(after.root as string, names);
      assert.ok(beforeDigest !== null, `${names.join('/')} exists before the rename`);
      assert.ok(afterDigest !== null, `${names.join('/')} exists after the rename`);
      assert.equal(afterDigest, beforeDigest, `${names.join('/')} keeps its digest when only a heading changed`);
    }
    external.set('manual:cli:10.6.1', { bytes: MANUAL, mediaType: 'text/markdown' });
  });

  test('editing one manual section changes only its node and its ancestors to the root', async () => {
    const source = 'manual:cli:10.6.1';
    const target = build('Rel_FAMX_10_6_1_11', 'site:tree:a');
    type NodeSnapshot = { digest: string; bytes: Uint8Array; entries: Map<string, Uint8Array> };
    const snapshot = async (root: string): Promise<Map<string, NodeSnapshot>> => {
      const nodes = new Map<string, NodeSnapshot>();
      const visit = async (digest: string, names: string[]): Promise<void> => {
        const node = await knowledge.store.node(digest);
        assert.ok(node, 'every asserted node must exist');
        const entries = new Map<string, Uint8Array>();
        for (const id of node.entries) {
          const entry = await knowledge.store.entry(id);
          assert.ok(entry, 'every asserted entry must exist');
          entries.set(id, canonicalBytes(entry));
        }
        nodes.set('/' + names.join('/'), { digest, bytes: canonicalBytes(node), entries });
        for (const child of node.children) await visit(child.digest, [...names, child.name]);
      };
      await visit(root, []);
      return nodes;
    };
    const readsBefore = external.reads.length;
    const before = await knowledge.produceTree({ product, build: target, by: admin });
    assert.ok(before.ok, before.reason ?? '');
    const beforeNodes = await snapshot(before.root as string);
    const originalReads = external.reads.slice(readsBefore).filter(id => id.startsWith('manual:cli:'));
    assert.ok(originalReads.length > 0);
    assert.ok(originalReads.every(id => id === source));

    try {
      // Re-read exactly the same source identity for exactly the same build; only one paragraph's bytes change.
      external.set(source, { bytes: MANUAL_EDITED, mediaType: 'text/markdown' });
      const readsAfter = external.reads.length;
      const after = await knowledge.produceTree({ product, build: target, by: admin });
      assert.ok(after.ok, after.reason ?? '');
      assert.deepEqual(external.reads.slice(readsAfter).filter(id => id.startsWith('manual:cli:')), originalReads);
      const afterNodes = await snapshot(after.root as string);
      assert.deepEqual([...afterNodes.keys()].sort(), [...beforeNodes.keys()].sort(), 'no section or command node was added or removed');

      const changed = ['/', '/manual', '/manual/cli', '/manual/cli/概述'];
      for (const path of [...changed, '/manual/cli/概述/命令', '/manual/cli/独立章节', '/manual/cli/独立章节/附录', '/commands']) {
        assert.ok(beforeNodes.has(path) && afterNodes.has(path), `the fixture must produce ${path}`);
      }
      assert.deepEqual([...beforeNodes.keys()].filter(path => beforeNodes.get(path)!.digest !== afterNodes.get(path)!.digest).sort(), changed.sort());
      for (const [path, original] of beforeNodes) {
        const reproduced = afterNodes.get(path)!;
        if (changed.includes(path)) {
          assert.notDeepEqual(reproduced.bytes, original.bytes, `${path}: changed node bytes`);
        } else {
          assert.equal(reproduced.digest, original.digest, `${path}: unchanged digest`);
          assert.deepEqual(reproduced.bytes, original.bytes, `${path}: byte-identical node`);
          assert.deepEqual(reproduced.entries, original.entries, `${path}: byte-identical entry content`);
        }
      }
      const textOf = (node: NodeSnapshot) => [...node.entries.values()].map(bytes => new TextDecoder().decode(bytes)).join('\n');
      assert.ok(textOf(beforeNodes.get('/manual/cli/概述')!).includes('本手册为合成。'));
      assert.ok(textOf(afterNodes.get('/manual/cli/概述')!).includes('本手册为合成，第二版。'));
      assert.ok(!textOf(afterNodes.get('/manual/cli/概述')!).includes('本手册为合成。'));
    } finally {
      external.set(source, { bytes: MANUAL, mediaType: 'text/markdown' });
    }
  });
});
