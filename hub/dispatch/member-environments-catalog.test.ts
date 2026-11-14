import {ExecutorSource} from '../../contracts/src/resources.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TestEnvironment} from '../../contracts/api.ts';
import {canonicalBytes,sha256Hex,type RecordsKit,type Transaction} from '../records/api.ts';
import {MemberEnvironments} from './member-environments.ts';
import {definition} from './testing/definition.ts';

const actor={id:'usr_0'+'a'.repeat(25),name:'合成账户',role:'user' as const};
const first='exe_0'+'a'.repeat(25),second='exe_0'+'b'.repeat(25);
function environment(char:string,executors=[first]) {
  return TestEnvironment.parse({schema:'test-environment@1',id:'env_0'+char.repeat(25),name:'合成环境'+char,target:'synthetic-bed',prefixes:[],resources:[{key:'synthetic/device/a',owner:actor.id,registered_at:'2026-11-14T00:00:00.000Z'},{key:'synthetic/device/b',owner:actor.id,registered_at:'2026-11-14T00:00:00.000Z'}],executors,enabled:true,missing_facts:[]});
}
function fixture(values:TestEnvironment[], configured=true, granted=true) {
  const events:string[]=[];
  const tx={} as Transaction;
  const sources=new Map([first,second].map(id=>{const bytes=canonicalBytes(ExecutorSource.parse({...definition('http://127.0.0.1:1/mcp'),id}));return [id,{bytes,sha:sha256Hex(bytes)}];}));
  const snapshots={user:actor,teams:()=>[],enabled:(record:unknown)=>record!==null&&record!==undefined,latest:(permission:string,_subject:string,id:string)=>permission==='resource_config'?(configured?{body:{bound:sources.get(id.slice('executor.'.length))?.sha}}:null):(granted?{body:{}}:null)};
  const records={artifacts:{capturePermissionSnapshot:async(_by:unknown,supplied?:Transaction)=>{if(supplied)assert.equal(supplied,tx);return snapshots;}},objects:{get:async(sha:string,supplied?:Transaction)=>{if(supplied)assert.equal(supplied,tx);return [...sources.values()].find(source=>source.sha===sha)?.bytes??null;}},principals:{get:async()=>actor},testEnvironments:{
    inheritance:async(supplied?:Transaction)=>{assert.equal(supplied,tx);events.push('inheritance');return {completed:true,record:null,missingFacts:[]};},
    resolve:async(keys:readonly string[],supplied?:Transaction)=>{if(supplied)assert.equal(supplied,tx);events.push('resolve:'+keys.join(','));const matches=values.filter(value=>keys.every(key=>value.resources.some(row=>row.key===key)));return {environments:matches.filter(value=>value.target!==null),unregistered:matches.filter(value=>value.target===null)};},
    canUseExecutor:async(_by:unknown,executor:string,supplied?:Transaction)=>{
      if(supplied)assert.equal(supplied,tx);
      events.push('executor-permission:'+executor);
      return configured&&granted&&values.length===1&&values[0].enabled&&values[0].executors.includes(executor);
    },
    canUse:async(_by:unknown,id:string,supplied?:Transaction)=>{if(supplied)assert.equal(supplied,tx);events.push('permission:'+id);return true;},list:async()=>values,
  }} as unknown as RecordsKit;
  const instance=new MemberEnvironments(records,{readSource:async()=>{throw new Error('no unscoped executor read');}},{view:async()=>({entries:[]}),registrations:async()=>[]} as ConstructorParameters<typeof MemberEnvironments>[2]);
  return {instance,events,tx,records};
}

test('ambiguity is found before authorization and reveals no hidden environment identity',async()=>{
  const a=environment('a'),b={...environment('b'),name:'synthetic-hidden',target:'synthetic-hidden-target'};
  const {instance,events}=fixture([a,b]);
  const refusal=await instance.authorizeKeys(actor,['synthetic/device/a']);
  assert.equal(refusal?.code,'SOURCE_NOT_PERMITTED');
  assert.equal(events.some(event=>event.startsWith('permission:')),false);
  assert.doesNotMatch(JSON.stringify(refusal),/synthetic-hidden|env_|exe_/);
});

test('two executors explicitly bound to one target share one environment permission',async()=>{
  const env=environment('a',[first,second]);const {instance,events,tx}=fixture([env]);
  assert.equal(await instance.permission(actor,first,tx),true);
  assert.equal(await instance.permission(actor,second,tx),true);
  assert.deepEqual(events,['executor-permission:'+first,'executor-permission:'+second]);
});

test('a canonical executor-binding refusal cannot be overridden by matching resource keys',async()=>{
  const {instance,events,tx}=fixture([environment('a')]);
  assert.equal(await instance.permission(actor,second,tx),false);
  assert.deepEqual(events,['executor-permission:'+second]);
});

test('all keys are resolved before the first permission read',async()=>{
  const {instance,events}=fixture([environment('a')]);
  assert.equal(await instance.authorizeKeys(actor,['synthetic/device/a','synthetic/device/b']),null);
  assert.deepEqual(events.slice(0,2),['resolve:synthetic/device/a','resolve:synthetic/device/b']);
  assert.equal(events.length,3);
});

test('inheritance delegates the exact caller transaction without a startup cache',async()=>{
  const {instance,events,tx}=fixture([]);
  assert.equal((await instance.inheritance(tx)).completed,true);
  assert.equal((await instance.inheritance(tx)).completed,true);
  assert.deepEqual(events,['inheritance','inheritance']);
});


