// Synthetic fault injection: only boundary contexts inherit the stray preflight switch; restore before cleanup.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup} from './testing/context.ts';
import {setupJournal} from './testing/journal.ts';
function shortcut(){
 const previous=Object.getOwnPropertyDescriptor(Object.prototype,'until');
 Object.defineProperty(Object.prototype,'until',{configurable:true,get(){return Object.hasOwn(this,'parameterPolicy')?4:undefined;},set(value){Object.defineProperty(this,'until',{value,writable:true,enumerable:true,configurable:true});}});
 return ()=>{if(previous)Object.defineProperty(Object.prototype,'until',previous);else Reflect.deleteProperty(Object.prototype,'until');};
}
test('a partial four-clause boundary can never authorize an intent or the first submission',async t=>{
 const c=await setup();t.after(()=>c.close());const restore=shortcut();let state;
 try{state=await c.service.dispatch(c.admin,c.run,c.executor.id);}finally{restore();}
 assert.equal(c.calls.filter(name=>name==='send_blob').length,0);
 const events=await c.service.journal.events(state.job);assert.equal(events.some(event=>event.body.detail.phase==='intent'),false);assert.equal(state.outcome,'not_dispatched');assert.match(state.missing_fact!,/九款/);
});
test('a partial four-clause boundary cannot authorize retransmission or erase the first delivery',async t=>{
 let restore=()=>{};const c=await setupJournal({lost:'once',onSubmit:async()=>{restore=shortcut();}});t.after(()=>c.close());
 const base=c.registered.definition,proof={version:'1',evidence:[`src:${c.proof.body.sha256}`]};
 await c.registry.update(c.admin,c.executor.id,{...base,premises:{...base.premises,retry_safety:proof},calls:{...base.calls,submit:{...base.calls.submit,write:{interaction:'submit_then_read',effect_class:'job',retry_safety:'same_key_safe',signing:'service_on_behalf',reversible:false,target_key:{$value:'target'},audience:null,evidence:{call:base.calls.result.tool,pointer:base.result.sha256},refusal:{stage:base.receipt.stage!,reached_device:base.receipt.reached_device!},writes_hub_records:true}}}});
 await c.freezeExecutor();let state;
 try{state=await c.service.dispatch(c.admin,c.run,c.executor.id);}finally{restore();}
 assert.equal(c.calls.filter(name=>name==='send_blob').length,1);assert.equal(state.outcome,'effective');
 const events=await c.service.journal.events(state.job);assert.equal(events.filter(event=>event.body.detail.phase==='intent').length,1);assert.equal(events.some(event=>event.body.detail.phase==='resend'),false);assert.ok(events.some(event=>event.body.detail.phase==='retry_refused'&&String(event.body.detail.missing_fact).includes('九款')));assert.ok(c.calls.includes('lookup_blob'));
});
