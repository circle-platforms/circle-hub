import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {KnowledgeContributionView} from '../../contracts/src/contributions.ts';
import {Claim} from '../../contracts/src/claim.ts';
import {RunRecord} from '../../contracts/src/run.ts';
import {startPostgres, type TemporaryPostgres} from '../testing/postgres.ts';
import {makeWorld, catalogXml, BASE_CATALOG, sandboxIsolation} from './test-support.ts';
import {join} from 'node:path';
import {openRecords} from '../records/index.ts';
import {DEFAULT_LIMITS} from '../config/index.ts';
import {createRunsService} from '../runs/engine/api.ts';
import {FakeWorkflowStore} from '../runs/engine/testing/workflows.ts';
import {toolText} from '../server/text.ts';
import {createKnowledge, formatKnowledgeRetract, knowledgeRetract} from './api.ts';
import {operationIdentity} from './feeding.ts';
import {canonicalize, sha256Hex} from '../records/api.ts';
import {osIsolationAvailable} from '../rules/api.ts';

const skip = (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)';
const call = {traceId:'4bf92f3577b34da6a3ce929d0e0e4736', sessionId:'operation-session'};
let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(async () => { await postgres?.stop(); });

const echo = '合成回显：状态正常\n';
const quote = '合成回显';

async function world(t: {after(fn: () => Promise<void>): void}) {
  const w = await makeWorld(postgres); t.after(() => w.close());
  const build = {name:'Rel_ACME_1_2_15', family:'ACME', line:'1.2', base:'Rel_ACME_1_2_15', platform:null, built_at:'2026-01-02T10:00:00.000Z', released_at:'2026-01-03T10:00:00.000Z', sources:{tree:'site:tree:Rel_ACME_1_2_15'}, root:null};
  w.external.set(build.sources.tree, {bytes:new TextEncoder().encode(catalogXml(BASE_CATALOG)), mediaType:'application/xml'});
  const produced = await w.knowledge.produceTree({product:w.product, build});
  assert.ok(produced.ok, produced.reason ?? '');
  const workflows = new FakeWorkflowStore();
  await workflows.add(fileURLToPath(new URL('../../packs/workflow/knowledge-contribution/', import.meta.url)));
  const service = createRunsService({records:w.kit, packs:w.packs, knowledge:w.knowledge, external:w.external, workflows, parsers:createDefaultRegistry()});
  const manifest = await w.kit.artifacts.ingest({bytes:new TextEncoder().encode(JSON.stringify({items:[{id:'assertion', title:'assertion'}]})), mediaType:'application/json', origin:{upload:{session:'operation-session', message:null}}, author:{user:w.admin.id}, provenanceType:'declared', visibility:{readers:[w.admin.id], admins:true, packs:[], shareable:false}});
  const captured = await w.kit.artifacts.ingest({bytes:new TextEncoder().encode(echo), mediaType:'text/plain', origin:{upload:{session:'operation-session', message:null}}, author:{user:w.admin.id}, provenanceType:'client_captured', visibility:{readers:[w.admin.id], admins:true, packs:[], shareable:false}});
  const composition = produced.composition!;
  const original = (await w.knowledge.store.composition(composition))!.sources[0].sha256;
  const started = await service.startRun(w.admin, {pack:'knowledge-contribution', product:'Acme', build:build.name, inputs:{subject:{reference:`src:${manifest.body.sha256}`}, originals:[{reference:`src:${original}`}, {reference:`src:${captured.body.sha256}`}]}}, call);
  assert.equal(started.call_result, 'ok', JSON.stringify(started.errors));
  const run = RunRecord.parse((await service.getRun(w.admin, started.run!.run))!.run);
  return {w, service, run, root: produced.root!, sha: captured.body.sha256, build};
}

