import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { User } from './api.ts';
import { systemActor } from './permissions.ts';
import { AccessError } from './errors.ts';
import { RequestPermissions, requestPermissions, withRequestPermissions } from './request-permissions.ts';

const user=(suffix:string,created_at:string,changes:Partial<User>={}):User=>({id:'usr_'+'0'.repeat(25)+suffix,name:'合成管理员',role:'admin',disabled:false,created_at,updated_at:created_at,...changes});
const at='2026-11-13T00:00:00.000Z';

test('the earliest enabled administrator is selected by creation time and ID, then read afresh',async()=>{
  const first=user('1',at),second=user('2',at),later=user('3','2026-11-13T01:00:00.000Z'),disabled=user('0','2026-11-12T00:00:00.000Z',{disabled:true});
  const reads:string[]=[];
  const actor=await systemActor({list:async()=>[later,disabled,second,first],get:async id=>{reads.push(id);return {...first,name:'合成当前名字'};}});
  assert.deepEqual(actor,{id:first.id,name:'合成当前名字',role:'admin'});assert.deepEqual(reads,[first.id]);
});

test('deactivated, deleted or demoted candidates never become system actors and absence has a registered code',async()=>{
  const first=user('1',at),second=user('2',at);
  await assert.rejects(systemActor({list:async()=>[first,second],get:async id=>id===first.id?{...first,role:'user'}:{...second,disabled:true}}),error=>error instanceof AccessError&&error.code==='SOURCE_UNAVAILABLE');
  await assert.rejects(systemActor({list:async()=>[{...first,deleted_at:at}],get:async()=>first}),AccessError);
});

test('system actor revalidation cannot reuse an active request permission snapshot',async()=>{
  const initial=user('1',at),snapshot=new RequestPermissions(initial.id,initial,new Date(at),[]);
  await withRequestPermissions({capturePermissionSnapshot:async()=>snapshot},initial,async()=>{
    const principals={list:async()=>[initial],get:async()=>requestPermissions(initial.id)?.user??{...initial,disabled:true}};
    assert.ok(requestPermissions(initial.id));
    await assert.rejects(systemActor(principals),AccessError);
    assert.equal(requestPermissions(initial.id),snapshot);
  });
});
