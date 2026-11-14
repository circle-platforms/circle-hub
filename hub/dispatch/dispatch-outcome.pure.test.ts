import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchOutcomeFacts } from './reasons.ts';

test('Stage and operation never supply an effect outcome', () => {
  assert.deepEqual(dispatchOutcomeFacts({phase:'complete',operation:'precheck'}), {phase:'complete',operation:'precheck'});
  assert.deepEqual(dispatchOutcomeFacts({input:null,phase:'complete'}), {phase:'complete'});
});
test('Reservation, invocation and worker settlement remain independent observations', () => {
  for (const key of ['reservation_recorded','submit_invoked','worker_settled']) {
    assert.deepEqual(dispatchOutcomeFacts({[key]:true}), {[key]:true});
  }
  assert.deepEqual(dispatchOutcomeFacts({outcome:'unknown',worker_settled:true}), {outcome:'unknown',worker_settled:true});
});
test('Missing observations remain absent and not_sent requires positive evidence', () => {
  assert.deepEqual(dispatchOutcomeFacts({}), {});
  assert.deepEqual(dispatchOutcomeFacts({not_sent:false}), {});
  assert.deepEqual(dispatchOutcomeFacts({submit_invoked:false}), {submit_invoked:false});
  assert.deepEqual(dispatchOutcomeFacts({not_sent:true}), {not_sent:true});
});
test('Only official carrier fields and valid references are projected', () => {
  assert.deepEqual(dispatchOutcomeFacts({phase:'complete',lease_key:'internal',raw:'secret',result:'invalid',operation:'invented'}), {phase:'complete'});
});

test('Runner projection keeps unknown despite complete and settled, omitting private fields throughout JSON', async () => {
  const { runnerNote } = await import('./accepted.ts');
  const note = runnerNote({job:'synthetic-job',ended:'unknown',boundary_refused:false,status:{job:'synthetic-job',phase:'complete',outcome:'unknown',frozen:true,events:3,operation:'dispatch',submit_invoked:true,reservation_recorded:true,worker_settled:true,missing_fact:'private-prefix/private-resource',next_action:'private-admin-command'}},'scheduler-admin',false,false);
  assert.equal(note.outcome,'unknown');
  assert.equal(note.operation,'dispatch');
  assert.equal(note.worker_settled,true);
  assert.equal(note.not_sent,undefined);
  assert.doesNotMatch(JSON.stringify(note), /private-prefix|private-resource|private-admin-command|scheduler-admin/);
});
