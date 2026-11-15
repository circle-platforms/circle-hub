// Synthetic named executor configuration and pinned operation definitions.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup} from './testing/context.ts';
test('executor source preserves references while the resolved definition and digest bind current values',async t=>{
 const c=await setup();t.after(()=>c.close());
 await c.kit.variables.setVariable(c.admin,'DEMO_MANIFEST',c.executor.definition.manifest_sha256,'DEMO_REASON');
 const registered=await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,manifest_sha256:'${var:DEMO_MANIFEST}'});
 const found=await c.registry.get(registered.id);assert.ok(found);
 assert.equal(found.definition.manifest_sha256,c.executor.definition.manifest_sha256);
 const bytes=await c.kit.objects.get(found.digest);assert.equal(JSON.parse(Buffer.from(bytes!).toString()).manifest_sha256,'${var:DEMO_MANIFEST}');
});
test('a historical executor without a named credential refuses before any request',async t=>{
 const {canonicalBytes}=await import('../records/api.ts');
 const c=await setup();t.after(()=>c.close());
 const source={...c.executor.definition};delete (source as Record<string,unknown>).credential;
 const object=await c.kit.objects.put(canonicalBytes(source),'application/json');
 await c.kit.authorizations.configureResource(c.admin,'executor.'+c.executor.id,object.sha256);
 const result=await c.service.precheck(c.admin,c.executor.id);
 assert.equal(result.dispatch_attempt, undefined);assert.equal(result.job_facts.operation, 'precheck');assert.equal(c.calls.length,0);
 assert.match(result.job_facts.next_action??result.job_facts.reason??'',/credential|secret set|executor update/);
});

test('only declared expected positions accept ordinary variables and a variable cannot create a binding',async t=>{
 const {ExecutorSource}=await import('./api.ts');const {definition}=await import('./testing/definition.ts');
 const base=definition('http://127.0.0.1:1/mcp');
 const ref='${var:DEMO_VALUE}';
 for(const source of [{...base,endpoint:ref},{...base,allowed_tools:[ref]},{...base,calls:{...base.calls,precheck:{...base.calls.precheck,arguments:{name:ref}}}},{...base,proof:{...base.proof,items:ref}},{...base,retry_safety:ref},{...base,read_retry_when:[{pointer:'/state',equals:ref}]},{...base,conditions:[{pointer:ref,equals:true}]}])assert.equal(ExecutorSource.safeParse(source).success,false);
 assert.equal(ExecutorSource.safeParse({...base,target:ref,manifest_sha256:ref,conditions:[{pointer:'/build',equals:ref},{pointer:'/size',at_least:ref},{pointer:'/hash',sha256:ref}]}).success,true);
 const c=await setup();t.after(()=>c.close());await assert.rejects(c.kit.variables.setVariable(c.admin,'DEMO_BAD',{$value:'build'},'DEMO_REASON'));
});

test('a value changing between binding and intent causes zero submissions',async t=>{
 const c=await setup();t.after(()=>c.close());
 const initial=await c.kit.variables.setVariable(c.admin,'DEMO_BUILD','synthetic-build','DEMO_REASON');
 const registered=await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,conditions:c.executor.definition.conditions.map((condition,index)=>index===0?{pointer:'/build',equals:'${var:DEMO_BUILD}'}:condition)});
 await c.freezeExecutor();
 assert.ok(c.detail.run.executors);
 assert.equal(JSON.parse(Buffer.from((await c.kit.objects.get(c.detail.run.executors))!).toString())[c.executor.id],registered.resolved_digest);
 assert.equal(registered.definition.conditions[0].equals,'synthetic-build');
 assert.notEqual(registered.resolved_digest,c.executor.resolved_digest);
 const get=c.service.registry.get.bind(c.service.registry);let calls=0;
 let changed=false;
 c.service.registry.get=async(id,...args)=>{if(++calls===2){const write=await c.kit.variables.setVariable(c.admin,'DEMO_BUILD','synthetic-other-build','DEMO_CHANGE');assert.notEqual(write.value.decision.digest,initial.value.decision.digest);assert.equal((await c.kit.authorizations.latest('resource_config','*','var:DEMO_BUILD'))?.digest,write.value.decision.digest);changed=true;}return get(id,...args);};
 const result=await c.service.dispatch(c.admin,c.run,c.executor.id);assert.equal(result.dispatch_attempt!.outcome,'not_dispatched');assert.equal(c.submitted.length,0);assert.equal(changed,true);
 const events=await c.service.journal.events(result.job);assert.ok(events.some(e=>String(e.body.detail.reason).includes('执行器配置已变')));assert.ok(!events.some(e=>e.body.detail.phase==='intent'));
});

