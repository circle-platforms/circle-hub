// Hydration batches bound live entry bodies without truncating exact historical admission charges.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {digestOf} from './digest.ts';
import {chargedBytes,historyUsage} from './personal-capacity.ts';
import type {RecordStore} from './api.ts';

test('capacity hydration spans bounded batches without dropping off-batch records or trusting a cumulative counter',async()=>{
 const owner='usr_01arzte2b0dy6pj8cd4avj118p',at='2026-11-03T00:00:00.000Z',records=new Map<string,{kind:string;body:unknown}>(),rows=[];let expected=0;
 for(let n=0;n<1025;n++){
  const content={kind:'observation',statement:'合成容量分批条目 '+n,data:{},applicability:null},entry=digestOf(content),body={space:owner,entry,content,grounds:[],status:'unverified',by:owner,at,session:null,replaces:null},digest=digestOf(body);
  records.set(digest,{kind:'knowledge_space_entry',body});rows.push({path:'/',entry,record:digest,status:'unverified'});expected+=chargedBytes(body);
 }
 const body={space:owner,parent:null,tree:'a'.repeat(64),sources:[],products:[],directories:['/'],entries:rows,by:owner,at,reason:'合成分批计量',used_bytes:Number.MAX_SAFE_INTEGER},version={digest:digestOf(body),body},batches:number[]=[];expected+=chargedBytes(body);
 const store={findMany:async(query:{kind:string})=>query.kind==='knowledge_space_version'?[version]:[],getMany:async(ids:readonly string[])=>{batches.push(ids.length);assert.ok(ids.length<=512,'entry bodies must not grow into an unbounded live batch');return new Map(ids.flatMap(id=>records.has(id)?[[id,records.get(id)!] as const]:[]));},get:async()=>{assert.fail('capacity uses explicit bounded batches');}} as unknown as RecordStore;
 assert.deepEqual(await historyUsage(store,owner),{knowledge:expected,memory:0,used:expected});assert.deepEqual(batches,[512,512,1]);
});
