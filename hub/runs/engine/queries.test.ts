import {isReason,labelOf} from '../../../contracts/generated/vocabulary.ts';
import assert from 'node:assert/strict';
import {CORE_VIOLATION_CODES,PROTOCOL_CODES} from '../../../contracts/generated/protocol.ts';
import { after, before, test } from 'node:test';
import type { RunSummary } from '../../../contracts/src/run.ts';
import { ResolveReferenceOutput } from '../../../contracts/src/tools.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openHarness, sandboxSkip, type Harness } from './testing/harness.ts';
import { ROOTS } from './testing/knowledge.ts';
import { ITEM, standardDocument, toyMap } from './testing/mindmap.ts';
import { receivedDigest } from './util.ts';

let postgres: TemporaryPostgres;
let h: Harness;
let map: string;
let run: RunSummary;
let accepted: Record<string, unknown>;
const skip = await sandboxSkip();

const IDS = [ITEM.c1, ITEM.c2, ITEM.c3, ITEM.c4];

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  h = await openHarness(postgres);
  map = await h.upload(h.alice, toyMap(standardDocument()));
  run = (await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } } }, h.call())).run!;
  await h.service.submitResult(h.alice, { run: run.run, model: 'model-a', items: [] }, h.call());
  accepted = {
    run: run.run,
    model: 'model-a',
    items: IDS.map((id) => ({ item: id, handling: 'handled', slots: { findings: [] } })),
    cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }],
  };
  await h.service.submitResult(h.alice, accepted, h.call());
});
after(async () => {
  await h?.close();
  await postgres?.stop();
});

test('getRun: the run, every submission with its receipt, the latest result; absent and forbidden are null', { skip }, async () => {
  const detail = (await h.service.getRun(h.alice, run.run))!;
  assert.equal(detail.run.run, run.run);
  assert.equal(detail.run.runner, h.alice.id);
  assert.equal(detail.submissions.length, 2);
  const [refused, ok] = detail.submissions;
  assert.equal(refused.acceptance, 'not_accepted');
  assert.ok(refused.errors.some((e) => e.code === 'SUBMISSION_SCHEMA_VIOLATION'));
  assert.equal(refused.result, null);
  assert.equal(ok.acceptance, 'accepted');
  assert.equal(ok.result, detail.latest!.record);
  assert.equal(detail.latest!.result.submission, receivedDigest(accepted).digest);
  assert.ok(Date.parse(ok.received_at) > Date.parse(refused.received_at));
  assert.equal(await h.service.getRun(h.bob, run.run), null);
  assert.equal(await h.service.getRun(h.alice, 'run_01m5h9zh07x7amhg4bwmye5yhw'), null);
  assert.equal(await h.service.getRun(h.alice, 'not a run id'), null);
  assert.ok(await h.service.getRun(h.admin, run.run));
});

test('getResult by submission digest or the latest; runs of a user, of a pack, and of the whole Hub for admins', { skip }, async () => {
  const latest = (await h.service.getResult(h.alice, run.run))!;
  const bySubmission = (await h.service.getResult(h.alice, run.run, receivedDigest(accepted).digest))!;
  assert.deepEqual(latest, bySubmission);
  assert.equal(await h.service.getResult(h.bob, run.run), null);
  assert.equal(await h.service.getResult(h.alice, run.run, 'f'.repeat(64)), null);
  const second = (await h.service.startRun(h.alice, { pack: 'toy-locate', inputs: { map: { reference: map } } }, h.call())).run!;
  const mine = await h.service.listRuns(h.alice);
  assert.deepEqual(mine.items.map((r) => r.run).slice(0, 2), [second.run, run.run]);
  assert.deepEqual((await h.service.listRuns(h.alice, { pack: 'toy-locate' })).items.map((r) => r.run), [second.run]);
  assert.deepEqual((await h.service.runsFor(h.alice, 'toy-review')).items.map((r) => r.run), [run.run]);
  assert.deepEqual((await h.service.listRuns(h.bob)).items, []);
  assert.deepEqual((await h.service.runsFor(h.bob, 'toy-review')).items, []);
  const all = await h.service.listRuns(h.admin);
  assert.ok(all.items.some((r) => r.run === run.run) && all.items.some((r) => r.run === second.run));
  const page = await h.service.listRuns(h.alice, { limit: 1 });
  assert.equal(page.items.length, 1);
  assert.ok(page.next);
  const rest = await h.service.listRuns(h.alice, { limit: 1, cursor: page.next });
  assert.equal(rest.items[0].run, run.run);
  assert.deepEqual(await h.service.listRuns(h.alice, { cursor: 'not-a-cursor' }), { items: [], next: null });
});

