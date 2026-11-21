import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExecutorDefinition } from './definition.ts';
import { definition } from './testing/definition.ts';
import { setup } from './testing/context.ts';
import { canonicalBytes } from '../records/api.ts';

import { probes, probesWithResidue } from './testing/probes.ts';
import { jobCommand } from '../server/cli-job.ts';

test('probe commands and exactly one named extraction group are checked against deployment declarations',()=>{
  const base=definition('http://127.0.0.1:1/');
  assert.ok(ExecutorDefinition.safeParse({...base,allowed_tools:[...base.allowed_tools,'inspect_seat'],probes}).success);
  for (const pattern of ['(.*)','(?<one>.*)(?<two>.*)']) assert.equal(ExecutorDefinition.safeParse({...base,allowed_tools:[...base.allowed_tools,'inspect_seat'],probes:{...probes,seats:[{...probes.seats[0],version:{command:'inspect version',pattern}}]}}).success,false);
  assert.equal(ExecutorDefinition.safeParse({...base,allowed_tools:[...base.allowed_tools,'inspect_seat'],probes:{...probes,seats:[{...probes.seats[0],version:{...probes.seats[0].version,command:'change state'}}]}}).success,false);
});

test('per-seat version and complete address sets are checked in the dispatch lease before submission',async t=>{
  for (const mismatch of ['none','version','extra','missing','alias','content-root-changed-alias','wrong-base-alias','historical-alias']) {
    const c=await setup({extraTools:['inspect_seat'],alter:(name,value)=>{
      if(name!=='inspect_seat') return value;
      const args=c.endpoint.calls.filter(e=>e.params.name==='inspect_seat').at(-1)!.params.arguments as Record<string,unknown>;
      return {output:args.command==='inspect version' ? `version: ${mismatch==='version' && args.seat===1 ? 'other_10_6' : mismatch.includes('alias') ? 'synthetic-alias_10_6' : 'synthetic-build'}` : mismatch==='missing' ? 'no interface rows' : `address: 192.0.2.${Number(args.seat)+1}/24${mismatch==='extra' ? '\naddress: 192.0.2.9/24' : ''}`};
    }}); t.after(()=>c.close());
    const manifest=await c.kit.artifacts.ingest({bytes:canonicalBytes({id:'synthetic-bed',devices:[1,2].map(n=>({interfaces:[{address:`192.0.2.${n}/24`}]}))}),mediaType:'application/json',origin:{upload:{session:'synthetic'}},author:{user:c.owner.id},provenanceType:'declared',visibility:{readers:[c.owner.id],admins:true,packs:[],shareable:false}});
    c.detail.run.sources=c.detail.run.sources.map(s=>s.slot==='synthetic-manifest'?{...s,reference:`src:${manifest.body.sha256}`}:s);
    (c.detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].statement.data as any).bed.manifest_sha256=manifest.body.sha256;
    c.effectDocument.effects[0].parameters.values.manifest_sha256=[manifest.body.sha256];
    await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,manifest_sha256:manifest.body.sha256,allowed_tools:[...c.executor.definition.allowed_tools,'inspect_seat'],probes});
    await c.freezeExecutor();
    if(mismatch.includes('alias')) {
      c.detail.run.product='synthetic-product';c.detail.run.root='a'.repeat(64);
      const base={name:'synthetic-build',base:'synthetic-build',root:(mismatch==='historical-alias'?'b':'a').repeat(64),family:'synthetic',line:'10.6',platform:null,built_at:null,released_at:null,sources:{}};
      c.service.options.knowledge={resolveBuild:async()=>base,builds:async()=>[base,{...base,name:'synthetic-alias_10_6',root:mismatch==='content-root-changed-alias'?'b'.repeat(64):base.root,base:mismatch==='wrong-base-alias'?'other_10_6':base.base}],rootInfo:async()=>[{root:'a'.repeat(64),composition:'c'.repeat(64),product:'synthetic-product',build:base,produced_at:c.now().toISOString()}]};
    }
    const good=mismatch==='none'||mismatch==='alias'||mismatch==='content-root-changed-alias'||mismatch==='historical-alias';
    const result=await c.service.dispatch(c.admin,c.run,c.executor.id);
    assert.equal(result.outcome,good?'effective':'not_dispatched'); assert.equal(result.frozen,false);
    assert.equal(c.calls.filter(n=>n==='send_blob').length,good?1:0);
    assert.ok(c.calls.includes('close_slot'));
    if(good)assert.ok(c.calls.lastIndexOf('inspect_seat')<c.calls.indexOf('send_blob'));
    // The version probe before a dispatch is also each seat's newest device observation, from that job (decision 112).
    if(mismatch==='none')assert.deepEqual((await c.service.latestDeviceObservations()).map(o=>[o.device,o.build,o.job!==null,o.run]),[['/devices/0','synthetic-build',true,null],['/devices/1','synthetic-build',true,null]]);
    await c.close();
  }
});

