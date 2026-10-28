import {createTestParserRegistry as createDefaultRegistry} from '../../hub/testing/parsers.ts';
import {addSyntheticExecutor} from '../../hub/dispatch/testing/credentials.ts';
// All endpoints, documents, models and workbook bytes in this suite are synthetic.
import assert from 'node:assert/strict';
import CASE_COMPILE_PACK from '../../packs/workflow/case-compile/pack.json' with { type: 'json' };
import { after, before, beforeEach, describe, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { osIsolationAvailable } from '../../hub/rules/api.ts';
import { recognize } from '../../hub/refs/api.ts';
import { sha256Hex, type ActionBody } from '../../hub/records/api.ts';
import { ExecutorDefinition, type JobStatus } from '../../hub/dispatch/api.ts';
import { definition } from '../../hub/dispatch/testing/definition.ts';
import { startEndpoint } from '../../hub/dispatch/testing/server.ts';
import { CONTRACT_DOC as BASE_CONTRACT, PROFILE_DOC as BASE_PROFILE, MANIFEST_DOC as BASE_MANIFEST, goodData } from '../../packs/workflow/case-compile/functions/test-support.ts';
import { runtimeDigest, stripAdditions, contractCanonical } from '../../packs/workflow/case-compile/functions/runtime-contract.ts';
import {compileGrammar, commandIdentity} from '../../packs/workflow/case-compile/functions/generated/command-grammar.ts';
import { entry } from '../../packs/workflow/case-compile/testing/runtime.ts';
import { satisfiedRecipe } from '../../packs/workflow/case-compile/tools/generate-workbook.ts';
import { generateWorkbook } from '../../packs/workflow/case-compile/functions/generate.ts';
import { reportLines, batchQualifications } from '../../scripts/real/accept/device-run.ts';
import { createScriptedModel } from '../../scripts/real/scripted-model.ts';
import { createTestHub, type TestHub, type TestUser } from '../../hub/server/testing-real.ts';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stage } from '../../packs/workflow/case-compile/pack-files.ts';
import { productSite, twoNameProduct, type ProductSite, type ProductPack } from './support/env.ts';
import { connect, type McpClient } from './support/mcp.ts';
import type { StartRunOutput, SubmitResultOutput } from '../../contracts/src/tools.ts';
import type { z } from 'zod';

const inspectEntry = { ...entry('widget-seat', 'inspect', [{ name: 'query', kind: 'positional_only', required: true, default: null }]),
  typed_authority: { source: BASE_CONTRACT.effects.effect_0.source, parameters: {query:{type:'text',role:'device_cli'}}, effects:['effect_0'] } };