test('resolve_reference previews quotations, commands and references against the run; it writes nothing', { skip }, async () => {
  const records = async () => (await h.kit.store.list({ kind: 'action', limit: 500 })).items.length + (await h.kit.store.list({ kind: 'validation_result', limit: 500 })).items.length;
  const before = await records();
  const preview = async (text: string, expect?: string) => {
    const answer = await h.service.resolveReference(h.alice, { run: run.run, text, ...(expect !== undefined ? { expect } : {}) }, h.call());
    const checked = ResolveReferenceOutput.safeParse({ ...answer, trace: '0af7651916cd43dd8448eb211c80319c' });
    assert.ok(checked.success, JSON.stringify(answer));
    return answer;
  };
  const quote = await preview('设置 3 区浇灌 15 分钟', 'quotation');
  assert.equal(quote.resolution, 'resolved');
  assert.equal(quote.references[0].role, 'subject');
  assert.ok(quote.references[0].reference.startsWith(`${map}/kityminder@1/n/c1aaaaaaaaaa:0-`));
  assert.ok(quote.diagnostics[0].includes('预览'));
  const twice = await preview('15 分钟', 'quotation');
  assert.equal(twice.resolution, 'ambiguous');
  assert.ok(twice.references.length >= 2);
  const manual = await preview('zone 取 1 到 8');
  assert.deepEqual([manual.resolution, manual.references[0].role], ['resolved', 'expected']);
  const command = await preview('zone set', 'command');
  assert.deepEqual([command.resolution, command.references[0].reference], ['resolved', `tree:${ROOTS.meadow329}/zone/set`]);
  const menu = await preview('schedule', 'command');
  assert.equal(menu.resolution, 'ambiguous');
  assert.ok(menu.diagnostics.some((d) => d.includes('schedule add')));
  assert.equal((await preview('zone delete', 'command')).resolution, 'unresolved');
  const asReference = await preview(run.items[1].location);
  assert.deepEqual([asReference.resolution, asReference.references[0].text], ['resolved', '查看分区状态']);
  const outside = await preview(`rec:${'f'.repeat(64)}`);
  assert.equal(outside.resolution, 'unresolved');
  const nowhere = await preview('这句话哪里都没有', 'quotation');
  assert.deepEqual([nowhere.resolution, nowhere.references], ['unresolved', []]);
  assert.equal(await records(), before);
});

test('resolve_reference on a run the caller may not see gives the same empty shape', { skip }, async () => {
  const forbidden = await h.service.resolveReference(h.bob, { run: run.run, text: '设置' }, h.call());
  const absent = await h.service.resolveReference(h.alice, { run: 'run_01m5h9zh07x7amhg4bwmye5yhw', text: '设置' }, h.call());
  assert.deepEqual(forbidden, absent);
  assert.deepEqual(forbidden, { call_result: 'error', errors: [{ code: 'SOURCE_UNAVAILABLE', message: '对你不可用', fix: PROTOCOL_CODES.SOURCE_UNAVAILABLE.fix, path: '/run' }], references: [], diagnostics: [] });
  assert.ok(ResolveReferenceOutput.safeParse({ ...forbidden, trace: '0af7651916cd43dd8448eb211c80319c' }).success);
});

test('resolve_reference on a run with large bound sources (>65536 candidates) does not blow call stack', { skip }, async () => {
  const largeDoc = Array.from({ length: 40_000 }, (_, i) => `# 标题${i}\n\n段落${i}\n`).join('\n');
  const notesRef = await h.upload(h.alice, Buffer.from(largeDoc, 'utf8'), 'text/markdown');
  const runWithLarge = (await h.service.startRun(h.alice, {
    pack: 'toy-review',
    product: 'Meadow',
    version: '3.2',
    inputs: { map: { reference: map }, notes: [{ reference: notesRef }] },
  }, h.call())).run!;
  const answer = await h.service.resolveReference(h.alice, { run: runWithLarge.run, text: '段落39999', expect: 'quotation' }, h.call());
  assert.equal(answer.call_result, 'ok');
  assert.equal(answer.resolution, 'resolved');
});