test('persistent probe refusals retry reads three times and never submit',async t=>{
  const c=await setup({extraTools:['inspect_seat'],alter:(name,value)=>name==='inspect_seat'?{ok:false,error:'synthetic bed busy',phase:'occupied',touched:false}:value});t.after(()=>c.close());
  await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,allowed_tools:[...c.executor.definition.allowed_tools,'inspect_seat'],probes});
    await c.freezeExecutor();
  await c.registry.update(c.admin,c.executor.id,{...(await c.registry.get(c.executor.id))!.definition,read_retry_when:[{pointer:'/phase',equals:'occupied'},{pointer:'/touched',equals:false}]});
    await c.freezeExecutor();
  // A manifest with no addresses would not reach the transport; version probes still establish retry counts.
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(state.outcome,'not_dispatched');assert.equal(state.frozen,false);
  assert.equal(c.calls.filter(n=>n==='send_blob').length,0);
  assert.equal(c.calls.filter(n=>n==='inspect_seat').length,12);
});

test('an explicit probe refusal does not cause repeated device login attempts',async t=>{
  const c=await setup({extraTools:['inspect_seat'],alter:(name,value)=>name==='inspect_seat'?{ok:false,error:'synthetic authentication refusal',phase:'denied',touched:false}:value});t.after(()=>c.close());
  await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,allowed_tools:[...c.executor.definition.allowed_tools,'inspect_seat'],probes});
    await c.freezeExecutor();
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(state.outcome,'not_dispatched');assert.equal(c.calls.filter(n=>n==='inspect_seat').length,1);
  assert.equal(c.calls.filter(n=>n==='send_blob').length,0);
});

/** A bed manifest whose devices declare their type: the unit under test plus the routers, clients and servers the compile
 * binds addresses from. Only the declared dispatch targets can be probed by the gateway. */
const typedManifest = (devices: Array<{ name: string; type?: string; address: string }>) => ({
  id: 'synthetic-bed',
  devices: devices.map((device) => ({ name: device.name, ...(device.type === undefined ? {} : { type: device.type }), interfaces: [{ address: device.address }] })),
});
const BED = [
  { name: 'dut0', type: 'load-balancer', address: '192.0.2.1/24' },
  { name: 'router0', type: 'router', address: '192.0.2.2/24' },
  { name: 'client0', type: 'client', address: '192.0.2.3/24' },
];

/** Binds a bed manifest and a probe declaration to the executor of a fresh harness. */
async function bindBed(c: Awaited<ReturnType<typeof setup>>, manifest: unknown, spec: unknown): Promise<void> {
  const stored = await c.kit.artifacts.ingest({ bytes: canonicalBytes(manifest), mediaType: 'application/json', origin: { upload: { session: 'synthetic' } }, author: { user: c.owner.id }, provenanceType: 'declared', visibility: { readers: [c.owner.id], admins: true, packs: [], shareable: false } });
  c.detail.run.sources = c.detail.run.sources.map(s => s.slot === 'synthetic-manifest' ? { ...s, reference: `src:${stored.body.sha256}` } : s);
  (c.detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].statement.data as any).bed.manifest_sha256 = stored.body.sha256;
  c.effectDocument.effects[0].parameters.values.manifest_sha256 = [stored.body.sha256];
  await c.registry.update(c.admin, c.executor.id, { ...c.executor.definition, manifest_sha256: stored.body.sha256, allowed_tools: [...c.executor.definition.allowed_tools, 'inspect_seat'], probes: spec });
  await c.freezeExecutor();
}

