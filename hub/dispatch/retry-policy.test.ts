import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RETRY_SAFETY} from '../../contracts/generated/vocabulary.ts';
import {setupJournal} from './testing/journal.ts';
for(const retry of RETRY_SAFETY)for(const certified of [false,true])test(`${retry} loses one response with retry premises certified ${certified}`,async t=>{
 const c=await setupJournal({lost:'once'});t.after(()=>c.close());const base=c.registered.definition;
 const proof={version:'1',evidence:[`src:${c.proof.body.sha256}`]};
 await c.registry.update(c.admin,c.executor.id,{...base,premises:{...base.premises,...(certified?{retry_safety:proof,window_resend:{...proof,window_ms:300000}}:{})},calls:{...base.calls,submit:{...base.calls.submit,write:{interaction:'submit_then_read',effect_class:'job',retry_safety:retry,signing:'service_on_behalf',reversible:false,target_key:{$value:'target'},audience:null,evidence:{call:base.calls.result.tool,pointer:base.result.sha256},refusal:{stage:base.receipt.stage!,reached_device:base.receipt.reached_device!},writes_hub_records:true}}}});
 await c.freezeExecutor();
 const state=await c.service.dispatch(c.admin,c.run,c.executor.id);assert.equal(state.dispatch_attempt!.outcome,'effective');
 const sent=c.endpoint.calls.filter(call=>call.params.name==='send_blob').map(call=>call.params.arguments as Record<string,unknown>);
 const resend=certified&&retry!=='unsafe';assert.equal(sent.length,resend?2:1);
 if(resend)assert.deepEqual(sent[0],sent[1]);
 const events=await c.service.journal.events(state.job);assert.equal(events.filter(event=>event.body.detail.phase==='intent').length,1);
 assert.equal(events.some(event=>event.body.detail.phase==='resend'&&event.body.detail.possibly_duplicated===true),certified&&retry==='duplicate_tolerant');
 const effects=await c.kit.store.findMany<{marks:string[]}>({kind:'effect',key:'effect.job',values:[state.job]});assert.equal(effects.at(-1)!.body.marks.includes('possible_duplicate'),certified&&retry==='duplicate_tolerant');
});
test('a deduplication window without explicit resend evidence remains read-only after a lost response',async t=>{
 const c=await setupJournal({lost:'once'});t.after(()=>c.close());const base=c.registered.definition;
 const proof={version:'1',evidence:[`src:${c.proof.body.sha256}`]};
 await c.registry.update(c.admin,c.executor.id,{...base,premises:{...base.premises,retry_safety:proof},calls:{...base.calls,submit:{...base.calls.submit,write:{interaction:'submit_then_read',effect_class:'job',retry_safety:'dedup_window',signing:'service_on_behalf',reversible:false,target_key:{$value:'target'},audience:null,evidence:{call:base.calls.result.tool,pointer:base.result.sha256},refusal:{stage:base.receipt.stage!,reached_device:base.receipt.reached_device!},writes_hub_records:true}}}});
 await c.freezeExecutor();assert.equal((await c.service.dispatch(c.admin,c.run,c.executor.id)).dispatch_attempt!.outcome,'effective');assert.equal(c.calls.filter(name=>name==='send_blob').length,1);
});