test('resume keeps the resolved definition after drift and a withdrawn credential yields an explicit recoverable gap',async t=>{
 const {DispatchService}=await import('./api.ts');const {secretNameOf}=await import('../../contracts/src/variables.ts');
 const c=await setup({mode:'transient-status'});t.after(()=>c.close());
 const initial=await c.kit.variables.setVariable(c.admin,'DEMO_BUILD','synthetic-build','DEMO_REASON');
 const registered=await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,conditions:c.executor.definition.conditions.map((condition,index)=>index===0?{pointer:'/build',equals:'${var:DEMO_BUILD}'}:condition)});
 await c.freezeExecutor();
 assert.ok(c.detail.run.executors);
 assert.equal(JSON.parse(Buffer.from((await c.kit.objects.get(c.detail.run.executors))!).toString())[c.executor.id],registered.resolved_digest);
 assert.equal(registered.definition.conditions[0].equals,'synthetic-build');
 assert.notEqual(registered.resolved_digest,c.executor.resolved_digest);
 const interrupted=new DispatchService({...c.service.options,sleep:async()=>{throw new Error('DEMO_INTERRUPTED');}});
 const first=await interrupted.dispatch(c.admin,c.run,c.executor.id);assert.equal(c.submitted.length,1);
 const binding=await c.service.journal.binding(first.job);assert.equal(binding.executor_source_digest,registered.digest);assert.equal(binding.executor_digest,registered.resolved_digest);assert.equal(binding.variables?.[0].name,'DEMO_BUILD');assert.equal(binding.variables?.[0].decision,initial.value.decision.digest);
 assert.equal(JSON.parse(Buffer.from((await c.kit.objects.get(binding.executor_digest))!).toString()).conditions[0].equals,'synthetic-build');
 const changed=await c.kit.variables.setVariable(c.admin,'DEMO_BUILD','synthetic-changed-build','DEMO_DRIFT');
 assert.notEqual(changed.value.decision.digest,initial.value.decision.digest);
 assert.equal((await c.kit.authorizations.latest('resource_config','*','var:DEMO_BUILD'))?.digest,changed.value.decision.digest);
 const name=secretNameOf(registered.definition.credential!)!;await c.kit.variables.unsetSecret(c.admin,name,'DEMO_REVOKE');
 const restarted=new DispatchService({...c.service.options});const before=c.calls.length;
 const missing=await restarted.resume(c.admin,first.job);assert.equal(c.calls.length,before);assert.match(missing.dispatch_attempt!.next_action??'',/secret set --name/);assert.match(missing.dispatch_attempt!.next_action??'',/job resume/);
 await c.kit.variables.setSecrets(c.admin,[{name,value:'synthetic-secret'}],'DEMO_RESTORE');
 const result=await restarted.resume(c.admin,first.job);assert.equal(result.dispatch_attempt!.outcome,'effective');assert.equal(c.submitted.length,1);
 const restoredBinding=await restarted.journal.binding(first.job);assert.equal(restoredBinding.executor_digest,registered.resolved_digest);assert.equal(restoredBinding.executor_source_digest,registered.digest);assert.equal(restoredBinding.variables?.[0].decision,initial.value.decision.digest);
 assert.equal(JSON.parse(Buffer.from((await c.kit.objects.get(restoredBinding.executor_digest))!).toString()).conditions[0].equals,'synthetic-build');
 const events=await restarted.journal.events(first.job);assert.equal(events.filter(e=>e.body.detail.phase==='configuration_drift').length,1);
});