/** One seat per index, each reading the version and the interfaces of its manifest device. */
const seatsFor = (indexes: number[]) => indexes.map(index => probes.seats[0]).map((seat, at) => ({ ...seat, seat: `synthetic-${indexes[at]}`, index: indexes[at], manifest: { ...seat.manifest, device: `/devices/${indexes[at]}` } }));

test('only declared dispatch targets need a probe seat; the other manifest devices are listed as unprobed', async t => {
  const c = await setup({ extraTools: ['inspect_seat'], alter: (name, value) => {
    if (name !== 'inspect_seat') return value;
    const args = c.endpoint.calls.filter(e => e.params.name === 'inspect_seat').at(-1)!.params.arguments as Record<string, unknown>;
    return { output: args.command === 'inspect version' ? 'version: synthetic-build' : `address: 192.0.2.${Number(args.seat) + 1}/24` };
  } }); t.after(() => c.close());
  await bindBed(c, typedManifest(BED), { ...probes, dispatch_targets: { type_field: '/type', types: ['load-balancer'] }, seats: seatsFor([0]) });
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(state.outcome, 'effective', JSON.stringify(state));
  assert.equal(c.calls.filter(n => n === 'send_blob').length, 1, 'the payload goes to the one probed seat');
  assert.equal(c.calls.filter(n => n === 'inspect_seat').length, 2, 'only the dispatch target is probed (version and interfaces)');
  assert.deepEqual(state.unprobed_devices, [{ index: 1, type: 'router' }, { index: 2, type: 'client' }]);
});

test('a declared dispatch target without a probe seat still refuses the precheck', async t => {
  const c = await setup({ extraTools: ['inspect_seat'], alter: (name, value) => {
    if (name !== 'inspect_seat') return value;
    const args = c.endpoint.calls.filter(e => e.params.name === 'inspect_seat').at(-1)!.params.arguments as Record<string, unknown>;
    return { output: args.command === 'inspect version' ? 'version: synthetic-build' : `address: 192.0.2.${Number(args.seat) + 1}/24` };
  } }); t.after(() => c.close());
  for (const [name, types, seats, missing] of [
    ['a second target type without a seat', ['load-balancer', 'router'], [0], '2 个派发目标'],
    ['no target declaration at all, so every device is one', undefined, [0], '3 个派发目标'],
    ['a seat for a device that is not a target', ['load-balancer'], [0, 1], '1 个派发目标'],
  ] as const) {
    await bindBed(c, typedManifest(BED), { ...probes, ...(types === undefined ? {} : { dispatch_targets: { type_field: '/type', types: [...types] } }), seats: seatsFor([...seats]) });
    const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
    assert.equal(state.outcome, 'not_dispatched', name);
    assert.equal(c.calls.filter(n => n === 'send_blob').length, 0, name);
    assert.match(state.missing_fact ?? '', /一一对应探测座位/, name);
    assert.ok((state.missing_fact ?? '').includes(missing), `${name}: ${state.missing_fact}`);
  }
});

test('a manifest device without a declared type stops the precheck instead of being guessed', async t => {
  const c = await setup({ extraTools: ['inspect_seat'] }); t.after(() => c.close());
  await bindBed(c, typedManifest([{ name: 'dut0', type: 'load-balancer', address: '192.0.2.1/24' }, { name: 'unknown0', address: '192.0.2.4/24' }]), { ...probes, dispatch_targets: { type_field: '/type', types: ['load-balancer'] }, seats: seatsFor([0]) });
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(state.outcome, 'not_dispatched');
  assert.equal(c.calls.filter(n => n === 'send_blob').length, 0);
  assert.match(state.missing_fact ?? '', /没有声明的类型字段/);
  assert.match(state.next_action ?? '', /类型字段|派发座位/);
});

type Harness = Awaited<ReturnType<typeof setup>>;
const PROMPT = 'DEMO#';
const EMPTY_PEERS = `peers:\nname        address\n${PROMPT}`;
const LEAKED = 'unit-b      DO_NOT_DISCLOSE_REMOTE_VALUE';
const READ_BUSY_RETRIED = [{ pointer: '/phase', equals: 'occupied' }, { pointer: '/touched', equals: false }];
const BUSY = { ok: false, error: 'synthetic bed busy', phase: 'occupied', touched: false };

