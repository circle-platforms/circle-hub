import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExecutorDefinition } from './definition.ts';
import { definition } from './testing/definition.ts';
import { setup } from './testing/context.ts';
import { canonicalBytes } from '../records/api.ts';

export const probes = {command_pattern:'^inspect (?:version|interfaces)$',call:{tool:'inspect_seat',arguments:{seat:{$value:'seat_index'},command:{$value:'command'},ticket:{$value:'lease_id'}}},output:'/output',seats:[0,1].map(index=>({seat:`synthetic-${index}`,index,manifest:{device:`/devices/${index}`,addresses:'/interfaces',address:'/address'},version:{command:'inspect version',pattern:'^version: (?<value>.+)$'},interfaces:{command:'inspect interfaces',pattern:'^address: (?<value>.+)$'}}))};

test('probe commands and exactly one named extraction group are checked against deployment declarations',()=>{
  const base=definition('http://127.0.0.1:1/');
  assert.ok(ExecutorDefinition.safeParse({...base,allowed_tools:[...base.allowed_tools,'inspect_seat'],probes}).success);
  for (const pattern of ['(.*)','(?<one>.*)(?<two>.*)']) assert.equal(ExecutorDefinition.safeParse({...base,allowed_tools:[...base.allowed_tools,'inspect_seat'],probes:{...probes,seats:[{...probes.seats[0],version:{command:'inspect version',pattern}}]}}).success,false);
  assert.equal(ExecutorDefinition.safeParse({...base,allowed_tools:[...base.allowed_tools,'inspect_seat'],probes:{...probes,seats:[{...probes.seats[0],version:{...probes.seats[0].version,command:'change state'}}]}}).success,false);
});

test('per-seat version and complete address sets are checked in the dispatch lease before submission',async t=>{
  for (const mismatch of ['none','version','extra','missing','alias','stale-alias']) {
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
      const base={name:'synthetic-build',base:'synthetic-build',root:'a'.repeat(64),family:'synthetic',line:'10.6',platform:null,built_at:null,released_at:null,sources:{}};
      c.service.options.knowledge={resolveBuild:async()=>base,builds:async()=>[base,{...base,name:'synthetic-alias_10_6',root:mismatch==='stale-alias'?'b'.repeat(64):base.root}]};
    }
    const good=mismatch==='none'||mismatch==='alias';
    const result=await c.service.dispatch(c.admin,c.run,c.executor.id);
    assert.equal(result.outcome,good?'effective':'not_dispatched'); assert.equal(result.frozen,false);
    assert.equal(c.calls.filter(n=>n==='send_blob').length,good?1:0);
    assert.ok(c.calls.includes('close_slot'));
    if(good)assert.ok(c.calls.lastIndexOf('inspect_seat')<c.calls.indexOf('send_blob'));
  }
});
