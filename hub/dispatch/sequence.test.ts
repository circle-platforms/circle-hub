import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ExecutorDefinition} from '../../contracts/src/resources.ts';
import {definition} from './testing/definition.ts';
import {setup} from './testing/context.ts';
import {setupJournal} from './testing/journal.ts';
import {Journal,digestOfValue} from './journal.ts';

 test('per-executor dispatch ordinals are signed, durable and never reset with a new service journal',async t=>{
  const c=await setup();t.after(()=>c.close());
  const result=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(result.outcome,'effective');
  const events=await c.service.journal.events(result.job);
  const intent=events.find(event=>event.body.detail.phase==='intent')!;
  const wire=c.endpoint.calls.find(call=>call.params.name==='send_blob')!.params.arguments as Record<string,unknown>;
  assert.equal(wire.dispatch_sequence,1);assert.equal(wire.sequence_scope,c.executor.id);
  assert.equal(intent.body.detail.dispatch_sequence,wire.dispatch_sequence);
  assert.equal(intent.body.detail.action_digest,digestOfValue({content:c.payload.body.sha256,tool:'send_blob',arguments:wire}));
  const binding=await c.service.journal.binding(result.job);
  const next=await Promise.all([c.service.journal.nextDispatchSequence(binding),c.service.journal.nextDispatchSequence(binding)]);
  assert.deepEqual(next.sort((a,b)=>a-b),[2,3]);
  const restarted=new Journal(c.service.journal.records,()=>new Date('2001-01-01T00:00:00Z'));
  assert.equal(await restarted.nextDispatchSequence(binding),4,'persisted maximum wins even when the issuer clock moves backwards');
  assert.equal(await restarted.nextDispatchSequence({...binding,executor:'synthetic-other-executor'}),1);
 });

 test('the issuer expires an intent before sending and leaves no gateway submit invocation',async t=>{
  const c=await setup();t.after(()=>c.close());
  const append=c.service.journal.append.bind(c.service.journal);
  t.mock.method(c.service.journal,'append',async(...args:Parameters<Journal['append']>)=>{
    const event=await append(...args);
    if(args[1]==='intent')c.clock.ms+=600000;
    return event;
  });
  const result=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(result.outcome,'not_dispatched');
  assert.equal(c.calls.filter(name=>name==='send_blob').length,0);
  assert.ok((await c.service.journal.events(result.job)).some(event=>event.body.detail.next_action));
 });

 for(const skew of [-7*3600000,7*3600000])test(`target wall-clock skew ${skew} never gates issuer dispatch`,async t=>{
  const c=await setupJournal({clockLagMs:skew});t.after(()=>c.close());
  const result=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(result.outcome,'effective');assert.equal(c.calls.filter(name=>name==='send_blob').length,1);
 });

test('request protocol binds sequence and scope exactly once without requiring a deadline',()=>{
  const d=definition('http://127.0.0.1:9');
  const shape=(arguments_:Record<string,unknown>)=>({...d,calls:{...d.calls,submit:{...d.calls.submit,arguments:arguments_}}});
  const args:Record<string,unknown>={...d.calls.submit.arguments};
  assert.ok(ExecutorDefinition.safeParse(shape(args)).success);
  for(const field of ['dispatch_sequence','sequence_scope']){
    const missing={...args}; delete missing[field];
    assert.equal(ExecutorDefinition.safeParse(shape(missing)).success,false);
  }
  assert.equal(ExecutorDefinition.safeParse(shape({...args,duplicate:{$value:'dispatch_sequence'}})).success,false);
  const legacy=shape({...args});delete (legacy.receipt as {request_id?:string}).request_id;
  delete legacy.calls.submit.arguments.dispatch_sequence;
  assert.equal(ExecutorDefinition.safeParse(legacy).success,false,'omitting receipt fields cannot bypass sequence identity');
});