function observation(ctx: Awaited<ReturnType<typeof world>>, path: string, action = '执行合成显示') {
  return {schema:'fed-observation@1', product:ctx.run.product, root:ctx.root, path, source:{system:'upload', bytes:ctx.sha}, action, result:{reference:`src:${ctx.sha}/text@1/l/1`, text:quote}};
}

function submit(ctx: Awaited<ReturnType<typeof world>>, path: string, feeding: Record<string, unknown>, statement = '执行了合成显示', relation?: {kind:'contradicts'; other:{reference:string; quote:string}}) {
  return {run:ctx.run.run, model:'integration-synthetic@1', items:[{item:'assertion', handling:'handled' as const, slots:{contribution:[{code:'assertion', text:statement, data:{root:ctx.root, path, source:{reference:`src:${ctx.sha}/text@1/l/1`, quote}, feeding, ...(relation?{relation}:{})}}]}}]};
}

test('an operation record enters at declaration grade from a client capture and keeps the locked build', {skip}, async t => {
  const ctx = await world(t);
  const frozen = ctx.run.feeding_offset?.offset;
  const answer = await ctx.service.submitResult(ctx.w.admin, submit(ctx, '/commands/system/show', observation(ctx, '/commands/system/show')), call);
  assert.equal(answer.result?.contributions?.stored.length, 1, JSON.stringify(answer.errors));
  const digest = answer.result!.contributions!.stored[0].record;
  const page = await ctx.w.knowledge.getNodes({root:ctx.root, paths:['/commands/system/show'], depth:0}, ctx.w.admin);
  const view = page!.nodes[0].contributions!.map(row => KnowledgeContributionView.parse(row)).find(row => row.record === digest)!;
  assert.ok('statement' in view.contribution);
  assert.equal(view.contribution.kind, 'assertion');
  assert.equal(view.contribution.source.provenance, 'client_captured');
  assert.equal(view.contribution.feeding?.schema, 'fed-observation@1');
  const feeding = view.contribution.feeding as {object:string; binding:{source:string; build?:string}; action:string; result:unknown};
  assert.equal(feeding.binding.source, 'run_lock');
  assert.equal(feeding.binding.build, ctx.build.name);
  assert.equal(feeding.object, sha256Hex(canonicalize(operationIdentity(feeding as unknown as Record<string, unknown>))));
  const text = toolText('get_nodes', {call_result:'ok', errors:[], trace:call.traceId, root:ctx.root, nodes:page!.nodes});
  assert.match(text, /条目 观察/);
  assert.match(text, /客户端捕获/);
  assert.match(text, /依据 声明/);
  const again = await ctx.service.submitResult(ctx.w.admin, submit(ctx, '/commands/system/show', observation(ctx, '/commands/system/show')), {...call, traceId:'a'.repeat(32)});
  assert.equal(again.result?.contributions?.stored[0].record, digest);
  const later = RunRecord.parse((await ctx.service.getRun(ctx.w.admin, ctx.run.run))!.run);
  assert.equal(later.feeding_offset?.offset, frozen);
  const claims = await ctx.w.kit.store.find({key:'knowledge.feeding.actor', value:ctx.w.admin.id, kind:'claim', limit:20});
  const recorded = claims.items.map(row => Claim.parse(row.body)).find(body => body.statement.data?.feeding && (body.statement.data.feeding as {schema?:string}).schema === 'fed-observation@1');
  assert.equal(recorded?.qualifier.nature, 'unknown');
  assert.equal(recorded?.qualifier.provenance, 'client_captured');
  assert.equal(recorded?.qualifier.basis_rank, undefined);
  const linked = await ctx.w.kit.store.find({key:'knowledge.contribution.run', value:ctx.run.run, kind:'claim', limit:5});
  assert.ok(linked.items.some(row => row.digest === digest));
  assert.equal(await ctx.w.knowledge.layers.contributions.read(digest, ctx.w.user), null);
  assert.ok(await ctx.w.knowledge.layers.contributions.read(digest, ctx.w.admin));
});

