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
    await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,manifest_sha256:manifest.body.sha256,allowed_tools:[...c.executor.definition.allowed_tools,'inspect_seat'],probes});
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
  await c.registry.update(c.admin,c.executor.id,{...(await c.registry.get(c.executor.id))!.definition,read_retry_when:[{pointer:'/phase',equals:'occupied'},{pointer:'/touched',equals:false}]});
  // A manifest with no addresses would not reach the transport; version probes still establish retry counts.
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(state.outcome,'not_dispatched');assert.equal(state.frozen,false);
  assert.equal(c.calls.filter(n=>n==='send_blob').length,0);
  assert.equal(c.calls.filter(n=>n==='inspect_seat').length,12);
});

test('an explicit probe refusal does not cause repeated device login attempts',async t=>{
  const c=await setup({extraTools:['inspect_seat'],alter:(name,value)=>name==='inspect_seat'?{ok:false,error:'synthetic authentication refusal',phase:'denied',touched:false}:value});t.after(()=>c.close());
  await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,allowed_tools:[...c.executor.definition.allowed_tools,'inspect_seat'],probes});
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(state.outcome,'not_dispatched');assert.equal(c.calls.filter(n=>n==='inspect_seat').length,1);
  assert.equal(c.calls.filter(n=>n==='send_blob').length,0);
});