test('two executors share one vault name and rotate without re-enrolling a configured destination',async t=>{
 const {secretNameOf}=await import('../../contracts/src/variables.ts');
 const c=await setup();t.after(()=>c.close());
 const first=c.executor;const second=await c.registry.add(c.admin,{...first.source,id:undefined});const name=secretNameOf(first.definition.credential!)!;
 const grant=await c.kit.authorizations.latest('resource_assign',c.environmentTeam.id,c.environment.id);assert.ok(grant);
 const {schema:_schema,id:_id,...registration}=c.environment;
 assert.ok(registration.name!==null&&registration.target!==null);
 const environment=await c.kit.testEnvironments.update(c.admin,c.environment.id,{...registration,name:registration.name,target:registration.target,executors:[first.id,second.id]});
 assert.equal(environment.id,c.environment.id);assert.deepEqual(environment.executors,[first.id,second.id]);
 assert.equal((await c.kit.authorizations.latest('resource_assign',c.environmentTeam.id,environment.id))?.digest,grant.digest);
 assert.equal(await c.kit.testEnvironments.canUseExecutor(c.admin,environment.id,first.id),true);
 assert.equal(await c.kit.testEnvironments.canUseExecutor(c.admin,environment.id,second.id),true);
 const set=(value:string)=>c.kit.variables.setSecrets(c.admin,[{name,value}],'DEMO_ROTATION');
 await set('DEMO!Executor42');
 await c.service.precheck(c.admin,first.id);await c.service.precheck(c.admin,second.id);
 let init=c.endpoint.calls.filter(call=>call.method==='initialize');assert.equal(init.length,2);assert.ok(init.every(call=>call.headers.authorization==='Bearer DEMO!Executor42'));
 await set('DEMO!Executor43');await c.service.precheck(c.admin,first.id);await c.service.precheck(c.admin,second.id);
 init=c.endpoint.calls.filter(call=>call.method==='initialize');assert.ok(init.slice(-2).every(call=>call.headers.authorization==='Bearer DEMO!Executor43'));
 await c.registry.update(c.admin,second.id,{...second.source,endpoint:c.endpoint.endpoint+'/changed'});
 const count=c.endpoint.calls.length;await c.service.precheck(c.admin,second.id);assert.ok(c.endpoint.calls.length>count);assert.ok(c.endpoint.calls.slice(count).every(call=>call.headers.authorization==='Bearer DEMO!Executor43'));
});

test('executor material migration uses the current administrator-approved endpoint',async t=>{
 const {canonicalBytes}=await import('../records/api.ts');
 const c=await setup();t.after(()=>c.close());const old={...c.executor.definition};delete old.credential;
 const stored=await c.kit.objects.put(canonicalBytes(old),'application/json');await c.kit.authorizations.configureResource(c.admin,'executor.'+c.executor.id,stored.sha256);
 await c.kit.vault.put('executor.'+c.executor.id+'.bearer','DEMO!Legacy42');
 const source={...old,credential:'${secret:DEMO_MIGRATION}'};
 const migrated=await c.registry.update(c.admin,c.executor.id,{...source,endpoint:c.endpoint.endpoint+'/changed'});assert.equal(migrated.definition.endpoint,c.endpoint.endpoint+'/changed');assert.equal(await c.kit.vault.has('executor.'+c.executor.id+'.bearer'),false);
 assert.equal((await c.registry.material(migrated.id,migrated.definition)).value,'DEMO!Legacy42');
 const version=(await c.kit.variables.listSecrets(c.admin)).find(v=>v.name==='DEMO_MIGRATION');assert.equal(version?.version,1);
});