test('a changed character, a model-reported version and any other provenance are refused', {skip}, async t => {
  const ctx = await world(t);
  const changed = observation(ctx, '/commands/system/show');
  (changed.result as {text:string}).text = '合成回显X';
  const mismatch = await ctx.service.submitResult(ctx.w.admin, submit(ctx, '/commands/system/show', changed), call);
  assert.equal(mismatch.result?.contributions?.stored.length ?? 0, 0);
  assert.match(JSON.stringify(mismatch.errors), /逐字/);
  const reported = {...observation(ctx, '/commands/system/show'), build:'synthetic-reported'};
  const version = await ctx.service.submitResult(ctx.w.admin, submit(ctx, '/commands/system/show', reported), {...call, traceId:'b'.repeat(32)});
  assert.match(JSON.stringify(version.errors), /版本/);
  const declaredText = '另一份合成回显：状态正常\n';
  const declared = await ctx.w.kit.artifacts.ingest({bytes:new TextEncoder().encode(declaredText), mediaType:'text/plain', origin:{upload:{session:'operation-session', message:null}}, author:{user:ctx.w.admin.id}, provenanceType:'declared', visibility:{readers:[ctx.w.admin.id], admins:true, packs:[], shareable:false}});
  const foreign = observation(ctx, '/commands/system/show');
  foreign.source.bytes = declared.body.sha256;
  (foreign.result as {reference:string; text:string}).reference = `src:${declared.body.sha256}/text@1/l/1`;
  (foreign.result as {text:string}).text = '另一份合成回显';
  const refused = await ctx.service.submitResult(ctx.w.admin, {run:ctx.run.run, model:'integration-synthetic@1', items:[{item:'assertion', handling:'handled', slots:{contribution:[{code:'assertion', text:'执行了合成显示', data:{root:ctx.root, path:'/commands/system/show', source:{reference:`src:${declared.body.sha256}/text@1/l/1`, quote:'另一份合成回显'}, feeding:foreign}}]}}]}, {...call, traceId:'c'.repeat(32)});
  assert.equal(refused.result?.contributions?.stored.length ?? 0, 0);
  assert.match(JSON.stringify(refused.errors), /client_captured|上传原件/);
});

