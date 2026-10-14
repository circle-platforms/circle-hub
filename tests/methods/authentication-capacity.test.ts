import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AuthenticationThrottle} from '../../packages/tasks/src/throttle.ts';
import {passwordDigest} from '../../packages/tasks/src/password.ts';
test('Authentication admission bounds address buckets and asynchronous hashing capacity while the event loop remains responsive',async()=>{
  const throttle=new AuthenticationThrottle();for(let i=0;i<2000;i++)throttle.enter('synthetic-client');assert.throws(()=>throttle.enter('synthetic-client'),(error:any)=>error.code==='RATE_LIMITED');
  for(let i=0;i<999;i++)throttle.enter(`synthetic-${i}`);assert.throws(()=>throttle.enter('overflow-client'),(error:any)=>error.code==='RATE_LIMITED');
  const jobs=Array.from({length:8},()=>passwordDigest('synthetic-secret',Buffer.alloc(16)));await assert.rejects(passwordDigest('overflow-secret',Buffer.alloc(16)),(error:any)=>error.code==='RATE_LIMITED');let responsive=false;await new Promise<void>(resolve=>setImmediate(()=>{responsive=true;resolve();}));assert.equal(responsive,true);assert.equal((await Promise.all(jobs)).length,8);
});
