import assert from 'node:assert/strict';
import {test} from 'node:test';
import {signTypedRuntime} from '../testing/typed-fixtures.ts';
import {addressFixture} from '../testing/block-addresses.ts';
import {projectItems} from './project.ts';
import {MINDMAP_MODEL,AUTOID} from './test-support.ts';
import {typedAddressUses} from './typed-authority.ts';
import {checkAddresses} from './checks.ts';
import {readSlots} from './slots.ts';
const f=addressFixture();
for(const [kind,index]of [['OBSERVE_ASSERT',0],['CONFIG',0],['CONFIG',2],['RESTORE_FROM',3]] as const){
 test(kind+' call '+index+' collects raw block endpoints and preserves the authored pointer',()=>{
  const data=f.data(kind,'192.0.2.130',index),before=JSON.stringify(data);
  const uses=typedAddressUses(f.contract,f.profile,data,f.catalog);
  assert.ok(uses.some(use=>use.value==='192.0.2.130'&&use.pointer===`/data/blocks/${index}/call/keywords/endpoint`),JSON.stringify(uses));
  const normalized=readSlots(data);assert.ok(normalized.ok);if(normalized.ok)assert.deepEqual(typedAddressUses(f.contract,f.profile,normalized.slots,f.catalog),uses);
  assert.equal(JSON.stringify(data),before);
 });
 test(kind+' call '+index+' rejects blind endpoints through the real address check',()=>{
  const out=checkAddresses(f.subject(f.data(kind,'192.0.2.130',index)));
  assert.ok(out.some(row=>row.code==='case-compile.environment_unreachable'&&row.pointer===`/data/blocks/${index}/call/keywords/endpoint`),JSON.stringify(out));
 });
 test(kind+' call '+index+' accepts a reachable frozen endpoint',()=>{
  const out=checkAddresses(f.subject(f.data(kind,'192.0.2.10',index)));assert.ok(out.every(row=>row.verdict==='support'),JSON.stringify(out));
 });
}

test('off-bed block endpoint is refused while a current lineage lease permits the same address',()=>{
 const data=f.data('OBSERVE_ASSERT','192.0.2.20');
 assert.ok(checkAddresses(f.subject(data)).some(row=>row.code==='case-compile.address_off_bed'&&row.pointer==='/data/blocks/0/call/keywords/endpoint'));
 const leases=[{key:'bed/bed-a/ip/192.0.2.20',until:null,mine:true}];
 assert.ok(checkAddresses(f.subject(data,{leases})).every(row=>row.verdict==='support'));
 assert.ok(checkAddresses(f.subject(data,{leases:[{...leases[0],mine:false}]})).some(row=>row.code==='case-compile.address_off_bed'));
});

test('VIP uses its exact declared role and a profile cannot substitute the external endpoint role',()=>{
 const data=f.data('OBSERVE_ASSERT');
 assert.ok(checkAddresses(f.subject(data)).every(row=>row.verdict==='support'));
 const profile=structuredClone(f.profileDoc);profile.allowed.find((row:any)=>row.object==='ORBIT_0'&&row.method==='command').parameters.endpoint='external_endpoint';
 const out=checkAddresses(f.subject(data,{profile}));
 assert.ok(out.some(row=>row.verdict==='refute'&&row.code==='case-compile.method_forbidden'&&row.pointer==='/data/blocks/0/call/keywords/endpoint'),JSON.stringify(out));
 assert.ok(out.some(row=>(row.data?.problems as Array<{pointer:string}>|undefined)?.some(problem=>problem.pointer==='/blocks/0/call/keywords/endpoint')),JSON.stringify(out));
});

test('deployment trigger narrowing refuses unreachable block endpoints without changing their membership',()=>{
 const data=f.data('OBSERVE_ASSERT','192.0.2.10');
 assert.ok(checkAddresses(f.subject(data)).every(row=>row.verdict==='support'));
 const profile=structuredClone(f.profileDoc);profile.trigger_types=['server'];
 assert.ok(checkAddresses(f.subject(data,{profile})).some(row=>row.code==='case-compile.environment_unreachable'&&row.pointer==='/data/blocks/0/call/keywords/endpoint'));
});

test('capacity excess refuses a block plan before the volume runs and valid ordinals remain accepted',()=>{
 const data=f.data('OBSERVE_ASSERT');
 assert.ok(checkAddresses(f.subject(data)).every(row=>row.verdict==='support'));
 const profile=structuredClone(f.profileDoc);profile.seats[0].ordinal=2;
 const out=checkAddresses(f.subject(data,{profile}));
 assert.ok(out.some(row=>row.code==='case-compile.bed_unknown'&&row.verdict==='refute'&&row.pointer==='/profile/seats/0/ordinal'));
 assert.ok(out.some(row=>row.statement.includes('框架取不到那台设备，整卷不跑')));
 const projected=projectItems({inputs:[{slot:'subject',sha256:'f'.repeat(64),parser:'kityminder@1',model:MINDMAP_MODEL},{slot:'contract',parser:'json@1',model:f.contractDoc},{slot:'profile',model:profile},{slot:'inventory',parser:'json@1',model:f.inventory}],parameters:{autoid:AUTOID}}) as {error?:{message:string};items?:unknown[]};
 assert.ok(projected.error?.message.includes('框架取不到那台设备，整卷不跑'));assert.equal(projected.items?.length??0,0);
});

test('addresses inside a parsed block command use the same closed command-role declaration',()=>{
 const g=addressFixture(),source='src:'+'d'.repeat(64)+'/json@1/p/signature';
 const doc=structuredClone(g.contractDoc);doc.effects.command.command_roles.push({signature:source,position:0,role:'bed_endpoint'});
 const signed=signTypedRuntime(doc),profile=structuredClone(g.profileDoc);profile.runtime.contract_sha256=signed.original.contract_sha256;
 const catalog=structuredClone(g.catalog) as any;
 catalog.entries.push({words:['demo','show','address'],reference:'tree:'+catalog.root+'/commands/demo/show/address',signatures:[{id:source,reference:source,params:[{name:'endpoint',type:'ipv4',native_type:{name:'synthetic-ipv4',grammar:'synthetic-address@1',declaration:'src:'+'d'.repeat(64)+'/json@1/p/types/endpoint'}}]}]});
 for(const [value,code]of [['192.0.2.10',null],['192.0.2.130','case-compile.environment_unreachable'],['192.0.2.200','case-compile.address_off_bed']] as const){
  const data=g.data();data.blocks[0].call.args=['demo show address '+value];
  const out=checkAddresses(g.subject(data,{contract:signed,profile,command_catalog:catalog}));
  if(code)assert.ok(out.some(row=>row.code===code&&row.pointer==='/data/blocks/0/call/args/0/command_parameters/0'),JSON.stringify(out));
  else assert.ok(out.every(row=>row.verdict==='support'),JSON.stringify(out));
 }
});

test('malformed raw blocks cannot masquerade as an empty address plan',()=>{
 const data=f.data();delete data.blocks[0].call;
 assert.throws(()=>typedAddressUses(f.contract,f.profile,data,f.catalog));
});