test('procedure and pitfall keep the same binding, a contradiction is marked, and withdrawal leaves the bytes', {skip}, async t => {
  const ctx = await world(t);
  const procedure = {schema:'fed-procedure@1', product:ctx.run.product, root:ctx.root, path:'/commands/system/show', source:{system:'upload', bytes:ctx.sha}, goal:'核对合成状态', steps:[{text:'执行合成显示', quote:{reference:`src:${ctx.sha}/text@1/l/1`, text:quote}}]};
  const first = await ctx.service.submitResult(ctx.w.admin, submit(ctx, '/commands/system/show', procedure, '核对合成状态的步骤'), call);
  assert.equal(first.result?.contributions?.stored.length, 1, JSON.stringify(first.errors));
  const left = first.result!.contributions!.stored[0].record;
  const leftView = await ctx.w.knowledge.layers.contributions.readView(left, ctx.w.admin);
  const target = leftView && 'statement' in leftView.contribution && leftView.contribution.feeding?.schema === 'fed-procedure@1' ? leftView.contribution.feeding.object : undefined;
  assert.ok(target);
  const pitfall = {schema:'fed-pitfall@1', product:ctx.run.product, root:ctx.root, path:'/commands/net/ping', source:{system:'upload', bytes:ctx.sha}, phenomenon:'合成显示为空', suggestion:'先核对地址', quote:{reference:`src:${ctx.sha}/text@1/l/1`, text:quote}, relations:[{kind:'contradicts', object:target, quote:{reference:`src:${ctx.sha}/text@1/l/1`, text:quote}}]};
  const secondRun = await ctx.service.startRun(ctx.w.admin, {pack:'knowledge-contribution', product:'Acme', build:ctx.build.name, inputs:{subject:{reference:ctx.run.sources.find(source => source.slot==='subject')!.reference}, originals:ctx.run.sources.filter(source => source.slot==='originals').map(source => ({reference:source.reference}))}}, {...call, traceId:'d'.repeat(32)});
  assert.equal(secondRun.call_result, 'ok', JSON.stringify(secondRun.errors));
  const other = {...ctx, run:RunRecord.parse((await ctx.service.getRun(ctx.w.admin, secondRun.run!.run))!.run)};
  const second = await ctx.service.submitResult(ctx.w.admin, {...submit(other, '/commands/net/ping', pitfall, '合成显示为空时先核对地址'), run:other.run.run}, {...call, traceId:'e'.repeat(32)});
  assert.equal(second.result?.contributions?.stored.length, 1, JSON.stringify(second.errors));
  const page = await ctx.w.knowledge.getNodes({root:ctx.root, paths:['/commands/net/ping'], depth:0}, ctx.w.admin);
  const text = toolText('get_nodes', {call_result:'ok', errors:[], trace:call.traceId, root:ctx.root, nodes:page!.nodes});
  assert.match(text, /条目 教训/);
  assert.match(text, /矛盾已标记，两边都留，不裁决/);
  assert.doesNotMatch(text, /裁决为/);
  const show = await ctx.w.knowledge.getNodes({root:ctx.root, paths:['/commands/system/show'], depth:0}, ctx.w.admin);
  assert.match(toolText('get_nodes', {call_result:'ok', errors:[], trace:call.traceId, root:ctx.root, nodes:show!.nodes}), /条目 步骤/);
  const stored = await ctx.w.kit.store.get(left);
  const feedingRecord = (stored!.body as {feeding_record?:string}).feeding_record!;
  await ctx.w.knowledge.feeding!.retract(ctx.w.admin, {schema:'retraction@1', entries:[feedingRecord], by:ctx.w.admin.id, at:new Date().toISOString(), reason:'合成撤回'});
  const after = await ctx.w.knowledge.layers.contributions.readView(left, ctx.w.admin);
  assert.equal(after?.status, 'grounds_withdrawn');
  assert.ok(await ctx.w.kit.store.get(left));
});

function evidenceClaims(value: unknown, out: Array<{nature: string; grounds: unknown}> = []): Array<{nature: string; grounds: unknown}> {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) { for (const item of value) evidenceClaims(item, out); return out; }
  const row = value as {qualifier?: {nature?: string}; grounds?: unknown};
  if (typeof row.qualifier?.nature === 'string' && (row.qualifier.nature === 'fact' || row.qualifier.nature === 'judgment')) out.push({nature: row.qualifier.nature, grounds: row.grounds});
  for (const item of Object.values(value as Record<string, unknown>)) evidenceClaims(item, out);
  return out;
}

