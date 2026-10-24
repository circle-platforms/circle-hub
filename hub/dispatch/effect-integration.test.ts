import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup} from './testing/context.ts';
import {DispatchService} from './service.ts';
for(const clause of [1,2,3,4,5,6,7,8])test(`the real dispatch refuses clause ${clause} before submit and records a dispatch refusal`,async t=>{
 const c=await setup();t.after(()=>c.close());
 if(clause===1)c.effectDocument.effects=[];
 if(clause===2)c.effectDocument.effects[0].parameters.values.build=['outside'];
 if(clause===3)c.detail.latest!.result.partitions.delivered[0].requirements[0].status='pending';
 if(clause===5)await c.leases.forceRelease({keys:c.executor.definition.resources,by:c.admin.id,reason:'合成围栏变化'});
 if(clause===4)c.clock.ms+=86400001;
 if(clause===6)c.detail.run.policy='f'.repeat(64);
 if(clause===7)c.service.options.recheckChecks=async()=>({policy_check:[{verdict:'refute',statement:'合成拒绝',grounds:[],tier:'blocking',codes:['SYNTHETIC_DENIED']}]});
 if(clause===8){const source=c.kit.artifacts.source.bind(c.kit.artifacts);c.kit.artifacts.source=async(...args)=>{const value=await source(...args);return value&&args[1]===c.payload.body.sha256?{...value,bytes:Buffer.from('tampered synthetic bytes')}:value;};}
 const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
 assert.equal(c.calls.includes('send_blob'),false);assert.equal(state.outcome,'not_dispatched');
 const events=await c.service.journal.events(state.job);const refusal=events.find(event=>event.body.detail.phase==='boundary_refused');
 assert.equal(refusal?.body.action,'dispatch');assert.equal(refusal?.body.detail.boundary_clause,clause);
 const effects=await c.kit.store.findMany({kind:'effect',key:'effect.job',values:[state.job]});assert.equal(effects.length,1);
});
test('a successful dispatch stores its allowed row and one budget allocation with immutable effect snapshots',async t=>{
 const c=await setup();t.after(()=>c.close());const state=await c.service.dispatch(c.admin,c.run,c.executor.id);assert.equal(state.outcome,'effective');
 const intent=(await c.service.journal.events(state.job)).find(e=>e.body.detail.phase==='intent')!;assert.equal(intent.body.detail.effect_row,'submit_verified');
 const effects=await c.kit.store.findMany<{outcome:string;request_id:string;content_sha256:string;previous:string|null}>({kind:'effect',key:'effect.job',values:[state.job]});
 assert.ok(effects.length>=2);assert.equal(effects[0].body.outcome,'issued');assert.equal(effects.at(-1)!.body.outcome,'effective');assert.equal(effects.at(-1)!.body.content_sha256,c.payload.body.sha256);assert.ok(effects.at(-1)!.body.previous);
});
for(const conditional of [false,true])for(const matched of [false,true])test(`before-state read is compared in the submit lease with conditional support ${conditional} and match ${matched}`,async t=>{
 const c=await setup();t.after(()=>c.close());const base=c.executor.definition;
 const evidence=await c.kit.artifacts.ingest({bytes:Buffer.from('synthetic conditional write audit'),mediaType:'text/plain',origin:{upload:{session:'synthetic'}},author:{user:c.admin.id},provenanceType:'declared',visibility:{readers:[c.admin.id],admins:true,packs:[],shareable:false}});
 await c.registry.update(c.admin,c.executor.id,{...base,premises:{conditional_write:{version:'1',evidence:[`src:${evidence.body.sha256}`]}},calls:{...base.calls,submit:{...base.calls.submit,arguments:{...base.calls.submit.arguments,...(conditional?{expected:{$value:'before_state'}}:{})},write:{interaction:'submit_then_read',effect_class:'job',retry_safety:'unsafe',signing:'service_on_behalf',reversible:false,target_key:{$value:'target'},audience:null,evidence:{call:base.calls.result.tool,pointer:base.result.sha256},before_state:{call:{tool:base.calls.precheck.tool,arguments:{ticket:{$value:'lease_id'}},timeout_ms:30000},pointer:'/build',expected:matched?'synthetic-build':'different',conditional_write:conditional},refusal:{stage:'/phase',reached_device:'/touched'},writes_hub_records:true}}},receipt:{...base.receipt,stage:'/phase',reached_device:'/touched'}});
 await c.freezeExecutor();const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
 assert.equal(c.calls.filter(name=>name==='send_blob').length,matched?1:0);
 const events=await c.service.journal.events(state.job);assert.equal(events.filter(e=>e.body.detail.phase==='before_state').length,1);
 if(matched){const intent=events.find(e=>e.body.detail.phase==='intent')!;assert.equal(intent.body.detail.before_state_bound,conditional);const before=events.find(e=>e.body.detail.phase==='before_state')!;assert.deepEqual(before.body.detail.remote_lease,intent.body.detail.remote_lease);assert.equal(state.outcome,'effective');}else {assert.equal(state.outcome,'not_dispatched');assert.match(state.missing_fact!,/前状态/);}
});

