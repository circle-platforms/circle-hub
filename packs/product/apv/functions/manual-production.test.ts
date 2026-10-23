// The apv manual producer through the real knowledge production (K01): the same sources produce the same root twice;
// a tree change in a command the manual never names leaves the manual subtree byte-identical (the node digest of
// /manual/cli), while the /commands subtree changes. Synthetic sources only.
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
import { createDefaultRegistry } from '../../../../hub/refs/api.ts';
import type { Principal } from '../../../../hub/records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../../hub/testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../../../../hub/testing/records.ts';

const MANUAL = [
  '# 概述',
  '',
  '本手册为合成。命令字面见 `demo pool add`。',
  '',
  '## 命令',
  '',
  '**demo pool add** *\\<name\\>*',
  '',
  '该命令用于添加成员。',
  '',
  '**demo probe** *\\<name\\>*',
  '',
  '该命令用于探测，仅 hg-k 平台支持。',
  '',
  '| 命令 | 说明 |',
  '| --- | --- |',
  '| **demo pool add** *\\<name\\>* | 添加成员 |',
  '| **demo route static** *\\<net\\>* | 静态路由 |',
].join('\n');

const TREE_A =
  '<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add" help_string="a"><arguments></arguments></item></menu>' +
  '<menu name="route"><item name="static" help_string="s"><arguments></arguments></item></menu></menu></scope></commands>';
// TREE_B adds one command the manual never names.
const TREE_B =
  '<commands><scope type="global"><menu name="demo"><menu name="pool"><item name="add" help_string="a"><arguments></arguments></item></menu>' +
  '<menu name="route"><item name="static" help_string="s"><arguments></arguments></item></menu>' +
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
  const packJson = JSON.parse(readFileSync(join(directory, 'pack.json'), 'utf8')) as { version: string };
  const digest = createHash('sha256').update(readFileSync(join(directory, 'pack.json'))).update(readFileSync(join(directory, 'product.json'))).digest('hex');
  product = { id: 'apv', version: packJson.version, digest, kind: 'product', directory, product: declaration };
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

function build(name: string, tree: string): KnownBuild {
  return {
    name,
    family: 'APV',
    line: '10.6.1',
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
    const first = await knowledge.produceTree({ product, build: build('Rel_APV_10_6_1_8', 'site:tree:a'), by: admin });
    assert.ok(first.ok, first.reason ?? '');
    const again = await knowledge.produceTree({ product, build: build('Rel_APV_10_6_1_8', 'site:tree:a'), by: admin });
    assert.ok(again.ok, again.reason ?? '');
    assert.equal(again.root, first.root, 'byte-identical reproduction (K01)');
    assert.ok((await nodeDigest(first.root as string, ['manual', 'cli'])) !== null, 'the manual namespace hangs in the root');
    const warning = JSON.stringify(again);
    assert.ok(!warning.includes('内部错误'), warning);

    const second = await knowledge.produceTree({ product, build: build('Rel_APV_10_6_1_9', 'site:tree:b'), by: admin });
    assert.ok(second.ok, second.reason ?? '');
    assert.notEqual(second.root, first.root);
    assert.equal(
      await nodeDigest(second.root as string, ['manual', 'cli']),
      await nodeDigest(first.root as string, ['manual', 'cli']),
      'the manual subtree is shared by the two builds (the manual never names the added command)',
    );
    assert.notEqual(await nodeDigest(second.root as string, ['commands']), await nodeDigest(first.root as string, ['commands']));
  });
});
