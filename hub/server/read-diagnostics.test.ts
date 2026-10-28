import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
import assert from 'node:assert/strict';
import type {ProtocolError} from '../../contracts/src/common.ts';
import {test} from 'node:test';
import {IntegrityError} from '../records/api.ts';

import {KnowledgeError} from '../knowledge/api.ts';
import type {ServerDeps} from './api.ts';
import {callTool} from './tools.ts';
const root='a'.repeat(64);
async function call(deps:unknown,args:Record<string,unknown>){
 return (await callTool(deps as ServerDeps,{principal:{id:'usr_01hzzzzzzzzzzzzzzzzzzzzzza',name:'synthetic',role:'user'},context:{traceId:'4bf92f3577b34da6a3ce929d0e0e4736',sessionId:null,adminNote:()=>{}},state:{method:'tools/call',tool:'get_nodes',args,started:0,runId:null,callResult:null,acceptance:null,errorCode:null,notes:[]}},'get_nodes',args)).structuredContent as {errors:ProtocolError[]};
}
test('an authorized run without a root gets a correction instead of a neutral denial',async()=>{
 const answer=await call({knowledge:{},runs:{getRun:async()=>({run:{target_basis:[]}})}},{run:'run_01hzzzzzzzzzzzzzzzzzzzzzza'});
 assert.equal(answer.errors[0].code,'SUBMISSION_SCHEMA_VIOLATION');assert.equal(answer.errors[0].path,'/run');assert.match(answer.errors[0].message,/没有锁定知识根/);
});
test('authorized knowledge diagnostics reach the caller at their argument path; no permission stays neutral',async()=>{
 const answer=await call({knowledge:{getNodes:async()=>{throw new KnowledgeError('游标失效；从第一页重读',{code:'REFERENCE_UNRESOLVED',detail:{path:'/cursor'}});}}},{root,cursor:'bad'});
 assert.equal(answer.errors[0].code,'REFERENCE_UNRESOLVED');assert.equal(answer.errors[0].path,'/cursor');assert.match(answer.errors[0].message,/游标/);
 const neutral=await call({knowledge:{getNodes:async()=>null}},{root,cursor:'bad'});assert.equal(neutral.errors[0].code,'SOURCE_UNAVAILABLE');
});
test('knowledge service faults are retried and then expose a timed recovery action',async()=>{
 let calls=0;
 const answer=await call({knowledge:{getNodes:async()=>{calls++;throw new Error('synthetic storage outage');}}},{root});
 assert.equal(calls,3);assert.equal(answer.errors[0].code,'SOURCE_RETRYABLE');assert.match(answer.errors[0].message,/缺少.*重读.*\d{4}-/);
});

test('a typed knowledge integrity fault is reported once with backup recovery',async()=>{
 let calls=0;
 const answer=await call({knowledge:{getNodes:async()=>{calls++;throw new IntegrityError('synthetic missing root bytes');}}},{root});
 assert.equal(calls,1);assert.equal(answer.errors[0].code,'SOURCE_INTEGRITY_UNPROVEN');assert.match(answer.errors[0].fix!,/备份恢复/);
});
test('knowledge retries and source-reference retries share the injected Hub clock',async()=>{
 const initial=Date.parse('2035-06-07T08:09:10.000Z');
 let tick=initial,attempts=0;
 const now=()=>new Date(tick);
 const knowledge=await call({now,knowledge:{getNodes:async()=>{attempts++;tick+=500;throw new Error('synthetic page fault');}}},{root});
 assert.equal(attempts,3);assert.equal(knowledge.errors[0].code,'SOURCE_RETRYABLE');assert.ok(knowledge.errors[0].message.includes(new Date(tick+1000).toISOString()));
 tick=initial;attempts=0;
 const source=await call({now,parsers:createDefaultRegistry(),records:{artifacts:{source:async()=>{attempts++;tick+=500;throw new Error('synthetic source fault');}}},knowledge:{treeReader:()=>({read:()=>null,readEntry:()=>null})}},{reference:'src:'+'b'.repeat(64)});
 assert.equal(attempts,3);assert.equal(source.errors[0].code,'SOURCE_RETRYABLE');assert.ok(source.errors[0].message.includes(new Date(tick+1000).toISOString()));
});