test('changes to another executor do not invalidate the used frozen definition',async t=>{
 const c=await setup();t.after(()=>c.close());
 const {addSyntheticExecutor}=await import('./testing/credentials.ts');
 await addSyntheticExecutor(c.kit,c.registry,c.admin,{...c.executor.definition,target:'synthetic-other-bed',resources:['synthetic/other/a'],endpoint:c.endpoint.endpoint+'/other'},'synthetic-other-key');
 assert.equal((await c.service.dispatch(c.admin,c.run,c.executor.id)).outcome,'effective');
});
test('changing the used executor after start requires a new revision',async t=>{
 const c=await setup();t.after(()=>c.close());await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,poll_ms:40});
 const state=await c.service.dispatch(c.admin,c.run,c.executor.id);const event=(await c.service.journal.events(state.job)).find(e=>e.body.detail.phase==='boundary_refused')!;
 assert.equal(event.body.error_code,'BOUNDARY_POLICY_DENIED');assert.equal(c.calls.includes('send_blob'),false);
});
test('lost responses produce effect snapshots with the missing fact and a concrete reconciliation exit',async t=>{
 const c=await setup({mode:'disconnect'});t.after(()=>c.close());const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
 const {EffectRecord}=await import('../../contracts/src/resources.ts');
 const effects=await c.kit.store.findMany({kind:'effect',key:'effect.job',values:[state.job]});const value=EffectRecord.parse(effects.at(-1)!.body);
 assert.equal(value.outcome,'unknown');assert.ok(value.missing);assert.equal(value.exit!.action,'request');assert.deepEqual(value.exit!.audience,{user:c.admin.id});assert.ok(value.request_id);assert.ok(value.not_after);assert.ok(value.action_digest);assert.equal(value.writing_identity.on_behalf_of,c.owner.id);
});