test('retracting a pitfall contribution marks only that entry and leaves the tree bytes', {skip}, async t => {
  const ctx = await world(t);
  const observedFeeding = observation(ctx, '/commands/system/show');
  const observed = await ctx.service.submitResult(ctx.w.admin, submit(ctx, '/commands/system/show', observedFeeding), call);
  assert.equal(observed.result?.contributions?.stored.length, 1, JSON.stringify(observed.errors));
  const observationRecord = observed.result!.contributions!.stored[0].record;
  const observedView = await ctx.w.knowledge.layers.contributions.readView(observationRecord, ctx.w.admin);
  const target = observedView && 'statement' in observedView.contribution && observedView.contribution.feeding?.schema === 'fed-observation@1' ? observedView.contribution.feeding.object : undefined;
  assert.ok(target);
  const pitfall = {schema:'fed-pitfall@1', product:ctx.run.product, root:ctx.root, path:'/commands/net/ping', source:{system:'upload', bytes:ctx.sha}, phenomenon:'合成显示为空', suggestion:'先核对地址', quote:{reference:`src:${ctx.sha}/text@1/l/1`, text:quote}, relations:[{kind:'contradicts', object:target, quote:{reference:`src:${ctx.sha}/text@1/l/1`, text:quote}}]};
  const secondRun = await ctx.service.startRun(ctx.w.admin, {pack:'knowledge-contribution', product:'Acme', build:ctx.build.name, inputs:{subject:{reference:ctx.run.sources.find(source => source.slot==='subject')!.reference}, originals:ctx.run.sources.filter(source => source.slot==='originals').map(source => ({reference:source.reference}))}}, {...call, traceId:'f'.repeat(32)});
  assert.equal(secondRun.call_result, 'ok', JSON.stringify(secondRun.errors));
  const other = {...ctx, run:RunRecord.parse((await ctx.service.getRun(ctx.w.admin, secondRun.run!.run))!.run)};
  const submitted = await ctx.service.submitResult(ctx.w.admin, {...submit(other, '/commands/net/ping', pitfall, '合成显示为空时先核对地址'), run:other.run.run}, {...call, traceId:'1'.repeat(32)});
  assert.equal(submitted.result?.contributions?.stored.length, 1, JSON.stringify(submitted.errors));
  const record = submitted.result!.contributions!.stored[0].record;
  const beforeRecord = await ctx.w.kit.store.get(record);
  const before = await ctx.w.knowledge.getNodes({root:ctx.root, paths:['/commands/net/ping', '/commands/system/show'], depth:0}, ctx.w.admin);
  const report = await knowledgeRetract(ctx.w.knowledge.feeding!, ctx.w.admin, {entries:[record], runs:[], objects:[], reason:'合成撤回教训', at:'2026-10-27T09:00:00.000Z'});
  assert.equal(report.appended.length, 1);
  assert.equal(formatKnowledgeRetract(report).at(-1), '原记录未改动；读侧将显示根据已撤回');
  const withdrawn = await ctx.w.knowledge.layers.contributions.readView(record, ctx.w.admin);
  assert.equal(withdrawn?.status, 'grounds_withdrawn');
  assert.match(withdrawn?.note ?? '', /失效|撤回/);
  assert.equal((await ctx.w.knowledge.layers.contributions.readView(observationRecord, ctx.w.admin))?.status, 'valid');
  assert.deepEqual(await ctx.w.kit.store.get(record), beforeRecord);
  const after = await ctx.w.knowledge.getNodes({root:ctx.root, paths:['/commands/net/ping', '/commands/system/show'], depth:0}, ctx.w.admin);
  assert.deepEqual(after?.nodes.map(node => node.entries), before?.nodes.map(node => node.entries));
  const page = await ctx.w.knowledge.getNodes({root:ctx.root, paths:['/commands/net/ping'], depth:0}, ctx.w.admin);
  assert.match(toolText('get_nodes', {call_result:'ok', errors:[], trace:call.traceId, root:ctx.root, nodes:page!.nodes}), /失效|撤回/);
  const repeat = await knowledgeRetract(ctx.w.knowledge.feeding!, ctx.w.admin, {entries:[record], runs:[], objects:[], reason:'合成撤回教训', at:'2026-10-27T09:00:00.000Z'});
  assert.deepEqual(repeat.appended, []);
  assert.match(formatKnowledgeRetract(repeat)[0], /这些目标已撤回（撤回记录 [0-9a-f]{12}），没有追加/);
});

