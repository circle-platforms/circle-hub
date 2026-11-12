// The engine's listings of the waiting requests (issue 200): a run's page, the run listing and the request listing answer
// what the full listing answers for the requests that wait, for each reader, without reading the settled ones.
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {runRecord} from '../../../contracts/src/fixtures.ts';
import {RunRecord} from '../../../contracts/src/run.ts';
import {newId} from '../../records/api.ts';
import {startPostgres} from '../../testing/postgres.ts';
import {openHarness} from './testing/harness.ts';
import {putRun} from './store.ts';
import {createRequestService} from '../../requests/api.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());

test('a run answers its waiting requests as its full listing does, to its runner and an administrator and to nobody else',async t=>{
 const h=await openHarness(postgres);t.after(h.close);
 const body=RunRecord.parse({...runRecord,run:newId('run'),runner:h.alice.id,pack:`${h.review.pack.id}@${h.review.pack.version}`,pack_digest:h.review.pack.digest,requirements:[],sources:[],items:[],target_basis:[],client_key:'synthetic-waiting-requests'});
 const run=await putRun(h.kit.store,body,new Date(body.started_at).toISOString()),requests=createRequestService(h.kit);
 const made:string[]=[];
 for(let n=0;n<6;n++)made.push((await requests.write({run:body.run,source:run.digest,kind:'repair',audience:h.alice.id,due:'2026-10-21T00:00:00.000Z',missing:`合成缺口 ${n}`,next_action:'原样重交',code:'not_covered'})).digest);
 await requests.answer(made[0],run.digest);
 assert.equal(await requests.supersede([made[1],made[2],made[3]],run.digest),3);
 assert.equal(await requests.reinstate([made[2]],run.digest),1);
 const waits=[made[2],made[4],made[5]];
 for(const reader of [h.alice,h.admin]){
  const full=await h.service.listRequests!(reader,body.run),waiting=await h.service.listRequests!(reader,body.run,{waiting:true});
  assert.equal(full.length,6);
  assert.deepEqual(waiting,full.filter(request=>request.answered_by===null));
  assert.deepEqual(waiting.map(request=>request.record),waits);
  assert.deepEqual((await h.service.getRun(reader,body.run,{requests:'waiting'}))!.requests,waiting,'the run page asks for the waiting ones');
  assert.deepEqual((await h.service.getRun(reader,body.run))!.requests,full,'and gets them all when it does not');
  assert.deepEqual((await h.service.getRun(reader,body.run,{history:{limit:1}}))!.requests,full);
  assert.deepEqual((await h.service.listRuns(reader,{limit:5})).requests?.filter(request=>request.run===body.run),waiting,'the run listing names the waiting ones');
  assert.deepEqual((await h.service.listRequests!(reader,undefined,{waiting:true})).filter(request=>request.run===body.run),waiting);
 }
 assert.deepEqual(await h.service.listRequests!(h.bob,body.run,{waiting:true}),[],'a reader who may not see the run sees none of its requests');
 assert.deepEqual(await h.service.listRequests!(h.bob,undefined,{waiting:true}),[]);
 // Voiding what still waits leaves nothing waiting, and the full listing keeps all six.
 assert.equal(await requests.supersede(waits,run.digest),3);
 assert.deepEqual(await h.service.listRequests!(h.admin,body.run,{waiting:true}),[]);
 assert.equal((await h.service.listRequests!(h.admin,body.run)).length,6);
 assert.equal((await h.service.listRuns(h.admin,{limit:5})).requests,undefined);
});
