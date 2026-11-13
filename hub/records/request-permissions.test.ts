import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newId } from './ids.ts';
import { RequestPermissions } from './request-permissions.ts';
import type { AuthorizationBody, AuthorizationRecord, User } from './api.ts';
import type { PermissionKind } from '../../contracts/generated/vocabulary.ts';

const at=new Date('2026-11-13T00:00:00.000Z');
const user:User={id:newId('usr'),name:'合成成员',role:'user',disabled:false,created_at:at.toISOString(),updated_at:at.toISOString()};
function decision(permission:PermissionKind,subject:string,object:string,revoked=false):AuthorizationRecord{
  const common={subject,object,revoked,bound:null,decided_by:newId('usr'),decided_at:at.toISOString(),expires_at:null,note:null,supersedes:null};
  const body:AuthorizationBody=permission==='share'?{...common,permission,share_audience:'pack_users'}:{...common,permission};
  return {id:newId('rcd'),kind:'authorization',schema:'authorization@1',digest:'a'.repeat(64),provenance:'declared',created_at:at.toISOString(),body};
}

test('a snapshot inherits every active team while excluding membership IDs from pack names',()=>{
  const one=newId('tm'),two=newId('tm');
  const grants=[decision('assign','*',one),decision('assign','*',two),decision('assign',user.id,one),decision('assign',user.id,two),decision('assign',one,'one-pack'),decision('assign',two,'two-pack'),decision('assign',user.id,'direct-pack')];
  const snapshot=new RequestPermissions(user.id,user,at,grants);
  assert.deepEqual(snapshot.packs(),['direct-pack','one-pack','two-pack']);
  assert.equal(snapshot.canUse('one-pack'),true);assert.equal(snapshot.canUse('two-pack'),true);assert.equal(snapshot.canUse(one),false);
  const removed=new RequestPermissions(user.id,user,at,[...grants,decision('assign',user.id,one,true)]);
  assert.deepEqual(removed.packs(),['direct-pack','two-pack']);
  assert.deepEqual(snapshot.packs(),['direct-pack','one-pack','two-pack']);
});

test('pack-user sharing and resource grants follow the same effective membership',()=>{
  const team=newId('tm'),grants=[decision('assign','*',team),decision('assign',user.id,team),decision('assign',team,'shared-pack'),decision('share','pack_users:shared-pack','synthetic-run'),decision('resource_assign',team,'synthetic-resource')];
  const snapshot=new RequestPermissions(user.id,user,at,grants);
  assert.equal(snapshot.shared('synthetic-run'),true);assert.equal(snapshot.canUseResource('synthetic-resource'),true);
  const withdrawn=new RequestPermissions(user.id,user,at,[...grants,decision('assign','*',team,true)]);
  assert.equal(withdrawn.shared('synthetic-run'),false);assert.equal(withdrawn.canUseResource('synthetic-resource'),false);
  const disabled=new RequestPermissions(user.id,{...user,disabled:true},at,[...grants,decision('resource_assign','*','synthetic-resource')]);
  assert.equal(disabled.shared('synthetic-run'),false);assert.equal(disabled.canUseResource('synthetic-resource'),false);assert.deepEqual(disabled.packs(),[]);
  const unassignedAdmin=new RequestPermissions(user.id,{...user,role:'admin'},at,[]);assert.equal(unassignedAdmin.canUseResource('synthetic-resource'),false);
});
