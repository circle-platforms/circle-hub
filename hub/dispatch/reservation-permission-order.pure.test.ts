import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DispatchService} from './service.ts';
import type {JobBinding} from './journal.ts';
import type {Transaction} from '../records/api.ts';

test('reservation takes the permission boundary before the lease lock and reuses its transaction for fencing and claims',async()=>{
  const tx:Transaction={transactionId:411};
  let boundary=false,lease=false;
  const events:string[]=[];
  const fences=[{key:'synthetic/key',lease:'synthetic-lease',fencing:1,released:false,expires_at:null}];
  const instance=Object.assign(Object.create(DispatchService.prototype) as DispatchService,{
    now:()=>new Date('2026-11-14T00:00:00.000Z'),
    assertNoSecrets:async()=>{},
    pinned:async()=>({target:'synthetic-target',endpoint:'http://127.0.0.1:1/mcp'}),
    journal:{blockers:async()=>[],append:async(...args:unknown[])=>{assert.equal(args[7],tx);assert.ok(boundary&&lease);events.push('claim');return {created:true};}},
    options:{
      records:{store:{
        withTransaction:async<T>(fn:(actual:Transaction)=>Promise<T>,outer?:Transaction)=>{if(outer)assert.equal(outer,tx);return fn(tx);},
        lock:async(key:string,actual:Transaction)=>{
          assert.equal(actual,tx);
          if(key==='test-environment.permissions'){if(!boundary){assert.equal(lease,false);events.push('permission');boundary=true;}}
          else {assert.ok(boundary&&lease);events.push('configuration');}
        },
        findMany:async()=>[],
        find:async(_query:unknown,actual:Transaction)=>{assert.equal(actual,tx);assert.ok(boundary&&lease);return {items:[{body:{bound:'b'.repeat(64),revoked:false}}]};},
      }},
      leases:{
        holderSnapshot:async(_keys:readonly string[],actual?:Transaction)=>{assert.equal(actual,tx);assert.ok(lease&&boundary);events.push('fences');return fences;},
        withMutationLock:async<T>(fn:(actual:Transaction)=>Promise<T>,outer?:Transaction)=>{assert.equal(outer,tx);assert.ok(boundary);lease=true;events.push('lease');try{return await fn(tx);}finally{lease=false;}},
      },
    },
  });
  const binding={job:'synthetic-job',executor:'synthetic-executor',executor_digest:'b'.repeat(64),resources:['synthetic/key'],fences} as JobBinding;
  const reserve=Reflect.get(DispatchService.prototype,'reserve') as (this:DispatchService,binding:JobBinding)=>Promise<void>;
  await reserve.call(instance,binding);
  assert.deepEqual(events.slice(0,3),['permission','lease','fences']);
  assert.ok(events.indexOf('configuration')>events.indexOf('lease'));
  assert.equal(events.filter(event=>event==='claim').length,4);
});
