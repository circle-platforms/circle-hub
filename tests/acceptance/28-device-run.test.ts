// All endpoints, documents, models and workbook bytes in this suite are synthetic.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { osIsolationAvailable } from '../../hub/rules/api.ts';
import { createDefaultRegistry, recognize } from '../../hub/refs/api.ts';
import { sha256Hex } from '../../hub/records/api.ts';
import { ExecutorDefinition, type JobStatus } from '../../hub/dispatch/api.ts';
import { definition } from '../../hub/dispatch/testing/definition.ts';
import { startEndpoint } from '../../hub/dispatch/testing/server.ts';
import { CONTRACT_DOC as BASE_CONTRACT, PROFILE_DOC as BASE_PROFILE, MANIFEST_DOC, goodData } from '../../packs/workflow/case-compile/functions/test-support.ts';
import { signRuntime, entry } from '../../packs/workflow/case-compile/testing/runtime.ts';
import { satisfiedRecipe } from '../../packs/workflow/case-compile/scripts/generate-workbook.ts';
import { generateWorkbook } from '../../packs/workflow/case-compile/functions/generate.ts';
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

const CONTRACT_DOC = signRuntime({ ...BASE_CONTRACT, entries: [...BASE_CONTRACT.entries, entry('widget-seat', 'inspect', [{ name: 'query', kind: 'positional_only', required: true, default: null }])] });
const PROFILE_DOC = { ...BASE_PROFILE, runtime: { ...BASE_PROFILE.runtime, contract_sha256: CONTRACT_DOC.contract_sha256 }, allowed: [...BASE_PROFILE.allowed, { object: 'widget-seat', method: 'inspect', parameters: { query: 'device_cli' } }] };
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
let latest: { key: string; digest: string; ids: string[]; submitted: string; payload: Buffer };
const dispatch = () => { assert.ok(bed.hub.hub.dispatch); return bed.hub.hub.dispatch; };
const startInputs = () => ({ subject: { reference: subject }, contract: { external: 'doc:doc:runner-contract' }, profile: { external: 'doc:doc:runtime-profile' }, inventory: { external: 'doc:doc:bed-topology' } });
async function start(args: Record<string, unknown>): Promise<z.infer<typeof StartRunOutput>> {
  const answer = await client.call('start_run', args); assert.equal(answer.isError, false, JSON.stringify(answer.out.errors)); assert.ok(answer.out.run); if (args.pack === 'case-compile') itemIds.set(answer.out.run.run, answer.out.run.items[0].id); return answer.out;
}
async function booking(): Promise<string> {
  return (await start({ pack: 'test-bed', inputs: { inventory: startInputs().inventory }, parameters: { action: 'acquire', bed: 'bed-a', need: { devices: [{ type: 'load-balancer', count: 2 }, { type: 'router', count: 1 }, { type: 'client', count: 1 }, { type: 'server', count: 1 }, { type: 'console', count: 1 }], hours: 1 } } })).run!.run;
}
async function release(booked: string) {
  await start({ pack: 'test-bed', inputs: { inventory: startInputs().inventory }, predecessor: booked, parameters: { action: 'release', booking: booked } });
  assert.equal((await bed.hub.leases.view('bed/')).entries.length, 0);
}
function submission(run: string, index: number, bad = false) {
  const data = goodData(); data.steps[0].args = bad ? 'synthetic-invalid' as unknown as string[] : [line];
  // Second authored case also exercises another enabled, role-resolvable method.
  if (index === 1) data.steps.push({ object: 'widget-seat', method: 'inspect', args: ['relay endpoint add 192.0.2.130 80'], keywords: {} });
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
  const ref = await client.upload(payload, 'synthetic.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const input = { ...p.input, predecessor: p.run, parameters: { autoid: ids[index], plan_run: p.run }, inputs: { ...startInputs(), workbook: { reference: ref } } };
  if (changed) { const refused = await client.call('start_run', input); assert.equal(refused.isError, true); assert.ok(refused.out.errors.some(e => e.code === 'SUBMISSION_SCHEMA_VIOLATION')); return { run: p.run, result: null, ref }; }
  const second = await start(input);
  const result = (await client.call('submit_result', submission(second.run!.run, index))).out;
  return { run: second.run!.run, result, ref };
}
async function resultReport(state: JobStatus) {
  assert.match(state.result!, /^src:[a-f0-9]{64}$/);
  const source = await bed.hub.records.artifacts.source(bed.reviewer.principal, state.result!.slice(4));
  assert.ok(source?.bytes); return JSON.parse(Buffer.from(source.bytes).toString());
}

before(async () => {
  if (skip) return;
  postgres = await startPostgres(); staged = await mkdtemp(join(tmpdir(), 'synthetic-device-packs-'));
  const site = await productSite(); const product = await twoNameProduct();
  const hub = await createTestHub({ postgres, repositoryPacks: ['apv', 'build-site', 'test-bed'], packs: [await stage(join(staged, 'case-compile'))], buildSite: site.site(), requireOsIsolation: true });
  const resource = await hub.addResource({ system_pack: 'build-site', name: '合成构建站', environment: 'test', origins: { 'build-site': `${hub.stubs!.buildSite.origin}${site.SITE_BASE}` }, settings: { index_page: 'index.html' } });
  assert.ok(resource.id);
  const synced = await hub.knowledgeSync(product.line, { options: { case_index: false } }); assert.equal(synced.error, null, JSON.stringify(synced));
  bed = { hub, product, site, reviewer: await hub.createUser('合成运行用户') };
  await bed.hub.assignPack(bed.reviewer.principal, 'test-bed'); await bed.hub.assignPack(bed.reviewer.principal, 'case-compile');
  client = await connect(bed.hub, bed.reviewer.token);
  // The three deployment documents pass the real administrator publication boundary.
  for (const [id, value] of [['runner-contract', CONTRACT_DOC], ['runtime-profile', PROFILE_DOC], ['bed-topology', MANIFEST_DOC]] as const) await bed.hub.hub.docs.put(bed.hub.admin.principal, id, bytes(value), { fileName: `${id}.json` });
  subject = await client.upload(original, 'synthetic-cases.json');
  endpoint = await startEndpoint(definition('x').allowed_tools, async (name, args, response) => {
    if (name === 'open_slot' || name === 'touch_slot') return { ok: true, ticket: 'synthetic-ticket', token: 'synthetic-fence', ttl: 60000 };
    if (name === 'close_slot') { releases++; return { ok: true }; }
    if (name === 'inspect_slot') return { build: bed.site.RELEASED, seats: mismatch ? 1 : 2, reachable: true };
    if (name === 'send_blob') {
      submissions++; const payload = Buffer.from(String(args.blob), 'base64');
      assert.ok(await bed.hub.records.store.getByKey('action', `dispatch.bytes:${sha256Hex(payload)}`), 'intent committed before submission');
      latest = { key: `synthetic-remote-${submissions}`, digest: sha256Hex(payload), ids: args.ids as string[], submitted: new Date().toISOString(), payload };
      assert.equal(args.digest, latest.digest);
      if (lose) { response.destroy(); return {}; }
      return { ok: true, key: latest.key, digest: latest.digest, ids: latest.ids };
    }
    if (name === 'inspect_blob') return { state: 'ended', exit: 0 };
    if (name === 'read_blob') return { ...latest, rows: latest.ids.map(id => ({ id, outcome: 'good' })), complete: true };
    return {};
  });
  const raw = definition(endpoint.endpoint);
  const configured = ExecutorDefinition.parse({ ...raw, target: 'bed-a', manifest_sha256: sha256Hex(bytes(MANIFEST_DOC)), resources: MANIFEST_DOC.beds[0].devices.map(d => `bed/bed-a/${d.name}`), precheck_context: { build: bed.site.RELEASED }, proof: { ...raw.proof, package: 'case-compile', slot: 'workbook', warrant_id: 'case-compile.workbook_verified@2.1.0' } });
  executor = (await dispatch().registry.add(bed.hub.admin.principal, configured, 'synthetic-dispatch-key')).id;
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
  test('a plan without a workbook cannot dispatch', async () => {
    const booked = await booking(); const p = await plan(booked); const before = submissions;
    await assert.rejects(dispatch().dispatch(bed.hub.admin.principal, p.run, executor)); assert.equal(submissions, before); await release(booked);
  });
  test('one altered workbook byte gains no support and never dispatches', async () => {
    const booked = await booking(); const p = await plan(booked); const v = await verify(p, 0, true); const before = submissions;
    assert.equal(v.result, null, 'the changed ZIP was refused by the core parser before any workbook support could exist');
    await assert.rejects(dispatch().dispatch(bed.hub.admin.principal, v.run, executor)); assert.equal(submissions, before); await release(booked);
  });
  test('a parseable but altered workbook fails semantic verification and cannot dispatch', async () => {
    const booked = await booking(); const p = await plan(booked); const changed = structuredClone(p.recipe);
    changed.slots.steps[0].args = [line.replace('60', '59')]; p.payload = Buffer.from(generateWorkbook(changed));
    const v = await verify(p); const before = submissions;
    assert.ok(v.result?.result);
    const rows = Object.values(v.result.result.partitions).flat();
    assert.ok(rows.some(row => row.requirements.some(r => r.requirement === 'workbook_verified' && r.status !== 'satisfied')));
    await assert.rejects(dispatch().dispatch(bed.hub.admin.principal, v.run, executor)); assert.equal(submissions, before); await release(booked);
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
    await assert.rejects(dispatch().dispatch(bed.hub.admin.principal, first.run, executor), /冻结|占用|已.*派发|提交/); assert.equal(submissions, before + 1);
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
