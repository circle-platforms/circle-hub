// Synthetic contribution run: a relation grounded directly in tree entries has no feeding record. An administrator retracts
// it as an entry; the record stays, the read side shows its basis withdrawn, the other end stays as it was (T6-3).
import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {KnowledgeContributionView} from '../../contracts/src/contributions.ts';
import {startPostgres, type TemporaryPostgres} from '../testing/postgres.ts';
import {makeWorld, catalogXml, BASE_CATALOG} from './test-support.ts';
import {createRunsService} from '../runs/engine/api.ts';
import {FakeWorkflowStore} from '../runs/engine/testing/workflows.ts';
import {toolText} from '../server/text.ts';
import {formatKnowledgeRetract, knowledgeRetract} from './api.ts';

let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(async () => { await postgres?.stop(); });

const call = {traceId:'4bf92f3577b34da6a3ce929d0e0e4736', sessionId:'retraction-session'};
const at = '2026-10-31T09:00:00.000Z';
const RETRACTED = /^这条回注本身已被管理员撤回；历史引文仍保留$/;

async function world(t: {after(fn: () => Promise<void>): void}) {
  const w = await makeWorld(postgres); t.after(() => w.close());
  const build = {name:'Rel_ACME_1_2_15', family:'ACME', line:'1.2', base:'Rel_ACME_1_2_15', platform:null, built_at:'2026-01-02T10:00:00.000Z', released_at:'2026-01-03T10:00:00.000Z', sources:{tree:'site:tree:Rel_ACME_1_2_15'}, root:null};
  w.external.set(build.sources.tree, {bytes:new TextEncoder().encode(catalogXml(BASE_CATALOG)), mediaType:'application/xml'});
  const produced = await w.knowledge.produceTree({product:w.product, build});
  assert.ok(produced.ok, produced.reason ?? '');
  const root = produced.root!;
  const original = (await w.knowledge.store.composition(produced.composition!))!.sources[0].sha256;
  const workflows = new FakeWorkflowStore();
  await workflows.add(fileURLToPath(new URL('../../packs/workflow/knowledge-contribution/', import.meta.url)));
  const service = createRunsService({records:w.kit, packs:w.packs, knowledge:w.knowledge, external:w.external, workflows, parsers:createDefaultRegistry()});
  const manifest = await w.kit.artifacts.ingest({bytes:new TextEncoder().encode(JSON.stringify({items:[{id:'relation', title:'relation'}, {id:'assertion', title:'assertion'}]})), mediaType:'application/json', origin:{upload:{session:call.sessionId, message:null}}, author:{user:w.admin.id}, provenanceType:'declared', visibility:{readers:[w.admin.id], admins:true, packs:[], shareable:false}});
  const started = await service.startRun(w.admin, {pack:'knowledge-contribution', product:'Acme', build:build.name, inputs:{subject:{reference:`src:${manifest.body.sha256}`}, originals:{reference:`src:${original}`}}}, call);
  assert.equal(started.call_result, 'ok', JSON.stringify(started.errors));
  const run = started.run!.run;
  // A relation that contradicts the ping node, both ends quoted from tree entries, and an assertion on that other end.
  const answer = await service.submitResult(w.admin, {run, model:'integration-synthetic@1', items:[
    {item:'relation', handling:'handled', slots:{contribution:[{code:'relation', text:'合成显示与合成探测的说法相互矛盾', data:{root, path:'/commands/system/show', source:{reference:`tree:${root}/commands/system/show`, quote:'show'}, relation:{kind:'contradicts', other:{reference:`tree:${root}/commands/net/ping`, quote:'ping'}}}}]}},
    {item:'assertion', handling:'handled', slots:{contribution:[{code:'assertion', text:'合成探测节点的说明', data:{root, path:'/commands/net/ping', source:{reference:`tree:${root}/commands/net/ping`, quote:'ping'}}}]}},
  ]}, call);
  const stored = answer.result?.contributions?.stored ?? [];
  assert.equal(stored.length, 2, JSON.stringify(answer.errors));
  const record = (item: string) => stored.find(row => row.item === item)!.record;
  return {w, root, run, relation:record('relation'), assertion:record('assertion'), receipt:stored.map(row => row.record)};
}

