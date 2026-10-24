import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExecutorDefinition } from './definition.ts';
import { definition } from './testing/definition.ts';
import { setup } from './testing/context.ts';
import { canonicalBytes } from '../records/api.ts';

import { probes } from './testing/probes.ts';

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