test('a declaration-grade operation record is refused as the ground of another submission', {skip}, async t => {
  const ctx = await world(t);
  const answer = await ctx.service.submitResult(ctx.w.admin, submit(ctx, '/commands/system/show', observation(ctx, '/commands/system/show')), call);
  assert.equal(answer.result?.contributions?.stored.length, 1, JSON.stringify(answer.errors));
  const digest = answer.result!.contributions!.stored[0].record;
  assert.ok(ctx.run.product);
  const rows = await ctx.w.knowledge.feeding!.entries(ctx.w.admin, ctx.run.product);
  const operation = rows.filter(row => row.body.schema === 'fed-observation@1');
  assert.ok(operation.length >= 1);
  assert.ok(operation.every(row => row.claim.qualifier.nature === 'unknown' && row.claim.qualifier.provenance === 'client_captured' && row.claim.qualifier.basis_rank === undefined));
  assert.ok(!rows.some(row => (row.claim.qualifier.nature === 'fact' || row.claim.qualifier.nature === 'judgment') && (row.body.schema === 'fed-observation@1' || row.body.schema === 'fed-procedure@1' || row.body.schema === 'fed-pitfall@1')));
  assert.ok(!evidenceClaims(answer.result).some(row => JSON.stringify(row.grounds ?? '').includes(digest)));
  const ordinary = await ctx.service.submitResult(ctx.w.admin, {run:ctx.run.run, model:'integration-synthetic@1', items:[{item:'assertion', handling:'handled', slots:{contribution:[{code:'assertion', text:'把上传原件当根据', data:{root:ctx.root, path:'/commands/system/show', source:{reference:`src:${ctx.sha}/text@1/l/1`, quote}}}]}}]}, {...call, traceId:'f'.repeat(32)});
  assert.equal(ordinary.result?.contributions?.stored.length ?? 0, 0);
  assert.match(JSON.stringify(ordinary.errors), /决定 73/);
  assert.match(JSON.stringify(ordinary.errors), /客户端捕获的原件只随操作记录/);
  const bound = await ctx.service.startRun(ctx.w.admin, {pack:'knowledge-contribution', product:'Acme', build:ctx.build.name, inputs:{subject:{reference:ctx.run.sources.find(source => source.slot==='subject')!.reference}, originals:[...ctx.run.sources.filter(source => source.slot==='originals').map(source => ({reference:source.reference})), {reference:`rec:${digest}`}]}}, {...call, traceId:'6'.repeat(32)});
  assert.equal(bound.call_result, 'ok', JSON.stringify(bound.errors));
  const cited = await ctx.service.submitResult(ctx.w.admin, {run:bound.run!.run, model:'integration-synthetic@1', items:[{item:'assertion', handling:'handled', slots:{contribution:[{code:'assertion', text:'把操作记录当根据', data:{root:ctx.root, path:'/commands/system/show', source:{reference:`rec:${digest}`, quote:'执行了合成显示'}}}]}}]}, {...call, traceId:'7'.repeat(32)});
  assert.equal(cited.result?.contributions?.stored.length ?? 0, 0);
  assert.match(JSON.stringify(cited.errors), /core\.contribution\.record_not_original/);
  assert.match(JSON.stringify(cited.errors), /决定 73/);
});