async function setupResidue(t: { after: (fn: () => unknown) => void }, answer: (seat: number, command: string) => Record<string, unknown> | string | undefined, options: { lockedBuild?: string; definition?: Record<string, unknown> } = {}): Promise<Harness> {
  const ref: { c?: Harness } = {};
  const c = await setup({ lockedBuild: options.lockedBuild, alter: (name, value) => {
    if (name !== 'inspect_bound_seat') return value;
    const args = ref.c!.endpoint.calls.filter(e => e.params.name === 'inspect_bound_seat').at(-1)!.params.arguments as Record<string, unknown>;
    const reply = answer(Number(args.seat), String(args.command));
    if (reply !== undefined) return typeof reply === 'string' ? { output: reply } : reply;
    return args.command === 'inspect peers' ? { output: EMPTY_PEERS } : args.command === 'inspect units' ? { output: PROMPT } : value;
  } });
  ref.c = c; t.after(() => c.close());
  const d = c.executor.definition;
  await c.registry.update(c.admin, c.executor.id, { ...d, ...options.definition, probes: { ...probesWithResidue, call: d.probes!.call } });
  await c.freezeExecutor();
  return c;
}
const reads = (c: Harness) => c.endpoint.calls.filter(e => e.params.name === 'inspect_bound_seat').map(e => e.params.arguments as Record<string, unknown>);
const probeEvents = async (c: Harness, job: string) => (await c.service.journal.events(job)).filter(e => e.body.detail.phase === 'device_probe');
const cli = (c: Harness, lines: string[]) => ({ out: (s: string) => lines.push(s), err: (s: string) => lines.push(s), admin: async () => c.admin, records: async () => c.kit, hub: async () => ({ dispatch: c.service, records: c.kit }), options: {}, ctx: { io: { cwd: c.kit.dataDir } } });

test('a clean bed passes the residue probes: the headers never count and an empty answer is empty only with its closing line', async t => {
  const c = await setupResidue(t, () => undefined);
  const state = await c.service.precheck(c.admin, c.executor.id);
  assert.equal(state.failed_checks, undefined, JSON.stringify(state));
  const events = await c.service.journal.events(state.job);
  assert.ok(events.some(e => e.body.detail.readonly_verified === true));
  assert.deepEqual((await probeEvents(c, state.job)).filter(e => String(e.body.detail.check).startsWith('residue-')).map(e => [e.body.detail.seat, e.body.detail.check, e.body.detail.state, e.body.detail.matched]), [
    ['synthetic-0', 'residue-1', 'clean', true], ['synthetic-0', 'residue-2', 'clean', true], ['synthetic-1', 'residue-1', 'clean', true], ['synthetic-1', 'residue-2', 'clean', true]]);
  // Per seat: version, interfaces, then the declared residue commands in order, each bound to the lease.
  assert.deepEqual(reads(c).map(a => [a.seat, a.command]), [0, 1].flatMap(seat => ['inspect version', 'inspect interfaces', 'inspect peers', 'inspect units'].map(command => [seat, command])));
  assert.ok(reads(c).every(a => a.ticket === 'synthetic-ticket'));
  // A dispatch reads them again, in its own lease, before anything is submitted.
  const dispatched = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(dispatched.outcome, 'effective', JSON.stringify(dispatched));
  assert.equal(reads(c).length, 16, 'the dispatch does not reuse the precheck');
  assert.equal(c.calls.filter(n => n === 'send_blob').length, 1);
  assert.ok(c.calls.lastIndexOf('inspect_bound_seat') < c.calls.indexOf('send_blob'));
});

