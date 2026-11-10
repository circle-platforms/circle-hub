import assert from 'node:assert/strict';
import {test} from 'node:test';
import {accepted,runRecord,RECOVERY,claim} from '../../contracts/src/fixtures.ts';
import {ENGINE_COMPONENT} from './engine/deps.ts';
import {RunRecord} from '../../contracts/src/run.ts';
import {ValidationResult} from '../../contracts/src/validation.ts';
import {Claim} from '../../contracts/src/claim.ts';
import {TASK_RESULT} from '../../contracts/generated/vocabulary.ts';
import type {RunSummary} from '../ports.ts';
import {runStatistics,runTaskResult,runPendingCount,primaryRunResult} from './statistics.ts';

function summary():RunSummary{return {run:{...RunRecord.parse(runRecord),requirements:[]},latest:{record:'a'.repeat(64),result:ValidationResult.parse({...accepted,cross_item:[],partitions:{delivered:[{item:'synthetic',label:'合成',location:'src:'+'a'.repeat(64),requirements:[{requirement:'synthetic',status:'satisfied',claims:[claim],layers:[{layer:'static',terminal:'pass'}]}]}],rejected:[],incomplete:[],quarantined:[]}})},production:null};}
function pending(summary:RunSummary){const requirement=summary.latest!.result.partitions.delivered[0].requirements[0];requirement.status='pending';requirement.layers=[{layer:'static',terminal:'unchecked',reason:'check_error',...RECOVERY}];}

test('statistics preserve every task result, pending count, primary selection and unknown-layer classification',()=>{
 const checked=new Set<string>();const check=(value:RunSummary,expected:string)=>{const statistics=runStatistics(value);assert.equal(statistics.result,expected);assert.equal(statistics.pending,runPendingCount(value));assert.equal(statistics.result,runTaskResult(value));checked.add(expected);return statistics;};
 const base=summary();base.run.requirements=[];check(base,'passed');
 const waiting=summary();waiting.latest=null;waiting.run.requirements=[];check(waiting,'awaiting');
 const unknown=summary();unknown.run.requirements=[];pending(unknown);assert.equal(check(unknown,'delivered_pending').pending,1);assert.equal(runStatistics(unknown).checks.find(row=>row.terminal==='unchecked')?.unknown,true);
 const unsatisfied=summary();unsatisfied.run.requirements=[];unsatisfied.latest!.result.partitions.delivered[0].requirements[0].status='unsatisfied';check(unsatisfied,'delivered_unsatisfied');
 for(const [partition,expected] of [['rejected','rejected'],['incomplete','incomplete'],['quarantined','held']] as const){const value=summary();value.run.requirements=[];const item=value.latest!.result.partitions.delivered.pop()!;if(partition==='rejected')value.latest!.result.partitions.rejected.push({...item,code:'synthetic.refusal'});else value.latest!.result.partitions[partition].push({...item,reason:'missing_input',...RECOVERY});const stats=check(value,expected);assert.equal(stats.blockers[0].count,1);assert.equal(partition==='rejected'?stats.blockers[0].code:stats.blockers[0].reason,partition==='rejected'?'synthetic.refusal':'missing_input');}
 const abandoned=summary();abandoned.run.requirements=[];abandoned.latest!.result.cross_item.push(Claim.parse({...claim,statement:{text:'合成中止',data:{run_disposition:'abandon'}},grounds:[],warrant:{producer:'function',id:ENGINE_COMPONENT}}));check(abandoned,'abandoned');assert.deepEqual([...checked].sort(),[...TASK_RESULT].sort());
 const management=summary();management.management={record:'b'.repeat(64),disposition:'abandon',result:null};assert.equal(runStatistics(management).result,'abandoned');
 const fact=summary();fact.run.requirements=RunRecord.parse(runRecord).requirements.map(row=>({...row,rules:row.rules??[],run_interpreters:row.run_interpreters??[],accepted_producer:'fact'}));fact.production=fact.latest;fact.latest=null;assert.equal(primaryRunResult(fact),fact.production);assert.equal(runStatistics(fact).result,'passed');
 const system=summary();system.run.requirements=fact.run.requirements;system.production=fact.production;system.latest!.result.system_input='a'.repeat(64);pending(system);assert.equal(primaryRunResult(system),system.latest);assert.equal(runStatistics(system).result,'delivered_pending');
});

test('large statements, original fields and claim bodies never scale the returned statistics or retain input objects',()=>{
 const small=summary();small.run.requirements=[];const large=structuredClone(small);large.run.items[0].fields={synthetic:'x'.repeat(2*1024*1024)};const claim=large.latest!.result.partitions.delivered[0].requirements[0].claims[0];assert.ok(claim);claim.statement.text='synthetic'.repeat(256*1024);claim.statement.data={synthetic:'x'.repeat(1024*1024)};
 const expected=runStatistics(small),actual=runStatistics(large);assert.deepEqual(actual,expected);assert.equal(JSON.stringify(actual).length,JSON.stringify(expected).length);assert.ok(JSON.stringify(actual).length<2048);assert.ok(!('run'in actual));assert.ok(!('latest'in actual));assert.ok(!JSON.stringify(actual).includes('synthetic'));
 large.latest!.result.partitions.delivered[0].requirements[0].layers.length=0;assert.deepEqual(actual,expected);
});