test('a relation grounded in tree entries is retracted as an entry: the record stays, its basis shows withdrawn, the other end stays valid', async t => {
  const ctx = await world(t);
  const feeding = ctx.w.knowledge.feeding!, layer = ctx.w.knowledge.layers.contributions;
  const stored = await ctx.w.kit.store.get(ctx.relation);
  assert.equal((stored!.body as {feeding_record?: string}).feeding_record, undefined, 'grounded in tree entries, no feeding record');
  assert.equal((stored!.body as {relation?: {kind: string}}).relation?.kind, 'contradicts');
  const nodes = async (path: string) => (await ctx.w.knowledge.getNodes({root:ctx.root, paths:[path], depth:0}, ctx.w.admin))!.nodes;
  const viewOf = async (record: string, path: string) => (await nodes(path))[0].contributions!.map(row => KnowledgeContributionView.parse(row)).find(row => row.record === record);
  assert.equal((await viewOf(ctx.relation, '/commands/system/show'))?.status, 'valid');
  const otherEnd = await nodes('/commands/net/ping');
  const count = async () => (await ctx.w.kit.store.find({key:'knowledge.feeding.retraction', value:'1', kind:'claim', limit:20})).items.length;

  const report = await knowledgeRetract(feeding, ctx.w.admin, {entries:[ctx.relation], runs:[], objects:[], reason:'合成撤回矛盾关系', at});
  assert.deepEqual(report.appended.map(row => [row.kind, row.count]), [['entries', 1]]);
  assert.equal(formatKnowledgeRetract(report).at(-1), '原记录未改动；读侧将显示根据已撤回');
  assert.equal(await count(), 1);

  // Not deleted: the record and its digest are unchanged; the node view, a single read and the tool text show it withdrawn.
  assert.deepEqual(await ctx.w.kit.store.get(ctx.relation), stored);
  const withdrawn = await viewOf(ctx.relation, '/commands/system/show');
  assert.equal(withdrawn?.status, 'grounds_withdrawn');
  assert.match(withdrawn?.note ?? '', RETRACTED);
  assert.deepEqual(withdrawn?.contribution, stored!.body);
  const single = await layer.readView(ctx.relation, ctx.w.admin);
  assert.equal(single?.status, 'grounds_withdrawn');
  assert.equal(single?.note, withdrawn?.note);
  assert.ok(await layer.read(ctx.relation, ctx.w.admin), 'a retracted contribution stays readable');
  const page = await ctx.w.knowledge.getNodes({root:ctx.root, paths:['/commands/system/show'], depth:0}, ctx.w.admin);
  assert.match(toolText('get_nodes', {call_result:'ok', errors:[], trace:call.traceId, root:ctx.root, nodes:page!.nodes}), /这条回注本身已被管理员撤回；历史引文仍保留/);

  // The other end: its tree entries and the assertion placed on it stay exactly as they were.
  assert.deepEqual(await nodes('/commands/net/ping'), otherEnd);
  assert.equal((await layer.readView(ctx.assertion, ctx.w.admin))?.status, 'valid');

  // The same target again appends nothing.
  const again = await knowledgeRetract(feeding, ctx.w.admin, {entries:[ctx.relation], runs:[], objects:[], reason:'合成撤回矛盾关系', at});
  assert.deepEqual(again.appended, []);
  assert.equal(await count(), 1);
  assert.match(formatKnowledgeRetract(again)[0], /^这些目标已撤回（撤回记录 [0-9a-f]{12}），没有追加$/);

  // Every new contribution, not only an operation record, names the run that stored it.
  const linked = await ctx.w.kit.store.find({key:'knowledge.contribution.run', value:ctx.run, kind:'claim', limit:10});
  assert.deepEqual(linked.items.map(row => row.digest).sort(), [...ctx.receipt].sort());
});

test('retracting the receipt entries of a run already retracted by an older run-only record appends one entry record, then nothing', async t => {
  const ctx = await world(t);
  const feeding = ctx.w.knowledge.feeding!, layer = ctx.w.knowledge.layers.contributions;
  const count = async () => (await ctx.w.kit.store.find({key:'knowledge.feeding.retraction', value:'1', kind:'claim', limit:20})).items.length;
  // What `knowledge retract --run` recorded before: the run alone. That record lists no contribution of the run.
  const older = await feeding.retract(ctx.w.admin, {schema:'retraction@1', runs:[ctx.run], by:ctx.w.admin.id, at, reason:'合成撤回运行'});
  assert.equal((await layer.readView(ctx.relation, ctx.w.admin))?.status, 'valid', 'a run-only record names no contribution');
  const before = await ctx.w.kit.store.get(ctx.relation);

  // The command now lists the run's receipt entries beside the run: the run is covered, the entries are not.
  const report = await knowledgeRetract(feeding, ctx.w.admin, {entries:ctx.receipt, runs:[ctx.run], objects:[], reason:'合成撤回运行', at});
  assert.deepEqual(report.appended.map(row => [row.kind, row.count]), [['entries', 2]]);
  assert.deepEqual(report.skipped, [{kind:'run', id:ctx.run, records:[older]}]);
  const lines = formatKnowledgeRetract(report);
  assert.match(lines[0], /^撤回记录 [0-9a-f]{12}：条目 2 个，原因 合成撤回运行$/);
  assert.ok(lines.includes(`已跳过运行 ${ctx.run.slice(0, 12)}：已有撤回记录 ${older.slice(0, 12)}`), lines.join('\n'));
  assert.equal(await count(), 2);
  for (const record of ctx.receipt) {
    const view = await layer.readView(record, ctx.w.admin);
    assert.equal(view?.status, 'grounds_withdrawn');
    assert.match(view?.note ?? '', RETRACTED);
  }
  assert.deepEqual(await ctx.w.kit.store.get(ctx.relation), before);

  // An identical repeat appends nothing.
  const again = await knowledgeRetract(feeding, ctx.w.admin, {entries:ctx.receipt, runs:[ctx.run], objects:[], reason:'合成撤回运行', at});
  assert.deepEqual(again.appended, []);
  assert.equal(await count(), 2);
  assert.match(formatKnowledgeRetract(again)[0], /^这些目标已撤回（撤回记录 [0-9a-f]{12}、[0-9a-f]{12}），没有追加$/);
});
