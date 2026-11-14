import test from 'node:test';
import assert from 'node:assert/strict';
import { lockExecutorConfiguration } from './executors.ts';
import { ExecutorNames } from './executor-names.ts';
import type { RecordsKit, RecordStore, Transaction, Principal } from '../records/api.ts';

function fixture() {
  const tx:Transaction={transactionId:41},calls:string[]=[];
  const stop=new Error('synthetic record-read boundary');
  const store={
    withTransaction:async <T>(fn:(tx:Transaction)=>Promise<T>,outer?:Transaction)=>{assert.equal(outer,tx);return fn(tx);},
    lock:async(key:string,actual:Transaction)=>{assert.equal(actual,tx);calls.push(key);},
    find:async()=>{throw stop;},
    findMany:async()=>{throw stop;},
  } as unknown as RecordStore;
  const actor:Principal={id:'usr_00000000000000000000000001',name:'合成管理员',role:'admin'};
  const records={store,principals:{lockActive:async(_by:Principal,actual:Transaction)=>{assert.equal(actual,tx);calls.push('actor');return actor;}}} as unknown as RecordsKit;
  return {tx,calls,stop,store,actor,records};
}

test('executor configuration enters the shared permission boundary before its own resource locks',async()=>{
  const f=fixture();
  await lockExecutorConfiguration(f.store,f.tx,'exe_00000000000000000000000001',['synthetic/key'],['synthetic-target'],['https://192.0.2.10']);
  assert.equal(f.calls[0],'test-environment.permissions');
  assert.ok(f.calls.slice(1).every(key=>key.startsWith('dispatch-config:')));
});

test('executor naming enters the permission boundary before locking its administrator or configuration',async()=>{
  const f=fixture();
  await assert.rejects(new ExecutorNames(f.records).checkInTransaction(f.actor,'exe_00000000000000000000000001','合成执行器',f.tx),error=>error===f.stop);
  assert.equal(f.calls[0],'test-environment.permissions');
  assert.equal(f.calls[1],'actor');
  assert.ok(f.calls.slice(2).some(key=>key==='dispatch-config:executor:exe_00000000000000000000000001'));
});