test('residue on one seat stops the precheck and the dispatch with a statement that names the seat and the command', async t => {
  let dirty = true;
  const c = await setupResidue(t, (seat, command) => dirty && seat === 1 && command === 'inspect peers' ? `peers:\nname        address\n${LEAKED}\n${PROMPT}` : undefined);
  const state = await c.service.precheck(c.admin, c.executor.id);
  assert.equal(state.outcome, 'not_dispatched'); assert.equal(state.frozen, false);
  assert.equal(state.failed_checks?.length, 1, JSON.stringify(state.failed_checks));
  const [check] = state.failed_checks!;
  assert.deepEqual([check.step, check.seat, check.check], ['device_probe', 'synthetic-1', 'residue-1']);
  assert.match(check.missing_fact, /^设备 synthetic-1 读取 inspect peers 后.*残留/);
  assert.match(check.next_action, /重新上机验证/);
  assert.match(check.next_action, /清掉残留/);
  assert.match(state.missing_fact!, /设备 synthetic-1 读取 inspect peers/);
  assert.equal(JSON.stringify(state).includes('DO_NOT_DISCLOSE_REMOTE_VALUE'), false, 'the answer to the user carries no device line');
  const events = await c.service.journal.events(state.job);
  assert.ok(events.some(e => e.body.detail.readonly_verified === false));
  assert.equal(JSON.stringify(events.map(e => e.body)).includes('DO_NOT_DISCLOSE_REMOTE_VALUE'), false, 'no journal record holds a device line');
  // The line is kept where the other probe output is kept: the restricted assessment and the saved original.
  const found = events.find(e => e.body.detail.check === 'residue-1' && e.body.detail.matched === false)!;
  assert.equal(found.body.detail.state, 'residue');
  const [assessment, original] = found.body.inputs;
  const assessed = JSON.parse(new TextDecoder().decode((await c.kit.artifacts.source(c.admin, assessment.slice(4)))!.bytes!));
  assert.deepEqual([assessed.seat, assessed.command, assessed.state, assessed.actual, assessed.expected], ['synthetic-1', 'inspect peers', 'residue', [LEAKED], []]);
  assert.ok(new TextDecoder().decode((await c.kit.artifacts.source(c.admin, original.slice(4), { consumer: 'function' }))!.bytes!).includes('DO_NOT_DISCLOSE_REMOTE_VALUE'));
  // The dispatch stops at the same finding: nothing is submitted, the lease is given back, no intent is written.
  const dispatched = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(dispatched.outcome, 'not_dispatched'); assert.equal(dispatched.frozen, false);
  assert.deepEqual(dispatched.failed_checks?.map(x => [x.seat, x.check]), [['synthetic-1', 'residue-1']]);
  assert.equal(JSON.stringify(dispatched).includes('DO_NOT_DISCLOSE_REMOTE_VALUE'), false);
  assert.equal(c.calls.filter(n => n === 'send_blob').length, 0);
  assert.ok(c.calls.includes('close_slot'));
  assert.equal((await c.service.journal.events(dispatched.job)).some(e => e.body.detail.phase === 'intent'), false);
  // Nothing was submitted and no intent was written, so once the administrator has cleaned the device the same run dispatches.
  dirty = false;
  const again = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(again.outcome, 'effective', JSON.stringify(again));
  assert.equal(c.calls.filter(n => n === 'send_blob').length, 1);
});

test('one precheck lists every seat and command with residue, and reads the next command after a finding', async t => {
  const c = await setupResidue(t, (seat, command) => command === 'inspect version' || command === 'inspect interfaces' ? undefined : seat === 0 && command === 'inspect units' ? `unit-a 192.0.2.5\n${PROMPT}` : seat === 1 ? `unit-b 192.0.2.6\n${PROMPT}` : undefined);
  const state = await c.service.precheck(c.admin, c.executor.id);
  assert.deepEqual(state.failed_checks?.map(x => [x.seat, x.check]), [['synthetic-0', 'residue-2'], ['synthetic-1', 'residue-1'], ['synthetic-1', 'residue-2']]);
  assert.equal(reads(c).length, 8, 'a finding does not end the collection');
});

test('residue is judged beside the version and interfaces rules, which stay as they were', async t => {
  const c = await setupResidue(t, (seat, command) => seat === 1 && command === 'inspect version' ? 'version: other_10_6' : seat === 0 && command === 'inspect peers' ? `unit-b 192.0.2.6\n${PROMPT}` : undefined, { lockedBuild: 'synthetic-build' });
  const state = await c.service.precheck(c.admin, c.executor.id, c.run);
  assert.deepEqual(state.failed_checks?.map(x => [x.seat, x.check]), [['synthetic-0', 'residue-1'], ['synthetic-1', 'version']]);
  assert.match(state.failed_checks![1].missing_fact, /座位 synthetic-1 的 version：回显值与锁定构建或绑定清单不符/);
});

