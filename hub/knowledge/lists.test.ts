// List slots (product@1 ProducerSource many): batches in list order, documents that cannot be read, checked, parsed or
// that the producer fails on are skipped and listed while the rest is produced, optional and missing lists, list sources
// used again within max_age_seconds or read again, fragments naming their element, and the per-node entry cap.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { TreeRootBody } from '../../contracts/src/knowledge.ts';
import type { KnownBuild } from '../../contracts/src/product.ts';
import type { ActionBody } from '../records/api.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { ProduceDetail } from './store.ts';
import { BASE_CATALOG, DEFAULT_PRODUCERS, casesProducer, catalogXml, makeWorld, mindMap, startPostgres, type SyntheticCase, type World } from './test-support.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

const XML = 'application/xml';
const JSON_TYPE = 'application/json';

function build(name: string, cases: string[] | string | undefined, extra: Partial<KnownBuild> = {}): KnownBuild {
  return {
    name,
    family: 'ACME',
    line: '1.2',
    base: name,
    platform: null,
    built_at: '2026-01-02T10:00:00.000Z',
    released_at: '2026-01-05T00:00:00.000Z',
    sources: { tree: `site:tree:${name}`, ...(cases === undefined ? {} : { cases }) },
    root: null,
    ...extra,
  };
}

async function world(t: { after: (fn: () => Promise<void>) => void }, producers: unknown[], options: Parameters<typeof makeWorld>[1] = {}): Promise<World> {
  const w = await makeWorld(postgres, { ...options, pack: { ...(options.pack ?? {}), declaration: { producers, ...(options.pack?.declaration ?? {}) } } });
  t.after(() => w.close());
  w.external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: XML });
  w.external.set('site:tree:Rel_ACME_1_2_16', { bytes: catalogXml({ ...BASE_CATALOG, net: [...BASE_CATALOG.net, { name: 'arp', params: [] }] }), mediaType: XML });
  return w;
}

/** Documents d<from>..d<to>, each with a reboot case (expected result) and a ping case (none). */
function documents(w: World, from: number, to: number, variant = ''): string[] {
  const ids: string[] = [];
  for (let i = from; i <= to; i++) {
    const id = `store:mindmap:d${i}`;
    const cases: SyntheticCase[] = [
      { id: `d${i}-c1`, text: `[cmd: system reboot] 重启用例 ${i}${variant}`, expected: ['重启成功'] },
      { id: `d${i}-c2`, text: `[cmd: net ping] 连通用例 ${i}`, expected: [] },
    ];
    w.external.set(id, { bytes: mindMap({ id: `d${i}`, module: i % 2 === 0 ? 'M2' : 'M1' }, cases), mediaType: JSON_TYPE });
    ids.push(id);
  }
  return ids;
}

async function composition(w: World, digest: string | null): Promise<TreeRootBody> {
  assert.ok(digest !== null);
  const record = await w.kit.store.get(digest);
  assert.ok(record !== null);
  return TreeRootBody.parse(record.body);
}

async function detail(w: World, action: string | null): Promise<ProduceDetail> {
  assert.ok(action !== null);
  const record = await w.kit.store.get<ActionBody>(action);
  return ProduceDetail.parse(record?.body.detail);
}

const docReads = (w: World): number => w.external.reads.filter((id) => id.startsWith('store:mindmap:')).length;

