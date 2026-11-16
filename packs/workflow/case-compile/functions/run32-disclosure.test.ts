import assert from 'node:assert/strict';
import {test} from 'node:test';
import {typedAuthorityGaps} from './typed-authority.ts';
import {contractOf,bedsOf,PROFILE_DOC,goodData,CONTRACT_DOC,MANIFEST_DOC,MINDMAP_MODEL,AUTOID} from './test-support.ts';
import {parseProfile} from './profile.ts';
import {projectItems} from './project.ts';

test('forbidden call discloses the exact request and full frozen intersection',()=>{
 const contract=contractOf(), parsed=parseProfile(PROFILE_DOC,contract,bedsOf()); assert.ok(parsed.ok); if(!parsed.ok)return;
 const slots=goodData();slots.steps[0].object='invented-seat';
 const gap=typedAuthorityGaps(contract,parsed.profile,slots).find(g=>g.verdict==='refute'&&g.pointer==='/steps/0')!;
 assert.ok(gap);const detail=gap as unknown as {requested:{object:string;method:string};allowed_calls:unknown[]};
 assert.deepEqual(detail.requested,{object:'invented-seat',method:'configure'});
 assert.deepEqual(detail.allowed_calls,parsed.profile.allowed.filter(call=>contract.enabled.some(entry=>entry.object===call.object&&entry.method===call.method)).map(({object,method})=>({object,method})));
 assert.match(gap.message,/invented-seat.configure/);assert.match(gap.message,/widget-seat.configure/);
});

test('whole profile refusal includes every individual problem in the returned error',()=>{
 const profile=structuredClone(PROFILE_DOC);profile.allowed=Array.from({length:8},(_,i)=>({object:'widget-seat',method:`missing-${i}`,parameters:{line:'device_cli'}})) as typeof profile.allowed;
 const out=projectItems({inputs:[{slot:'subject',sha256:'a'.repeat(64),parser:'kityminder@1',model:MINDMAP_MODEL},{slot:'contract',model:CONTRACT_DOC},{slot:'profile',model:profile},{slot:'inventory',model:MANIFEST_DOC}],parameters:{autoid:AUTOID}}) as {error:{code:string;message:string};warnings:{message:string}[]};
 assert.equal(out.error.code,'case-compile.profile_invalid');assert.ok(out.warnings.length>=8);
 for(const warning of out.warnings)assert.ok(out.error.message.includes(warning.message.split('（处理')[0]),warning.message);
});

test('device responder refusal names its observation and full frozen seats',async()=>{
 const {fixture,plan,assertion,quote}=await import('../testing/blocks.ts');const {readSlots}=await import('./slots.ts');
 const f=fixture(),data=plan([{kind:'OBSERVE_ASSERT',id:'host',call:{object:'client',method:'shell',args:['echo SYNTHETIC_READY'],keywords:{}},assertions:[assertion('hostAssert','host')]}]);
 data.block_context!.responders=[{output:'host',kind:'device',ref:'invented-device',quote:quote()}];
 const parsed=readSlots(data);assert.ok(parsed.ok);if(!parsed.ok)return;
 const gap=typedAuthorityGaps(f.contract,f.profile,parsed.slots,undefined,f.catalog).find(g=>(g as any).requested?.responder==='invented-device') as any;
 assert.ok(gap);assert.equal(gap.pointer,'/block_context/responders/0');assert.equal(gap.step_pointer,'/blocks/0/call');assert.deepEqual(gap.allowed_seats,f.profile.seats.map(s=>s.device));assert.match(gap.message,/client.shell/);assert.match(gap.message,/invented-device/);
 const {checkPlanObject}=await import('../tools/check-plan.ts');
 const local=checkPlanObject('synthetic.json',{item:'synthetic-item',handling:'handled',slots:{plan:[{data}]}},{groups:[{kind:'case-compile',contract:f.contractDoc,profile:f.profileDoc,manifest:f.inventory}],items:[{id:'synthetic-item'}]});
 const problem=local.problems.find(p=>(p.requested as any)?.responder==='invented-device');assert.deepEqual(problem,{...gap,code:'case-compile.method_forbidden'});
});

test('long allowed lists rank spelling only for disclosure and retain the complete machine set',async()=>{
 const {callBoundaryGaps}=await import('./call-boundaries.ts');
 const contract=contractOf(),parsed=parseProfile(PROFILE_DOC,contract,bedsOf());assert.ok(parsed.ok);if(!parsed.ok)return;
 const profile=parsed.profile,base=contract.enabled.find(entry=>entry.object==='widget-seat'&&entry.method==='configure')!;
 for(let i=0;i<12;i++){const object=i===0?'invented-seau':`zz-extra-${i}`;contract.enabled.push({...base,object});profile.allowed.push({object,method:'configure',parameters:{}});}
 const slots=goodData();slots.steps[0].object='invented-seat';
 const gap=callBoundaryGaps(contract,profile,slots)[0];assert.equal(gap.verdict,'refute');assert.equal(gap.allowed_calls!.length,profile.allowed.length);
 assert.ok(gap.message.indexOf('invented-seau.configure')<gap.message.indexOf('widget-seat.configure'));assert.match(gap.message,/完整集合见结构化结果/);
 assert.ok(!gap.allowed_calls!.some(row=>row.object==='invented-seat'));
});