for (const [name, reply, fact] of [
  ['a blank answer', '', /没有声明的收尾行/],
  ['headers without the closing line', 'peers:\nname        address', /没有声明的收尾行/],
  ['a line the definition declares as a failure', '% rejected: no such command\nDEMO#', /设备输出说明读取失败/],
  ['a tool answer that holds no text', { output: 5 }, /没有文字回答/],
] as const) {
  test(`${name} is an unread bed, never a clean one and never a residue`, async t => {
    const c = await setupResidue(t, (seat, command) => seat === 0 && command === 'inspect peers' ? reply : undefined);
    const state = await c.service.precheck(c.admin, c.executor.id);
    assert.equal(state.outcome, 'not_dispatched');
    assert.deepEqual(state.failed_checks?.map(x => [x.seat, x.check]), [['synthetic-0', 'residue-1']]);
    assert.match(state.failed_checks![0].missing_fact, fact);
    assert.match(state.failed_checks![0].missing_fact, /不能判断设备上有没有残留/);
    assert.doesNotMatch(state.failed_checks![0].missing_fact, /留有/);
    assert.deepEqual((await probeEvents(c, state.job)).filter(e => e.body.detail.matched === false).map(e => e.body.detail.state), ['unread']);
    assert.equal(c.calls.includes('send_blob'), false);
  });
}

test('a refused residue read stops all further reading of the device and is not reported as residue', async t => {
  const c = await setupResidue(t, (seat, command) => seat === 0 && command === 'inspect peers' ? { ok: false, error: 'synthetic refusal', phase: 'denied', touched: false } : undefined);
  const state = await c.service.precheck(c.admin, c.executor.id);
  assert.equal(state.outcome, 'not_dispatched');
  assert.deepEqual(state.failed_checks?.map(x => [x.seat, x.check]), [['synthetic-0', 'residue-1']]);
  assert.match(state.failed_checks![0].missing_fact, /设备拒绝读取.*不能判断设备上有没有残留/);
  assert.equal(reads(c).length, 3, 'version, interfaces and the refused command; no repeated login, no later seat');
  assert.ok(c.calls.includes('close_slot'));
});

test('a residue read that fails the way the definition calls safe to repeat is read again, three times at most', async t => {
  let busy = 1;
  const once = await setupResidue(t, (seat, command) => seat === 0 && command === 'inspect peers' && busy-- > 0 ? BUSY : undefined, { definition: { read_retry_when: READ_BUSY_RETRIED } });
  const state = await once.service.precheck(once.admin, once.executor.id);
  assert.equal(state.failed_checks, undefined, JSON.stringify(state.failed_checks));
  assert.equal(reads(once).length, 9, 'one extra read of the command that failed once');
  const always = await setupResidue(t, (seat, command) => seat === 0 && command === 'inspect units' ? BUSY : undefined, { definition: { read_retry_when: READ_BUSY_RETRIED } });
  const failed = await always.service.precheck(always.admin, always.executor.id);
  assert.deepEqual(failed.failed_checks?.map(x => [x.seat, x.check]), [['synthetic-0', 'residue-2']]);
  assert.match(failed.failed_checks![0].missing_fact, /连续三次不可用/);
  assert.equal(reads(always).length, 10, 'three reads of the failing command, then the other seat is read as usual');
});

test('the job command prints the residue statement and the way out, and no device line', async t => {
  const c = await setupResidue(t, (seat, command) => seat === 1 && command === 'inspect peers' ? `${LEAKED}\n${PROMPT}` : undefined);
  const lines: string[] = [];
  assert.equal(await jobCommand(cli(c, lines), ['precheck', '--executor', c.executor.id]), 1);
  const text = lines.join('\n');
  assert.match(text, /设备 synthetic-1 读取 inspect peers 后发现残留/);
  assert.match(text, /下一步：管理员核对设备输出并清掉残留/);
  assert.doesNotMatch(text, /DO_NOT_DISCLOSE_REMOTE_VALUE|synthetic-secret/);
  assert.equal(c.calls.includes('send_blob'), false);
});

test('a seat that declares no residue probes is read exactly as before', async t => {
  const c = await setup(); t.after(() => c.close());
  assert.equal(Object.hasOwn(c.executor.definition.probes!.seats[0], 'residue'), false);
  const state = await c.service.precheck(c.admin, c.executor.id);
  assert.equal(state.failed_checks, undefined);
  assert.equal(reads(c).length, 4, 'version and interfaces on two seats');
  assert.equal((await probeEvents(c, state.job)).some(e => String(e.body.detail.check).startsWith('residue')), false);
});
