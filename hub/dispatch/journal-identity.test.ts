import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setupJournal} from './testing/journal.ts';

test('the request identity is read under the submit lease and committed before the only submission',async t=>{
  const c=await setupJournal({lost:true,absent:true});t.after(()=>c.close());
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  const names=c.calls;assert.ok(names.indexOf('lookup_blob')<names.indexOf('send_blob'));
  const events=await c.service.journal.events(state.job);const intent=events.find(e=>e.body.detail.phase==='intent')!;
  assert.ok(intent.body.detail.request_identity);assert.equal(intent.body.detail.request_protocol_version,'1');
  const query=c.endpoint.calls.find(e=>e.params.name==='lookup_blob')!;
  const submit=c.endpoint.calls.find(e=>e.params.name==='send_blob')!;
  assert.equal(query.headers['mcp-session-id'],submit.headers['mcp-session-id']);
  assert.equal(query.headers['x-circle-hub-actor'],submit.headers['x-circle-hub-actor']);
  assert.equal((query.params.arguments as any).ticket,(submit.params.arguments as any).ticket);
  assert.equal((query.params.arguments as any).request,(submit.params.arguments as any).request);
  const snapshot=events.find(e=>e.body.detail.phase==='request_identity')!;
  assert.ok(snapshot.body.inputs.every(ref=>intent.body.inputs.includes(ref)));
  assert.equal(state.outcome,'unknown');assert.equal(names.filter(n=>n==='send_blob').length,1);
});

for(const identityChange of ['epoch','subject','since','missing'] as const) {
  test(`a changed or missing ${identityChange} cannot turn an empty lookup into nonexecution`,async t=>{
    const c=await setupJournal({lost:true,absent:true,identityChange});t.after(()=>c.close());
    const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
    assert.equal(state.outcome,'unknown');assert.equal(state.frozen,true);
    if(identityChange==='since'){assert.match(state.missing_fact!,/查空不证明未执行/);assert.match(state.next_action!,/不得重交/);}
    else {assert.match(state.missing_fact!,/日志|主体/);assert.match(state.next_action!,/人工核对原投递事实/);}
    await c.service.resume(c.admin,state.job);assert.equal(c.calls.filter(n=>n==='send_blob').length,1);
  });
}

test('an inconsistent retention boundary below the journal start cannot prove nonexecution',async t=>{
  const c=await setupJournal({lost:true,absent:true,floorBeforeSince:true});t.after(()=>c.close());
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(state.outcome,'unknown');assert.equal(state.frozen,true);assert.match(state.missing_fact!,/查空不证明未执行/);
});

test('the actual submit session must advertise a declared request protocol version',async t=>{
  const c=await setupJournal({supportedVersions:['2']});t.after(()=>c.close());
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(state.outcome,'not_dispatched');assert.equal(c.calls.includes('send_blob'),false);
  assert.match(state.reason!,/投递会话版本/);assert.match(state.next_action!,/版本.*协议|版本.*支持/);
  assert.equal((await c.service.journal.events(state.job)).some(e=>e.body.detail.phase==='intent'),false);
});

test('a submit reply cannot change the previously observed request identity',async t=>{
  const c=await setupJournal({receiptChange:true});t.after(()=>c.close());
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(state.outcome,'unknown');assert.equal(state.frozen,true);assert.match(state.next_action!,/人工核对原投递事实/);
  assert.equal(c.calls.includes('read_blob'),false);
});

test('a supported query session cannot retroactively certify a legacy submit session',async t=>{
  const c=await setupJournal({lost:true,absent:true,uncertified:true});t.after(()=>c.close());
  const first=await c.service.dispatch(c.admin,c.run,c.executor.id);
  const events=await c.service.journal.events(first.job),intent=events.find(e=>e.body.detail.phase==='intent')!;
  const detail={...intent.body.detail};delete detail.request_protocol_verified;delete detail.request_protocol_version;
  await c.service.journal.append(await c.service.journal.binding(first.job),'intent','validate','completed',detail,intent.body.inputs);
  await c.registry.update(c.admin,c.executor.id,{...c.registered.definition,premises:{request_journal:{version:'1',evidence:[`src:${c.proof.body.sha256}`]}}});
  const state=await c.service.resume(c.admin,first.job);
  assert.equal(state.outcome,'unknown');assert.equal(state.frozen,true);assert.match(state.next_action!,/人工核对原投递事实/);
  assert.equal(c.calls.filter(n=>n==='send_blob').length,1);
});

test('conformance rejects identity changes between observation and admission replies',async t=>{
  const c=await setupJournal({uncertified:true,receiptChange:true});t.after(()=>c.close());
  const state=await c.service.conformance(c.admin,c.executor.id);
  assert.equal((await c.service.journal.events(state.job)).at(-1)!.body.detail.conformance_verified,false);
});

for(const stopped of [false,true]) {
  test(`a ${stopped?'negative':'startup'} record without a start marker cannot invent a device fact`,async t=>{
    const c=await setupJournal({lost:true,stopped,deviceReached:null});t.after(()=>c.close());
    const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
    assert.equal(state.outcome,'unknown');assert.equal(state.frozen,true);
    assert.equal(c.calls.includes('inspect_blob'),false);
    assert.ok(state.missing_fact);assert.ok(state.next_action);
    const events=await c.service.journal.events(state.job);
    assert.equal(events.some(e=>e.body.detail.phase==='reconciled' && e.body.detail.reached_device===false),false);
  });
}
