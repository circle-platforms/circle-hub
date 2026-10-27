// T7-6 inventories the entire synthetic world, not a hand-selected list of unknown results.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunSummary } from '../../contracts/src/run.ts';
import { PARTITION } from '../../contracts/generated/vocabulary.ts';
import { isUnknownTerminal, partitionCountsOf } from '../../contracts/src/validation.ts';
import { MissingFact, UnknownExit, RecoveryGap } from '../../contracts/src/recovery.ts';
import { createRequestService } from '../../hub/requests/api.ts';
import { listRunInventory, type RunListRow } from '../../hub/server/run-list.ts';
import { listRunRecords, resultsOf } from '../../hub/runs/engine/store.ts';
import { startPostgres } from '../../hub/testing/postgres.ts';
import { openBed } from './support/hub.ts';
import { draft, startReview } from './support/review.ts';

test('T7-6 every run in the synthetic world is inventoried and every current unknown has missing facts and an executable exit', async t => {
  const postgres = await startPostgres();
  t.after(() => postgres.stop());
  const bed = await openBed({postgres});
  t.after(() => bed.close());
  const client = await bed.connect(bed.reviewer, 'synthetic-census');
  const subject = await client.upload(bed.store.reviewMindmap(), 'synthetic-census.km.json');
  // No-result, accepted, rejected-latest and omitted-item controls share one durable world.
  const runs:RunSummary[] = [];
  for (let n = 0; n < 5; n++) {
    const run = await startReview(client,{product:bed.second.names[0],version:'2.1',inputs:{subject:{reference:subject}}});
    runs.push(run);
    if (n === 0) continue;
    if (n === 4) {
      const refused=await client.call('submit_result',{run:run.run,model:'synthetic-invalid-submission',items:[{item:'not-an-item',handling:'handled',slots:{findings:[]}}]});
      assert.equal(refused.out.acceptance,'not_accepted');
      continue;
    }
    const submission = draft(run, new Map(), n === 3 ? {omit:new Set([run.items[0].id])} : {});
    const answer = await client.call('submit_result',submission);
    assert.equal(answer.out.acceptance,'accepted',answer.text);
    if (n === 2) {
      const invalid = await client.call('submit_result',{...submission,items:[{item:'not-an-item',handling:'handled',slots:{findings:[]}}]});
      assert.equal(invalid.out.acceptance,'not_accepted');
    }
  }
  const previous=(await bed.hub.deps.runs.getRun(bed.reviewer.principal,runs[1].run))!.latest!.record;
  const verification=await client.call('start_run',{pack:'case-review-verify',product:bed.second.names[0],version:'2.1',predecessor:runs[1].run,inputs:{target:{reference:subject},draft:{reference:'rec:'+previous}}});
  assert.equal(verification.isError,false,verification.text);
  const verified=verification.out.run!;runs.push(verified);
  const unknownIdentity=await client.call('submit_result',{run:verified.run,model:'synthetic-legacy-undeclared-family',items:verified.items.map(item=>({item:item.id,handling:'handled',slots:{verification:[]}})),cross_item:[{nature:'judgment',statement:'合成复核 PARTIAL',grounds:[],code:'PARTIAL',rank:'P4'}]});
  assert.equal(unknownIdentity.out.acceptance,'accepted',unknownIdentity.text);
  const inventory = async (unknown:boolean) => {
    const rows:RunListRow[]=[];
    let cursor:string|null=null;
    const seen = new Set<string>();
    do {
      const page = await listRunInventory(bed.hub.records,bed.hub.admin.principal,{pack:null,user:null,state:null,since:null,unknown,limit:1,cursor});
      rows.push(...page.items);
      cursor=page.next;
      if(cursor!==null){assert.ok(!seen.has(cursor));seen.add(cursor);}
    } while(cursor!==null);
    return rows;
  };
  const all = await inventory(false);
  const stored = [];
  let cursor:string|null=null;
  do {
    const page = await listRunRecords(bed.hub.records.store,{}, {limit:1,cursor});
    stored.push(...page.items);
    cursor=page.next;
  } while(cursor!==null);
  assert.ok(all.length>=runs.length,'no created run was silently excluded');
  for(const run of runs)assert.ok(all.some(row=>row.run===run.run));
  assert.equal(all.find(row=>row.run===runs[0].run)!.state,'进行中');
  assert.equal(all.find(row=>row.run===runs[2].run)!.state,'未受理','a later rejection does not erase the earlier accepted unknown');
  assert.deepEqual(all.map(r=>r.run).sort(),stored.map(r=>r.body.run).sort());
  const expectedUnknown:string[]=[];
  let checked=0, pending=0;
  for(const row of all){
    const results=(await resultsOf(bed.hub.records.store,row.run)).filter(r=>r.body.system_input===undefined);
    results.sort((a,b)=>a.created_at===b.created_at?(a.digest<b.digest?1:-1):a.created_at<b.created_at?1:-1);
    const accepted=results.find(r=>r.body.acceptance==='accepted');
    if(!accepted){assert.equal(row.unknown,0);assert.equal(row.state,results.length===0?'进行中':'未受理');pending++;continue;}
    const result=accepted.body;
    const requests=await createRequestService(bed.hub.records).all(row.run);
    function checkExit(missing:unknown,exit:unknown){
      assert.ok(MissingFact.safeParse(missing).success);
      const parsed=UnknownExit.parse(exit);
      if(parsed.action==='request'&&'user'in parsed.audience){
        const audience=parsed.audience.user;
        const request=requests.find(r=>r.kind===parsed.request_kind&&r.audience===audience&&r.due===parsed.due&&r.missing===missing);
        assert.ok(request, 'a human exit is a stored request, not just a sentence in the result');
        assert.ok(MissingFact.safeParse(request.next_action).success);
      }
    }
    assert.equal(row.unknown,partitionCountsOf(result.partitions).unknown);
    if(row.unknown>0)expectedUnknown.push(row.run);
    for(const claim of result.cross_item){
      if(claim.qualifier.nature!=='unknown'&&claim.statement.verdict!=='unknown')continue;
      assert.ok(claim.requirement,'a cross-item unknown names its requirement');
      const request=requests.find(r=>r.source===result.submission&&r.requirement===claim.requirement&&r.missing===claim.statement.text);
      assert.ok(request,'a cross-item unknown has a stored request for its exact missing fact');
      assert.ok(MissingFact.safeParse(request.missing).success);
      assert.ok(MissingFact.safeParse(request.next_action).success);
      checked++;
    }
    for(const p of PARTITION)for(const item of result.partitions[p])for(const requirement of item.requirements)for(const layer of requirement.layers){
      if(isUnknownTerminal(layer)){
        assert.ok(MissingFact.safeParse(layer.missing).success,`${row.run}/${item.item}/${requirement.requirement}: missing fact`);
        assert.ok(UnknownExit.safeParse(layer.exit).success,`${row.run}/${item.item}/${requirement.requirement}: named, scheduled exit`);
        checkExit(layer.missing,layer.exit);
        checked++;
      }
      for(const gap of layer.gaps??[]){assert.ok(RecoveryGap.safeParse(gap).success);checkExit(gap.missing,gap.exit);checked++;}
    }
  }
  assert.ok(pending>0,'the census includes runs without an accepted result');
  assert.ok(checked>0,'the census is not vacuous');
  assert.deepEqual((await inventory(true)).map(r=>r.run).sort(),expectedUnknown.sort(),'the same reader as run list --unknown sees exactly the current unknown runs');
});