describe('list slots in batches', () => {
  test('the producer is called once per batch in list order; outputs concatenate in batch and element order', async (t) => {
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 3, params: { trace: true } })]);
    const ids = documents(w, 1, 7);
    const result = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15', ids) });
    assert.equal(result.ok, true, result.reason ?? '');
    assert.deepEqual(
      result.warnings.filter((text) => text.startsWith('cases：batch')),
      ['cases：batch 0/3: d1,d2,d3', 'cases：batch 1/3: d4,d5,d6', 'cases：batch 2/3: d7'],
    );
    assert.deepEqual(result.calls, { made: 4, reused: 0 }, 'the command producer once, three batches');
    assert.equal(result.entries, 4 + 14);
    assert.equal(result.skippedCount, 0);
    const body = await composition(w, result.composition);
    // Every case row cites its own document by the digest of its element.
    const shaOf = new Map(body.sources.filter((s) => s.slot === 'cases').map((s) => [s.sha256, s.external]));
    assert.equal(shaOf.size, 7);
    const cases = body.composition.filter((row) => row.kind === 'case');
    assert.equal(cases.length, 14);
    for (const row of cases) {
      const [, sha, selector] = /^src:([0-9a-f]{64})\/kityminder@1\/n\/(d\d+)-c\d$/.exec(row.fragments[0]) ?? [];
      assert.equal(shaOf.get(sha), `store:mindmap:${selector}`, row.fragments[0]);
      assert.equal(row.basis, 'release_record');
    }
    assert.deepEqual(body.skipped, []);
    assert.equal(body.skipped_count, 0);
    const reboot = await w.knowledge.getNodes({ root: result.root as string, paths: ['/commands/system/reboot'], depth: 0 }, w.user);
    assert.equal(reboot?.nodes[0].entries.length, 8, 'the definition and seven cases');
    const recorded = await detail(w, result.action);
    assert.equal(recorded.lists.length, 1);
    assert.equal(recorded.lists[0].count, 7);
    assert.deepEqual(recorded.calls, { made: 4, reused: 0 });
    assert.equal(recorded.sources.length, 1, 'the generate action lists single sources; the list is summarised');
  });

  test('an optional list keeps the root when more than half of its documents cannot be read', async (t) => {
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 2, optional: true })]);
    const ids = documents(w, 1, 4);
    w.external.objects.delete('store:mindmap:d1');
    w.external.objects.delete('store:mindmap:d2');
    w.external.objects.delete('store:mindmap:d3');
    const result = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15', ids) });
    assert.equal(result.ok, true, result.reason ?? '');
    assert.ok(result.skippedCount >= 3, String(result.skippedCount));
    assert.ok(result.root);
  });

  test('a list element is handed to the producer with its external id', async (t) => {
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 4, params: { identity: true } })]);
    const ids = documents(w, 1, 2);
    const result = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15', ids) });
    assert.equal(result.ok, true, result.reason ?? '');
    const named = result.warnings.find((warning) => warning.includes('identity '));
    assert.ok(named, result.warnings.join('\n'));
    assert.match(named, /store:mindmap:d1/);
    assert.match(named, /store:mindmap:d2/);
  });

  test('a document that cannot be read or whose connector fails is skipped and listed; the rest is produced', async (t) => {
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 2 })]);
    const ids = documents(w, 1, 5);
    w.external.objects.delete('store:mindmap:d2');
    w.external.throwing.add('store:mindmap:d4');
    const result = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15', ids) });
    assert.equal(result.ok, true, result.reason ?? '');
    assert.equal(result.skippedCount, 2);
    assert.deepEqual(result.skipped.map((s) => [s.external, s.slot, s.producer]), [
      ['store:mindmap:d2', 'cases', 'cases'],
      ['store:mindmap:d4', 'cases', 'cases'],
    ]);
    assert.match(result.skipped[0].reason, /HTTP 404/);
    assert.match(result.skipped[1].reason, /连接器出错/);
    assert.equal(result.entries, 4 + 6, 'the cases of d1, d3 and d5');
    const body = await composition(w, result.composition);
    assert.equal(body.skipped_count, 2);
    assert.deepEqual(body.skipped?.map((s) => s.external), ['store:mindmap:d2', 'store:mindmap:d4']);
    assert.equal(body.sources.filter((s) => s.slot === 'cases').length, 3);
    const recorded = await detail(w, result.action);
    assert.deepEqual(recorded.lists[0].skipped.map((s) => [s.external, s.retry]), [
      ['store:mindmap:d2', true],
      ['store:mindmap:d4', true],
    ]);
  });

  test('hostile documents are skipped one by one: a credential, no mind map, a crash, unparseable bytes; a foreign citation is refused', async (t) => {
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 3 })]);
    // Nine documents, four of them hostile: under half of the list is skipped (more fails the production, review.test.ts).
    const ids = documents(w, 1, 9);
    w.external.set(ids[1], { bytes: mindMap({ id: 'd2' }, [{ id: 'd2-c1', text: '[cmd: system show] 登录 password = Xy7#kq9Lm2', expected: ['ok'] }]), mediaType: JSON_TYPE });
    w.external.set(ids[2], { bytes: JSON.stringify({ cases: [1, 2, 3] }), mediaType: JSON_TYPE });
    w.external.set(ids[3], { bytes: mindMap({ id: 'd4', text: 'THROW' }, [{ id: 'd4-c1', text: '[cmd: system show] x' }]), mediaType: JSON_TYPE });
    w.external.set(ids[4], { bytes: 'not json at all {', mediaType: JSON_TYPE });
    const result = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15', ids) });
    assert.equal(result.ok, true, result.reason ?? '');
    const reasons = Object.fromEntries(result.skipped.map((s) => [s.external, s.reason]));
    assert.deepEqual(Object.keys(reasons), [ids[1], ids[2], ids[3], ids[4]]);
    assert.match(reasons[ids[1]], /凭据扫描有命中/);
    assert.match(reasons[ids[2]], /生产器 cases 处理这份源文件时失败：生产器 cases 运行失败（TypeError）：Cannot read properties of undefined/);
    assert.match(reasons[ids[3]], /生产器 cases 处理这份源文件时失败/);
    assert.match(reasons[ids[4]], /被 json@1 拒绝.*不是有效的 JSON/);
    assert.equal(result.entries, 4 + 10, 'the cases of d1, d6, d7, d8 and d9');
    assert.ok(result.calls.made > 4, 'failing batches were split to find the document');
    const recorded = await detail(w, result.action);
    assert.deepEqual(recorded.lists[0].skipped.map((s) => s.retry), [true, true, true, true], 'every skipped document remains eligible for the next sync');

    // A fragment naming a digest outside its batch is refused like any fragment that does not verify (K02 R[0]).
    const foreign = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 3, params: { foreign: 'f'.repeat(64) } })]);
    const fids = documents(foreign, 1, 4);
    const refused = await foreign.knowledge.produceTree({ product: foreign.product, build: build('Rel_ACME_1_2_15', fids) });
    assert.equal(refused.ok, true, refused.reason ?? '');
    assert.equal(refused.refusedCount, 2, 'the first entry of each of the two batches');
    assert.ok(refused.refused.every((r) => /不在这一批的输入槽 cases 里/.test(r.reason)));
    assert.deepEqual(refused.refused.map((r) => r.index), [0, 6], 'indices count over the concatenated output');
  });

  test('a producer that fails on an empty batch too fails the production instead of blaming documents', async (t) => {
    const broken = `export default function (input: any): unknown { throw new Error('broken'); }`;
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 2 })], { pack: { functions: { 'cases.ts': broken } } });
    const ids = documents(w, 1, 3);
    const result = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15', ids) });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /空的一批也失败.*生产器本身的问题/);
  });

  test('a batch is handed in calls within the byte cap and an oversized document is tried alone', async (t) => {
    const tree = Buffer.byteLength(catalogXml(BASE_CATALOG), 'utf8');
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 3 })], { knowledge: { limits: { maxBuildBytes: tree + 2000 } } });
    const ids = documents(w, 1, 3);
    const big = mindMap({ id: 'd2' }, [{ id: 'd2-c1', text: `[cmd: system show] ${'长'.repeat(1500)}`, expected: ['ok'] }]);
    w.external.set(ids[1], { bytes: big, mediaType: JSON_TYPE });
    const result = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15', ids) });
    assert.equal(result.ok, true, result.reason ?? '');
    assert.equal(result.skippedCount, 0);
    assert.equal(result.entries, 4 + 5, 'all three documents were handed to the producer');
  });
});

