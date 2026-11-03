// Deterministic barriers for synthetic account/transaction races, never timing-based completion guesses.
import assert from 'node:assert/strict';
import pg from 'pg';
import type {TestRecordsKit} from './records.ts';
export function barrier(){const {promise,resolve}=Promise.withResolvers<void>();return {promise,release:()=>resolve()};}
export async function reaches(gate:ReturnType<typeof barrier>,operation:Promise<unknown>){
 await Promise.race([gate.promise,operation.then(()=>assert.fail('the operation finished before reaching its transaction barrier'))]);
}
export async function waitForUserUpdateLock(kit:Pick<TestRecordsKit,'database'>,query='SELECT * FROM users WHERE id = $1 FOR UPDATE'){
 const client=new pg.Client({...kit.database,ssl:false});await client.connect();
 try{
  for(let n=0;n<500;n++){
   const rows=await client.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query=$1 AND cardinality(pg_blocking_pids(pid))>0",[query]);
   if(rows.rowCount)return;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('the account change must be observed waiting for the committing user row lock');
 }finally{await client.end();}
}