test('a product reader who can read the original sees the operation record on the command node', {skip}, async t => {
  const ctx = await world(t);
  const hidden = await ctx.service.submitResult(ctx.w.admin, submit(ctx, '/commands/system/show', observation(ctx, '/commands/system/show')), call);
  const hiddenDigest = hidden.result!.contributions!.stored[0].record;
  const hiddenPage = await ctx.w.knowledge.getNodes({root:ctx.root, paths:['/commands/system/show'], depth:0}, ctx.w.user);
  assert.ok(hiddenPage);
  assert.equal((hiddenPage.nodes[0].contributions ?? []).some(row => row.record === hiddenDigest), false);
  const sharedEcho = '读者可见的合成回显：状态正常\n';
  const sharedQuote = '读者可见的合成回显';
  const shared = await ctx.w.kit.artifacts.ingest({bytes:new TextEncoder().encode(sharedEcho), mediaType:'text/plain', origin:{upload:{session:'operation-session', message:null}}, author:{user:ctx.w.admin.id}, provenanceType:'client_captured', visibility:{readers:[ctx.w.admin.id, ctx.w.user.id], admins:true, packs:[], shareable:false}});
  const tree = ctx.run.sources.find(source => source.slot==='originals' && source.reference !== `src:${ctx.sha}`)!.reference;
  const started = await ctx.service.startRun(ctx.w.admin, {pack:'knowledge-contribution', product:'Acme', build:ctx.build.name, inputs:{subject:{reference:ctx.run.sources.find(source => source.slot==='subject')!.reference}, originals:[{reference:tree}, {reference:`src:${shared.body.sha256}`}]}}, {...call, traceId:'8'.repeat(32)});
  assert.equal(started.call_result, 'ok', JSON.stringify(started.errors));
  const run = RunRecord.parse((await ctx.service.getRun(ctx.w.admin, started.run!.run))!.run);
  const reader = {...ctx, run, sha: shared.body.sha256};
  const seen = observation(reader, '/commands/net/ping', '执行读者可见的显示');
  (seen.result as {text:string}).text = sharedQuote;
  const first = await ctx.service.submitResult(ctx.w.admin, submit(reader, '/commands/net/ping', seen, '执行了读者可见的显示'), {...call, traceId:'9'.repeat(32)});
  assert.equal(first.result?.contributions?.stored.length, 1, JSON.stringify(first.errors));
  const left = first.result!.contributions!.stored[0].record;
  const seenView = await ctx.w.knowledge.layers.contributions.readView(left, ctx.w.admin);
  const target = seenView && 'statement' in seenView.contribution && seenView.contribution.feeding?.schema === 'fed-observation@1' ? seenView.contribution.feeding.object : undefined;
  assert.ok(target);
  const pitfall = {schema:'fed-pitfall@1', product:run.product, root:ctx.root, path:'/commands/net/ping', source:{system:'upload', bytes:shared.body.sha256}, phenomenon:'读者可见的显示为空', suggestion:'先核对地址', quote:{reference:`src:${shared.body.sha256}/text@1/l/1`, text:sharedQuote}, relations:[{kind:'contradicts', object:target, quote:{reference:`src:${shared.body.sha256}/text@1/l/1`, text:sharedQuote}}]};
  const second = await ctx.service.submitResult(ctx.w.admin, {...submit(reader, '/commands/net/ping', pitfall, '读者可见的显示为空时先核对地址'), run:run.run}, {...call, traceId:'a1'.padEnd(32, 'a')});
  assert.equal(second.result?.contributions?.stored.length, 1, JSON.stringify(second.errors));
  const page = await ctx.w.knowledge.getNodes({root:ctx.root, paths:['/commands/net/ping'], depth:0}, ctx.w.user);
  const views = page!.nodes[0].contributions!.map(row => KnowledgeContributionView.parse(row));
  const visible = views.find(row => row.record === left)!;
  assert.ok('statement' in visible.contribution);
  assert.equal(visible.contribution.source.provenance, 'client_captured');
  assert.equal(visible.contribution.submitted_by, ctx.w.admin.id);
  assert.equal(visible.contribution.session, 'operation-session');
  const text = toolText('get_nodes', {call_result:'ok', errors:[], trace:call.traceId, root:ctx.root, nodes:page!.nodes});
  assert.match(text, /客户端捕获/);
  assert.match(text, new RegExp(ctx.w.admin.id));
  assert.match(text, /会话 operation-session/);
  assert.match(text, /矛盾已标记，两边都留，不裁决/);
  assert.equal(await ctx.w.knowledge.getNodes({root:ctx.root, paths:['/commands/net/ping'], depth:0}, ctx.w.outsider), null);
});

