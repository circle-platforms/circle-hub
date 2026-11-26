import {createTestParserRegistry as createDefaultRegistry} from '../../hub/testing/parsers.ts';
import {addSyntheticExecutor} from '../../hub/dispatch/testing/credentials.ts';
import assert from 'node:assert/strict';
import CASE_COMPILE_PACK from '../../packs/workflow/case-compile/pack.json' with { type: 'json' };
import { after, before, beforeEach, describe, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { osIsolationAvailable } from '../../hub/rules/api.ts';
import { recognize } from '../../hub/refs/api.ts';
import { newId, sha256Hex, type ActionBody } from '../../hub/records/api.ts';
import { ExecutorDefinition, readRunJobs, staleWarrant, type JobStatus, type DispatchNote } from '../../hub/dispatch/api.ts';
import { definition } from '../../hub/dispatch/testing/definition.ts';
import { startEndpoint } from '../../hub/dispatch/testing/server.ts';
import { CONTRACT_DOC as BASE_CONTRACT, PROFILE_DOC as BASE_PROFILE, MANIFEST_DOC as BASE_MANIFEST, goodData } from '../../packs/workflow/case-compile/functions/test-support.ts';
import { templateDocument } from '../../packs/workflow/case-compile/testing/template.ts';
import { runtimeDigest, stripAdditions, contractCanonical } from '../../packs/workflow/case-compile/functions/runtime-contract.ts';
import {compileGrammar, commandIdentity} from '../../packs/workflow/case-compile/functions/generated/skills/command-tools/command-check/grammar.ts';
import { entry } from '../../packs/workflow/case-compile/testing/runtime.ts';
import { satisfiedRecipe } from '../../packs/workflow/case-compile/tools/generate-workbook.ts';
import { generateWorkbook } from '../../packs/workflow/case-compile/functions/generate.ts';
import { reportLines, batchQualifications } from '../../scripts/real/accept/device-run.ts';
import { createScriptedModel } from '../../scripts/real/scripted-model.ts';
import { createTestHub, type TestHub, type TestUser } from '../../hub/server/testing-real.ts';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stage } from '../../packs/workflow/case-compile/pack-files.ts';
import { CallFailure } from '../../packs/workflow/case-compile/functions/text.ts';
import { hubTools, openCompile } from '../../packs/workflow/case-compile/tools/open-compile.ts';
import { stageRecompose } from '../../packs/workflow/case-compile/testing/stage-recompose.ts';
import { attachRecompositionFields } from '../../packs/workflow/case-compile/testing/recompose-hub-helper.ts';
import { recordFor } from '../../packs/workflow/case-compile/recompose/tools/submit-records.ts';
import { INDEX } from '../../hub/runs/engine/store.ts';
import { productSite, twoNameProduct, type ProductSite, type ProductPack } from './support/env.ts';
import { connect, type McpClient } from './support/mcp.ts';
import type { StartRunOutput, SubmitResultOutput } from '../../contracts/src/tools.ts';
import type { z } from 'zod';

const inspectEntry = { ...entry('widget-seat', 'inspect', [{ name: 'query', kind: 'positional_only', required: true, default: null }]),
  typed_authority: { source: BASE_CONTRACT.effects.effect_0.source, parameters: {query:{type:'text',role:'device_cli'}}, effects:['effect_0'] } };