describe('optional and missing lists', () => {
  test('an optional list the build lacks runs the producer once on an empty list; a required one fails the production', async (t) => {
    const optional = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ optional: true, params: { trace: true } })]);
    const produced = await optional.knowledge.produceTree({ product: optional.product, build: build('Rel_ACME_1_2_15', undefined) });
    assert.equal(produced.ok, true, produced.reason ?? '');
    assert.ok(produced.warnings.some((text) => /cases\.cases：构建 Rel_ACME_1_2_15 没有 cases 来源（可选，按空列表生产）/.test(text)), produced.warnings.join('\n'));
    assert.ok(produced.warnings.includes('cases：batch 0/1: '), 'one call with an empty list');
    assert.equal(produced.entries, 4);

    const required = await world(t, [DEFAULT_PRODUCERS[0], casesProducer()]);
    const failed = await required.knowledge.produceTree({ product: required.product, build: build('Rel_ACME_1_2_15', undefined) });
    assert.equal(failed.ok, false);
    assert.match(failed.reason ?? '', /cases\.cases：构建 Rel_ACME_1_2_15 没有 cases 来源/);

    // A role holding one id is a list of one; a list in a role the producer reads singly is refused with the reason.
    const ids = documents(required, 1, 1);
    const single = await required.knowledge.produceTree({ product: required.product, build: build('Rel_ACME_1_2_15', ids[0]) });
    assert.equal(single.ok, true, single.reason ?? '');
    assert.equal(single.entries, 4 + 2);
    const notMany = await world(t, [DEFAULT_PRODUCERS[0], { ...casesProducer(), inputs: { cases: { source: 'cases' } } }]);
    const wrong = await notMany.knowledge.produceTree({ product: notMany.product, build: build('Rel_ACME_1_2_15', ['store:mindmap:d1']) });
    assert.equal(wrong.ok, false);
    assert.match(wrong.reason ?? '', /是一个列表，生产器的这个输入没有声明 many/);

    const two = await world(t, [DEFAULT_PRODUCERS[0], { ...casesProducer(), inputs: { cases: { source: 'cases', many: true }, more: { source: 'cases', many: true } } }]);
    const twice = await two.knowledge.produceTree({ product: two.product, build: build('Rel_ACME_1_2_15', ['store:mindmap:d1']) });
    assert.equal(twice.ok, false);
    assert.match(twice.reason ?? '', /最多一个/);
  });

  test('a listed id twice is read once and handed to the producer once', async (t) => {
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 10, params: { trace: true } })]);
    const ids = documents(w, 1, 2);
    const result = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15', [ids[0], ids[1], ids[0]]) });
    assert.equal(result.ok, true, result.reason ?? '');
    assert.ok(result.warnings.includes('cases：batch 0/1: d1,d2'));
    assert.ok(result.warnings.some((text) => /1 个重复的外部对象/.test(text)));
    assert.equal(docReads(w), 2);
  });
});