test('sharing grants read queries and preview but never submission or predecessor rights', { skip }, async t => {
  const { recordReader, identityOf } = await import('./readers.ts');
  const { runById } = await import('./store.ts');
  const a = h.kit.authorizations;
  const stored = (await runById(h.kit.store, run.run))!;
  await a.share(h.admin, run.run, {kind:'pack_users',pack:'toy-review'});
  assert.equal(await h.service.getRun(h.bob, run.run), null);
  await a.assign(h.admin,h.bob.id,'toy-review');
  const view = await h.service.getRun(h.bob,run.run); assert.ok(view);
  assert.deepEqual(view.run,stored.body);
  assert.ok(await h.service.getResult(h.bob,run.run));
  assert.ok((await h.service.listRuns(h.bob,{limit:1})).items.some(row=>row.run===run.run));
  const records = recordReader(h.kit.store);
  assert.ok(await records.read(stored.digest,identityOf(h.bob)));
  assert.ok(await records.read(view.latest!.record,identityOf(h.bob)));
  assert.ok(await records.read(view.submissions.find(s=>s.acceptance==='accepted')!.record,identityOf(h.bob)));
  const preview = await h.service.resolveReference(h.bob,{run:run.run,text:'rec:'+stored.digest,expect:'reference'},h.call());
  assert.equal(preview.call_result,'ok');
  t.mock.method(h.packs,'readableProducts',async()=>new Set<string>());
  const noTree = await h.service.resolveReference(h.bob,{run:run.run,text:'zone set 2 5',expect:'command'},h.call());
  assert.equal(noTree.call_result,'ok'); assert.equal(noTree.resolution,'unresolved'); assert.deepEqual(noTree.references,[]);
  const submission = await h.service.submitResult(h.bob,{...accepted,run:run.run},h.call());
  assert.equal(submission.acceptance,'not_accepted'); assert.equal(submission.errors[0].code,'SOURCE_UNAVAILABLE');
  h.workflows.assign(h.bob.id,'toy-review');
  const next = await h.service.startRun(h.bob,{pack:'toy-review',predecessor:run.run,inputs:{map:{reference:map}}},h.call());
  assert.equal(next.call_result,'error'); assert.equal(next.errors[0].code,'SOURCE_UNAVAILABLE'); assert.equal(next.errors[0].path,'/predecessor');
  await a.unshare(h.admin,run.run,{kind:'pack_users',pack:'toy-review'});
  assert.equal(await h.service.getRun(h.bob,run.run),null);
  assert.equal(await records.read(stored.digest,identityOf(h.bob)),null);
  assert.equal((await h.service.resolveReference(h.bob,{run:run.run,text:'rec:'+stored.digest},h.call())).call_result,'error');
});

test('production policy covers current future and Hub runs but not judgment runs and pages visible rows only', { skip }, async () => {
  const { productionShareKey } = await import('../../records/api.ts');
  const a = h.kit.authorizations;
  const first = (await h.service.startRun(h.alice,{pack:'toy-locate',inputs:{map:{reference:map}},client_key:'synthetic-shared-key'},h.call())).run!;
  await a.share(h.admin,productionShareKey('toy-locate'),{kind:'pack_users',pack:'toy-locate'});
  assert.equal(await h.service.getRun(h.bob,first.run),null);
  await a.assign(h.admin,h.bob.id,'toy-locate'); h.workflows.assign(h.bob.id,'toy-locate');
  assert.ok(await h.service.getRun(h.bob,first.run));
  const future = (await h.service.startHubRun(h.admin,{pack:'toy-locate',inputs:{map:{reference:map}}},h.call())).answer.run!;
  assert.ok(await h.service.getRun(h.bob,future.run));
  assert.equal(await h.service.getRun(h.bob,run.run),null);
  const collected: string[] = []; let cursor: string|null = null;
  do { const page = await h.service.runsFor(h.bob,'toy-locate',{limit:1,cursor}); collected.push(...page.items.map(r=>r.run)); cursor=page.next; } while(cursor);
  assert.deepEqual(collected,(await h.service.runsFor(h.admin,'toy-locate')).items.map(r=>r.run)); assert.equal(new Set(collected).size,collected.length);
  await a.share(h.admin,productionShareKey('toy-review'),{kind:'pack_users',pack:'toy-review'});
  assert.equal(await h.service.getRun(h.bob,run.run),null);
  const ownMap = await h.upload(h.bob,toyMap(standardDocument()));
  const own = (await h.service.startRun(h.bob,{pack:'toy-locate',inputs:{map:{reference:ownMap}},client_key:'synthetic-shared-key'},h.call())).run!;
  assert.notEqual(own.run,first.run);
  await a.unassign(h.admin,h.bob.id,'toy-locate');
  assert.equal(await h.service.getRun(h.bob,first.run),null); assert.equal(await h.service.getRun(h.bob,future.run),null);
  await a.assign(h.admin,h.bob.id,'toy-locate'); await a.unshare(h.admin,productionShareKey('toy-locate'),{kind:'pack_users',pack:'toy-locate'});
  assert.equal(await h.service.getRun(h.bob,first.run),null); assert.ok(await h.service.getRun(h.bob,own.run));
});