test('declared conditional support without target-version evidence stays explicitly unbound',async t=>{
 const c=await setup();t.after(()=>c.close());const base=c.executor.definition;
 await c.registry.update(c.admin,c.executor.id,{...base,calls:{...base.calls,submit:{...base.calls.submit,arguments:{...base.calls.submit.arguments,expected:{$value:'before_state'}},write:{interaction:'submit_then_read',effect_class:'job',retry_safety:'unsafe',signing:'service_on_behalf',reversible:false,target_key:{$value:'target'},audience:null,evidence:{call:base.calls.result.tool,pointer:base.result.sha256},before_state:{call:{tool:base.calls.precheck.tool,arguments:{ticket:{$value:'lease_id'}},timeout_ms:30000},pointer:'/build',expected:'synthetic-build',conditional_write:true},refusal:{stage:'/phase',reached_device:'/touched'},writes_hub_records:true}}},receipt:{...base.receipt,stage:'/phase',reached_device:'/touched'}});
 await c.freezeExecutor();const state=await c.service.dispatch(c.admin,c.run,c.executor.id);assert.equal(state.outcome,'effective');const events=await c.service.journal.events(state.job);assert.equal(events.find(e=>e.body.detail.phase==='intent')!.body.detail.before_state_bound,false);assert.match(String(events.find(e=>e.body.detail.phase==='before_state')!.body.detail.missing_fact),/尚未认证/);
});
for(const missing of ['accepted result','replay port','policy result'] as const)test(`parameter policy names the missing ${missing} without claiming out-of-range parameters`,async t=>{
 const c=await setup();t.after(()=>c.close());const row=c.effectDocument.effects[0];Object.assign(row,{parameters:{policy:'policies/synthetic.json',check:'policy_check'}});
 if(missing==='accepted result')c.detail.latest=null;
 if(missing==='replay port')c.service.options.recheckChecks=undefined;
 if(missing==='policy result')c.service.options.recheckChecks=async()=>{throw new Error('SyntheticPrivatePolicyDetail84');};
 const state=await c.service.dispatch(c.admin,c.run,c.executor.id);assert.equal(state.outcome,'not_dispatched');assert.equal(c.calls.includes('send_blob'),false);
 const events=await c.service.journal.events(state.job),refusal=events.find(event=>event.body.detail.phase==='boundary_refused')!;
 assert.equal(refusal.body.error_code,missing==='accepted result'?'EFFECT_RELEASE_UNMET':'PACK_POLICY_DENIED');assert.equal(refusal.body.detail.boundary_clause,missing==='accepted result'?3:2);assert.equal(refusal.body.detail.effect_row,row.id);assert.deepEqual(refusal.body.detail.requirements,row.release.requirements);
 assert.match(state.missing_fact!,missing==='accepted result'?/受理.*核验事实/:/参数.*政策|参数政策/);assert.match(state.next_action!,missing==='accepted result'?/完成.*核验/:/恢复.*(接口|读取)/);assert.ok(!state.missing_fact!.includes('参数未落'));
 const effects=await c.kit.store.findMany<{boundary:{code:string;row:string};outcome:string}>({kind:'effect',key:'effect.job',values:[state.job]});assert.equal(effects.length,1);assert.equal(effects[0].body.boundary.code,refusal.body.error_code);assert.equal(effects[0].body.boundary.row,row.id);assert.ok(!JSON.stringify(effects).includes('SyntheticPrivatePolicyDetail84'));
});
test('closed parameter sets also name absent verification facts instead of inventing a range violation',async t=>{
 const c=await setup();t.after(()=>c.close());c.detail.latest=null;
 const state=await c.service.dispatch(c.admin,c.run,c.executor.id),refusal=(await c.service.journal.events(state.job)).find(event=>event.body.detail.phase==='boundary_refused')!;
 assert.equal(c.calls.includes('send_blob'),false);assert.equal(refusal.body.error_code,'EFFECT_RELEASE_UNMET');assert.equal(refusal.body.detail.effect_row,'submit_verified');assert.match(state.missing_fact!,/受理.*核验事实/);
});
test('a legacy executor without an environment cannot dispatch even after its definition is frozen',async t=>{
 const c=await setup();t.after(()=>c.close());const {environment,...legacy}=c.executor.definition;
 await c.registry.update(c.admin,c.executor.id,legacy);await c.freezeExecutor();
 const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
 assert.equal(c.calls.filter(name=>name==='send_blob').length,0);assert.equal(state.outcome,'not_dispatched');
 const events=await c.service.journal.events(state.job),refusal=events.find(event=>event.body.detail.phase==='boundary_refused')!;
 assert.equal(events.some(event=>event.body.detail.phase==='intent'),false);assert.equal(refusal.body.detail.boundary_clause,6);assert.equal(refusal.body.error_code,'BOUNDARY_POLICY_DENIED');
 const effects=await c.kit.store.findMany<{outcome:string;boundary:{clause:number;code:string}}>({kind:'effect',key:'effect.job',values:[state.job]});assert.equal(effects.length,1);assert.equal(effects[0].body.outcome,'not_dispatched');assert.equal(effects[0].body.boundary.clause,6);assert.equal(effects[0].body.boundary.code,'BOUNDARY_POLICY_DENIED');
});
test('a historical run without its frozen executor registry cannot dispatch',async t=>{
 const c=await setup();t.after(()=>c.close());delete c.detail.run.executors;
 const state=await c.service.dispatch(c.admin,c.run,c.executor.id);assert.equal(c.calls.includes('send_blob'),false);assert.equal(state.outcome,'not_dispatched');
 const refusal=(await c.service.journal.events(state.job)).find(event=>event.body.detail.phase==='boundary_refused')!;assert.equal(refusal.body.detail.boundary_clause,6);assert.equal(refusal.body.error_code,'BOUNDARY_POLICY_DENIED');
 const effects=await c.kit.store.findMany<{outcome:string}>({kind:'effect',key:'effect.job',values:[state.job]});assert.equal(effects.length,1);assert.equal(effects[0].body.outcome,'not_dispatched');
});