test('a repeated byte output keeps the exact capture record bound by its run', {skip}, async t => {
  const ctx = await world(t);
  const first = ctx.run.sources.find(source => source.slot === 'originals' && source.reference === `src:${ctx.sha}`)!.artifact;
  const second = await ctx.w.kit.artifacts.ingest({bytes:new TextEncoder().encode(echo), mediaType:'text/plain', origin:{upload:{session:'operation-session-two',message:null}}, author:{user:ctx.w.admin.id}, provenanceType:'client_captured', visibility:{readers:[ctx.w.admin.id],admins:true,packs:[],shareable:false}, name:'second-capture.txt', capturedAt:'2026-10-27T08:00:00.000Z'});
  assert.notEqual(second.digest, first);
  const tree = ctx.run.sources.find(source => source.slot === 'originals' && source.reference !== `src:${ctx.sha}`)!.reference;
  const started = await ctx.service.startRun(ctx.w.admin, {pack:'knowledge-contribution',product:ctx.run.product,build:ctx.build.name,inputs:{subject:{reference:ctx.run.sources.find(source => source.slot==='subject')!.reference},originals:[{reference:tree},{reference:`src:${second.body.sha256}`}]}}, {...call,traceId:'a2'.repeat(16)});
  assert.equal(started.call_result,'ok',JSON.stringify(started.errors));
  const run = RunRecord.parse((await ctx.service.getRun(ctx.w.admin,started.run!.run))!.run);
  const local = {...ctx,run,sha:second.body.sha256};
  const feeding = observation(local,'/commands/system/show','执行第二次合成显示');
  const answer = await ctx.service.submitResult(ctx.w.admin,submit(local,'/commands/system/show',feeding,'第二次合成显示'),{...call,traceId:'a3'.repeat(16)});
  assert.equal(answer.result?.contributions?.stored.length,1,JSON.stringify(answer.errors));
  const digest = answer.result!.contributions!.stored[0].record;
  const page = await ctx.w.knowledge.getNodes({root:ctx.root,paths:['/commands/system/show'],depth:0},ctx.w.admin);
  const view = page!.nodes[0].contributions!.map(row => KnowledgeContributionView.parse(row)).find(row => row.record===digest)!;
  assert.ok('statement' in view.contribution);
  assert.equal(view.contribution.source.records[0],second.digest);
  const storedFeeding = view.contribution.feeding;
  assert.ok(storedFeeding && (storedFeeding.schema === 'fed-observation@1' || storedFeeding.schema === 'fed-procedure@1' || storedFeeding.schema === 'fed-pitfall@1'));
  assert.equal(storedFeeding.at,second.body.captured_at);
  assert.ok(run.sources.some(source => source.artifact===second.digest));
});

test('a contribution with an operation record is stored on a pool of one connection (issue #104)', {skip}, async t => {
  const ctx = await world(t);
  // The same Hub on one connection: the submission's save transaction holds it, so nothing after its locks may read through
  // the pool, or it waits for the pool's ten-second timeout.
  const narrow = await openRecords({dataDir:ctx.w.kit.dataDir, logDir:join(ctx.w.kit.dataDir, 'one-connection-logs'), database:ctx.w.kit.database, limits:DEFAULT_LIMITS}, {keyProvider:ctx.w.kit.keyProvider, maxConnections:1});
  t.after(() => narrow.close());
  const knowledge = createKnowledge({records:narrow, parsers:createDefaultRegistry(), packs:ctx.w.packs, external:ctx.w.external, jev:null, sandbox:{requireOsIsolation:await sandboxIsolation()}, admin:ctx.w.admin});
  const workflows = new FakeWorkflowStore();
  await workflows.add(fileURLToPath(new URL('../../packs/workflow/knowledge-contribution/', import.meta.url)));
  const service = createRunsService({records:narrow, packs:ctx.w.packs, knowledge, external:ctx.w.external, workflows, parsers:createDefaultRegistry()});
  const started = Date.now();
  const answer = await service.submitResult(ctx.w.admin, submit(ctx, '/commands/system/show', observation(ctx, '/commands/system/show')), call);
  assert.equal(answer.result?.contributions?.stored.length, 1, JSON.stringify(answer.errors));
  assert.ok(Date.now() - started < 30_000, 'no wait for a second connection');
});
