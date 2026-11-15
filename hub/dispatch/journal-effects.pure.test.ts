import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Journal,type JobBinding} from './journal.ts';
import {newId,canonicalBytes,type RecordsKit,type Transaction} from '../records/api.ts';

test('action and effect share the held transaction including the fixed-definition fallback read',async()=>{
  const tx:Transaction={transactionId:1},rows:any[]=[];
  let transactions=0,definitionReads=0;
  const held=(actual?:Transaction)=>assert.equal(actual,tx,'a retained-object lookup must not borrow a second main-pool client');
  const records={store:{
    async withTransaction<T>(work:(tx:Transaction)=>Promise<T>,outer?:Transaction){if(outer){held(outer);return work(outer);}transactions++;return work(tx);},
    async lock(_key:string,actual?:Transaction){held(actual);},
    async findMany(query:{key:string},actual?:Transaction){held(actual);return rows.filter(row=>query.key==='dispatch.job'?row.kind==='action':row.kind==='effect');},
    async put(value:any,actual?:Transaction){held(actual);const saved={...value,digest:String(rows.length+1).repeat(64),created:true};rows.push(saved);return saved;},
  },objects:{async get(_digest:string,actual?:Transaction){held(actual);definitionReads++;return canonicalBytes({calls:{submit:{}},max_run_ms:1000});}}} as unknown as RecordsKit;
  const run=newId('run'),user=newId('usr');
  const binding:JobBinding={job:'a'.repeat(64),initiated_by:user,user,executor:newId('exe'),executor_digest:'b'.repeat(64),target_key:'c'.repeat(64),resources:[],input:{run,user,lineage:run,ancestors:[run],item:'synthetic-artifact',items:['synthetic-case'],plan_run:newId('run'),sha256:'d'.repeat(64),target:'synthetic-bed',manifest_sha256:'e'.repeat(64),build:'synthetic-build',generator:'synthetic-generator',result:'f'.repeat(64)}};
  await new Journal(records,()=>new Date('2026-11-15T00:00:00Z')).append(binding,'intent','dispatch','completed');
  assert.equal(transactions,1);assert.equal(definitionReads,1);assert.deepEqual(rows.map(row=>row.kind),['action','effect']);
});
