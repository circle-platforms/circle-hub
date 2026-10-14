import assert from 'node:assert/strict';import {test} from 'node:test';import {setup} from './harness.ts';
test('Worker liveness query: a configured detection threshold is distinct from the scope SLA and disclosed with exception counts',async t=>{
 const h=await setup(t,{CIRCLE_SERVER_WORKER_OFFLINE_MS:'60000'});await h.request('/v1/workers/register',{},'lab-east-01');await h.db.query("UPDATE workers SET last_seen=clock_timestamp()-interval '75 seconds' WHERE worker_id='lab-east-01'");const queues=await h.request('/v1/queues?scopeId=scp_lab',undefined,'admin');assert.equal(queues.exceptions.groups.workerOffline.count,1);assert.equal(queues.workerOfflineAfterMs,60000);assert.equal(queues.exceptions.groups.workerOffline.slaMs,queues.slaByScope.scp_lab.exceptions);
});
