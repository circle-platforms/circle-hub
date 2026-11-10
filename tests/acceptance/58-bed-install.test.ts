// Scenario 58 (decisions 117 and 144): a build installed on a whole booked bed through the Hub's own dispatch, as the test
// framework's upgrade cases run. The upgrade cases and the image extensions they take come from the install profile an
// administrator publishes as a named document (doc:doc:bed-install-profile), the finish marker from the executor definition;
// the pack carries none of them. All endpoints, documents, builds, images and bytes in this suite are synthetic.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { z } from 'zod';
import BED_INSTALL_PACK from '../../packs/workflow/bed-install/pack.json' with { type: 'json' };
import PROFILE from '../../packs/workflow/bed-install/examples/bed-install-profile.json' with { type: 'json' };
import { addSyntheticExecutor } from '../../hub/dispatch/testing/credentials.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { osIsolationAvailable } from '../../hub/rules/api.ts';
import { sha256Hex } from '../../hub/records/api.ts';
import { ExecutorDefinition, readRunJobs, type JobStatus } from '../../hub/dispatch/api.ts';
import { definition } from '../../hub/dispatch/testing/definition.ts';
import { startEndpoint } from '../../hub/dispatch/testing/server.ts';
import { MANIFEST_DOC as BASE_MANIFEST } from '../../packs/workflow/case-compile/functions/test-support.ts';
import { createTestHub, type TestHub, type TestUser } from '../../hub/server/testing-real.ts';
import { productSite, twoNameProduct, type ProductSite, type ProductPack } from './support/env.ts';
import { connect, type McpClient } from './support/mcp.ts';
import type { StartRunOutput, SubmitResultOutput } from '../../contracts/src/tools.ts';

const skip = (await osIsolationAvailable()) ? false : 'no OS isolation on this machine: real isolated pack execution unavailable';
const MANIFEST_DOC = { ...BASE_MANIFEST, beds: BASE_MANIFEST.beds.map((bed) => ({ ...bed, devices: bed.devices.map((device) => ({ ...device, interfaces: [...device.ipv4, ...device.ipv6] })) })) };
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const TARGET = 'Rel_FAMX_9_2_1_8';
const REQUEST = { schema: 'bed-install@1', build: TARGET, image: `FAMXOS-${TARGET}.img` };
const CASES = PROFILE.upgrade_cases.slice(0, 2);
/** The synthetic finish line every upgrade case writes; only the executor definition knows it. */
const FINISH = 'SYNTHETIC_UPGRADE_END';

let postgres: TemporaryPostgres | undefined; let opened: TestHub | undefined;
let bed: { hub: TestHub; product: ProductPack; site: ProductSite; user: TestUser }; let client: McpClient;
let endpoint: Awaited<ReturnType<typeof startEndpoint>>;
let sent: Buffer[] = [];
let latest: { request: string; key: string; digest: string; ids: string[]; submitted: string } | undefined;
const dispatch = () => { assert.ok(bed.hub.hub.dispatch); return bed.hub.hub.dispatch; };

