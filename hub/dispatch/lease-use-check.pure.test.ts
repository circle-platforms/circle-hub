import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DispatchService} from './service.ts';
import type {HolderSnapshot} from '../leases/api.ts';
import type {LeaseUseCheck} from './lease-use-check.ts';

const actor='usr_0'+'a'.repeat(25),other='usr_0'+'b'.repeat(25),run='run_0'+'c'.repeat(25),oldRun='run_0'+'d'.repeat(25);
const now=new Date('2026-11-14T00:00:00.000Z');
const row:HolderSnapshot={key:'synthetic/key',lease:'lse_0'+'e'.repeat(25),fencing:1,user:actor,run,released:false,expires_at:null};
function inspect(rows:HolderSnapshot[]|Error,keys=[row.key],requiredMs=0) {
  const instance=Object.assign(Object.create(DispatchService.prototype) as DispatchService,{now:()=>now,options:{leases:{holderSnapshot:async()=>{if(rows instanceof Error)throw rows;return rows;}}}});
  const coverage=Reflect.get(DispatchService.prototype,'coverage') as (this:DispatchService,lineage:string[],actor:string,keys:string[],requiredMs:number)=>Promise<{rows:HolderSnapshot[];missing:string[];lease_check:LeaseUseCheck}>;
  return coverage.call(instance,[run],actor,keys,requiredMs);
}

test('structured lease coverage separates another account from an own booking outside this lineage',async()=>{
  const foreign=await inspect([{...row,user:other,run:oldRun}]);
  assert.deepEqual(foreign.missing,[row.key]);
  assert.equal(foreign.lease_check.allowed,false);
  assert.equal(foreign.lease_check.active_other_account_holding,true);
  assert.equal(foreign.lease_check.active_actor_outside_lineage,false);
  const own=await inspect([{...row,run:oldRun}]);
  assert.equal(own.lease_check.active_other_account_holding,false);
  assert.equal(own.lease_check.active_actor_outside_lineage,true);
  assert.equal(own.lease_check.allowed,false);
});

test('missing, expired, released and insufficient window are distinct observed lease facts',async()=>{
  const missing=await inspect([]);
  assert.equal(missing.lease_check.rows_read,true);
  assert.equal(missing.lease_check.keys[0].row_exists,false);
  assert.equal(missing.lease_check.keys[0].actor_matches,null);
  const expired=await inspect([{...row,expires_at:now.toISOString()}]);
  assert.equal(expired.lease_check.expired,true);
  assert.equal(expired.lease_check.released,false);
  const released=await inspect([{...row,released:true}]);
  assert.equal(released.lease_check.released,true);
  assert.equal(released.lease_check.expired,false);
  const short=await inspect([{...row,expires_at:'2026-11-14T00:00:01.000Z'}],[row.key],2000);
  assert.equal(short.lease_check.keys[0].active,true);
  assert.equal(short.lease_check.keys[0].covers_window,false);
  assert.equal(short.lease_check.expired,false);
  assert.deepEqual(short.missing,[row.key]);
});

test('a live lineage-held lease yields one positive check without implying physical execution',async()=>{
  const result=await inspect([row]);
  assert.deepEqual(result.missing,[]);
  assert.equal(result.lease_check.allowed,true);
  assert.equal(result.lease_check.active_other_account_holding,false);
  assert.equal(result.lease_check.keys[0].run_in_lineage,true);
  assert.equal(Object.hasOwn(result.lease_check,'physical_execution'),false);
});

test('failed lease reads retain unknown fields instead of manufacturing an empty or expired lease set',async()=>{
  await assert.rejects(inspect(new Error('synthetic row reader unavailable')),error=>{
    assert.ok(error instanceof Error);
    const check=Reflect.get(error,'lease_check') as LeaseUseCheck|undefined;
    assert.ok(check);
    assert.equal(check.allowed,null);
    assert.equal(check.rows_read,false);
    assert.equal(check.missing_keys,null);
    assert.equal(check.active_other_account_holding,null);
    assert.equal(check.expired,null);
    return true;
  });
});