test('an explicitly certified deduplication window expires independently of the delivery deadline',async t=>{
 let c:Awaited<ReturnType<typeof setupJournal>>;c=await setupJournal({lost:'once',onSubmit:async()=>{c.clock.ms+=2000;}});t.after(()=>c.close());
 const base=c.registered.definition,proof={version:'1',evidence:[`src:${c.proof.body.sha256}`]};
 await c.registry.update(c.admin,c.executor.id,{...base,premises:{...base.premises,retry_safety:proof,window_resend:{...proof,window_ms:1000}},calls:{...base.calls,submit:{...base.calls.submit,write:{interaction:'submit_then_read',effect_class:'job',retry_safety:'dedup_window',signing:'service_on_behalf',reversible:false,target_key:{$value:'target'},audience:null,evidence:{call:base.calls.result.tool,pointer:base.result.sha256},refusal:{stage:base.receipt.stage!,reached_device:base.receipt.reached_device!},writes_hub_records:true}}}});
 await c.freezeExecutor();assert.equal((await c.service.dispatch(c.admin,c.run,c.executor.id)).dispatch_attempt!.outcome,'effective');assert.equal(c.calls.filter(name=>name==='send_blob').length,1);
});
test('a changed before-state after a lost reply never becomes a false not-dispatched outcome',async t=>{
 const c=await setupJournal({lost:'once',beforeStateChange:true});t.after(()=>c.close());const base=c.registered.definition,proof={version:'1',evidence:[`src:${c.proof.body.sha256}`]};
 await c.registry.update(c.admin,c.executor.id,{...base,premises:{...base.premises,retry_safety:proof},calls:{...base.calls,submit:{...base.calls.submit,write:{interaction:'submit_then_read',effect_class:'job',retry_safety:'same_key_safe',signing:'service_on_behalf',reversible:false,target_key:{$value:'target'},audience:null,evidence:{call:base.calls.result.tool,pointer:base.result.sha256},before_state:{call:{tool:base.calls.precheck.tool,arguments:{ticket:{$value:'lease_id'}},timeout_ms:30000},pointer:'/build',expected:'synthetic-build',conditional_write:false},refusal:{stage:base.receipt.stage!,reached_device:base.receipt.reached_device!},writes_hub_records:true}}}});
 await c.freezeExecutor();const state=await c.service.dispatch(c.admin,c.run,c.executor.id);assert.equal(state.dispatch_attempt!.outcome,'effective');assert.equal(c.calls.filter(name=>name==='send_blob').length,1);
 assert.equal((await c.service.journal.events(state.job)).some(e=>e.body.detail.phase==='boundary_refused'),false);assert.ok(c.calls.includes('lookup_blob'));
});
// The boundary also runs before a resend, after the first submit was invoked: a policy check that reaches no conclusion there refuses the
// resend and the record says the submit was invoked and the request must be reconciled, never that nothing went out (decision 116).
for(const clause of [2,7] as const)test(`clause ${clause}: a policy check without a conclusion before a resend refuses it without saying that nothing was sent`,async t=>{
 const c=await setupJournal({lost:'once'});t.after(()=>c.close());const base=c.registered.definition,proof={version:'1',evidence:[`src:${c.proof.body.sha256}`]};
 await c.registry.update(c.admin,c.executor.id,{...base,premises:{...base.premises,retry_safety:proof},calls:{...base.calls,submit:{...base.calls.submit,write:{interaction:'submit_then_read',effect_class:'job',retry_safety:'same_key_safe',signing:'service_on_behalf',reversible:false,target_key:{$value:'target'},audience:null,evidence:{call:base.calls.result.tool,pointer:base.result.sha256},refusal:{stage:base.receipt.stage!,reached_device:base.receipt.reached_device!},writes_hub_records:true}}}});
 await c.freezeExecutor();
 const row=c.effectDocument.effects[0],accepted=Object.fromEntries(Object.entries((row.parameters as {values:Record<string,unknown[]>}).values).map(([key,values])=>[key,values[0]]));
 if(clause===2)Object.assign(row,{parameters:{policy:'policies/synthetic.json',check:'policy_check'}});
 // The replay concludes until the first submit has reached the target, then the sandbox cannot run the check.
 c.service.options.recheckChecks=async()=>({policy_check:c.calls.includes('send_blob')
  ?[{verdict:'unknown',reason:'check_error',missing:'合成沙箱缺口',statement:'合成未知',grounds:[],tier:'blocking',data:{sandbox:'SANDBOX_UNAVAILABLE'}}]
  :[{verdict:'support',statement:'合成政策通过',grounds:[],tier:'blocking',data:{parameters:accepted}}]});
 const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
 assert.equal(c.calls.filter(name=>name==='send_blob').length,1);
 const events=await c.service.journal.events(state.job);assert.equal(events.some(event=>event.body.detail.phase==='resend'),false);assert.equal(events.some(event=>event.body.detail.phase==='boundary_refused'),false);
 const said=String(events.find(event=>event.body.detail.phase==='retry_refused')!.body.detail.missing_fact);
 assert.match(said,clause===2?/^参数政策检查 policy_check 没有运行完：Hub 的沙箱没能运行它/:/^政策检查 policy_check 没有运行完：Hub 的沙箱没能运行它/);
 assert.match(said,/不是计划、工作簿或包被驳回；提交已调用，原请求是否执行须对账$/);assert.doesNotMatch(said,/什么都没发出/);
 // The first delivery is not erased: the original request is still read back.
 assert.ok(c.calls.includes('lookup_blob'));assert.equal(state.dispatch_attempt!.outcome,'effective');
});
for(const definitionFailure of [false,true])test(`a locally unsent retry cannot erase the first delivery with definition failure ${definitionFailure}`,async t=>{
 const c=await setupJournal({lost:'once'});t.after(()=>c.close());const base=c.registered.definition,proof={version:'1',evidence:[`src:${c.proof.body.sha256}`]};
 await c.registry.update(c.admin,c.executor.id,{...base,premises:{...base.premises,retry_safety:proof},calls:{...base.calls,submit:{...base.calls.submit,write:{interaction:'submit_then_read',effect_class:'job',retry_safety:'same_key_safe',signing:'service_on_behalf',reversible:false,target_key:{$value:'target'},audience:null,evidence:{call:base.calls.result.tool,pointer:base.result.sha256},refusal:{stage:base.receipt.stage!,reached_device:base.receipt.reached_device!},writes_hub_records:true}}}});
 await c.freezeExecutor();const {SubmissionNotSentError,InvocationDefinitionError}=await import('./transport.ts');
 const service=c.service as unknown as {session:(...args:unknown[])=>import('./transport.ts').RpcClient};const original=service.session.bind(c.service);
 service.session=(...args)=>{const client=original(...args),call=client.call.bind(client);let submits=0;client.call=async(...values)=>{if(values[0]==='submit'&&++submits===2)throw definitionFailure?new InvocationDefinitionError():new SubmissionNotSentError(`src:${c.proof.body.sha256}`);return call(...values);};return client;};
 const state=await c.service.dispatch(c.admin,c.run,c.executor.id);assert.equal(state.dispatch_attempt!.outcome,'effective');assert.equal(c.calls.filter(name=>name==='send_blob').length,1);assert.ok(c.calls.includes('lookup_blob'));
 const events=await c.service.journal.events(state.job);assert.equal(events.some(e=>e.body.detail.submit_invoked===false),false);
});