const CONTRACT_DOC = { ...structuredClone(BASE_CONTRACT), entries: [...structuredClone(BASE_CONTRACT.entries), inspectEntry] };
const recovered = stripAdditions(CONTRACT_DOC)!;
recovered.contract_sha256 = runtimeDigest(recovered);
CONTRACT_DOC.original = {contract_sha256:String(recovered.contract_sha256),sha256:sha256Hex(Buffer.from(contractCanonical(recovered)))};
CONTRACT_DOC.contract_sha256 = runtimeDigest(CONTRACT_DOC);
const MANIFEST_DOC={...BASE_MANIFEST,beds:BASE_MANIFEST.beds.map(bed=>({...bed,devices:bed.devices.map(device=>({...device,interfaces:[...device.ipv4,...device.ipv6]}))}))};
const PROFILE_DOC = { ...BASE_PROFILE, device_count:MANIFEST_DOC.beds[0].devices.length, runtime: { ...BASE_PROFILE.runtime }, workbook: { ...BASE_PROFILE.workbook, template: templateDocument(BASE_PROFILE.workbook, BASE_PROFILE.runtime.minimum_version, CONTRACT_DOC.original.contract_sha256) }, allowed: [...BASE_PROFILE.allowed, { object: 'widget-seat', method: 'inspect', parameters: { query: 'device_cli' }, reviewed: true }] };
const skip = await osIsolationAvailable() ? false : 'sandbox-exec absent: real isolated pack execution unavailable';
const ids = ['990000000000000041', '990000000000000042'];
const line = 'widget health interval pool-a 60';
const expected = '合成健康检查生效';
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
const map = { root: { data: { id: 'synthetic-map', text: '合成用例' }, children: ids.map((autoid, i) => ({ data: { id: `case-${i}`, text: `合成健康检查 ${i}`, priority: 2, resource: ['合成'], auto: 'YES', autoid }, children: [{ data: { id: `step-${i}`, text: line }, children: [{ data: { id: `expected-${i}`, text: expected } }] }] })) } };
const original = bytes(map);
const model = recognize(createDefaultRegistry(), original, 'application/json')!.document.model as { nodes: Array<{ text: string; selector: string }> };
let staged: string;
let postgres: TemporaryPostgres; let bed: { hub: TestHub; product: ProductPack; site: ProductSite; reviewer: TestUser }; let client: McpClient; let subject: string;
let endpoint: Awaited<ReturnType<typeof startEndpoint>>;
// Closed by after() even when before() fails between creating the Hub and filling bed: its listeners would keep the file open.
let opened: TestHub | undefined;
let executor: string;
const itemIds = new Map<string, string>();
let lose = false; let mismatch = false; let aliasEcho = false; let submissions = 0; let releases = 0;
let latest: { request:string; key: string; digest: string; ids: string[]; submitted: string; payload: Buffer };
const dispatch = () => { assert.ok(bed.hub.hub.dispatch); return bed.hub.hub.dispatch; };
const startInputs = () => ({ subject: { reference: subject }, contract: { external: 'doc:doc:runner-contract' }, profile: { external: 'doc:doc:runtime-profile' }, inventory: { external: 'doc:doc:bed-topology' } });
async function start(args: Record<string, unknown>): Promise<z.infer<typeof StartRunOutput>> {
  const answer = await client.call('start_run', args); assert.equal(answer.isError, false, JSON.stringify(answer.out.errors)); assert.ok(answer.out.run); if (args.pack === 'case-compile') itemIds.set(answer.out.run.run, answer.out.run.items[0].id); return answer.out;
}
async function booking(target = 'bed-a', inventory = startInputs().inventory.external): Promise<string> {
  const booked = (await start({ pack: 'test-bed', inputs: { inventory: {external:inventory} }, parameters: { action: 'acquire', bed: target, need: { devices: [{ type: 'load-balancer', count: 2 }, { type: 'router', count: 1 }, { type: 'client', count: 1 }, { type: 'server', count: 1 }, { type: 'console', count: 1 }] } } })).run!.run;
  const held = (await bed.hub.leases.view('bed/')).entries;
  assert.ok(held.length > 0);
  assert.ok(held.every(row => row.until === null), 'bookings last until the owning lineage releases them');
  return booked;
}
async function release(booked: string) {
  await start({ pack: 'test-bed', inputs: { inventory: startInputs().inventory }, predecessor: booked, parameters: { action: 'release', booking: booked } });
  assert.equal((await bed.hub.leases.view('bed/')).entries.length, 0);
}
function submission(run: string, index: number, bad = false) {
  return { run, model: 'synthetic-scripted-model', items: [planItem(index, itemIds.get(run)!, bad)] };
}
function planItem(index: number, item: string, bad = false, frozenItem?: any, receipt?: string) {
  const data = goodData(); data.steps[0].args = bad ? 'synthetic-invalid' as unknown as string[] : [line];
  if (index === 1) {data.steps.push({ object: 'widget-seat', method: 'inspect', args: ['relay endpoint add 192.0.2.74 80'], keywords: {} });data.steps.push({object:'widget-seat',method:'configure',args:['no relay endpoint add 192.0.2.74 80'],keywords:{},cleanup:true});}
  data.steps.push({object:'widget-seat',method:'configure',args:['no widget health interval pool-a'],keywords:{},cleanup:true});
  data.expects[0].text = expected;
  data.expects[0].quote = { reference: `src:${sha256Hex(original)}/kityminder@1/${model.nodes.find(n => n.selector === `n/expected-${index}`)!.selector}`, text: expected };
  if (frozenItem && receipt) attachRecompositionFields(frozenItem, receipt, data);
  return { item, handling: 'handled', slots: { plan: [{ text: '合成计划', quotes: [data.expects[0].quote], data }] } };
}
async function plan(booked: string, index = 0, repair = false) {
  const input = { pack: 'case-compile', product: bed.product.names[0], build: bed.site.RELEASED, predecessor: booked, inputs: startInputs(), parameters: { autoid: ids[index] } };
  const started = await start(input); const run = started.run!.run;
  let sent = submission(run, index); let accepted: z.infer<typeof SubmitResultOutput>;
  if (repair) {
    const scripted = createScriptedModel({ respond: turn => [{ tool: 'submit_result', input: submission(run, index, turn.index === 0) }] });
    await new Promise<void>(resolve => scripted.listen(0, '127.0.0.1', resolve));
    const port = (scripted.address() as import('node:net').AddressInfo).port;
    try {
      for (let round = 0; round < 2; round++) {
        const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'synthetic', messages: round ? [{ role: 'assistant', content: 'repair' }, { role: 'user', content: '修正明确拒绝的参数' }] : [{ role: 'user', content: '提交合成计划' }] }) });
        const reply = await response.json() as { content: Array<{ input: ReturnType<typeof submission> }> };
        sent = reply.content[0].input;
        const result = await client.call('submit_result', sent); accepted = result.out;
        if (!round) { assert.notEqual(accepted.acceptance, 'accepted'); assert.ok(accepted.errors.some(e => e.code === 'SUBMISSION_SCHEMA_VIOLATION'), JSON.stringify(accepted.errors)); }
        else assert.equal(accepted.acceptance, 'accepted', JSON.stringify(accepted.errors));
      }
    } finally { await new Promise<void>((resolve, reject) => scripted.close(e => e ? reject(e) : resolve())); }
  } else accepted = (await client.call('submit_result', sent)).out;
  assert.equal(accepted!.acceptance, 'accepted', JSON.stringify(accepted!.errors));
  const requirements = accepted!.result!.partitions.delivered[0].requirements;
  assert.ok(requirements.filter(r => r.requirement !== 'workbook_verified').every(r => r.status === 'satisfied'), JSON.stringify(requirements));
  assert.notEqual(requirements.find(r => r.requirement === 'workbook_verified')!.status, 'satisfied');
  const recipe = satisfiedRecipe({ run: started, result: accepted!, submission: sent, contract: bytes(CONTRACT_DOC), profile: bytes(PROFILE_DOC), inventory: bytes(MANIFEST_DOC) });
  const directory = await mkdtemp(join(staged, 'client-generator-'));
  const artifacts = { run: bytes(started), result: bytes(accepted!), submission: bytes(sent), contract: bytes(CONTRACT_DOC), profile: bytes(PROFILE_DOC), inventory: bytes(MANIFEST_DOC) };
  const argv: string[] = [];
  for (const [name, contents] of Object.entries(artifacts)) { const file = join(directory, `${name}.json`); await writeFile(file, contents, { mode: 0o600 }); argv.push(`--${name}`, name === 'run' ? directory : file); }
  const output = join(directory, 'case.xlsx');
  const receipt = JSON.parse(execFileSync(process.execPath, [join(staged, 'case-compile/tools/generate-workbook.ts'), ...argv, '--out', output], { encoding: 'utf8' }));
  const payload = await readFile(output); assert.equal(receipt.sha256, sha256Hex(payload));
  return { input, run, recipe, sent, payload };
}
async function verify(p: Awaited<ReturnType<typeof plan>>, index = 0, changed = false, beforeSubmit: () => void = () => {}) {
  const payload = Buffer.from(p.payload);
  if (changed) { const at = payload.indexOf('pool-a'); assert.ok(at >= 0); payload[at + 5] = 'b'.charCodeAt(0); assert.equal(payload.filter((v, i) => v !== p.payload[i]).length, 1); }
  if (changed) {
    const refused=await client.call('upload_file',{file_path:payload.toString('base64'),name:'synthetic.xlsx',media_type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    assert.equal(refused.isError,true);assert.equal(refused.out.acceptance,'not_accepted');assert.ok(refused.out.errors.some(e=>e.code==='SOURCE_UNPARSEABLE'&&/xlsx@1.*CRC/.test(e.message)&&e.fix));assert.equal(refused.out.reference,undefined);
    return {run:p.run,result:null,ref:null,sent:null};
  }
  const ref = await client.upload(payload, 'synthetic.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const input = { ...p.input, predecessor: p.run, parameters: { autoid: ids[index], plan_run: p.run }, inputs: { ...startInputs(), workbook: { reference: ref } } };
  const second = await start(input);
  beforeSubmit();
  const sent = submission(second.run!.run, index);
  const result = (await client.call('submit_result', sent)).out;
  return { run: second.run!.run, result, ref, sent };
}
async function settled(v: { run: string; result: z.infer<typeof SubmitResultOutput> | null }): Promise<JobStatus> {
  const note = v.result?.dispatch?.[0]; assert.ok(note?.job, JSON.stringify(v.result?.dispatch)); assert.match(note.text, /已按工作流的规定自动开始上机验证/);
  let read: unknown;
  for (let i = 0; i < 600; i++) {
    const job = (await readRunJobs(bed.hub.records, dispatch(), bed.hub.admin.principal, v.run)).find(row => row.job === note.job); read = job;
    if (job?.ended) return job.status;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`the dispatched job did not end: ${JSON.stringify(read)}`);
}
async function resultReport(state: JobStatus) {
  assert.match(state.result!, /^src:[a-f0-9]{64}$/);
  const source = await bed.hub.records.artifacts.source(bed.reviewer.principal, state.result!.slice(4));
  assert.ok(source?.bytes); const report = JSON.parse(Buffer.from(source.bytes).toString());
  assert.ok(reportLines(report).length > 0); assert.equal(batchQualifications([report]).length, 1);
  return report;
}

before(async () => {
  if (skip) return;
  postgres = await startPostgres(); staged = await mkdtemp(join(tmpdir(), 'synthetic-device-packs-'));
  const site = await productSite(); const product = await twoNameProduct();
  const files=site.site();const treeKey=`${site.SITE_BASE}/command_tree-${site.RELEASED}.xml`;
  const inverse='<menu name="no"><menu name="widget"><menu name="health"><item name="interval"><arguments><arg name="pool" type="STRING"/></arguments></item></menu></menu><menu name="relay"><menu name="endpoint"><item name="add"><arguments><arg name="address" type="IPADDR"/><arg name="port" type="U16"/></arguments></item></menu></menu></menu>';
  const xml=Buffer.from(files[treeKey].body).toString('latin1');files[treeKey]={...files[treeKey],body:Buffer.from(xml.replace('</scope>',inverse+'</scope>'),'latin1')};
  const hub = await createTestHub({ postgres, repositoryPacks: ['famx', 'build-site', 'test-bed'], packs: [await stage(join(staged, 'case-compile')), await stageRecompose('recompose', join(staged, 'recompose'))], buildSite: files, requireOsIsolation: true }); opened = hub;
  const resource = await hub.addResource({ system_pack: 'build-site', name: '合成构建站', environment: 'test', origins: { 'build-site': `${hub.stubs!.buildSite.origin}${site.SITE_BASE}` }, settings: { index_page: 'index.html' } });
  assert.ok(resource.id);
  for(const active of await hub.hub.registry.activeProducts())for(const variable of active.product.variables??[])await hub.records.variables.setVariable(hub.admin.principal,variable.name,variable.default,'合成自动化测试环境验收显式部署设置');
  const synced = await hub.knowledgeSync(product.line, { options: { case_index: false } }); assert.equal(synced.error, null, JSON.stringify(synced));
  const root = synced.builds.find(build => build.name === site.RELEASED)?.root;
  assert.ok(root);
  const catalog = await hub.hub.knowledge.catalog(root, 'commands@1', {base:'/commands',lines:[line,'relay endpoint add 192.0.2.74 80','no widget health interval pool-a','no relay endpoint add 192.0.2.74 80']});
  assert.ok(catalog);
  const grammar = compileGrammar(catalog.entries().map(e=>({path:'/commands/'+e.words.map(encodeURIComponent).join('/'),words:e.words,signatures:e.signatures})));
  const commands = [line,'relay endpoint add 192.0.2.74 80','no widget health interval pool-a','no relay endpoint add 192.0.2.74 80'].map(text=>{const identity=commandIdentity(grammar,text);assert.ok(identity, text);return identity;});
  delete CONTRACT_DOC.effects.effect_0.commands;
  CONTRACT_DOC.effects.effect_0.command_scope=['/commands/widget','/commands/no/widget','/commands/relay','/commands/no/relay'];
  CONTRACT_DOC.roles.bed_address = {source:BASE_CONTRACT.effects.effect_0.source,bed_member:true};
  CONTRACT_DOC.effects.effect_0.roles.push('bed_address');
  CONTRACT_DOC.effects.effect_0.command_roles = [1,3].map(index=>({signature:commands[index].signature,position:0,role:'bed_address'}));
  CONTRACT_DOC.contract_sha256 = runtimeDigest(CONTRACT_DOC);
  bed = { hub, product, site, reviewer: await hub.createUser('合成运行用户') };
  await bed.hub.assignPack(bed.reviewer.principal, 'test-bed'); await bed.hub.assignPack(bed.reviewer.principal, 'recompose'); await bed.hub.assignPack(bed.reviewer.principal, 'case-compile');
  client = await connect(bed.hub, bed.reviewer.token);
  for (const [id, value] of [['runner-contract', CONTRACT_DOC], ['runtime-profile', PROFILE_DOC], ['bed-topology', MANIFEST_DOC]] as const) await bed.hub.hub.docs.put(bed.hub.admin.principal, id, bytes(value), { fileName: `${id}.json` });
  subject = await client.upload(original, 'synthetic-cases.json');
  endpoint = await startEndpoint([...definition('x').allowed_tools,'inspect_seat'], async (name, args, response) => {
    if (name === 'open_slot' || name === 'touch_slot') return { ok: true, ticket: 'synthetic-ticket', token: 'synthetic-fence', ttl: 60000 };
    if (name === 'close_slot') { releases++; return { ok: true }; }
    if (name === 'inspect_slot') return { build: bed.site.RELEASED, seats: mismatch ? 1 : PROFILE_DOC.device_count, reachable: true };
    if(name==='inspect_seat'){const device=MANIFEST_DOC.beds[0].devices[Number(args.seat)];assert.ok(device);return {output:args.command==='inspect version'?`version: ${aliasEcho ? bed.site.ALIAS : bed.site.RELEASED}`:device.interfaces.map(address=>`address: ${address}`).join('\n')};}
    if (name === 'send_blob') {
      submissions++; const payload = Buffer.from(String(args.blob), 'base64');
      const intents=await bed.hub.records.store.findMany<ActionBody>({kind:'action',key:'dispatch.bytes',values:[sha256Hex(payload)]});const intent=intents.find(row=>row.body.detail.phase==='intent'&&row.body.detail.request_id===args.request);assert.ok(intent,'matching request intent committed before submission');assert.ok(intent.body.inputs.includes(`src:${sha256Hex(payload)}`));// The intent is unique per byte, task lineage and attempt (issue 145): the lineage is the one the job was bound to.
      const lineage=(await (dispatch() as any).journal.binding(String(intent.body.detail.job))).input?.lineage;assert.match(String(lineage),/^run_[0-9a-z]{26}$/);assert.equal((await bed.hub.records.store.getByKey('action',`dispatch.bytes:${sha256Hex(payload)}:${lineage}:${intent.body.detail.attempt}`))?.digest,intent.digest);
      assert.equal(typeof args.request,'string');latest = { request:String(args.request), key: `synthetic-remote-${submissions}`, digest: sha256Hex(payload), ids: args.ids as string[], submitted: new Date().toISOString(), payload };
      assert.equal(args.digest, latest.digest);
      if (lose) { response.destroy(); return {}; }
      return { request:latest.request, ok: true, key: latest.key, digest: latest.digest, ids: latest.ids };
    }
    if (name === 'inspect_blob') return { state: 'ended', exit: 0 };
    if (name === 'read_blob') return { ...latest, rows: latest.ids.map(id => ({ id, outcome: 'good' })), complete: true };
    return {};
  });
  const raw = definition(endpoint.endpoint);
  const configured = ExecutorDefinition.parse({ ...raw, target:'bed-a', manifest_sha256:sha256Hex(bytes(MANIFEST_DOC)),
    resources:MANIFEST_DOC.beds[0].devices.map(d=>`bed/bed-a/${d.name}`),precheck_context:{product:bed.product.line},
    allowed_tools:[...raw.allowed_tools,'inspect_seat'],refused_tools:['synthetic_admin_reset'],conditions:raw.conditions.map(condition=>condition.pointer==='/seats'?{...condition,at_least:PROFILE_DOC.device_count}:condition),
    probes:{devices:'/beds/0/devices',command_pattern:'^inspect (?:version|interfaces)$',call:{tool:'inspect_seat',arguments:{seat:{$value:'seat_index'},command:{$value:'command'},ticket:{$value:'lease_id'}}},output:'/output',
      seats:MANIFEST_DOC.beds[0].devices.map((device,index)=>({seat:device.name,index,manifest:{device:`/beds/0/devices/${index}`,addresses:'/interfaces',address:''},version:{command:'inspect version',pattern:'^version: (?<value>.+)$'},interfaces:{command:'inspect interfaces',pattern:'^address: (?<value>.+)$'}}))},
    input_documents:{contract:'runner-contract',profile:'runtime-profile'},
    result:{...raw.result,request_id:'/request'},proof:{...raw.proof,package:'case-compile',slot:'workbook',warrant_id:`case-compile.workbook_verified@${CASE_COMPILE_PACK.version}`} });
  assert.equal(staleWarrant(configured.proof.warrant_id,'case-compile',CASE_COMPILE_PACK.version),null);
  assert.deepEqual(staleWarrant(configured.proof.warrant_id,'case-compile','999.0.0'),{named:configured.proof.warrant_id,wanted:'case-compile.workbook_verified@999.0.0'});
  executor = (await addSyntheticExecutor(bed.hub.records,dispatch().registry,bed.hub.admin.principal,configured,'synthetic-dispatch-key')).id;
  await bed.hub.records.authorizations.assignResource(bed.hub.admin.principal,executor,bed.reviewer.principal.id);
});
after(async () => { await client?.close(); await endpoint?.close(); await opened?.close(); await postgres?.stop(); if (staged) await rm(staged, { recursive: true, force: true }); });

beforeEach(async () => { aliasEcho = false; if (!skip && bed) { const keys = (await bed.hub.leases.view('bed/')).entries.map(e => e.key); if (keys.length) await bed.hub.leases.forceRelease({ keys, by: bed.hub.admin.principal.id, reason: '合成测试失败后的隔离清理' }); } });

describe('scenario 28: published documents to real Hub workbook dispatch and release', { skip }, () => {
  test('booking lookup skips an unreadable registration, records its reason privately and refuses when none can be resolved', async t => {
    const admin = bed.hub.admin.principal, registry = dispatch().registry;
    const held = await booking(), args = {booking:{run:held,workflow:'case-compile'}};
    const base = await registry.readSource(executor); assert.ok(base);
    const key = 'SYNTHETIC_BOOKING_MANIFEST';
    await bed.hub.records.variables.setVariable(admin,key,base.source.manifest_sha256,'synthetic test');
    const bad = await registry.add(admin,{...base.source,manifest_sha256:'${var:SYNTHETIC_BOOKING_MANIFEST}'});
    t.after(async () => {
      await bed.hub.records.variables.setVariable(admin,key,base.source.manifest_sha256,'synthetic restore');
      await registry.disable(admin,bad.id);
      await registry.update(admin,executor,base.source);
    });
    await bed.hub.records.variables.setVariable(admin,key,'invalid-digest','synthetic drift');
    const good = await client.call('list_task_packs',args);
    assert.equal(good.isError,false,JSON.stringify(good.out.errors));
    assert.equal(good.out.booking_documents?.length,1);
    const log = (await bed.hub.records.callLog.query(admin,{traceId:good.out.trace})).items;
    assert.ok(log.some(row=>row.admin_reasons?.some(note=>note.includes(bad.id) && note.includes(key))));
    assert.ok(!good.text.includes(bad.id) && !good.text.includes(key));
    await registry.disable(admin,executor);
    const none = await client.call('list_task_packs',args);
    assert.equal(none.isError,true);
    assert.equal(none.out.errors[0].code,'SOURCE_READ_FAILED');
    assert.equal(none.text.split('供模型引用')[0].trim(),'暂时不可用：本次预订没有可用的执行器登记。请管理员核对执行器登记。');
    assert.match(none.out.errors[0].message,/执行器登记/);
    assert.equal(none.out.errors[0].fix,'请管理员核对执行器登记');
    assert.ok(!none.text.includes(bad.id) && !none.text.includes(key));
  });

  test('booking lookup distinguishes an absent run, another runner and unavailable dispatch', async t => {
    const admin = bed.hub.admin.principal;
    const request = (run:string) => ({booking:{run,workflow:'case-compile'}});
    const absent = await client.call('list_task_packs',request(newId('run')));
    assert.equal(absent.out.errors[0].code,'SOURCE_ABSENT');
    const held = await booking();
    const other = await bed.hub.createUser('合成预订文档读取者');
    await bed.hub.assignPack(other.principal,'case-compile');
    const otherClient = await connect(bed.hub,other.token); t.after(()=>otherClient.close());
    const foreign = await otherClient.call('list_task_packs',request(held));
    assert.equal(foreign.out.errors[0].code,'SOURCE_UNAVAILABLE');
    const notes = async (traceId:string) => (await bed.hub.records.callLog.query(admin,{traceId})).items.flatMap(row=>row.admin_reasons ?? []);
    assert.ok((await notes(foreign.out.trace)).some(note=>note.includes(held) && note.includes('持有')));
    const view = bed.hub.deps.dispatch;
    try {
      delete bed.hub.deps.dispatch;
      const missing = await client.call('list_task_packs',request(held));
      assert.equal(missing.out.errors[0].code,'SOURCE_UNAVAILABLE');
      assert.ok((await notes(missing.out.trace)).some(note=>note.includes('派发服务')));
      assert.deepEqual(missing.out.errors,foreign.out.errors);
    } finally { bed.hub.deps.dispatch = view; }
    await release(held);
  });

  test('an active booking with no covering executor and a released booking have different next actions', async t => {
    const admin = bed.hub.admin.principal, registry = dispatch().registry;
    const base = await registry.readSource(executor); assert.ok(base);
    const held = await booking(), query = {booking:{run:held, workflow:'case-compile'}};
    const options = {subject,product:bed.product.names[0],build:bed.site.RELEASED,booking:held};
    const call = hubTools(new URL(bed.hub.url).origin,bed.reviewer.token);
    t.after(()=>registry.update(admin,executor,base.source).then(()=>{}));
    await registry.disable(admin,executor);
    const uncovered = await client.call('list_task_packs',query);
    assert.equal(uncovered.isError,false);
    assert.deepEqual(uncovered.out.booking_documents,[]);
    await assert.rejects(openCompile(call,options,staged),error => error instanceof CallFailure
      && error.category === 'temporarily_unavailable' && error.fact.includes('覆盖本次预订'));
    await release(held);
    const released = await client.call('list_task_packs',query);
    assert.equal(released.out.errors[0].code,'SOURCE_ABSENT');
    assert.match(released.out.errors[0].fix ?? '',/重新预订/);
    await assert.rejects(openCompile(call,options,staged),error => error instanceof CallFailure
      && error.category === 'not_found' && error.next_action.includes('重新预订'));
  });

  test('the compile tool binds each active booking’s declared documents using the Hub response', async t => {
    const admin = bed.hub.admin.principal;
    const originalExecutor = await dispatch().registry.readSource(executor);
    assert.ok(originalExecutor);
    const other = 'bed-other';
    const alternate = {...MANIFEST_DOC, beds:[{...MANIFEST_DOC.beds[0],name:other}]};
    for (const [name, value] of [['other-contract',CONTRACT_DOC],['other-profile',{...PROFILE_DOC,bed:other}],['other-inventory',alternate]] as const) {
      await bed.hub.hub.docs.put(admin,name,bytes(value),{fileName:name+'.json'});
    }
    const second = await dispatch().registry.add(admin,{...originalExecutor.source,target:other,
      resources:alternate.beds[0].devices.map(d => `bed/${other}/${d.name}`),manifest_sha256:sha256Hex(bytes(alternate)),
      input_documents:{contract:'other-contract',profile:'other-profile'}});
    t.after(() => dispatch().registry.disable(admin,second.id).then(() => {}));
    const call = hubTools(new URL(bed.hub.url).origin, bed.reviewer.token);
    for (const [target, inventory, rules, profile] of [
      ['bed-a','bed-topology','runner-contract','runtime-profile'],
      [other,'other-inventory','other-contract','other-profile'],
    ] as const) {
      const held = await booking(target,'doc:doc:'+inventory);
      const options = {subject,product:bed.product.names[0],build:bed.site.RELEASED,booking:held};
      await assert.rejects(openCompile(call,{...options,contract:'doc:doc:wrong'},staged), error =>
        error instanceof CallFailure && error.category === 'invalid_parameters' && error.next_action.includes('doc:doc:'+rules+'@'));
      const opened = await openCompile(call,options,staged);
      const detail = await bed.hub.deps.runs.getRun(bed.reviewer.principal,opened.planRun);
      assert.ok(detail);
      for (const [slot,doc] of [['contract',rules],['inventory',inventory],['profile',profile]] as const) {
        assert.ok(opened.documents[slot].startsWith('doc:doc:'+doc+'@'));
        assert.equal(detail.run.sources.find(source => source.slot === slot)?.external,opened.documents[slot]);
      }
    }
  });

  test('a rework keeps the original revisions after named documents are republished and actually carries the source plan', async t => {
    const admin = bed.hub.admin.principal;
    const call = hubTools(new URL(bed.hub.url).origin, bed.reviewer.token);
    const options = {subject, product:bed.product.names[0], build:bed.site.RELEASED, booking:await booking()};
    const first = await openCompile(call, options, staged);
    const docs = [['runner-contract', CONTRACT_DOC], ['runtime-profile', PROFILE_DOC]] as const;
    t.after(async () => {
      for (const [name, value] of docs) await bed.hub.hub.docs.put(admin,name,bytes(value),{fileName:name+'.json'});
    });
    for (const [name, value] of docs) {
      await bed.hub.hub.docs.put(admin,name,Buffer.from(JSON.stringify(value,null,2)),{fileName:name+'.json'});
    }
    const fresh = await openCompile(call,options,staged);
    assert.notEqual(fresh.documents.contract,first.documents.contract);
    assert.notEqual(fresh.documents.profile,first.documents.profile);
    await assert.rejects(openCompile(call,{...options, contract:first.documents.contract},staged), error =>
      error instanceof CallFailure && error.next_action.includes(fresh.documents.contract));

    const reopened = await openCompile(call,{...options,...first.documents,
      reuse:{run:first.recomposeRun,record:first.recomposeRecord}},staged);
    assert.deepEqual(reopened.documents,first.documents);
    const run = async (id: string) => {
      const detail = await bed.hub.deps.runs.getRun(bed.reviewer.principal,id);
      assert.ok(detail);
      return detail.run;
    };
    const source = await run(first.planRun);
    const target = await run(reopened.planRun);
    const directory = await mkdtemp(join(tmpdir(),'carry-frozen-docs-'));
    t.after(() => rm(directory,{recursive:true,force:true}));
    for (const [name,data] of [['source',source],['target',target]] as const) {
      await mkdir(join(directory,name));
      await writeFile(join(directory,name,'run.json'),JSON.stringify(data));
      for (const slot of ['contract','inventory','profile'] as const) {
        assert.equal(data.sources.find(s=>s.slot===slot)?.external,first.documents[slot]);
      }
    }
    const plan = planItem(0,source.items[0]!.id);
    await mkdir(join(directory,'plans'));
    const originalPlan = JSON.stringify(plan);
    await writeFile(join(directory,'plans','00.json'),originalPlan);
    const carry = (targetDir: string, output: string) => promisify(execFile)(process.execPath,[
      join(staged,'case-compile/tools/carry-plans.ts'), '--source','source','--target',targetDir,'--source-plans','plans','--plans',output,
    ],{cwd:directory,encoding:'utf8'});
    const carried = await carry('target','carried');
    const manifest = JSON.parse(carried.stdout.slice(carried.stdout.indexOf('{')));
    assert.deepEqual(manifest.carried.map((row:{item:string})=>row.item),[plan.item]);
    assert.equal(await readFile(join(directory,'carried','00.json'),'utf8'),originalPlan);
    await mkdir(join(directory,'fresh'));
    await writeFile(join(directory,'fresh','run.json'),JSON.stringify(await run(fresh.planRun)));
    await assert.rejects(carry('fresh','wrong-revision'), /绑定的输入（subject\/contract\/inventory\/profile）不一致/);
  });

  test('two authored cases use independent bookings, different S, terminal results and qualified reports', async () => {
    const checked = await dispatch().precheck(bed.hub.admin.principal, executor); assert.equal(checked.frozen, false);
    const hashes: string[] = []; const bookings: string[] = [];
    for (let index = 0; index < 2; index++) {
      const booked = await booking(); bookings.push(booked);
      const listing = await client.call('list_task_packs', {booking:{run:booked, workflow:'case-compile'}});
      assert.deepEqual(listing.out.booking_documents, [{
        inputs:{contract:'doc:doc:runner-contract@' + sha256Hex(bytes(CONTRACT_DOC)), profile:'doc:doc:runtime-profile@' + sha256Hex(bytes(PROFILE_DOC))},
        manifest:'doc:doc:bed-topology@' + sha256Hex(bytes(MANIFEST_DOC)),
      }]);
      const p = await plan(booked, index, index === 0); const v = await verify(p, index);
      assert.ok(v.result!.result!.partitions.delivered[0].requirements.every(r => r.status === 'satisfied'));
      const state = await settled(v); const job = state.job;
      assert.equal(state.outcome, 'effective'); assert.equal(state.frozen, false);
      const binding = await dispatch().journal.binding(job); assert.equal(binding.initiated_by, bed.reviewer.principal.id); assert.equal(binding.acting_by, bed.hub.admin.principal.id);
      assert.deepEqual(latest.payload, p.payload); hashes.push(latest.digest);
      const report = await resultReport(state); assert.equal(report.rows[0].reported_terminal, 'pass'); assert.equal(report.rows[0].dynamic_terminal, 'no_verdict'); assert.ok(report.rows[0].limits.includes('未排除本地操作'));
      const count = submissions; const again = (await client.call('submit_result', v.sent!)).out;
      assert.equal(again.dispatch?.length, 1); assert.match(again.dispatch![0].text, /设备返回 src:[a-f0-9]{64}/); assert.equal(again.dispatch![0].job, job); assert.equal(again.dispatch![0].result, state.result); assert.equal(submissions, count);
      const read = await client.call('get_nodes', { reference: state.result }); assert.equal(read.isError, false);
      const stored = await bed.hub.hub.runs.getRun(bed.reviewer.principal, p.run); assert.equal(stored!.run.predecessor, booked); await release(booked);
    }
    assert.equal(new Set(hashes).size, 2); assert.equal(new Set(bookings).size, 2);
  });
  test('a whole mindmap compiles into one workbook that the Hub dispatches once, with one verdict row per case', async () => {
    aliasEcho = true;
    const booked = await booking(); const before = submissions;
    const scope = { pack: 'case-compile', product: bed.product.names[0], build: bed.site.RELEASED };
    const recomposeStart = await start({ pack: 'recompose', product: bed.product.names[0], build: bed.site.RELEASED, inputs: { subject: { reference: subject } } });
    const recompRun = recomposeStart.run!.run;
    const recompSubmit = await client.call('submit_result', {
      run: recompRun,
      model: 'synthetic-scripted-model',
      items: recomposeStart.run!.items.map((item) => {
        const atoms = Array.isArray((item.fields as Record<string, unknown>)?.atoms)
          ? ((item.fields as Record<string, unknown>).atoms as Array<{ reference?: string }>)
          : [];
        const data = recordFor(item, { method: { kind: 'declared', text: '配置健康检查命令后核对预期输出', sources: [atoms[0]?.reference ?? item.location], basis: '作者步骤已给出可执行命令和预期输出' } }, 'synthetic-scripted-model');
        return { item: item.id, handling: 'handled', slots: { record: [{ text: '合成重组判断', quotes: (data.atoms as Array<{ quote_ref: string; text: string }>).map((a) => ({ reference: a.quote_ref, text: a.text })), data }] } };
      }),
    });
    assert.equal(recompSubmit.out.acceptance, 'accepted', JSON.stringify(recompSubmit.out.errors));
    const recompRunRec = (await bed.hub.records.store.find({ kind: 'run', key: INDEX.runId, value: recompRun })).items[0];
    const recompResultRec = (await bed.hub.records.store.find({ kind: 'validation_result', key: INDEX.resultRun, value: recompRun, newestFirst: true })).items[0];
    const receiptRef = `rec:${recompResultRec.digest}`;
    const wholeInputs = { ...startInputs(), recomposition_run: { reference: `rec:${recompRunRec.digest}` }, recomposition_result: { reference: receiptRef } };
    const whole = await start({ ...scope, predecessor: booked, inputs: wholeInputs });
    const planRun = whole.run!.run; const items = whole.run!.items.map(item => item.id);
    assert.equal(items.length, ids.length, 'every textual-autoid case of the document is an item');
    const planned = (await client.call('submit_result', { run: planRun, model: 'synthetic-scripted-model', items: whole.run!.items.map((item, index) => planItem(index, item.id, false, item, receiptRef)) })).out;
    assert.equal(planned.acceptance, 'accepted', JSON.stringify(planned.errors));
    for (const row of planned.result!.partitions.delivered) assert.ok(row.requirements.filter(r => r.requirement !== 'workbook_verified').every(r => r.status === 'satisfied'), JSON.stringify(row.requirements));
    // fetch-run calls this in-process Hub back, so it runs asynchronously: a synchronous child would block the Hub that answers it.
    const directory = await mkdtemp(join(staged, 'whole-mindmap-'));
    const fetching = promisify(execFile)(process.execPath, [join(staged, 'case-compile/tools/fetch-run.ts'), '--hub', bed.hub.mcpUrl, '--run', planRun, '--out', directory], { encoding: 'utf8' });
    fetching.child.stdin!.end(bed.reviewer.token); await fetching;
    const sources = JSON.parse(await readFile(join(directory, 'sources.json'), 'utf8')) as Array<{ slot: string; file: string; reference: string }>;
    for (const [slot, value] of [['contract', CONTRACT_DOC], ['profile', PROFILE_DOC], ['inventory', MANIFEST_DOC]] as const) {
      const matches = sources.filter(source => source.slot === slot);
      assert.equal(matches.length, 1, `one frozen source pointer for ${slot}`);
      assert.ok(matches[0].file.startsWith('sources/'), 'the downloaded manifest supplies the filename');
      const downloaded = await readFile(join(directory, matches[0].file));
      assert.deepEqual(downloaded, bytes(value), `${slot} keeps its exact authored source bytes`);
      assert.equal(matches[0].reference, `src:${sha256Hex(downloaded)}`);
    }
    const argv = ['run', 'result', 'submission'].flatMap(name => [`--${name}`, name === 'run' ? directory : join(directory, `${name}.json`)]);
    const output = join(directory, 'case.xlsx');
    const receipt = JSON.parse(execFileSync(process.execPath, [join(staged, 'case-compile/tools/generate-workbook.ts'), ...argv, '--out', output], { encoding: 'utf8' }));
    const payload = await readFile(output); assert.equal(receipt.sha256, sha256Hex(payload));
    const ref = await client.upload(payload, 'synthetic-whole.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const verification = await start({ ...scope, predecessor: planRun, parameters: { plan_run: planRun }, inputs: { ...wholeInputs, workbook: { reference: ref }, plan_result: { run: planRun } } });
    const sent = { run: verification.run!.run, model: 'synthetic-scripted-model', items: verification.run!.items.map((item, index) => planItem(index, item.id, false, item, receiptRef)) };
    const result = (await client.call('submit_result', sent)).out;
    assert.equal(result.acceptance, 'accepted', JSON.stringify(result.errors));
    assert.equal(result.result!.partitions.delivered.length, ids.length);
    for (const row of result.result!.partitions.delivered) assert.ok(row.requirements.every(r => r.status === 'satisfied'), JSON.stringify(row.requirements));
    const state = await settled({ run: verification.run!.run, result });
    assert.equal(state.outcome, 'effective'); assert.equal(submissions, before + 1, 'one dispatch carries the whole mindmap');
    assert.deepEqual(latest.ids, ids); assert.deepEqual(latest.payload, payload);
    const report = await resultReport(state);
    assert.deepEqual(report.rows.map((row: { item: string }) => row.item), ids, 'one verdict row per case of the workbook');
    const returned = await client.call('get_nodes', { reference: state.device_return }); assert.equal(returned.isError, false, JSON.stringify(returned));
    for (const id of ids) assert.ok(JSON.stringify(returned).includes(`${id}：`), 'the device return says each case, so an answer need not send the runner through the whole report');
    for (const row of report.rows) assert.equal(row.reported_terminal, 'pass');
    const again = (await client.call('submit_result', sent)).out; assert.equal(again.dispatch?.[0]?.job, state.job); assert.equal(submissions, before + 1);
    aliasEcho = false;
    await release(booked);
  });
  test('a booking of part of the bed dispatches nothing and the runner is told why', async () => {
    const partial = (await start({ pack: 'test-bed', inputs: { inventory: startInputs().inventory }, parameters: { action: 'acquire', bed: 'bed-a', need: { devices: [{ type: 'load-balancer', count: 1 }] } } })).run!.run;
    assert.ok((await bed.hub.leases.view('bed/')).entries.length > 0);
    const before = submissions; const v = await verify(await plan(partial));
    assert.equal(v.result?.acceptance, 'accepted', JSON.stringify(v.result?.errors));
    const note: DispatchNote | undefined = v.result?.dispatch?.[0]; assert.ok(note, JSON.stringify(v.result?.dispatch));
    assert.match(note.text, /^不存在：.*预订/); assert.doesNotMatch(note.text, /已派发|已按任务包/);
    const held = new Set((await bed.hub.leases.view('bed/')).entries.map(e => e.key));
    const missing = MANIFEST_DOC.beds[0].devices.map(d => `bed/bed-a/${d.name}`).filter(key => !held.has(key));
    assert.ok(missing.length > 0);
    assert.equal(note.booking?.missing_resources,missing.length);
    assert.equal(note.booking?.target,'bed-a');
    assert.ok(note.text.includes('bed-a'),note.text);
    assert.match(note.text,new RegExp(`缺少 ${missing.length} 项`));
    for (const key of missing) assert.equal(note.text.includes(key),false,`member does not receive ${key}`);
    const explanation=await dispatch().explainRelease(bed.hub.admin.principal,v.run,executor);
    for (const key of missing) assert.ok(explanation.lease_coverage?.missing_fact?.includes(key),`administrator receives ${key}`);
    assert.equal(note.text.includes(note.job!),false);assert.doesNotMatch(note.text,/boundary_refused/);
    const [earlier, again] = (await client.call('submit_result', v.sent!)).out.dispatch ?? [];
    assert.equal(earlier?.job, note.job, JSON.stringify(earlier)); assert.match(earlier.text, /^不存在：.*未发出.*预订.*这次重交 Hub 已再试/);
    assert.ok(again?.job && again.job !== note.job, JSON.stringify(again)); assert.match(again.text, /^不存在：.*预订/);
    assert.equal(submissions, before);
    await release(partial);
  });
  test('a frozen workflow without its allowed effect row cannot submit a verified workbook',async()=>{
    const booked=await booking(),p=await plan(booked),before=submissions;
    const workflows=dispatch().options.workflows,read=workflows.byDigest.bind(workflows);
    const legacy=()=>{workflows.byDigest=async digest=>{const workflow=await read(digest);if(!workflow)return workflow;return {...workflow,readJson:async path=>{const value=await workflow.readJson(path);if(path!=='requirements.json')return value;const {effects,...legacy}=value as Record<string,unknown>;return legacy;}};};};
    try{const v=await verify(p,0,false,legacy);assert.ok((v.result?.dispatch??[]).every(note=>/^上机验证没有发出/.test(note.text)),JSON.stringify(v.result?.dispatch));assert.equal(submissions,before,'the accepted submission dispatched nothing');
      const state=await dispatch().dispatch(bed.hub.admin.principal,v.run,executor);assert.equal(state.outcome,'not_dispatched');const event=(await dispatch().journal.events(state.job)).find(e=>e.body.detail.phase==='boundary_refused')!;assert.equal(event.body.error_code,'EFFECT_NOT_ALLOWED');assert.equal(event.body.detail.boundary_clause,1);assert.equal(submissions,before);}
    finally{workflows.byDigest=read;await release(booked);}
  });
  test('a plan without a workbook cannot dispatch', async () => {
    const booked = await booking(); const p = await plan(booked); const before = submissions;
    assert.equal((await dispatch().dispatch(bed.hub.admin.principal,p.run,executor)).outcome,'not_dispatched'); assert.equal(submissions, before); await release(booked);
  });
  test('one altered workbook byte gains no support and never dispatches', async () => {
    const booked = await booking(); const p = await plan(booked); const v = await verify(p, 0, true); const before = submissions;
    assert.equal(v.result, null, 'the changed ZIP was refused by the core parser before any workbook support could exist');
    assert.equal((await dispatch().dispatch(bed.hub.admin.principal,v.run,executor)).outcome,'not_dispatched'); assert.equal(submissions, before); await release(booked);
  });
  test('a parseable but altered workbook fails semantic verification and cannot dispatch', async () => {
    const booked = await booking(); const p = await plan(booked); const changed = structuredClone(p.recipe);
    changed.slots.expects[0].text = expected.slice(0, -2); p.payload = Buffer.from(generateWorkbook(changed));
    const v = await verify(p); const before = submissions;
    assert.ok(v.result?.result);
    const rows = Object.values(v.result.result.partitions).flat();
    assert.ok(rows.some(row => row.requirements.some(r => r.requirement === 'workbook_verified' && r.status !== 'satisfied')));
    assert.equal((await dispatch().dispatch(bed.hub.admin.principal,v.run,executor)).outcome,'not_dispatched'); assert.equal(submissions, before); await release(booked);
  });
  test('failed declared environment precheck submits nothing and releases its gateway lease', async () => {
    const booked = await booking(); const p = await plan(booked); const before = submissions; const closed = releases;
    try {
      const v = await verify(p, 0, false, () => { mismatch = true; }); const state = await settled(v);
      assert.equal(state.outcome, 'not_dispatched'); assert.equal(state.frozen, false); assert.equal(submissions, before);
      // The target lease is released after the job's end record, so its release is awaited rather than raced.
      for (let i = 0; i < 200 && releases === closed; i++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(releases, closed + 1);
      assert.deepEqual(state.failed_conditions, [{ pointer: '/seats', operator: 'at_least' }], JSON.stringify(state));
      const text = (await client.call('submit_result', v.sent!)).out.dispatch?.[0]?.text ?? '';
      assert.match(text, /已结束/); assert.doesNotMatch(text, /还在进行/);
      assert.match(text, /核对项目 \/seats.*至少数量/);assert.match(text,/请管理员/);
      assert.equal(text.includes(state.job),false);assert.doesNotMatch(text,/boundary_refused|circle-hub/);
      assert.equal(submissions, before);
    }
    finally { mismatch = false; await release(booked); }
  });
  test('lost receipt freezes the first case and blocks the next until administrator reconciliation', async () => {
    const booked = await booking(); const p = await plan(booked); const before = submissions;
    const first = await verify(p, 0, false, () => { lose = true; });
    const frozen = await settled(first); lose = false;
    assert.equal(frozen.outcome, 'unknown'); assert.equal(frozen.frozen, true); assert.match(frozen.next_action!, /管理员/);
    const budgetRefused=await dispatch().dispatch(bed.hub.admin.principal,first.run,executor);
    assert.equal(budgetRefused.outcome,'not_dispatched');
    const refusal=(await dispatch().journal.events(budgetRefused.job)).find(event=>event.body.detail.phase==='boundary_refused')!;
    assert.equal(refusal.body.error_code,'EFFECT_BUDGET_EXHAUSTED');assert.equal(refusal.body.detail.boundary_clause,4);assert.equal(refusal.body.detail.effect_row,'submit_verified_workbook');
    assert.equal((await dispatch().status(bed.hub.admin.principal,frozen.job)).frozen,true,'a new budget refusal never unfreezes the original effect');
    const whileFrozen=await verify(await plan(booked,1),1);
    assert.ok(!whileFrozen.result?.dispatch?.some(note=>note.job),JSON.stringify(whileFrozen.result?.dispatch));assert.match(String(whileFrozen.result?.dispatch?.[0]?.text),/上机验证没有发出|没有发出/);
    await assert.rejects(dispatch().dispatch(bed.hub.admin.principal,whileFrozen.run,executor),/冻结|占用/);
    assert.equal(submissions,before+1);
    assert.deepEqual(latest.ids, [ids[0]], 'the next authored case has not been dispatched');
    const recovered = await dispatch().dispose(bed.hub.admin.principal, frozen.job, { choice: 'reconcile', remote_id: latest.key });
    assert.equal(recovered.frozen, false); assert.equal(recovered.outcome, 'effective'); assert.equal(submissions, before + 1); await resultReport(recovered);
    await release(booked);
    const nextBooking = await booking(); assert.notEqual(nextBooking, booked);
    const second = await verify(await plan(nextBooking, 1), 1);
    assert.equal((await settled(second)).outcome, 'effective');
    assert.equal(submissions, before + 2); await release(nextBooking);
  });
});