test('compatible read repairs and certification use original variable decisions after current values drift',async t=>{
 const c=await setup({mode:'unmapped'});t.after(()=>c.close());
 const initial=await c.kit.variables.setVariable(c.admin,'DEMO_BUILD','synthetic-build','DEMO_REASON');
 const original=await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,conditions:c.executor.definition.conditions.map((condition,index)=>index===0?{pointer:'/build',equals:'${var:DEMO_BUILD}'}:condition)});
 await c.freezeExecutor();
 assert.ok(c.detail.run.executors);
 assert.equal(JSON.parse(Buffer.from((await c.kit.objects.get(c.detail.run.executors))!).toString())[c.executor.id],original.resolved_digest);
 assert.equal(original.definition.conditions[0].equals,'synthetic-build');
 assert.notEqual(original.resolved_digest,c.executor.resolved_digest);
 const job=await c.service.dispatch(c.admin,c.run,c.executor.id);assert.equal(job.job_facts.frozen,true);
 const binding=await c.service.journal.binding(job.job);assert.equal(binding.executor_digest,original.resolved_digest);assert.equal(binding.executor_source_digest,original.digest);assert.equal(binding.variables?.[0].decision,initial.value.decision.digest);
 const changed=await c.kit.variables.setVariable(c.admin,'DEMO_BUILD','synthetic-current-build','DEMO_DRIFT');
 assert.notEqual(changed.value.decision.digest,initial.value.decision.digest);
 assert.equal((await c.kit.authorizations.latest('resource_config','*','var:DEMO_BUILD'))?.digest,changed.value.decision.digest);
 await c.registry.update(c.admin,c.executor.id,{...original.source,status:{...original.source.status,map:{...original.source.status.map,unmapped:{action_result:'completed',effect_outcome:'effective'}}}});
 const repaired=await c.service.dispose(c.admin,job.job,{choice:'reconcile',remote_id:'synthetic-remote'});assert.equal(repaired.dispatch_attempt!.outcome,'effective');assert.equal(c.submitted.length,1);
 const events=await c.service.journal.events(job.job);const use=events.find(e=>e.body.detail.phase==='reading_definition');assert.ok(use);
 const bytes=await c.kit.objects.get(String(use.body.detail.reading_definition_sha256));assert.equal(JSON.parse(Buffer.from(bytes!).toString()).target,c.executor.definition.target);assert.equal(JSON.parse(Buffer.from(bytes!).toString()).conditions[0].equals,'synthetic-build');
 assert.equal((await c.service.journal.binding(job.job)).executor_digest,original.resolved_digest);
 assert.equal(JSON.parse(Buffer.from((await c.kit.objects.get(original.resolved_digest))!).toString()).conditions[0].equals,'synthetic-build');
 assert.equal((use.body.detail.variables as any[])[0].decision,original.variables[0].decision);
});

test('foreign credential echoes share the connector redactor and raw hashes stay outside run-scoped actions',async t=>{
 const secret='DEMO!OtherCredential42';
 const c=await setup({alter:(name,value)=>name==='inspect_slot'?{...value,diagnostic:secret}:value});t.after(()=>c.close());
 await c.kit.variables.setSecrets(c.admin,[{name:'DEMO_OTHER_AUTH',value:secret}],'DEMO_OTHER_ENROLLMENT');
 const result=await c.service.dispatch(c.admin,c.run,c.executor.id);assert.equal(c.submitted.length,1);
 const actions=(await c.service.journal.events(result.job));
 const redacted=actions.filter(e=>e.body.detail.redacted===true&&e.body.run!==null);assert.ok(redacted.length);
 assert.ok(redacted.every(e=>!Object.hasOwn(e.body.detail,'received_sha256')));
 assert.ok(actions.some(e=>e.body.run===null&&e.body.detail.redacted===true&&typeof e.body.detail.received_sha256==='string'));
 assert.ok(!JSON.stringify(actions).includes(secret));
 for(const action of actions.filter(e=>typeof e.body.detail.source_record==='string')) {
  const digest=String(action.body.detail.source_record).slice(4);const record=await c.kit.store.get<any>(digest);
  if(record?.body.sha256){const bytes=await c.kit.objects.get(record.body.sha256);if(bytes)assert.ok(!Buffer.from(bytes).includes(Buffer.from(secret)));}
 }
});

