import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentManagementPorts } from './test-environments-console.ts';
import { canonicalBytes, sha256Hex, newId, type AuthorizationRecord, type Principal, type RecordsKit, type Transaction, type User } from '../records/api.ts';
import type { TestEnvironmentEntry } from '../records/api.ts';

const at='2026-11-14T00:00:00.000Z';
function fixture(){
  const tx:Transaction={transactionId:17};
  const user=(name:string,role:'user'|'admin',disabled=false):User=>({id:newId('usr'),name,role,disabled,deleted_at:null,created_at:at,updated_at:at});
  const admin=user('合成管理员','admin'),first=user('合成甲','user'),disabled=user('合成乙','user',true),users=[admin,first,disabled];
  const team={id:newId('tm'),name:'合成团队',created_at:at,created_by:admin.id,member_count:2,pack_count:0,resource_count:1,changed_at:at};
  const exe=newId('exe'),entry:TestEnvironmentEntry={schema:'test-environment@1',id:newId('env'),name:'合成环境',target:'synthetic-target',prefixes:[{prefix:'synthetic/',owner:first.id,registered_at:at}],resources:[{key:'exact/device',owner:disabled.id,registered_at:at}],executors:[exe],enabled:true,missing_facts:[],isTestEnvironment:true,isBookingPrefix:false};
  const entries=[entry],auth:AuthorizationRecord[]=[];
  function grant(subject:string,revoked=false,expiresAt:string|null=null){const row:AuthorizationRecord={id:newId('rcd'),kind:'authorization',schema:'authorization@1',digest:sha256Hex(canonicalBytes([subject,revoked,expiresAt,auth.length])),created_at:at,provenance:'declared',body:{permission:'resource_assign',subject,object:entry.id,revoked,bound:null,decided_by:admin.id,decided_at:at,expires_at:expiresAt,note:null,supersedes:null}};auth.push(row);return row;}
  const inherited=grant(team.id,false,'2099-01-01T00:00:00.000Z');grant(disabled.id);grant(first.id);grant(first.id,true);grant('*');
  const content=canonicalBytes({schema:'test-environment-inheritance-completion@1',rule_version:1,completed_at:at,source_records:[],grant_records:[inherited.digest],environment_ids:[entry.id]});
  const marker:AuthorizationRecord={...inherited,digest:'f'.repeat(64),body:{...inherited.body,permission:'resource_config',subject:'*',object:'environment-inheritance',bound:sha256Hex(content)}};
  let bytes:Uint8Array|null=content,catalogReads=0;
  const check=(actual?:Transaction)=>assert.equal(actual,tx);
  const records={
    store:{withTransaction:async<T>(fn:(tx:Transaction)=>Promise<T>)=>fn(tx),list:async(query:{kind:string},actual?:Transaction)=>{check(actual);return {items:query.kind==='authorization'?auth:[],next:null};},get:async(_hash:string,actual?:Transaction)=>{check(actual);return marker;}},
    objects:{get:async(_hash:string,actual?:Transaction)=>{check(actual);return bytes;}},
    principals:{get:async(id:string,actual?:Transaction)=>{check(actual);return users.find(user=>user.id===id)??null;},list:async(actual?:Transaction)=>{check(actual);return users;}},
    teams:{list:async(_by:Principal,actual?:Transaction)=>{check(actual);return [team];},members:async(_by:Principal,id:string,actual?:Transaction)=>{check(actual);assert.equal(id,team.id);return [{user:first},{user:disabled}];}},
    testEnvironments:{list:async(_by:Principal,actual?:Transaction)=>{check(actual);catalogReads++;return entries;},inheritance:async(actual?:Transaction)=>{check(actual);return {completed:true,record:marker.digest,missingFacts:[]};}},
  } as unknown as RecordsKit;
  const ports=createEnvironmentManagementPorts(records,{view:async()=>({entries:[{key:'synthetic/seat',user:first.id,run:newId('run'),since:at,until:null},{key:'other/seat',user:disabled.id,run:newId('run'),since:at,until:null}]})},{now:()=>new Date(at),names:{list:async(_by,actual)=>{check(actual);return [{schema:'executor-name@1',executor:exe,name:'合成执行器'}];}}});
  return {admin,first,disabled,team,entry,entries,grant,ports,users,catalogReads:()=>catalogReads,corrupt:()=>{bytes=Buffer.from('synthetic corruption');}};
}

test('management reads the real catalog and retains every owner and assignment fact on one transaction',async()=>{
  const f=fixture(),[row]=await f.ports.testEnvironments.list(f.admin);
  assert.equal(row.owner,'合成甲、合成乙');assert.equal(row.ownership.length,2);
  assert.equal(row.ownership[0].ownerDisabled,false);assert.equal(row.ownership[1].ownerDisabled,true);
  assert.deepEqual(row.executors,['合成执行器']);assert.deepEqual(row.occupancyKeys,['exact/device','synthetic/seat']);
  assert.equal(row.assignments.length,3);
  const team=row.assignments.find(row=>row.subject.kind==='team')!;assert.equal(team.expiresAt,'2099-01-01T00:00:00.000Z');assert.equal(team.createdByAutomaticInheritance,true);assert.deepEqual(team.holderIds,[f.first.id,f.disabled.id]);
  assert.equal(row.assignments.find(row=>row.subject.kind==='account')!.accountDisabled,true);
  assert.equal(Object.hasOwn(f.ports.testEnvironments,'assignmentsEnforced'),false,'a display port must not cache the startup switch');
});

test('management does not trust the incoming role and rereads authority after deactivation',async()=>{
  const f=fixture();
  await assert.rejects(f.ports.testEnvironments.list({...f.first,role:'admin'}),/只有启用的管理员/);assert.equal(f.catalogReads(),0);
  await f.ports.testEnvironments.list(f.admin);f.admin.disabled=true;
  await assert.rejects(f.ports.testEnvironments.list(f.admin),/只有启用的管理员/);
});

test('a later revocation is visible without restarting or mutating a second directory',async()=>{
  const f=fixture();assert.ok((await f.ports.testEnvironments.list(f.admin))[0].assignments.some(row=>row.subject.kind==='team'));
  f.grant(f.team.id,true);
  assert.ok(!(await f.ports.testEnvironments.list(f.admin))[0].assignments.some(row=>row.subject.kind==='team'));
});

test('unreadable inheritance bytes cannot be presented as a manual grant origin',async()=>{
  const f=fixture();f.corrupt();await assert.rejects(f.ports.testEnvironments.list(f.admin),/继承来源现在不能核对/);
});

test('confirmed non-environment prefixes keep disabled owners visible and disclose an unconnected history reader',async()=>{
  const f=fixture();f.entries.push({...f.entry,id:newId('env'),name:null,target:null,prefixes:[{prefix:'ordinary/',owner:f.disabled.id,registered_at:at}],resources:[],executors:[],isTestEnvironment:false,isBookingPrefix:true});
  const [prefix]=await f.ports.bookingPrefixes.list(f.admin);
  assert.equal(prefix.prefix,'ordinary/');assert.equal(prefix.ownerName,'合成乙');assert.equal(prefix.ownerDisabled,true);
  assert.deepEqual(prefix.workflowAssignees,[]);assert.equal(prefix.holders,undefined);
  assert.ok(prefix.missingFacts.some(fact=>fact.includes('未检查历史持有记录')));
  assert.equal((await f.ports.testEnvironments.list(f.admin)).length,1);
});
