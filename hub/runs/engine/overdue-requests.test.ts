import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {startPostgres,type TemporaryPostgres} from '../../testing/postgres.ts';
import {openRetryHarness} from './testing/retry-harness.ts';
import {sandboxSkip} from './testing/harness.ts';
import {standardDocument,toyMap} from './testing/mindmap.ts';
import {createRequestService} from '../../requests/api.ts';
import {runById} from './store.ts';
let pg:TemporaryPostgres;const skip=await sandboxSkip();
before(async()=>{pg=await startPostgres();});after(async()=>{await pg?.stop();});
test('overdue requests stay separately visible and escalate once per deadline without replacing their originals',{skip},async()=>{
  const h=await openRetryHarness(pg);
  try{
    const map=await h.upload(h.alice,toyMap(standardDocument()));
    const started=await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'10.6.1',build:'Rel_MEADOW_10_6_1_7',inputs:{map:{reference:map}}},h.call());
    const run=started.run!,stored=(await runById(h.kit.store,run.run))!;
    const requests=createRequestService(h.kit),question=await requests.write({run:run.run,kind:'clarification',audience:h.alice.id,due:run.started_at,missing:'缺少合成补证',next_action:'原运行者补齐事实',source:stored.digest,code:'missing_input'});
    const original=await h.kit.store.get(question.digest);
    h.advance(1000);await h.service.maintain();
    const listing=await h.service.listRuns(h.admin);
    assert.ok(listing.overdue_requests?.some(q=>q.record===question.digest));
    const escalation=listing.requests?.find(q=>q.source===question.digest);
    assert.ok(escalation);assert.equal(escalation.audience,h.admin.id);
    assert.ok(Date.parse(escalation.due)>Date.parse(question.body.due));
    assert.ok(escalation.next_action.includes(question.digest));
    assert.deepEqual(await h.kit.store.get(question.digest),original);
    await h.service.maintain();
    assert.equal((await requests.all(run.run)).filter(q=>q.source===question.digest).length,1);
    h.advance(86400001);await h.service.maintain();
    assert.equal((await requests.all(run.run)).filter(q=>q.source===escalation.record).length,1,'an administrator deadline also has a next action');
    await requests.answer(question.digest,stored.digest);await h.service.maintain();
    const all=await requests.all(run.run);
    assert.equal(all.find(q=>q.record===escalation.record)!.answered_by,stored.digest);
    assert.equal(all.find(q=>q.source===escalation.record)!.answered_by,stored.digest);
    assert.ok(!(await h.service.listRuns(h.admin)).overdue_requests?.some(q=>q.record===question.digest));
  }finally{await h.close();}
});
