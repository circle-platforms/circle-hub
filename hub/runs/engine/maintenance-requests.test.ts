import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accepted, ADMIN, runRecord } from '../../../contracts/src/fixtures.ts';
import { RunRecord } from '../../../contracts/src/run.ts';
import { ValidationResult } from '../../../contracts/src/validation.ts';
import { openTestRecords } from '../../testing/records.ts';
import { createRequestService } from '../../requests/api.ts';
import type { EngineContext } from './deps.ts';
import { restoreLegacyRequests,restoreRecordedRequests } from './maintenance-requests.ts';

test('recorded exits regain named requests on a real temporary database without a sandbox', async t => {
  const kit = await openTestRecords();
  t.after(() => kit.close());
  const run = RunRecord.parse({...runRecord, runner:ADMIN});
  const result = ValidationResult.parse(accepted);
  const item = result.partitions.delivered[0];
  const requirement = item.requirements[0];
  const due = '2099-01-01T00:00:00.000Z';
  const exit = {action:'request' as const,request_kind:'repair' as const,audience:{user:ADMIN},due};
  requirement.layers = [{layer:'static',terminal:'unchecked',reason:'missing_input',missing:'合成主要缺失事实',exit,
    gaps:[{reason:'missing_input',missing:'合成独立缺失事实',exit:structuredClone(exit)},
      {reason:'missing_input',missing:'缺受众的旧出口',exit:{action:'request'}} as never]}];
  requirement.status = 'pending';
  delete requirement.unsatisfied_reason;
  item.requirements = [requirement];
  result.partitions = {delivered:[item],rejected:[],quarantined:[],incomplete:[]};
  result.cross_item = [];result.errors = [];
  const storedRun = await kit.store.put({kind:'run',schema:'run@1',provenance:'observed',body:run});
  const storedResult = await kit.store.put({kind:'validation_result',schema:'validation@1',provenance:'projected',body:result});
  const original = JSON.stringify((await kit.store.get(storedResult.digest))!.body);
  const ctx = {deps:{records:kit,workflows:{byDigest:async()=>null}},now:()=>new Date('2026-10-01T00:00:00.000Z')} as unknown as EngineContext;
  const requests = createRequestService(kit);
  await restoreRecordedRequests(ctx,storedRun,storedResult);
  const first = await requests.all(run.run);
  assert.deepEqual(first.map(row=>row.missing).sort(),['合成主要缺失事实','合成独立缺失事实']);
  assert.ok(first.every(row=>row.audience===ADMIN&&row.due===due&&row.source===result.submission&&row.next_action.trim()));
  const answer = await kit.store.put({kind:'claim',schema:'synthetic-answer@1',provenance:'declared',body:{fact:'合成答复'}});
  await requests.answer(first[0].record,answer.digest);
  await restoreRecordedRequests(ctx,storedRun,storedResult);
  const again = await requests.all(run.run);
  assert.equal(again.length,2);
  assert.equal(again.find(row=>row.record===first[0].record)?.answered_by,answer.digest);
  assert.equal(JSON.stringify((await kit.store.get(storedResult.digest))!.body),original);
});

test('existing historical repair requests are checked in bounded batches without extending deadlines', async t => {
  const kit = await openTestRecords();
  t.after(() => kit.close());
  const run = RunRecord.parse({...runRecord, runner:ADMIN});
  const result = ValidationResult.parse(accepted);
  const template = result.partitions.delivered[0];
  result.partitions = {delivered:Array.from({length:150},(_,index)=>{
    const item=structuredClone(template);item.item='synthetic-'+index;item.requirements=[item.requirements[0]];
    item.requirements[0].layers=[{layer:'static',terminal:'unchecked',reason:'missing_input'}];
    item.requirements[0].status='pending';delete item.requirements[0].unsatisfied_reason;return item;
  }),rejected:[],quarantined:[],incomplete:[]};
  result.cross_item=[];result.errors=[];
  const storedRun=await kit.store.put({kind:'run',schema:'run@1',provenance:'observed',body:run});
  const storedResult=await kit.store.put({kind:'validation_result',schema:'validation@1',provenance:'projected',body:result});
  let now=new Date('2026-10-01T00:00:00.000Z');
  const ctx={deps:{records:kit},now:()=>now} as unknown as EngineContext;
  await restoreLegacyRequests(ctx,storedRun,storedResult);
  const service=createRequestService(kit),first=await service.all(run.run);
  assert.equal(first.length,150);
  const before=first.map(row=>({record:row.record,due:row.due}));
  let single=0,batches=0;
  const find=kit.store.find.bind(kit.store),findFirstMany=kit.store.findFirstMany.bind(kit.store);
  t.mock.method(kit.store,'find',async (...args:Parameters<typeof find>)=>{if(args[0].key==='runs.request.key')single++;return find(...args);});
  t.mock.method(kit.store,'findFirstMany',async (...args:Parameters<typeof findFirstMany>)=>{if(args[0].key==='runs.request.key'){batches++;assert.ok(args[0].values.length<=128);}return findFirstMany(...args);});
  now=new Date('2026-10-08T00:00:00.000Z');
  await restoreLegacyRequests(ctx,storedRun,storedResult);
  assert.equal(single,0);assert.equal(batches,2);
  assert.deepEqual((await service.all(run.run)).map(row=>({record:row.record,due:row.due})),before);
});
