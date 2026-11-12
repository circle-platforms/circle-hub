import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runRecord,accepted,RECOVERY} from '../../contracts/src/fixtures.ts';
import {RunRecord} from '../../contracts/src/run.ts';
import {ValidationResult} from '../../contracts/src/validation.ts';
import type {ServerDeps} from './api.ts';
import type {PageContext} from './console/pages.ts';
import type {RunSummary} from '../ports.ts';
import {loadTasks} from './console/tasks.ts';
import {checkCounts,blockers} from './console/overview.ts';
import {runStatistics} from '../runs/api.ts';

const run={...RunRecord.parse(runRecord),requirements:[]};
const summary=():RunSummary=>({run,latest:{record:'a'.repeat(64),result:ValidationResult.parse({...accepted,cross_item:[],partitions:{delivered:[{item:'synthetic',label:'合成',location:'src:'+'a'.repeat(64),requirements:[{requirement:'synthetic',status:'satisfied',claims:[],layers:[{layer:'static',terminal:'pass'}]}]}],rejected:[],incomplete:[],quarantined:[]}})},production:null});
const context=(runs:Partial<ServerDeps['runs']>)=>({principal:{id:run.runner,name:'合成统计读者',role:'user'},deps:{runs}} as PageContext);

test('list loader prefers compact statistics without falling back on denied or failed current heads',async()=>{
 const small=runStatistics(summary());let calls=0;
 const ctx=context({getRunStatistics:async()=>{calls++;return small;},getRun:async()=>{throw Error('full detail must not be read');},getRunSummary:async()=>{throw Error('full summary must not be read');}});
 const rows=await loadTasks(ctx,[run]);assert.equal(calls,1);assert.deepEqual(rows,[{run,statistics:small,result:small.result,pending:small.pending}]);assert.ok(!('detail'in rows[0]));
 ctx.deps.runs.getRunStatistics=async()=>null;assert.equal((await loadTasks(ctx,[run]))[0].result,null);ctx.deps.runs.getRunStatistics=async()=>{throw Error('unavailable');};assert.equal((await loadTasks(ctx,[run]))[0].result,null);
});
test('compact statistics retain the four-worker bound and original order for 120 rows',{timeout:10000},async()=>{
 const input=Array.from({length:120},(_,i)=>({...run,run:'run_'+String(i).padStart(26,'0')})),release=Promise.withResolvers<void>(),started=Promise.withResolvers<void>();let active=0,peak=0,launched=0;
 const ctx=context({getRunStatistics:async(_by,id)=>{launched++;active++;peak=Math.max(peak,active);if(launched===4)started.resolve();try{await release.promise;return {...runStatistics(summary()),pending:input.findIndex(row=>row.run===id)};}finally{active--;}}});
 const loading=loadTasks(ctx,input);try{await started.promise;assert.equal(launched,4);assert.equal(peak,4);}finally{release.resolve();await loading;}
 const rows=await loading;assert.equal(launched,120);assert.equal(peak,4);assert.deepEqual(rows.map(row=>row.run.run),input.map(row=>row.run));assert.deepEqual(rows.map(row=>row.pending),Array.from({length:120},(_,i)=>i));assert.ok(rows.every(row=>!('detail'in row)));
});
test('legacy summary and detail ports immediately discard claims while preserving overview totals and blocker labels',async()=>{
 const detail=summary();const requirement=detail.latest!.result.partitions.delivered[0].requirements[0];requirement.status='pending';requirement.layers=[{layer:'static',terminal:'unchecked',reason:'check_error',...RECOVERY}];const item=structuredClone(detail.latest!.result.partitions.delivered[0]);detail.latest!.result.partitions.rejected.push({...item,code:'synthetic.blocker'});
 const expected=await loadTasks(context({getRunStatistics:async()=>runStatistics(detail)}),[run]);
 const oldSummary=await loadTasks(context({getRunSummary:async()=>detail,getRun:async()=>{throw Error('no full read');}}),[run]);const oldDetail=await loadTasks(context({getRun:async()=>({...detail,submissions:[],requests:[]})}),[run]);assert.deepEqual(oldSummary,expected);assert.deepEqual(oldDetail,expected);
 assert.equal(expected[0].result,'rejected');assert.equal(expected[0].pending,1);assert.equal(checkCounts(expected).find(row=>row.label==='未知')?.value,2);assert.deepEqual(blockers(expected),[{label:'synthetic.blocker',value:1}]);assert.ok(!JSON.stringify(expected[0].statistics).includes('claims'));
});
