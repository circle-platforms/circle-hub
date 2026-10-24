import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {runRecord} from '../../../contracts/src/fixtures.ts';
import {RunRecord} from '../../../contracts/src/run.ts';
import type {RunsService} from '../../ports.ts';
import {openTestRecords,type TestRecordsKit} from '../../testing/records.ts';
import {startPostgres,type TemporaryPostgres} from '../../testing/postgres.ts';
import {createRequestService} from '../../requests/api.ts';
import {recordReaderFor} from '../../server/readers.ts';
import {recordReader,identityOf,canSeeRun,canViewRun} from './readers.ts';
import {putRun} from './store.ts';
let pg:TemporaryPostgres,kit:TestRecordsKit;
before(async()=>{pg=await startPostgres();kit=await openTestRecords({postgres:pg});});
after(async()=>{await kit?.close();await pg?.stop();});
test('request references inherit run visibility in both readers without broadening pack-level visibility',async()=>{
  const admin=(await kit.principals.bootstrapAdmin('合成管理员')).user;
  const alice=await kit.principals.createUser(admin,'合成甲'),bob=await kit.principals.createUser(admin,'合成乙');
  const run=RunRecord.parse({...runRecord,runner:alice.id,version:'10.6',build:'rel_demo_10_6_1',started_at:'2026-10-24T00:00:00.000Z',submission_due:'2026-10-26T00:00:00.000Z'});
  const stored=await putRun(kit.store,run,run.started_at);
  const requests=createRequestService(kit);
  const fields={kind:'repair' as const,audience:alice.id,due:'2026-10-26T00:00:00.000Z',missing:'合成缺口',next_action:'原样重交',source:stored.digest,code:'missing_input'};
  const question=await requests.write({...fields,run:run.run});
  const pack=await requests.write({...fields,pack_digest:'a'.repeat(64)});
  const hypothesis=await kit.store.put({kind:'claim',schema:'hypothesis-set@1',provenance:'projected',body:{run:run.run,hypotheses:[],residual:{status:'open'},next_request:'rec:'+question.digest}});
  const otherClaim=await kit.store.put({kind:'claim',schema:'synthetic-other@1',provenance:'declared',body:{run:run.run}});
  const runs={getRun:async(by:typeof alice,id:string)=>id===run.run&&canSeeRun(by,run)?{run,submissions:[],latest:null,production:null}:null} as unknown as RunsService;
  for(const reader of [{read:(id:string)=>recordReaderFor(kit,runs,alice).read(id,identityOf(alice,run.run))},{read:(id:string)=>recordReader(kit.store).read(id,identityOf(alice,run.run))}]){
    assert.ok(await reader.read(question.digest));
    assert.ok(await reader.read(hypothesis.digest));
    assert.equal(await reader.read(otherClaim.digest),null);
    assert.equal(await reader.read(pack.digest),null);
  }
  assert.equal(await recordReaderFor(kit,runs,bob).read(question.digest,identityOf(bob,run.run)),null);
  assert.equal(await recordReaderFor(kit,runs,bob).read(hypothesis.digest,identityOf(bob,run.run)),null);
  assert.equal(await recordReader(kit.store).read(question.digest,identityOf(bob,run.run)),null);
  await kit.authorizations.share(admin,run.run,[bob.id]);
  const sharedRuns={getRun:async(by:typeof bob,id:string)=>id===run.run&&await canViewRun(by,run,kit.store)?{run,submissions:[],latest:null,production:null}:null} as unknown as RunsService;
  const accepted=await kit.store.put({kind:'validation_result',schema:'validation@1',provenance:'projected',body:{run:run.run,acceptance:'accepted'}});
  const refused=await kit.store.put({kind:'validation_result',schema:'validation@1',provenance:'projected',body:{run:run.run,acceptance:'not_accepted',errors:[{message:'合成私有诊断'}]}});
  for(const reader of [recordReaderFor(kit,sharedRuns,bob),recordReader(kit.store)]){
    assert.ok(await reader.read(stored.digest,identityOf(bob,run.run)));
    assert.ok(await reader.read(accepted.digest,identityOf(bob,run.run)));
    assert.equal(await reader.read(refused.digest,identityOf(bob,run.run)),null);
    assert.equal(await reader.read(question.digest,identityOf(bob,run.run)),null,'sharing does not grant request authority');
    assert.equal(await reader.read(hypothesis.digest,identityOf(bob,run.run)),null,'sharing does not grant hypothesis-set visibility');
    assert.equal(await reader.read(pack.digest,identityOf(bob,run.run)),null);
  }
  assert.ok(await recordReaderFor(kit,runs,admin).read(question.digest,identityOf(admin,run.run)));
});
