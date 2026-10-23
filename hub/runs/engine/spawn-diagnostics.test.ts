import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after,before,test} from 'node:test';
import type {ActionBody} from '../../records/api.ts';
import {startPostgres,type TemporaryPostgres} from '../../testing/postgres.ts';
import {INDEX} from './store.ts';
import {sandboxSkip} from './testing/harness.ts';
import {reviewPack,writePack} from './testing/packs.ts';
import {standardDocument,toyMap} from './testing/mindmap.ts';
import {openRetryHarness} from './testing/retry-harness.ts';
let postgres:TemporaryPostgres;const skip=await sandboxSkip();
before(async()=>{postgres=await startPostgres();});after(async()=>{await postgres?.stop();});
for(const operation of ['check','subject'])test(`exhausted ${operation} startup cause goes only to the administrator`,{skip},async()=>{
  const h=await openRetryHarness(postgres);const original=childProcess.spawn;
  const dir=await mkdtemp(join(tmpdir(),'circle-hub-spawn-admin-'));
  try{
    const spec=reviewPack();spec.version='1.0.1';
    spec.files['requirements.json']={json:{schema:'requirements@1',requirements:[{...h.review.requirements[0],checks:['structure']},h.review.requirements[3]]}};
    spec.files['functions/probe.ts']='export default () => [];';
    const structure={id:'structure',applies:'run',judges:'subject',tier:'advisory',function:{module:'functions/probe.ts'}};
    if(operation==='subject')spec.files['functions/subject.ts']='export default input => ({items:input.items});';
    spec.files['checks.json']={json:{schema:'checks@1',checks:[operation==='subject'?{...structure,subject:{module:'functions/subject.ts'}}:structure]}};
    await h.workflows.add(await writePack(dir,spec));
    const doc=standardDocument();doc.groups=[{...doc.groups[0],cases:[doc.groups[0].cases[0]]}];
    const source=await h.upload(h.alice,toyMap(doc));
    const run=(await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'10.6.1',build:'Rel_MEADOW_10_6_1_7',inputs:{map:{reference:source}}},h.call())).run!;
    let launches=0;
    childProcess.spawn=((...args:Parameters<typeof original>)=>{
      if(args[1]?.some(arg=>String(arg).endsWith('/bootstrap.ts'))){launches++;throw Object.assign(new Error('SyntheticSpawnAdminOnly'),{code:'EAGAIN'});}
      return original(...args);
    }) as typeof original;syncBuiltinESMExports();
    const submission={run:run.run,model:'synthetic-model',items:run.items.map(item=>({item:item.id,handling:'handled',slots:{findings:[]}})),cross_item:[{nature:'judgment',statement:'一般',grounds:[],code:'draft_level',rank:'P4'}]};
    const answer=await h.service.submitResult(h.alice,submission,h.call());
    assert.equal(answer.acceptance,'accepted');assert.equal(launches,3);
    const diagnostics=h.logs.map(entry=>entry.detail).join('\n');
    assert.match(diagnostics,/EAGAIN/);assert.match(diagnostics,/SyntheticSpawnAdminOnly/);
    const actions=(await h.kit.store.find<ActionBody>({key:INDEX.actionRun,value:run.run,kind:'action'})).items.filter(row=>row.body.action==='validate');
    const attempts=actions[0].body.detail.retry_attempts as Array<Record<string,unknown>>;
    assert.deepEqual(attempts.map(value=>value.attempt),[1,2,3]);assert.ok(attempts.every(value=>value.reason==='check_error'));
    for(const value of [answer,actions.map(row=>row.body)]){
      const json=JSON.stringify(value);assert.ok(!json.includes('EAGAIN'));assert.ok(!json.includes('SyntheticSpawnAdminOnly'));
    }
    assert.ok(!JSON.stringify(attempts).includes('spawn_failed'));
    const before=launches;
    const repeated=await h.service.submitResult(h.alice,submission,h.call());
    assert.equal(repeated.acceptance,'accepted');assert.equal(launches,before+3,'a transitional receipt rechecks the same body against current facts');
    assert.equal(repeated.counts!.unknown,answer.counts!.unknown);
    assert.ok(!JSON.stringify(repeated).includes('SyntheticSpawnAdminOnly'));
  }finally{childProcess.spawn=original;syncBuiltinESMExports();await h.close();await rm(dir,{recursive:true,force:true});}
});