test('disabling an executor prevents new sessions until an administrator explicitly enables it',async t=>{
 const c=await setup();t.after(()=>c.close());await c.registry.disable(c.admin,c.executor.id);
 const before=c.endpoint.calls.length;
 await assert.rejects(c.registry.material(c.executor.id,c.executor.definition),/禁用/);assert.equal(c.endpoint.calls.length,before);
 await c.registry.update(c.admin,c.executor.id,{...c.executor.source,enabled:true});
 assert.equal((await c.registry.material(c.executor.id,c.executor.definition)).value,'synthetic-secret');
});

for(const change of ['variable','definition'])test(`a late ${change} change immediately before intent still prevents every submission`,async t=>{
 const c=await setup();t.after(()=>c.close());await c.kit.variables.setVariable(c.admin,'DEMO_TARGET',c.executor.definition.target,'DEMO_TARGET');
 const source=await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,target:'${var:DEMO_TARGET}'});
 const events=c.service.journal.events.bind(c.service.journal);let changed=false;
 c.service.journal.events=async job=>{const rows=await events(job);if(!changed&&rows.some(e=>e.body.detail.phase==='device_probe')){changed=true;if(change==='variable')await c.kit.variables.setVariable(c.admin,'DEMO_TARGET','DEMO_LATE_TARGET','DEMO_LATE');else await c.registry.update(c.admin,c.executor.id,{...source.source,max_bytes:524288});}return rows;};
 const result=await c.service.dispatch(c.admin,c.run,c.executor.id);assert.equal(changed,true);assert.equal(c.submitted.length,0);assert.equal(result.dispatch_attempt!.outcome,'not_dispatched');assert.ok(!(await events(result.job)).some(e=>e.body.detail.phase==='intent'));
});

test('resume keeps the pinned credential name while permitting a new version of that same name',async t=>{
 const {DispatchService}=await import('./api.ts');const {secretNameOf}=await import('../../contracts/src/variables.ts');
 const c=await setup();t.after(()=>c.close());
 const interrupted=new DispatchService({...c.service.options,sleep:async()=>{throw new Error('DEMO_INTERRUPTED');}});
 const issued=await interrupted.dispatch(c.admin,c.run,c.executor.id);assert.equal(issued.dispatch_attempt!.outcome,'issued');assert.equal(c.submitted.length,1);
 const pinnedName=secretNameOf(c.executor.definition.credential!)!;
 const updated=await c.registry.update(c.admin,c.executor.id,{...c.executor.source,credential:'${secret:DEMO_OTHER_AUTH}'});
 await c.kit.variables.setSecrets(c.admin,[{name:'DEMO_OTHER_AUTH',value:'Demo!DifferentAuth42'}],'DEMO_OTHER');
 const before=c.endpoint.calls.length;
 const resumed=await c.service.resume(c.admin,issued.job);assert.equal(resumed.dispatch_attempt!.outcome,'effective');
 assert.ok(c.endpoint.calls.slice(before).every(call=>call.headers.authorization==='Bearer synthetic-secret'),'a source edit cannot change the name used by the issued job');
 await c.kit.variables.setSecrets(c.admin,[{name:pinnedName,value:'Demo!SameNameNext42'}],'DEMO_ROTATE');
 assert.equal((await c.registry.material(c.executor.id,c.executor.definition)).value,'Demo!SameNameNext42');assert.equal(c.submitted.length,1);
});
