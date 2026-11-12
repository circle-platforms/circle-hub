import assert from 'node:assert/strict';
import {test} from 'node:test';
import {accepted,runRecord} from '../../../contracts/src/fixtures.ts';
import {ValidationResult} from '../../../contracts/src/validation.ts';
import {RunRecord,type RunRecordView} from '../../../contracts/src/run.ts';
import type {RunSummary} from '../../ports.ts';
import {newId} from '../../records/api.ts';
import type {PageContext} from './pages.ts';
import {loadTasks,resultCell} from './tasks.ts';

const runs=(count:number):RunRecordView[]=>Array.from({length:count},()=>({...RunRecord.parse({...runRecord,run:newId('run'),requirements:[]}),requirements:[]}));
const summary=(run:RunRecordView,pending=0):RunSummary=>({run,latest:pending?{record:'a'.repeat(64),result:ValidationResult.parse({...accepted,cross_item:[],partitions:{delivered:[{item:'synthetic',label:'合成',location:'src:'+'a'.repeat(64),requirements:Array.from({length:pending},(_,i)=>({requirement:'synthetic-'+i,status:'pending',claims:[],layers:[]}))}],rejected:[],incomplete:[],quarantined:[]}})}:null,production:null});

test('a full page bounds simultaneous heavy summaries without dropping or reordering its 120 runs',{timeout:10_000},async()=>{
 const input=runs(120),release=Promise.withResolvers<void>(),started=Promise.withResolvers<void>();let active=0,peak=0,launched=0;
 const ctx={principal:{id:newId('usr')},deps:{runs:{getRunSummary:async(_user:unknown,id:string)=>{launched++;active++;peak=Math.max(peak,active);if(launched===4)started.resolve();try{await release.promise;return summary(input.find(run=>run.run===id)!,input.findIndex(run=>run.run===id)%4);}finally{active--;}}}}} as unknown as PageContext;
 const loading=loadTasks(ctx,input);try{await started.promise;assert.equal(launched,4,'remaining summaries must not start before an active read finishes');assert.equal(peak,4);}finally{release.resolve();await loading;}
 const rows=await loading;assert.equal(rows.length,120);assert.deepEqual(rows.map(row=>row.run.run),input.map(run=>run.run));assert.deepEqual(rows.map(row=>row.pending),input.map((_,i)=>i%4));assert.equal(peak,4);assert.equal(launched,120);
});

test('reverse completion order keeps each summary attached to its original row',{timeout:10_000},async()=>{
 const input=runs(4),gates=input.map(()=>Promise.withResolvers<RunSummary>()),started=Promise.withResolvers<void>();let launched=0;
 const ctx={principal:{id:newId('usr')},deps:{runs:{getRunSummary:async(_user:unknown,id:string)=>{if(++launched===4)started.resolve();return gates[input.findIndex(run=>run.run===id)].promise;}}}} as unknown as PageContext;
 const loading=loadTasks(ctx,input);try{await started.promise;for(let index=input.length-1;index>=0;index--)gates[index].resolve(summary(input[index],index));}finally{gates.forEach((gate,index)=>gate.resolve(summary(input[index],index)));}
 const rows=await loading;assert.deepEqual(rows.map(row=>row.run.run),input.map(run=>run.run));assert.deepEqual(rows.map(row=>row.pending),[0,1,2,3]);
});

test('bounded summary loading keeps unavailable and unknown outcomes honest and supports an older detail-only port',async()=>{
 const input=runs(12);let legacyReads=0;
 const partial={...accepted,partitions:{delivered:[{item:'synthetic',label:'合成未决',requirements:[{requirement:'synthetic',status:'pending',layers:[]}]}],rejected:[],incomplete:[],quarantined:[]}};
 const ctx={principal:{id:newId('usr')},deps:{runs:{getRunSummary:async(_user:unknown,id:string)=>{
  const index=input.findIndex(run=>run.run===id);if(index===1)return null;if(index===2)throw Error('synthetic read unavailable');
  return index===3?{...summary(input[index]),latest:{record:'a'.repeat(64),result:partial}}:summary(input[index]);
 },getRun:async()=>{legacyReads++;throw Error('must not fall back past a summary result');}}}} as unknown as PageContext;
 const rows=await loadTasks(ctx,input);assert.equal(rows.length,12);assert.equal(legacyReads,0);
 for(const index of [1,2]){assert.equal(rows[index].pending,0);assert.equal(rows[index].result,null);assert.match(String(resultCell(rows[index])),/结果暂不可用/);}
 assert.equal(rows[0].result,'awaiting');assert.equal(rows[3].result,'delivered_pending');assert.equal(rows[3].pending,1);
 delete ctx.deps.runs.getRunSummary;ctx.deps.runs.getRun=async(_user,id)=>{legacyReads++;return {...summary(input.find(run=>run.run===id)!),submissions:[],results:[]};};
 const legacy=await loadTasks(ctx,input);assert.equal(legacyReads,12);assert.deepEqual(legacy.map(row=>row.run.run),input.map(run=>run.run));
 assert.deepEqual(await loadTasks(ctx,[]),[]);
});
