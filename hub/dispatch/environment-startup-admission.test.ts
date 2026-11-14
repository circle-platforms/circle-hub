import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DispatchService, type DispatchOptions} from './service.ts';
import type {Transaction} from '../records/api.ts';

// Exercise the actual preflight/final-intent guard without any network or database.
const guard = Reflect.get(DispatchService.prototype, 'environmentUseFailure') as (this:DispatchService,user:string,executor:string,tx?:Transaction)=>Promise<{code:string}|null>;
function service(environmentAccess?:DispatchOptions['environmentAccess']) {
  return Object.assign(Object.create(DispatchService.prototype) as DispatchService, {options:{enforceEnvironmentAssignments:false,environmentAccess}});
}

test('dispatch rereads completion in the supplied intent transaction despite the old false switch', async()=>{
  const tx={} as Transaction;
  let completed:boolean|null=false;
  let reads=0, permissions=0;
  const instance=service({
    inheritance:async supplied=>{assert.equal(supplied,tx);reads++;return {completed};},
    permission:async(actor,executor,supplied)=>{assert.equal(supplied,tx);assert.equal(actor.id,'synthetic-runner');assert.equal(executor,'synthetic-executor');permissions++;return false;},
    canUse:async()=>{throw new Error('must not borrow an outer connection');},
  });
  assert.equal(await guard.call(instance,'synthetic-runner','synthetic-executor',tx),null);
  completed=true;
  assert.equal((await guard.call(instance,'synthetic-runner','synthetic-executor',tx))?.code,'SOURCE_NOT_PERMITTED');
  completed=null;
  assert.equal((await guard.call(instance,'synthetic-runner','synthetic-executor',tx))?.code,'SOURCE_UNAVAILABLE');
  assert.equal(reads,3);
  assert.equal(permissions,1);
});

test('dispatch never converts missing or unreadable completion into pending legacy permission', async()=>{
  for(const provider of [undefined,{
    inheritance:async()=>{throw new Error('synthetic unreadable completion');},
    permission:async()=>{throw new Error('no permission read after unreadable completion');},
    canUse:async()=>{throw new Error('no permission read after unreadable completion');},
  }]) {
    assert.equal((await guard.call(service(provider),'synthetic-runner','synthetic-executor'))?.code,'SOURCE_UNAVAILABLE');
  }
});