test('a missing-configuration verdict from the canonical authority remains refused',async()=>{
  const {instance,events,tx}=fixture([environment('a')],false);
  assert.equal(await instance.permission(actor,first,tx),false);
  assert.deepEqual(events,['executor-permission:'+first]);
});


test('confirmed ordinary prefixes skip only environment authorization',async()=>{
  const generic={...environment('a',[]),name:null,target:null,missing_facts:['原前缀没有目标']};
  const {instance,events}=fixture([generic]);
  assert.equal(await instance.authorizeKeys(actor,['synthetic/device/a']),null);
  assert.deepEqual(events,['resolve:synthetic/device/a']);
  assert.equal(await instance.authorizeKeys(actor,['synthetic/unregistered']),null);
});

test('a known environment overlapping a generic prefix still requires its grant',async()=>{
  const generic={...environment('a',[]),name:null,target:null,missing_facts:['原前缀没有目标']};
  const known=environment('b');
  const {instance,records,events}=fixture([generic,known]);
  records.testEnvironments.canUse=async()=>false;
  assert.equal((await instance.authorizeKeys(actor,['synthetic/device/a']))?.code,'SOURCE_NOT_PERMITTED');
  assert.deepEqual(events,['resolve:synthetic/device/a']);
});

test('unreadable catalog is not treated as an unregistered prefix',async()=>{
  const {instance,records}=fixture([]);
  records.testEnvironments.resolve=async()=>{throw new Error('synthetic unreadable catalog');};
  await assert.rejects(instance.authorizeKeys(actor,['synthetic/unregistered']),/synthetic unreadable catalog/);
});


const ownHolding={key:'synthetic/device/a',user:actor.id,run:'run_0'+'c'.repeat(25),since:'2026-11-14T00:00:00.000Z',until:'2026-11-14T01:00:00.000Z'};

test('confirmed non-environment holding is excluded without changing ordinary lease context',async()=>{
  const generic={...environment('a',[]),name:null,target:null,missing_facts:['原前缀没有目标']};
  const {instance}=fixture([generic],true,false);
  const entries=[{...ownHolding}];
  instance.leases.view=async()=>({entries});
  assert.deepEqual(await instance.unattributedHoldings(actor),[]);
  assert.deepEqual((await instance.leases.view('',true)).entries,[ownHolding]);
});

test('unique known withdrawn holding retains a known absent assignment',async()=>{
  const {instance}=fixture([environment('a')],true,false);
  instance.leases.view=async()=>({entries:[ownHolding]});
  const holdings=await instance.unattributedHoldings(actor);
  assert.equal(holdings?.length,1);
  assert.equal(holdings?.[0].assigned,false);
  assert.equal(holdings?.[0].can_use,false);
  assert.equal(holdings?.[0].target,null);
  assert.equal(holdings?.[0].booking_run,ownHolding.run);
});

test('ambiguous known targets retain unknown attribution rather than claiming absent assignment',async()=>{
  const a=environment('a'),b={...environment('b'),target:'synthetic-private-target'};
  const {instance}=fixture([a,b],true,false);
  instance.leases.view=async()=>({entries:[ownHolding]});
  const holdings=await instance.unattributedHoldings(actor);
  assert.equal(holdings?.length,1);
  assert.equal(holdings?.[0].assigned,null);
  assert.equal(holdings?.[0].target,null);
  assert.equal(holdings?.[0].can_use,false);
  assert.equal(holdings?.[0].target_missing,'预订对应多个已登记目标，归属不能唯一核对');
  const text=JSON.stringify(holdings);
  for(const privateValue of [a.id,b.id,a.name!,b.name!,b.target,ownHolding.key,actor.id])assert.equal(text.includes(privateValue),false);
});

test('unreadable catalog cannot exclude an existing holding as a confirmed ordinary prefix',async()=>{
  const {instance,records}=fixture([],true,false);
  instance.leases.view=async()=>({entries:[ownHolding]});
  records.testEnvironments.resolve=async()=>{throw new Error('synthetic unreadable catalog');};
  assert.equal(await instance.unattributedHoldings(actor),null);
});


test('executor permission delegates ordinary-variable target resolution to records on every same-TX check',async()=>{
  const {instance,records,tx}=fixture([environment('a')]);
  let allowed=true;
  const calls:Array<{actor:unknown;executor:string;tx:Transaction|undefined}>=[];
  records.testEnvironments.canUseExecutor=async(by,executor,supplied)=>{
    calls.push({actor:by,executor,tx:supplied});
    return allowed;
  };
  Object.defineProperty(records,'objects',{get(){throw new Error('consumer must not read or resolve raw executor bytes');}});
  records.artifacts.capturePermissionSnapshot=async()=>{throw new Error('the canonical authority owns the fresh principal and grants');};
  assert.equal(await instance.permission(actor,first,tx),true,'a canonical resolved-target permit is not rejected by a raw variable string');
  allowed=false;
  assert.equal(await instance.permission(actor,first,tx),false,'a retargeted variable refusal is fresh and does not reuse an earlier grant');
  assert.deepEqual(calls,[{actor,executor:first,tx},{actor,executor:first,tx}]);
  const unavailable=new Error('synthetic canonical resolver unavailable');
  records.testEnvironments.canUseExecutor=async()=>{throw unavailable;};
  await assert.rejects(instance.permission(actor,first,tx),error=>error===unavailable);
});