describe('list sources used again within max_age_seconds', () => {
  test('a stored load younger than max_age is used without a read; 0 and an older one read again', async (t) => {
    let now = new Date('2026-03-01T00:00:00.000Z');
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer({ batch: 2 })], { now: () => now });
    const ids = documents(w, 1, 4);
    const first = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15', ids) });
    assert.equal(first.ok, true, first.reason ?? '');
    assert.deepEqual(first.loads, { reused: 0, read: 4 });
    assert.equal(docReads(w), 4);

    // Another build of the line lists the same documents: nothing is read again; its batches run (the build is an input).
    now = new Date('2026-03-01T12:00:00.000Z');
    const second = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_16', ids) });
    assert.equal(second.ok, true, second.reason ?? '');
    assert.deepEqual(second.loads, { reused: 4, read: 0 });
    assert.equal(docReads(w), 4);
    assert.deepEqual(second.calls, { made: 3, reused: 0 });

    const forced = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_16', ids), maxAgeSeconds: 0 });
    assert.deepEqual(forced.loads, { reused: 0, read: 4 });
    assert.equal(docReads(w), 8);

    now = new Date('2026-03-03T00:00:00.000Z');
    const older = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_16', ids) });
    assert.deepEqual(older.loads, { reused: 0, read: 4 }, 'the last loads are more than a day old');
    assert.equal(docReads(w), 12);
    assert.equal(older.root, second.root, 'equal content gives the same root whichever way the documents were loaded');
  });

  test('stored loads use current acceptance without a re-read and become unreadable after withdrawal', async (t) => {
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer()]);
    const ids = documents(w, 1, 2);
    w.external.set(ids[1], { bytes: mindMap({ id: 'd2' }, [{ id: 'd2-c1', text: '[cmd: system show] 登录 password = Xy7#kq9Lm2', expected: ['ok'] }]), mediaType: JSON_TYPE });
    const first = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15', ids) });
    assert.equal(first.skippedCount, 1);
    const sha = /源文件 ([0-9a-f]{64})/.exec(first.skipped[0].reason)?.[1];
    assert.ok(sha);
    await w.kit.artifacts.acceptFindings(w.admin, sha, '合成用例里的示例写法，不是真实凭据');
    const second = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15', ids) });
    assert.equal(second.ok, true, second.reason ?? '');
    assert.equal(second.skippedCount,0,'the stored document is now effectively accepted');
    assert.deepEqual(second.loads,{reused:2,read:0});
    await w.kit.artifacts.revokeFindings(w.admin,sha,'撤回合成来源受理');
    const third=await w.knowledge.produceTree({product:w.product,build:build('Rel_ACME_1_2_15',ids)});
    assert.equal(third.skippedCount,1);
    assert.deepEqual(third.loads,{reused:1,read:1},'the withdrawn cached source is re-read, remains held and is not admitted');
  });
});

describe('the entry cap of a node', () => {
  test('a node holds at most maxNodeEntries entries; the rest are refused with the reason and counted', async (t) => {
    const w = await world(t, [DEFAULT_PRODUCERS[0], casesProducer()], { knowledge: { limits: { maxNodeEntries: 3 } } });
    const ids = documents(w, 1, 4);
    const result = await w.knowledge.produceTree({ product: w.product, build: build('Rel_ACME_1_2_15', ids) });
    assert.equal(result.ok, true, result.reason ?? '');
    const full = result.refused.filter((r) => /达到每个节点的上限/.test(r.reason));
    assert.equal(full.length, 4, 'reboot and ping each hold their definition and two cases');
    assert.deepEqual([...new Set(full.map((r) => r.path))].sort(), ['/commands/net/ping', '/commands/system/reboot']);
    const page = await w.knowledge.getNodes({ root: result.root as string, paths: ['/commands/system/reboot'], depth: 0 }, w.admin);
    assert.equal(page?.nodes[0].entries.length, 3);
  });
});