test('shared pagination sorts frozen start times rather than append order and has stable ties', {skip}, async()=>{
  const {RunRecord}=await import('../../../contracts/src/run.ts');
  const {newId}=await import('../../records/api.ts');
  const fresh=(await h.service.startRun(h.alice,{pack:'toy-locate',inputs:{map:{reference:map}}},h.call())).run!;
  const base=(await h.service.getRun(h.alice,fresh.run))!.run;
  const rows:string[]=[];
  for(const started_at of ['2026-10-20T00:00:00.000Z','2026-10-19T00:00:00.000Z','2026-10-20T00:00:00.000Z']){
    const run=newId('run');rows.push(run);
    const body=RunRecord.parse({...base,run,started_at});
    await h.kit.store.put({kind:'run',schema:'run@1',provenance:'observed',body,index:[{key:'runs.id',value:run},{key:'runs.pack',value:'toy-locate'}]});
    await h.kit.authorizations.share(h.admin,run,[h.bob.id]);
  }
  let cursor:string|null=null;const all:string[]=[];
  do{const page=await h.service.runsFor(h.bob,'toy-locate',{limit:2,cursor});assert.ok(page.items.length>0);all.push(...page.items.map(r=>r.run));cursor=page.next;}while(cursor);
  assert.equal(new Set(all).size,all.length);
  assert.deepEqual(all.filter(id=>rows.includes(id)),[rows[2],rows[0],rows[1]]);
});

test('shared run details never include rejected validation bodies while owner and admin retain them', {skip}, async()=>{
  const rejected=await h.service.submitResult(h.alice,{run:run.run,model:'synthetic-review',items:[{item:'synthetic-private-item',handling:'handled',slots:{}}]},h.call());
  assert.equal(rejected.acceptance,'not_accepted');
  const original=(await h.service.getRun(h.alice,run.run))!;
  const receipt=original.submissions.at(-1)!;
  assert.ok(receipt.errors.some(error=>error.message.includes('synthetic-private-item')));
  assert.ok(receipt.errors.some(error=>error.path!==undefined));
  assert.ok(receipt.errors.some(error=>error.requirement!==undefined));
  await h.kit.authorizations.share(h.admin,run.run,[h.bob.id]);
  const shared=(await h.service.getRun(h.bob,run.run))!;
  const visible=shared.submissions.find(row=>row.record===receipt.record)!;
  assert.equal(visible.acceptance,'not_accepted');assert.equal(visible.result,null);
  assert.ok(visible.errors.length>0);
  for(const error of visible.errors){
    assert.deepEqual(Object.keys(error).sort(),['code','message']);
    assert.equal(error.message,Object.hasOwn(PROTOCOL_CODES,error.code)?PROTOCOL_CODES[error.code as keyof typeof PROTOCOL_CODES].when:Object.hasOwn(CORE_VIOLATION_CODES,error.code)?CORE_VIOLATION_CODES[error.code as keyof typeof CORE_VIOLATION_CODES].when:isReason(error.code)?labelOf('reason',error.code):'');
  }
  assert.ok(!JSON.stringify(visible.errors).includes('synthetic-private-item'));
  assert.deepEqual((await h.service.getRun(h.alice,run.run))!.submissions.find(row=>row.record===receipt.record)!.errors,receipt.errors);
  assert.deepEqual((await h.service.getRun(h.admin,run.run))!.submissions.find(row=>row.record===receipt.record)!.errors,receipt.errors);
  assert.deepEqual(shared.run,original.run);
  await h.kit.authorizations.unshare(h.admin,run.run,h.bob.id);
  assert.equal(await h.service.getRun(h.bob,run.run),null);
});
