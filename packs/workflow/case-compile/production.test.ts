import {readAddress} from './functions/bed.ts';
import {bedsOf} from './functions/test-support.ts';
import { createHash } from 'node:crypto';
import { satisfiedRecipe } from './tools/generate-workbook.ts';
import { generateWorkbook, GENERATOR } from './functions/generate.ts';
// Real run engine and temporary PostgreSQL; every contract, profile, document, device and model is synthetic.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { join } from 'node:path';
import { StartRunOutput, SubmitResultOutput } from '../../../contracts/src/tools.ts';
import { ValidationResult } from '../../../contracts/src/validation.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { createDefaultRegistry, parserKey, recognize } from '../../../hub/refs/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { temporaryDirectory } from '../../../hub/runs/api.ts';
import { stage as stageBed } from '../test-bed/pack-files.ts';
import { CONTRACT_DOC, PROFILE_DOC, MANIFEST_DOC, AUTOID, COMMAND_IDENTITIES, goodData } from './functions/test-support.ts';
import { checkAddresses } from './functions/checks.ts';
import { planSubject } from './functions/subject.ts';
import { call, openHub, sha, ROOT, type Hub } from './testing/hub.ts';
const skip = (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)';
let postgres: TemporaryPostgres; let hub: Hub;
const map = (duplicate = false) => ({ root: { data: { id: 'doc-1', text: '合成文档' }, children: [
  { data: { id: 'c-1', text: '健康检查间隔配置测试', resource: ['功能'], priority: 2, autoid: AUTOID, auto: '1' }, children: [{ data: { id: 'step', text: 'widget health interval 60' }, children: [{ data: { id: 'expected', text: '健康检查间隔设置成功' } }] }] },
  ...(duplicate ? [{ data: { id: 'c-2', text: '合成重复编号', resource: ['功能'], priority: 2, autoid: AUTOID }, children: [{ data: { text: '健康检查间隔设置成功' } }] }] : []),
] } });
const MINDMAP_JSON = JSON.stringify(map());
function leafReference(): string {
  const parsed = recognize(createDefaultRegistry(), new TextEncoder().encode(MINDMAP_JSON), 'application/json');
  assert.ok(parsed && parserKey(parsed.parser) === 'kityminder@1');
  const node = (parsed.document.model as { nodes: Array<{ text: string; selector: string }> }).nodes.find((n) => n.text === '健康检查间隔设置成功')!;
  return `src:${sha(MINDMAP_JSON)}/kityminder@1/${node.selector}`;
}
const CASE_INDEX='knowledge:index:widget:Fixture_Build_A?kind=case&key=document';
const start = () => ({ pack: 'case-compile', product: 'widget', build: 'Fixture_Build_A', inputs: {case_index:{external:CASE_INDEX}, subject: { external: 'agile:mindmap:doc-1' }, contract: { external: 'doc:doc:fixture-runtime-contract' }, profile: { external: 'doc:doc:fixture-runtime-profile' }, inventory: { external: 'doc:doc:fixture-bed' } }, parameters: { autoid: AUTOID } });
function submission(run: string, mutate?: (data: ReturnType<typeof goodData>) => void) {
  const data = goodData(); data.expects[0].quote.reference = leafReference(); mutate?.(data);
  return { run, model: 'synthetic-model', items: [{ item: 'doc-1:c-1', handling: 'handled' as const, slots: { plan: [{ text: '合成计划槽位', quotes: data.expects.map((v) => v.quote), data }] } }] };
}
before(async () => {
  postgres = await startPostgres(); if (skip) return;
  hub = await openHub(postgres);
  const put = (id: string, value: unknown) => hub.external.put(id, { bytes: new TextEncoder().encode(JSON.stringify(value)), mediaType: 'application/json' });
  put(CASE_INDEX,{schema:'index-view@1',kind:'case',key:'document',product:'widget',build:{root:ROOT,build:'Fixture_Build_A'},keys:{'doc-1':['c'.repeat(64)]},entries:{['c'.repeat(64)]:{entry:'c'.repeat(64),reference:'tree:'+ROOT+'/commands/widget/health/interval@'+'c'.repeat(64),kind:'case',statement:'合成冻结命令身份',data:{document:'doc-1',node:'c-1',command_identities:COMMAND_IDENTITIES,command_tree_root:ROOT}}},total_keys:1,total_entries:1,truncated:false,skipped:0,notes:[]});
  put('agile:mindmap:doc-1', map()); put('agile:mindmap:duplicate', map(true));
  put('doc:doc:fixture-runtime-contract', CONTRACT_DOC); put('doc:doc:fixture-runtime-profile', PROFILE_DOC); put('doc:doc:fixture-bed', MANIFEST_DOC);
});
after(async () => { await hub?.close(); await postgres?.stop(); });
describe('case-compile 2.0 against the real engine', { skip }, () => {
  it('accepts one textual autoid, verifies original identity and stores qualified receipts without generating content', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, start(), call()); assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    assert.ok(StartRunOutput.safeParse({ ...detail.answer, trace: 'a'.repeat(32) }).success);
    const run = detail.answer.run!; assert.deepEqual(run.items.map((v) => v.id), ['doc-1:c-1']);
    assert.deepEqual([run.items[0].fields.autoid, run.items[0].fields.auto, run.items[0].fields.priority], [AUTOID, '1', '2']);
    assert.deepEqual(run.requirements.map((v) => v.key), ['plan', 'contract_methods', 'bed_addresses', 'commands_known', 'expected_grounded', 'workbook_verified']);
    const answer = await hub.service.submitResult(hub.alice, submission(run.run), call());
    assert.ok(SubmitResultOutput.safeParse({ ...answer, trace: 'a'.repeat(32) }).success, JSON.stringify(answer));
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors)); const result = ValidationResult.parse(answer.result);
    const requirements = result.partitions.delivered[0].requirements;
    assert.ok(requirements.filter((v) => v.requirement !== 'workbook_verified').every((v) => v.status === 'satisfied'), JSON.stringify(requirements));
    const pending = requirements.find((v) => v.requirement === 'workbook_verified')!; assert.notEqual(pending.status, 'satisfied'); assert.ok(pending.claims.some((v) => v.statement.verdict === 'unknown' && v.statement.reason === 'missing_input'));
    const claims = requirements.flatMap((v) => v.claims);
    const own = requirements.filter((v) => v.requirement !== 'workbook_verified').flatMap((v) => v.claims).filter((v) => v.warrant.id.startsWith('case-compile.'));
    assert.ok(own.length); for (const claim of own) { assert.equal(claim.statement.verdict, 'support'); assert.match(claim.statement.text, /按合成合约核对/); assert.match(claim.statement.text, /不证明在真实设备上跑得通/); }
    const receipt = own.find((v) => v.statement.data?.contract_sha256 === CONTRACT_DOC.original.contract_sha256)!;
    assert.equal(receipt.statement.data?.runtime_version, CONTRACT_DOC.runtime.minimum_version);
    assert.ok(!JSON.stringify(result).includes('exec-plan@1')); assert.ok(!JSON.stringify(result).includes('"plan_json"'));
  });
  it('resolves complete plan commands for a natural-language case without authored identities', async () => {
    const document = map(); document.root.children[0].children[0].data.text = '开启合成服务，同时添加合成监听';
    const bytes = JSON.stringify(document), external = 'agile:mindmap:synthetic-natural';
    hub.external.put(external, {bytes:new TextEncoder().encode(bytes),mediaType:'application/json'});
    const parsed = recognize(createDefaultRegistry(),new TextEncoder().encode(bytes),'application/json')!;
    const expected = (parsed.document.model as {nodes:Array<{text:string;selector:string}>}).nodes.find(node=>node.text==='健康检查间隔设置成功')!;
    const args=start(); delete (args.inputs as Partial<typeof args.inputs>).case_index; args.inputs.subject.external=external;
    const started=await hub.service.startRunDetailed(hub.alice,args,call());assert.equal(started.answer.call_result,'ok',JSON.stringify(started.answer.errors));
    const run=started.answer.run!, sent=submission(run.run,data=>{delete data.command_identities;data.expects[0].quote.reference=`src:${sha(bytes)}/kityminder@1/${expected.selector}`;});
    sent.items[0].item=run.items[0].id;
    const beforeFull=hub.knowledge.fullCatalogReads,beforeSelected=hub.knowledge.selectedCatalogReads,beforeTree=hub.knowledge.treeReads.length;
    const accepted=await hub.service.submitResult(hub.alice,sent,call());
    assert.equal(hub.knowledge.fullCatalogReads,beforeFull,'submission must not load the complete catalog');
    assert.equal(hub.knowledge.selectedCatalogReads-beforeSelected,1,'all checks share one selected grammar read');
    assert.ok(hub.knowledge.treeReads.length-beforeTree<=1,'only the single selected command can become a tree source');assert.equal(accepted.acceptance,'accepted',JSON.stringify(accepted.errors));
    const requirements=Object.values(accepted.result!.partitions).flat().flatMap(item=>item.requirements);
    for(const key of ['commands_known','contract_methods','bed_addresses','expected_grounded'])assert.equal(requirements.find(row=>row.requirement===key)?.status,'satisfied',JSON.stringify(requirements));
    sent.items[0].slots.plan[0].data.steps[0].args=['widget unknown 60'];
    const rejected=await hub.service.submitResult(hub.alice,sent,call());
    const unknown=Object.values(rejected.result!.partitions).flat().flatMap(item=>item.requirements).find(row=>row.requirement==='commands_known')!;
    assert.notEqual(unknown.status,'satisfied');assert.ok(unknown.claims.some(claim=>claim.statement.verdict==='refute'),JSON.stringify(unknown));
  });
  it('repairs a rejected value within two rounds without changing the frozen original contract', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, start(), call()); const run = detail.answer.run!;
    const first = await hub.service.submitResult(hub.alice, submission(run.run, (v) => { v.steps[0].args = ['=fixture']; }), call());
    const error = first.errors.find((v) => v.code === 'case-compile.method_forbidden'); assert.ok(error, JSON.stringify(first)); assert.equal(error.rounds_left, 2);
    const fixed = await hub.service.submitResult(hub.alice, submission(run.run), call()); assert.equal(fixed.acceptance, 'accepted');
    const stored = (await hub.service.getRun(hub.alice, run.run))!; assert.deepEqual(stored.run.groups?.[0].contract, CONTRACT_DOC);
  });
  it('returns slot-shape repair instructions from the complete published schema', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, start(), call());
    const answer = await hub.service.submitResult(hub.alice, submission(detail.answer.run!.run, (v) => { v.steps[0].args = 'not-an-array' as unknown as string[]; }), call());
    assert.notEqual(answer.acceptance, 'accepted');
    const repairs = answer.errors.map((v) => `${v.path ?? ''} ${v.message} ${v.fix}`).join('\n');
    assert.match(repairs, /args/); assert.match(repairs, /数组|array/);
  });
  it('exhausts exactly two repair rounds and preserves the failed requirement', async () => {
    const detail = await hub.service.startRunDetailed(hub.alice, start(), call()); const run = detail.answer.run!;
    let last;
    for (const value of ['=fixture-one', '=fixture-two', '=fixture-three']) last = await hub.service.submitResult(hub.alice, submission(run.run, (v) => { v.steps[0].args = [value]; }), call());
    const result = ValidationResult.parse(last!.result); assert.equal(result.rounds.used, 2); assert.equal(result.rounds.max, 2); assert.ok(result.partitions.incomplete.some((v) => v.item === 'doc-1:c-1'));
  });
  it('refuses missing or duplicate automation ids before accepting a run', async () => {
    const missing = start(); missing.parameters.autoid = '990000000000000032'; const miss = await hub.service.startRunDetailed(hub.alice, missing, call()); assert.equal(miss.answer.call_result, 'error'); assert.equal(miss.answer.run, undefined);
    const duplicate = start(); duplicate.inputs.subject.external = 'agile:mindmap:duplicate'; const dup = await hub.service.startRunDetailed(hub.alice, duplicate, call()); assert.equal(dup.answer.call_result, 'error'); assert.equal(dup.answer.run, undefined);
  });
  it('inherits addresses actually allocated by test-bed through its reservation predecessor', async () => {
    const temp = await temporaryDirectory('fixture-bed-pack-');
    try {
      const published = await hub.registry.publish(hub.alice, await stageBed(join(temp.path, 'bed'))); assert.equal(published.ok, true, JSON.stringify(published));
      await hub.registry.assign(hub.admin, hub.alice.id, 'test-bed');
      const booking = await hub.service.startRunDetailed(hub.alice, { pack: 'test-bed', inputs: { inventory: { external: 'doc:doc:fixture-bed' } }, parameters: { action: 'acquire', bed: 'bed-a', need: { devices: [{ type: 'load-balancer', count: 2 }, { type: 'router', count: 1 }, { type: 'client', count: 1 }, { type: 'server', count: 1 }, { type: 'console', count: 1 }] }, addresses: { segment: '192.0.2.0/26', count: 1 } } }, call());
      assert.equal(booking.answer.call_result, 'ok', JSON.stringify(booking.answer.errors));
      const compiled = await hub.service.startRunDetailed(hub.alice, { ...start(), predecessor: booking.answer.run!.run }, call()); assert.equal(compiled.answer.call_result, 'ok', JSON.stringify(compiled.answer.errors));
      const stored = (await hub.service.getRun(hub.alice, compiled.answer.run!.run))!;
      const group = stored.run.groups![0]; const leases = (group.leases as { entries: Array<{ key: string; until:string|null;mine?: boolean }> }).entries;
      const allocated = leases.find((v) => v.mine && v.key.startsWith('bed/bed-a/ip/')); assert.ok(allocated, JSON.stringify(group.leases));
      const address = allocated.key.slice('bed/bed-a/ip/'.length); assert.ok(/^192\.0\.2\./.test(address));
      assert.equal(readAddress(bedsOf()[0],leases,'2026-10-23T02:00:00.000Z',address).kind,'allocated');
      const unrelated = await hub.service.startRunDetailed(hub.alice, start(), call()); assert.equal(unrelated.answer.call_result, 'ok');
      const other = (await hub.service.getRun(hub.alice, unrelated.answer.run!.run))!;
      const noLineage=(other.run.groups![0].leases as {entries:typeof leases}).entries;
      assert.equal(readAddress(bedsOf()[0],noLineage,'2026-10-23T02:00:00.000Z',address).kind,'off_bed');
    } finally { await temp.remove(); }
  });
  it('satisfies every requirement through generation and successor verification without source or model command declarations', async () => {
    const args=start();delete (args.inputs as Partial<typeof args.inputs>).case_index;
    const first = await hub.service.startRunDetailed(hub.alice, args, call()); const planRun = first.answer.run!;
    const sent = submission(planRun.run);assert.equal(Object.hasOwn(sent.items[0].slots.plan[0].data,'command_identities'),false);assert.equal(Object.hasOwn(planRun.items[0].fields,'command_identities'),false); const answer = await hub.service.submitResult(hub.alice, sent, call()); assert.equal(answer.acceptance, 'accepted');
    const contract = Buffer.from(JSON.stringify(CONTRACT_DOC)); const profile = Buffer.from(JSON.stringify(PROFILE_DOC)); const inventory = Buffer.from(JSON.stringify(MANIFEST_DOC));
    const recipe = satisfiedRecipe({ run: first.answer, result: answer, submission: sent, contract, profile, inventory });
    const bytes = generateWorkbook(recipe);
    await hub.kit.artifacts.ingest({ bytes, mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', origin: { read: { object: 'fixture:workbook:synthetic' } }, author: { user: null }, provenanceType: 'observed', visibility: { readers: [hub.alice.id], admins: true, packs: [], shareable: false }, name: 'fixture.xlsx' });
    const second = await hub.service.startRunDetailed(hub.alice, { ...args, predecessor: planRun.run, parameters: { ...args.parameters, plan_run: planRun.run }, inputs: { ...args.inputs, workbook: { reference: `src:${createHash('sha256').update(bytes).digest('hex')}` } } }, call());
    assert.equal(second.answer.call_result, 'ok', JSON.stringify(second.answer.errors));
    const verified = await hub.service.submitResult(hub.alice, submission(second.answer.run!.run), call()); assert.equal(verified.acceptance, 'accepted', JSON.stringify(verified.errors));
    const result = ValidationResult.parse(verified.result); const requirements = result.partitions.delivered[0].requirements; assert.ok(requirements.every((v) => v.status === 'satisfied'), JSON.stringify(requirements));
    const receipt = requirements.find((v) => v.requirement === 'workbook_verified')!.claims.find((v) => v.statement.data?.sha256)!;
    assert.deepEqual(receipt.statement.data, { sha256: createHash('sha256').update(bytes).digest('hex'), autoids: [AUTOID], bed: { id: 'bed-a', manifest_sha256: sha(JSON.stringify(MANIFEST_DOC)) }, build: 'Fixture_Build_A', generator: GENERATOR, plan_run: planRun.run });
  });
  it('accepts descriptive model-grounded expectations, generates observable literals and preserves native judgment identity',async()=>{
    const description='[check1]合成配置添加成功',observable='service enabled',document=map();const step=document.root.children[0].children[0];assert.ok('children' in step);step.children[0].data.text=description;
    const bytes=JSON.stringify(document),external='agile:mindmap:synthetic-model-expected';hub.external.put(external,{bytes:new TextEncoder().encode(bytes),mediaType:'application/json'});
    const parsed=recognize(createDefaultRegistry(),new TextEncoder().encode(bytes),'application/json')!;
    const leaf=(parsed.document.model as {nodes:Array<{text:string;selector:string}>}).nodes.find(node=>node.text===description)!;
    const args=start();delete (args.inputs as Partial<typeof args.inputs>).case_index;args.inputs.subject.external=external;
    const first=await hub.service.startRunDetailed(hub.alice,args,call());assert.equal(first.answer.call_result,'ok',JSON.stringify(first.answer.errors));const plan=first.answer.run!;
    const send=(run:typeof plan)=>{const value=submission(run.run,data=>{data.expects[0]={text:observable,quote:{text:description,reference:`src:${sha(bytes)}/kityminder@1/${leaf.selector}`},after:1,basis:'model_judgment',rationale:'合成运行器输出此状态行，模型据此选择观察文字；语义不由 Hub 断言'};});value.items[0].item=run.items[0].id;return value;};
    const submitted=send(plan),answer=await hub.service.submitResult(hub.alice,submitted,call());assert.equal(answer.acceptance,'accepted',JSON.stringify(answer.errors));
    const expected=Object.values(answer.result!.partitions).flat().flatMap(item=>item.requirements).find(row=>row.requirement==='expected_grounded')!;
    assert.equal(expected.status,'satisfied');const model=expected.claims.find(claim=>claim.warrant.producer==='model')!;
    assert.ok(model);assert.equal(model.warrant.id,'synthetic-model');assert.equal(model.statement.data?.basis,'model_judgment');assert.ok(model.statement.data?.rationale);assert.deepEqual(model.statement.data?.quote,submitted.items[0].slots.plan[0].data.expects[0].quote);assert.ok(model.qualifier.marks.includes('conditional_on_judgment'));assert.ok(model.validity.premises.some(pointer=>pointer.endsWith('/data/expects/0')));
    const {statusText}=await import('../../../hub/server/claims.ts');assert.equal(statusText(expected),'满足（判断）');
    const recipe=satisfiedRecipe({run:first.answer,result:answer,submission:submitted,contract:Buffer.from(JSON.stringify(CONTRACT_DOC)),profile:Buffer.from(JSON.stringify(PROFILE_DOC)),inventory:Buffer.from(JSON.stringify(MANIFEST_DOC))});const workbook=generateWorkbook(recipe);
    assert.ok(Buffer.from(workbook).includes(Buffer.from(observable)));assert.ok(!Buffer.from(workbook).includes(Buffer.from(description)));
    await hub.kit.artifacts.ingest({bytes:workbook,mediaType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',origin:{read:{object:'fixture:workbook:model-grounded'}},author:{user:null},provenanceType:'observed',visibility:{readers:[hub.alice.id],admins:true,packs:[],shareable:false}});
    const second=await hub.service.startRunDetailed(hub.alice,{...args,predecessor:plan.run,parameters:{...args.parameters,plan_run:plan.run},inputs:{...args.inputs,workbook:{reference:'src:'+createHash('sha256').update(workbook).digest('hex')}}},call());assert.equal(second.answer.call_result,'ok',JSON.stringify(second.answer.errors));
    const verified=await hub.service.submitResult(hub.alice,send(second.answer.run!),call());assert.equal(verified.acceptance,'accepted',JSON.stringify(verified.errors));
    const requirements=Object.values(verified.result!.partitions).flat().flatMap(item=>item.requirements);assert.ok(requirements.every(row=>row.status==='satisfied'),JSON.stringify(requirements));
    const proof=requirements.find(row=>row.requirement==='workbook_verified')!;assert.ok(proof.claims.some(claim=>claim.warrant.producer==='function'&&claim.statement.verdict==='support'));assert.ok(requirements.find(row=>row.requirement==='expected_grounded')!.claims.some(claim=>claim.warrant.producer==='model'&&claim.qualifier.marks.includes('conditional_on_judgment')));
  });
  it('keeps the pack unavailable to an unassigned user', async () => { const result = await hub.service.startRunDetailed(hub.bob, start(), call()); assert.equal(result.answer.call_result, 'error'); });
});
it('closure 02 prerequisite pointers survive both requirements and repaired submissions resume catalog and quote checks',{skip},async()=>{
 const started=await hub.service.startRunDetailed(hub.alice,start(),call());assert.ok(started.answer.run);const id=started.answer.run.run;
 const blocked=await hub.service.submitResult(hub.alice,submission(id,data=>{data.steps[0].args=['widget health interval "60'];}),call());
 const requirements=Object.values(blocked.result!.partitions).flat().flatMap(item=>item.requirements);
 for(const key of ['commands_known','workbook_verified'])assert.ok(requirements.find(r=>r.requirement===key)!.claims.some(c=>c.statement.verdict==='unknown'||c.statement.verdict==='refute'));
 const typed=requirements.find(r=>r.requirement==='contract_methods')!.claims;assert.ok(typed.some(c=>Array.isArray(c.statement.data?.problems)&&(c.statement.data.problems as Array<{pointer:string}>).some(p=>p.pointer==='/steps/0/args/0')));
 const fixed=await hub.service.submitResult(hub.alice,submission(id),call());const claims=Object.values(fixed.result!.partitions).flat().flatMap(item=>item.requirements).flatMap(r=>r.claims);
 assert.ok(claims.some(c=>c.warrant.id.startsWith('case-compile.commands_catalog@')&&c.statement.verdict==='support'));assert.ok(claims.some(c=>c.warrant.id==='quote@1'&&c.statement.verdict==='support'));
});