const CONTRACT_DOC = { ...structuredClone(BASE_CONTRACT), entries: [...structuredClone(BASE_CONTRACT.entries), inspectEntry] };
// R5: extensions change the original runner identity, not just the @2 declaration digest.
const recovered = stripAdditions(CONTRACT_DOC)!;
recovered.contract_sha256 = runtimeDigest(recovered);
CONTRACT_DOC.original = {contract_sha256:String(recovered.contract_sha256),sha256:sha256Hex(Buffer.from(contractCanonical(recovered)))};
CONTRACT_DOC.contract_sha256 = runtimeDigest(CONTRACT_DOC);
// Keep both address families in the single interface list used by declared per-device probes.
const MANIFEST_DOC={...BASE_MANIFEST,beds:BASE_MANIFEST.beds.map(bed=>({...bed,devices:bed.devices.map(device=>({...device,interfaces:[...device.ipv4,...device.ipv6]}))}))};
const PROFILE_DOC = { ...BASE_PROFILE, device_count:MANIFEST_DOC.beds[0].devices.length, runtime: { ...BASE_PROFILE.runtime, contract_sha256: CONTRACT_DOC.original.contract_sha256 }, allowed: [...BASE_PROFILE.allowed, { object: 'widget-seat', method: 'inspect', parameters: { query: 'device_cli' }, reviewed: true }] };
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
let executor: string;
const itemIds = new Map<string, string>();
let lose = false; let mismatch = false; let submissions = 0; let releases = 0;
let latest: { request:string; key: string; digest: string; ids: string[]; submitted: string; payload: Buffer };
const dispatch = () => { assert.ok(bed.hub.hub.dispatch); return bed.hub.hub.dispatch; };
const startInputs = () => ({ subject: { reference: subject }, contract: { external: 'doc:doc:runner-contract' }, profile: { external: 'doc:doc:runtime-profile' }, inventory: { external: 'doc:doc:bed-topology' } });
async function start(args: Record<string, unknown>): Promise<z.infer<typeof StartRunOutput>> {
  const answer = await client.call('start_run', args); assert.equal(answer.isError, false, JSON.stringify(answer.out.errors)); assert.ok(answer.out.run); if (args.pack === 'case-compile') itemIds.set(answer.out.run.run, answer.out.run.items[0].id); return answer.out;
}
async function booking(): Promise<string> {
  const booked = (await start({ pack: 'test-bed', inputs: { inventory: startInputs().inventory }, parameters: { action: 'acquire', bed: 'bed-a', need: { devices: [{ type: 'load-balancer', count: 2 }, { type: 'router', count: 1 }, { type: 'client', count: 1 }, { type: 'server', count: 1 }, { type: 'console', count: 1 }] } } })).run!.run;
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
  const data = goodData(); data.steps[0].args = bad ? 'synthetic-invalid' as unknown as string[] : [line];
  // Second authored case also exercises another enabled, role-resolvable method.
  // dut0's 192.0.2.74/26 shares its segment with client0, so the address is reachable at compile time.
  if (index === 1) {data.steps.push({ object: 'widget-seat', method: 'inspect', args: ['relay endpoint add 192.0.2.74 80'], keywords: {} });data.steps.push({object:'widget-seat',method:'configure',args:['no relay endpoint add 192.0.2.74 80'],keywords:{},cleanup:true});}
  data.steps.push({object:'widget-seat',method:'configure',args:['no widget health interval pool-a'],keywords:{},cleanup:true});
  data.expects[0].text = expected;
  data.expects[0].quote = { reference: `src:${sha256Hex(original)}/kityminder@1/${model.nodes.find(n => n.selector === `n/expected-${index}`)!.selector}`, text: expected };
  return { run, model: 'synthetic-scripted-model', items: [{ item: itemIds.get(run)!, handling: 'handled', slots: { plan: [{ text: '合成计划', quotes: [data.expects[0].quote], data }] } }] };
}
async function plan(booked: string, index = 0, repair = false) {
  const input = { pack: 'case-compile', product: bed.product.names[0], build: bed.site.RELEASED, predecessor: booked, inputs: startInputs(), parameters: { autoid: ids[index] } };
  const started = await start(input); const run = started.run!.run;
  let sent = submission(run, index); let accepted: z.infer<typeof SubmitResultOutput>;
  if (repair) {
    // The model is an actual loopback Messages API; its tool calls are executed by this synthetic client.
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
  for (const [name, contents] of Object.entries(artifacts)) { const file = join(directory, `${name}.json`); await writeFile(file, contents, { mode: 0o600 }); argv.push(`--${name}`, file); }
  const output = join(directory, 'case.xlsx');
  // Execute the published tools/ entry, not a source-directory shortcut or Hub generation.
  const receipt = JSON.parse(execFileSync(process.execPath, [join(staged, 'case-compile/tools/generate-workbook.ts'), ...argv, '--out', output], { encoding: 'utf8' }));
  const payload = await readFile(output); assert.equal(receipt.sha256, sha256Hex(payload));
  return { input, run, recipe, sent, payload };
}
async function verify(p: Awaited<ReturnType<typeof plan>>, index = 0, changed = false) {
  const payload = Buffer.from(p.payload);
  if (changed) { const at = payload.indexOf('pool-a'); assert.ok(at >= 0); payload[at + 5] = 'b'.charCodeAt(0); assert.equal(payload.filter((v, i) => v !== p.payload[i]).length, 1); }
  if (changed) {
    const refused=await client.call('upload_file',{file_path:payload.toString('base64'),name:'synthetic.xlsx',media_type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    assert.equal(refused.isError,true);assert.equal(refused.out.acceptance,'not_accepted');assert.ok(refused.out.errors.some(e=>e.code==='SOURCE_UNPARSEABLE'&&/xlsx@1.*CRC/.test(e.message)&&e.fix));assert.equal(refused.out.reference,undefined);
    return {run:p.run,result:null,ref:null};
  }
  const ref = await client.upload(payload, 'synthetic.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const input = { ...p.input, predecessor: p.run, parameters: { autoid: ids[index], plan_run: p.run }, inputs: { ...startInputs(), workbook: { reference: ref } } };
  const second = await start(input);
  const result = (await client.call('submit_result', submission(second.run!.run, index))).out;
  return { run: second.run!.run, result, ref };
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
  // This synthetic deployment declares reversible native commands; inverse arities come from this locked tree.
  const files=site.site();const treeKey=`${site.SITE_BASE}/command_tree-${site.RELEASED}.xml`;
  const inverse='<menu name="no"><menu name="widget"><menu name="health"><item name="interval"><arguments><arg name="pool" type="STRING"/></arguments></item></menu></menu><menu name="relay"><menu name="endpoint"><item name="add"><arguments><arg name="address" type="IPADDR"/><arg name="port" type="U16"/></arguments></item></menu></menu></menu>';
  const xml=Buffer.from(files[treeKey].body).toString('latin1');files[treeKey]={...files[treeKey],body:Buffer.from(xml.replace('</scope>',inverse+'</scope>'),'latin1')};
  const hub = await createTestHub({ postgres, repositoryPacks: ['famx', 'build-site', 'test-bed'], packs: [await stage(join(staged, 'case-compile'))], buildSite: files, requireOsIsolation: true });
  const resource = await hub.addResource({ system_pack: 'build-site', name: '合成构建站', environment: 'test', origins: { 'build-site': `${hub.stubs!.buildSite.origin}${site.SITE_BASE}` }, settings: { index_page: 'index.html' } });
  assert.ok(resource.id);
  for(const active of await hub.hub.registry.activeProducts())for(const variable of active.product.variables??[])await hub.records.variables.setVariable(hub.admin.principal,variable.name,variable.default,'合成台架验收显式部署设置');
  const synced = await hub.knowledgeSync(product.line, { options: { case_index: false } }); assert.equal(synced.error, null, JSON.stringify(synced));
  // Provision this synthetic deployment's exact effect closure from its locked tree, rather than
  // carrying identities of the unrelated package unit fixture into a different product root.
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
  await bed.hub.assignPack(bed.reviewer.principal, 'test-bed'); await bed.hub.assignPack(bed.reviewer.principal, 'case-compile');
  client = await connect(bed.hub, bed.reviewer.token);
  // The three deployment documents pass the real administrator publication boundary.
  for (const [id, value] of [['runner-contract', CONTRACT_DOC], ['runtime-profile', PROFILE_DOC], ['bed-topology', MANIFEST_DOC]] as const) await bed.hub.hub.docs.put(bed.hub.admin.principal, id, bytes(value), { fileName: `${id}.json` });
  subject = await client.upload(original, 'synthetic-cases.json');
  endpoint = await startEndpoint([...definition('x').allowed_tools,'inspect_seat'], async (name, args, response) => {
    if (name === 'open_slot' || name === 'touch_slot') return { ok: true, ticket: 'synthetic-ticket', token: 'synthetic-fence', ttl: 60000 };
    if (name === 'close_slot') { releases++; return { ok: true }; }
    if (name === 'inspect_slot') return { build: bed.site.RELEASED, seats: mismatch ? 1 : PROFILE_DOC.device_count, reachable: true };
    if(name==='inspect_seat'){const device=MANIFEST_DOC.beds[0].devices[Number(args.seat)];assert.ok(device);return {output:args.command==='inspect version'?`version: ${bed.site.RELEASED}`:device.interfaces.map(address=>`address: ${address}`).join('\n')};}
    if (name === 'send_blob') {
      submissions++; const payload = Buffer.from(String(args.blob), 'base64');
      const intents=await bed.hub.records.store.findMany<ActionBody>({kind:'action',key:'dispatch.bytes',values:[sha256Hex(payload)]});const intent=intents.find(row=>row.body.detail.phase==='intent'&&row.body.detail.request_id===args.request);assert.ok(intent,'matching request intent committed before submission');assert.ok(intent.body.inputs.includes(`src:${sha256Hex(payload)}`));assert.equal((await bed.hub.records.store.getByKey('action',`dispatch.bytes:${sha256Hex(payload)}:${intent.body.detail.attempt}`))?.digest,intent.digest);
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
    resources:MANIFEST_DOC.beds[0].devices.map(d=>`bed/bed-a/${d.name}`),precheck_context:{build:bed.site.RELEASED,product:bed.product.line},
    allowed_tools:[...raw.allowed_tools,'inspect_seat'],refused_tools:['synthetic_admin_reset'],conditions:raw.conditions.map(condition=>condition.pointer==='/seats'?{...condition,at_least:PROFILE_DOC.device_count}:condition),
    probes:{devices:'/beds/0/devices',command_pattern:'^inspect (?:version|interfaces)$',call:{tool:'inspect_seat',arguments:{seat:{$value:'seat_index'},command:{$value:'command'},ticket:{$value:'lease_id'}}},output:'/output',
      seats:MANIFEST_DOC.beds[0].devices.map((device,index)=>({seat:device.name,index,manifest:{device:`/beds/0/devices/${index}`,addresses:'/interfaces',address:''},version:{command:'inspect version',pattern:'^version: (?<value>.+)$'},interfaces:{command:'inspect interfaces',pattern:'^address: (?<value>.+)$'}}))},
    result:{...raw.result,request_id:'/request'},proof:{...raw.proof,package:'case-compile',slot:'workbook',warrant_id:`case-compile.workbook_verified@${CASE_COMPILE_PACK.version}`} });
  executor = (await addSyntheticExecutor(bed.hub.records,dispatch().registry,bed.hub.admin.principal,configured,'synthetic-dispatch-key')).id;
});
after(async () => { await client?.close(); await endpoint?.close(); await bed?.hub.close(); await postgres?.stop(); if (staged) await rm(staged, { recursive: true, force: true }); });

beforeEach(async () => { if (!skip && bed) { const keys = (await bed.hub.leases.view('bed/')).entries.map(e => e.key); if (keys.length) await bed.hub.leases.forceRelease({ keys, by: bed.hub.admin.principal.id, reason: '合成测试失败后的隔离清理' }); } });

describe('scenario 28: published documents to real Hub workbook dispatch and release', { skip }, () => {
  test('two authored cases use independent bookings, different S, terminal results and qualified reports', async () => {
    const checked = await dispatch().precheck(bed.hub.admin.principal, executor); assert.equal(checked.frozen, false);
    const hashes: string[] = []; const bookings: string[] = [];
    for (let index = 0; index < 2; index++) {
      const booked = await booking(); bookings.push(booked);
      const p = await plan(booked, index, index === 0); const v = await verify(p, index);
      assert.ok(v.result!.result!.partitions.delivered[0].requirements.every(r => r.status === 'satisfied'));
      const state = await dispatch().dispatch(bed.hub.admin.principal, v.run, executor);
      assert.equal(state.outcome, 'effective'); assert.equal(state.frozen, false);
      assert.deepEqual(latest.payload, p.payload); hashes.push(latest.digest);
      const report = await resultReport(state); assert.equal(report.rows[0].reported_terminal, 'pass'); assert.equal(report.rows[0].dynamic_terminal, 'no_verdict'); assert.ok(report.rows[0].limits.includes('未排除本地操作'));
      const read = await client.call('get_nodes', { reference: state.result }); assert.equal(read.isError, false);
      const stored = await bed.hub.hub.runs.getRun(bed.reviewer.principal, p.run); assert.equal(stored!.run.predecessor, booked); await release(booked);
    }
    assert.equal(new Set(hashes).size, 2); assert.equal(new Set(bookings).size, 2);
  });
  test('a frozen workflow without its allowed effect row cannot submit a verified workbook',async()=>{
    const booked=await booking(),v=await verify(await plan(booked)),before=submissions;
    const workflows=dispatch().options.workflows,read=workflows.byDigest.bind(workflows);
    // An older workflow port has no effects declaration; all source and result fixtures remain the real run's.
    workflows.byDigest=async digest=>{const workflow=await read(digest);if(!workflow)return workflow;return {...workflow,readJson:async path=>{const value=await workflow.readJson(path);if(path!=='requirements.json')return value;const {effects,...legacy}=value as Record<string,unknown>;return legacy;}};};
    try{const state=await dispatch().dispatch(bed.hub.admin.principal,v.run,executor);assert.equal(state.outcome,'not_dispatched');const event=(await dispatch().journal.events(state.job)).find(e=>e.body.detail.phase==='boundary_refused')!;assert.equal(event.body.error_code,'EFFECT_NOT_ALLOWED');assert.equal(event.body.detail.boundary_clause,1);assert.equal(submissions,before);}
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
    // Change an observable expectation within the existing quote; the command receipt stays valid.
    changed.slots.expects[0].text = expected.slice(0, -2); p.payload = Buffer.from(generateWorkbook(changed));
    const v = await verify(p); const before = submissions;
    assert.ok(v.result?.result);
    const rows = Object.values(v.result.result.partitions).flat();
    assert.ok(rows.some(row => row.requirements.some(r => r.requirement === 'workbook_verified' && r.status !== 'satisfied')));
    assert.equal((await dispatch().dispatch(bed.hub.admin.principal,v.run,executor)).outcome,'not_dispatched'); assert.equal(submissions, before); await release(booked);
  });
  test('failed declared environment precheck submits nothing and releases its gateway lease', async () => {
    const booked = await booking(); const v = await verify(await plan(booked)); const before = submissions; const closed = releases; mismatch = true;
    try { const state = await dispatch().dispatch(bed.hub.admin.principal, v.run, executor); assert.equal(state.outcome, 'not_dispatched'); assert.equal(state.frozen, false); assert.equal(submissions, before); assert.equal(releases, closed + 1); }
    finally { mismatch = false; await release(booked); }
  });
  test('lost receipt freezes the first case and blocks the next until administrator reconciliation', async () => {
    const booked = await booking(); const first = await verify(await plan(booked)); const before = submissions; lose = true;
    const frozen = await dispatch().dispatch(bed.hub.admin.principal, first.run, executor); lose = false;
    assert.equal(frozen.outcome, 'unknown'); assert.equal(frozen.frozen, true); assert.match(frozen.next_action!, /管理员/);
    const budgetRefused=await dispatch().dispatch(bed.hub.admin.principal,first.run,executor);
    assert.equal(budgetRefused.outcome,'not_dispatched');
    const refusal=(await dispatch().journal.events(budgetRefused.job)).find(event=>event.body.detail.phase==='boundary_refused')!;
    assert.equal(refusal.body.error_code,'EFFECT_BUDGET_EXHAUSTED');assert.equal(refusal.body.detail.boundary_clause,4);assert.equal(refusal.body.detail.effect_row,'submit_verified_workbook');
    assert.equal((await dispatch().status(bed.hub.admin.principal,frozen.job)).frozen,true,'a new budget refusal never unfreezes the original effect');
    const whileFrozen=await verify(await plan(booked,1),1);
    await assert.rejects(dispatch().dispatch(bed.hub.admin.principal,whileFrozen.run,executor),/冻结|占用/);
    assert.equal(submissions,before+1);
    assert.deepEqual(latest.ids, [ids[0]], 'the next authored case has not been dispatched');
    const recovered = await dispatch().dispose(bed.hub.admin.principal, frozen.job, { choice: 'reconcile', remote_id: latest.key });
    assert.equal(recovered.frozen, false); assert.equal(recovered.outcome, 'effective'); assert.equal(submissions, before + 1); await resultReport(recovered);
    await release(booked);
    const nextBooking = await booking(); assert.notEqual(nextBooking, booked);
    const second = await verify(await plan(nextBooking, 1), 1);
    assert.equal((await dispatch().dispatch(bed.hub.admin.principal, second.run, executor)).outcome, 'effective');
    assert.equal(submissions, before + 2); await release(nextBooking);
  });
});