async function call(args: Record<string, unknown>) { return client.call('start_run', args); }
async function start(args: Record<string, unknown>): Promise<z.infer<typeof StartRunOutput>> {
  const answer = await call(args); assert.equal(answer.isError, false, JSON.stringify(answer.out.errors)); assert.ok(answer.out.run); return answer.out;
}
const inventory = { external: 'doc:doc:bed-topology' };
const profile = { external: 'doc:doc:bed-install-profile' };
async function wholeBed(): Promise<string> {
  const need = { devices: [{ type: 'load-balancer', count: 2 }, { type: 'router', count: 1 }, { type: 'client', count: 1 }, { type: 'server', count: 1 }, { type: 'console', count: 1 }] };
  return (await start({ pack: 'test-bed', inputs: { inventory }, parameters: { action: 'acquire', bed: 'bed-a', need } })).run!.run;
}
const installArgs = (booking: string, reference: string, profileInput: unknown = profile) => ({ pack: 'bed-install', product: bed.product.names[0], build: bed.site.RELEASED, predecessor: booking, inputs: { inventory, profile: profileInput, request: { reference } }, parameters: { bed: 'bed-a' } });
async function install(booking: string, request: unknown = REQUEST, claimed = TARGET) {
  const reference = await client.upload(bytes(request), 'install.json', 'application/json');
  const run = (await start(installArgs(booking, reference))).run!;
  const items = run.items.map((item) => item.id);
  const submission = { run: run.run, model: 'synthetic-scripted-model', items: items.map((item) => ({ item, handling: 'handled', slots: { reason: [{ text: `合成依据：要装 ${claimed}`, data: { build: claimed } }] } })) };
  const result = (await client.call('submit_result', submission)).out as z.infer<typeof SubmitResultOutput>;
  return { run: run.run, items, submission, result, reference };
}
async function settled(run: string, note: { job?: string } | undefined): Promise<JobStatus> {
  assert.ok(note?.job);
  for (let i = 0; i < 600; i++) {
    const job = (await readRunJobs(bed.hub.records, dispatch(), bed.hub.admin.principal, run)).find((row) => row.job === note.job);
    if (job?.ended) return job.status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the install job did not end');
}

before(async () => {
  if (skip) return;
  postgres = await startPostgres();
  const site = await productSite(); const product = await twoNameProduct();
  const hub = await createTestHub({ postgres, repositoryPacks: [product.id, 'build-site', 'test-bed', 'bed-install', 'case-compile'], buildSite: site.site(), requireOsIsolation: true }); opened = hub;
  const resource = await hub.addResource({ system_pack: 'build-site', name: '合成构建站', environment: 'test', origins: { 'build-site': `${hub.stubs!.buildSite.origin}${site.SITE_BASE}` }, settings: { index_page: 'index.html' } });
  assert.ok(resource.id);
  for (const active of await hub.hub.registry.activeProducts()) for (const variable of active.product.variables ?? []) await hub.records.variables.setVariable(hub.admin.principal, variable.name, variable.default, '合成装构建验收显式部署设置');
  const synced = await hub.knowledgeSync(product.line, { options: { case_index: false } }); assert.equal(synced.error, null, JSON.stringify(synced));
  bed = { hub, product, site, user: await hub.createUser('合成运行用户') };
  // A real user also holds a pack bound to the product line (case-compile here), which makes the product readable to them.
  for (const pack of ['test-bed', 'bed-install', 'case-compile']) await hub.assignPack(bed.user.principal, pack);
  client = await connect(hub, bed.user.token);
  await hub.hub.docs.put(hub.admin.principal, 'bed-topology', bytes(MANIFEST_DOC), { fileName: 'bed-topology.json' });
  await hub.hub.docs.put(hub.admin.principal, 'bed-install-profile', bytes(PROFILE), { fileName: 'bed-install-profile.json' });
  await hub.hub.docs.put(hub.admin.principal, 'bed-install-profile-short', bytes({ ...PROFILE, upgrade_cases: PROFILE.upgrade_cases.slice(0, 1) }), { fileName: 'bed-install-profile-short.json' });
  endpoint = await startEndpoint([...definition('x').allowed_tools, 'inspect_seat'], async (name, args) => {
    if (name === 'open_slot' || name === 'touch_slot') return { ok: true, ticket: 'synthetic-ticket', token: 'synthetic-fence', ttl: 60000 };
    if (name === 'close_slot') return { ok: true };
    if (name === 'inspect_slot') return { build: bed.site.RELEASED, seats: MANIFEST_DOC.beds[0].devices.length, reachable: true };
    if (name === 'inspect_seat') {
      const device = MANIFEST_DOC.beds[0].devices[Number(args.seat)]; assert.ok(device);
      return { output: args.command === 'inspect version' ? `version: ${bed.site.RELEASED}` : device.interfaces.map((address) => `address: ${address}`).join('\n') };
    }
    if (name === 'send_blob') {
      const payload = Buffer.from(String(args.blob), 'base64'); sent.push(payload);
      latest = { request: String(args.request), key: `synthetic-install-${sent.length}`, digest: sha256Hex(payload), ids: args.ids as string[], submitted: new Date().toISOString() };
      assert.equal(args.digest, latest.digest);
      return { request: latest.request, ok: true, key: latest.key, digest: latest.digest, ids: latest.ids };
    }
    if (name === 'inspect_blob') return { state: 'ended', exit: 0 };
    if (name === 'read_blob') return { ...latest, rows: latest!.ids.map((id) => ({ id, outcome: 'good', log: `synthetic upgrade ${id}\n${FINISH} 1` })), complete: true };
    return {};
  });
  const raw = definition(endpoint.endpoint);
  const devices = MANIFEST_DOC.beds[0].devices;
  const configured = ExecutorDefinition.parse({ ...raw, target: 'bed-a', manifest_sha256: sha256Hex(bytes(MANIFEST_DOC)),
    resources: devices.map((device) => `bed/bed-a/${device.name}`), precheck_context: { product: bed.product.line },
    allowed_tools: [...raw.allowed_tools, 'inspect_seat'], refused_tools: ['synthetic_admin_reset'], conditions: raw.conditions.map((condition) => condition.pointer === '/seats' ? { ...condition, at_least: devices.length } : condition),
    probes: { devices: '/beds/0/devices', command_pattern: '^inspect (?:version|interfaces)$', call: { tool: 'inspect_seat', arguments: { seat: { $value: 'seat_index' }, command: { $value: 'command' }, ticket: { $value: 'lease_id' } } }, output: '/output',
      seats: devices.map((device, index) => ({ seat: device.name, index, manifest: { device: `/beds/0/devices/${index}`, addresses: '/interfaces', address: '' }, version: { command: 'inspect version', pattern: '^version: (?<value>.+)$' }, interfaces: { command: 'inspect interfaces', pattern: '^address: (?<value>.+)$' } })) },
    // The finish marker is deployment data of the executor definition, never of the pack (decision 144).
    result: { ...raw.result, request_id: '/request', log: '/log', closing_marker: FINISH },
    proof: { ...raw.proof, package: 'bed-install', requirement: 'install', slot: 'request', warrant_id: `bed-install.install@${BED_INSTALL_PACK.version}` } });
  await addSyntheticExecutor(bed.hub.records, dispatch().registry, bed.hub.admin.principal, configured, 'synthetic-install-key');
});
after(async () => { await client?.close(); await endpoint?.close(); await opened?.close(); await postgres?.stop(); });
beforeEach(async () => {
  sent = []; latest = undefined;
  if (!skip && bed) { const keys = (await bed.hub.leases.view('bed/')).entries.map((entry) => entry.key); if (keys.length) await bed.hub.leases.forceRelease({ keys, by: bed.hub.admin.principal.id, reason: '合成测试之间的隔离清理' }); }
});

describe('scenario 58: installing a build on a whole booked bed from the published install profile (decisions 117, 144)', { skip }, () => {
  test('the accepted install run is dispatched once by the Hub with the uploaded request bytes, one verdict row per profile upgrade case', async () => {
    const booking = await wholeBed();
    const run = await install(booking);
    assert.deepEqual(run.items, CASES, 'one upgrade case of the profile per load balancer of the bed, in inventory order');
    assert.equal(run.result.acceptance, 'accepted', JSON.stringify(run.result.errors));
    assert.ok(run.result.result!.partitions.delivered.every((item) => item.requirements.every((requirement) => requirement.status === 'satisfied')), JSON.stringify(run.result.result));
    const note = run.result.dispatch?.[0]; assert.match(note?.text ?? '', /已按任务包的效果行派发作业/, JSON.stringify(run.result.dispatch));
    const state = await settled(run.run, note);
    assert.equal(state.outcome, 'effective'); assert.equal(state.frozen, false);
    assert.equal(sent.length, 1); assert.deepEqual(JSON.parse(sent[0].toString()), REQUEST, 'the gateway receives exactly the checked request bytes');
    assert.deepEqual(latest!.ids, CASES, 'the dispatched items are the profile\'s upgrade cases');
    const source = await bed.hub.records.artifacts.source(bed.user.principal, state.result!.slice(4)); assert.ok(source?.bytes);
    const report = JSON.parse(Buffer.from(source.bytes).toString()) as { rows: Array<{ item: string; reported_terminal: string }> };
    assert.deepEqual(report.rows.map((row) => [row.item, row.reported_terminal]), CASES.map((id) => [id, 'pass']));
    // Repeating the same submission reads the job; it never installs again.
    const again = (await client.call('submit_result', run.submission)).out as z.infer<typeof SubmitResultOutput>;
    assert.equal(again.dispatch?.[0].job, note!.job); assert.equal(sent.length, 1);
  });

  test('the same request bytes are not installed twice; a retry is a new request with its attempt', async () => {
    const booking = await wholeBed();
    // The scenario's first test installed REQUEST itself: this one starts from its own first attempt.
    const first = await install(booking, { ...REQUEST, attempt: 1 });
    await settled(first.run, first.result.dispatch?.[0]);
    assert.equal(sent.length, 1);
    // The at-most-once guard answers the runner with the job that used these bytes and its way out, not an administrator.
    const again = await install(booking, { ...REQUEST, attempt: 1 });
    assert.equal(again.result.acceptance, 'accepted', JSON.stringify(again.result.errors));
    const refused = again.result.dispatch?.[0];
    assert.equal(refused?.job, undefined, JSON.stringify(again.result.dispatch));
    assert.match(refused?.text ?? '', /这份产物已经由作业 [0-9a-f]{64} 派发过，作业已结束；同一任务血缘的这份字节只派发一次/);
    assert.doesNotMatch(refused?.text ?? '', /等管理员/);
    assert.equal(sent.length, 1);
    const retry = await install(booking, { ...REQUEST, attempt: 2 });
    assert.equal(retry.result.acceptance, 'accepted', JSON.stringify(retry.result.errors));
    await settled(retry.run, retry.result.dispatch?.[0]);
    assert.equal(sent.length, 2);
    assert.deepEqual(JSON.parse(sent[1].toString()), { ...REQUEST, attempt: 2 });
  });

  test('an image that is not the requested build or has an extension the profile does not list, or a bed not wholly booked, is refused and nothing is dispatched', async () => {
    const booking = await wholeBed();
    const wrong = await install(booking, { ...REQUEST, image: 'FAMXOS-Rel_FAMX_9_2_1_9.img' });
    assert.notEqual(wrong.result.acceptance === 'accepted' && wrong.result.dispatch?.some((row) => row.job), true, JSON.stringify(wrong.result.dispatch));
    assert.match(JSON.stringify(wrong.result), /bed-install\.request_invalid/);
    const extension = await install(booking, { ...REQUEST, image: `FAMXOS-${TARGET}.iso` });
    assert.notEqual(extension.result.acceptance === 'accepted' && extension.result.dispatch?.some((row) => row.job), true, JSON.stringify(extension.result.dispatch));
    assert.match(JSON.stringify(extension.result), /以装构建档案写的 \.img 结尾/);
    assert.equal(sent.length, 0);
    const keys = (await bed.hub.leases.view('bed/')).entries.map((entry) => entry.key);
    await bed.hub.leases.forceRelease({ keys: keys.filter((key) => key.endsWith('/console0')), by: bed.hub.admin.principal.id, reason: '合成：整台中的一台被释放' });
    const partial = await install(booking);
    assert.match(JSON.stringify(partial.result), /bed-install\.booking_missing/);
    assert.equal(sent.length, 0);
  });

  test('without the published profile, or with too few upgrade cases in it, the run is refused with the missing fact and the administrator\'s next step', async () => {
    const booking = await wholeBed();
    const reference = await client.upload(bytes(REQUEST), 'install.json', 'application/json');
    const absent = await call(installArgs(booking, reference, { external: 'doc:doc:bed-install-profile-unpublished' }));
    assert.equal(absent.isError, true, JSON.stringify(absent.out));
    assert.match(JSON.stringify(absent.out.errors), /SOURCE_ABSENT/);
    assert.match(JSON.stringify(absent.out.errors), /circle-hub doc put/);
    const short = await call(installArgs(booking, reference, { external: 'doc:doc:bed-install-profile-short' }));
    assert.equal(short.isError, true, JSON.stringify(short.out));
    const errors = JSON.stringify(short.out.errors);
    assert.match(errors, /bed-install\.too_many_targets/);
    assert.match(errors, /circle-hub doc put bed-install-profile-short <文件>/);
    assert.equal(sent.length, 0);
  });
});
