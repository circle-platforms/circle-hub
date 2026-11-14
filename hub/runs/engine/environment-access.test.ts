import {TestEnvironment} from '../../../contracts/api.ts';
import type {TestEnvironmentResolution,Transaction} from '../../records/api.ts';
import {EffectBoundaryError} from '../../dispatch/api.ts';
import {toolText} from '../../server/text.ts';
import {MemberEnvironments} from '../../dispatch/member-environments.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import type { LoadedWorkflow } from '../../ports.ts';
import type { EngineContext } from './deps.ts';
import { Refusal } from './errors.ts';
import { askClaims, grantLeases, type LeaseRequest } from './start.ts';

const actor = {id:'usr_0'+'a'.repeat(25),name:'合成成员',role:'user' as const};
const run = 'run_0'+'a'.repeat(25);
const denied: ProtocolError = {code:'SOURCE_NOT_PERMITTED',message:'没有分配相应运行环境',fix:'请管理员分配'};
const workflow = {pack:{id:'synthetic-workflow'},workflow:{leases:{prefix:'meadow/',max_ttl_seconds:600}}} as LoadedWorkflow;

function fixture(enforceEnvironmentAssignments: boolean | undefined, authorizeKeys?: (by: typeof actor, keys: readonly string[]) => Promise<ProtocolError|null>, completion: () => boolean|null = () => true) {
  const events: string[] = [];
  const tx={} as import('../../records/api.ts').Transaction;
  const locks:string[]=[];
  const holder = {key:'meadow/allowed',user:actor.id,run,released:false,expires_at:'2026-11-14T06:00:00.000Z',lease:'lse_0'+'a'.repeat(25),fencing:1};
  const mutate = async () => { events.push('write'); return {ok:true,lease:holder.lease,keys:[holder.key],until:holder.expires_at}; };
  const ctx = {now:()=>new Date('2026-11-14T03:00:00.000Z'),deps:{
    records:{store:{withTransaction:async(fn:(tx:import('../../records/api.ts').Transaction)=>Promise<unknown>)=>fn(tx),lock:async(key:string,supplied:unknown)=>{assert.equal(supplied,tx);locks.push(key);}}},
    ...(enforceEnvironmentAssignments !== undefined ? {enforceEnvironmentAssignments} : {}),
    leases:{holders:async()=>[holder],registrations:async()=>[],acquire:mutate,extend:mutate,release:mutate},
    ...(authorizeKeys?{environmentAccess:{inheritance:async()=>({completed:completion()}),authorizeKeys:async(by:typeof actor,keys:readonly string[])=>{events.push('authorize');return authorizeKeys(by,keys);}}}:{}),
  }} as unknown as EngineContext;
  return {ctx,events,tx,locks};
}

const unavailable = (error: unknown): boolean => error instanceof Refusal && error.errors[0]?.code === 'ENVIRONMENT_PERMISSION_UNAVAILABLE';
const refused = (error: unknown): boolean => error instanceof Refusal && error.errors[0]?.code === 'SOURCE_NOT_PERMITTED' && /没有分配|未配置/.test(error.errors[0].message);

test('booking without the environment permission provider is refused before every lease mutation', async () => {
  const {ctx,events} = fixture(true);
  await assert.rejects(grantLeases(ctx,actor,workflow,[{keys:['meadow/allowed'],ttl_seconds:30}],run,undefined),unavailable);
  assert.deepEqual(events,[]);
});

test('the entire acquire and extend key set is authorized before extend or acquire can write', async () => {
  for (const op of ['acquire','extend'] as const) {
    const {ctx,events} = fixture(true,async(by,keys)=>{
      assert.equal(by,actor);
      assert.deepEqual(keys,['meadow/allowed','meadow/unassigned']);
      return denied;
    });
    const requests: LeaseRequest[] = [
      {keys:['meadow/allowed'],ttl_seconds:30},
      {op,keys:['meadow/unassigned'],ttl_seconds:30},
    ];
    await assert.rejects(grantLeases(ctx,actor,workflow,requests,run,undefined),refused);
    assert.deepEqual(events,['authorize'],'no partial mutation or compensating write');
  }
});

test('authorized acquire and extend keep their known lease checks and write after authorization', async () => {
  for (const op of ['acquire','extend'] as const) {
    const {ctx,events} = fixture(true,async(by,keys)=>{
      assert.equal(by,actor);assert.deepEqual(keys,['meadow/allowed']);return null;
    });
    assert.equal((await grantLeases(ctx,actor,workflow,[{op,keys:['meadow/allowed'],ttl_seconds:30}],run,undefined)).length,1);
    assert.deepEqual(events,['authorize','authorize','write']);
  }
});

test('loss of use permission does not prevent the holder from releasing its own lease', async () => {
  const {ctx,events} = fixture(true,async()=>{throw new Error('release is cleanup, not acquisition');});
  assert.equal((await grantLeases(ctx,actor,workflow,[{op:'release',keys:['meadow/allowed']}],run,undefined)).length,1);
  assert.deepEqual(events,['write']);
});


test('verified pending state permits legacy use while existing lease exclusion still refuses', async () => {
  for (const enabled of [undefined, false]) {
    const {ctx,events} = fixture(enabled,async()=>{throw new Error('pending must not check allocation');},()=>false);
    ctx.deps.leases!.acquire = async()=>{
      events.push('lease-conflict');
      return {ok:false,code:'LEASE_UNAVAILABLE',message:'合成键已占用'};
    };
    await assert.rejects(grantLeases(ctx,actor,workflow,[{keys:['meadow/allowed'],ttl_seconds:30}],run,undefined),error=>error instanceof Refusal&&error.errors[0]?.code==='LEASE_UNAVAILABLE');
    assert.deepEqual(events,['lease-conflict']);
  }
});


test('obsolete prefix registration projections are rejected before any lease read or write', async () => {
  for (const op of ['register', 'unregister'] as const) {
    const {ctx,events} = fixture(false);
    ctx.deps.leases!.holders = async()=>{ throw new Error('obsolete projection must fail before reading holders'); };
    const requests = [{keys:['meadow/allowed'],ttl_seconds:30},{op,prefix:'meadow/new/',reason:'synthetic removal'}] as LeaseRequest[];
    await assert.rejects(grantLeases(ctx,actor,workflow,requests,run,undefined),error=>error instanceof Refusal&&error.errors[0]?.code==='SUBMISSION_SCHEMA_VIOLATION');
    assert.deepEqual(events,[]);
  }
});


test('the same provider observes pending then completed then unknown despite a static false flag', async () => {
  let completed:boolean|null=false;
  const {ctx,events}=fixture(false,async()=>denied,()=>completed);
  const requests:LeaseRequest[]=[{keys:['meadow/allowed'],ttl_seconds:30}];
  await grantLeases(ctx,actor,workflow,requests,run,undefined);
  assert.deepEqual(events,['write']);
  completed=true;
  await assert.rejects(grantLeases(ctx,actor,workflow,requests,run,undefined),refused);
  assert.deepEqual(events,['write','authorize']);
  completed=null;
  await assert.rejects(grantLeases(ctx,actor,workflow,requests,run,undefined),unavailable);
  assert.deepEqual(events,['write','authorize']);
});


test('confirmed non-environment booking has identical output before and after inheritance and retains lease checks',async()=>{
  let completed=false;
  const catalog=new MemberEnvironments({
    testEnvironments:{
      resolve:async()=>({environments:[],unregistered:[]}),
      canUse:async()=>{throw new Error('ordinary prefixes do not acquire environment grants');},
    },
  } as unknown as ConstructorParameters<typeof MemberEnvironments>[0],{} as ConstructorParameters<typeof MemberEnvironments>[1],{} as ConstructorParameters<typeof MemberEnvironments>[2]);
  const {ctx,events}=fixture(false,(by,keys)=>catalog.authorizeKeys(by,keys),()=>completed);
  const requests:LeaseRequest[]=[{keys:['meadow/allowed'],ttl_seconds:30}];
  const before=await grantLeases(ctx,actor,workflow,requests,run,undefined);
  completed=true;
  const after=await grantLeases(ctx,actor,workflow,requests,run,undefined);
  assert.deepEqual(after,before,'all returned lease fields remain identical with the controlled same lease outcome');
  assert.deepEqual(events,['write','authorize','authorize','write']);

  const otherWorkflow={...workflow,workflow:{...workflow.workflow,leases:{prefix:'outside/',max_ttl_seconds:600}}};
  await assert.rejects(grantLeases(ctx,actor,otherWorkflow,requests,run,undefined),error=>error instanceof Refusal&&error.errors[0]?.code==='LEASE_PREFIX');
  assert.deepEqual(events,['write','authorize','authorize','write','authorize'],'skipping only environment authorization cannot write outside the workflow prefix');

  catalog.records.testEnvironments.resolve=async()=>{throw new Error('synthetic catalog unavailable');};
  await assert.rejects(grantLeases(ctx,actor,workflow,requests,run,undefined),unavailable);
  assert.deepEqual(events,['write','authorize','authorize','write','authorize','authorize'],'unreadable catalog causes no lease mutation');
});


test('final booking permission and acquire or extend use the same locked transaction',async()=>{
  for(const op of ['acquire','extend'] as const) {
    const {ctx,events,tx,locks}=fixture(true,async()=>null);
    const reads:unknown[]=[];
    ctx.deps.environmentAccess!.inheritance=async supplied=>{reads.push(supplied);return {completed:true};};
    ctx.deps.environmentAccess!.authorizeKeys=async(_by,_keys,supplied)=>{reads.push(supplied);return null;};
    if(op==='acquire') {
      const original=ctx.deps.leases!.acquire.bind(ctx.deps.leases);
      ctx.deps.leases!.acquire=async(input,supplied)=>{assert.equal(supplied,tx);return original(input,supplied);};
    } else {
      const original=ctx.deps.leases!.extend.bind(ctx.deps.leases);
      ctx.deps.leases!.extend=async(input,supplied)=>{assert.equal(supplied,tx);return original(input,supplied);};
    }
    await grantLeases(ctx,actor,workflow,[{op,keys:['meadow/allowed'],ttl_seconds:30}],run,undefined);
    assert.deepEqual(reads,[undefined,undefined,tx,tx]);
    assert.equal(locks.length,1);
    assert.deepEqual(events,['write']);
  }
});


test('the unavailable permission producer renders as a call error instead of a source-status chain',async()=>{
  for(const role of ['user','admin'] as const) {
    const {ctx}=fixture(false);
    let errors:ProtocolError[]=[];
    try {await grantLeases(ctx,{...actor,role},workflow,[{keys:['meadow/allowed'],ttl_seconds:30}],run,undefined);}
    catch(error){assert.ok(error instanceof Refusal);errors=error.errors;}
    assert.equal(errors[0]?.code,'ENVIRONMENT_PERMISSION_UNAVAILABLE');
    assert.equal(errors[0]?.message,'测试环境的权限核对现在不能进行，这次没有执行');
    const text=toolText('start_run',{call_result:'error',errors},{caller:{role}});
    assert.ok(text.includes('暂时不可用：测试环境的权限核对现在不能进行，这次没有执行。'));
    assert.ok(text.includes(role==='admin'?'联系维护人员恢复测试环境权限核对':'请联系管理员'));
    for(const wrong of ['状态未知','原因缺资料','读不到这份资料'])assert.equal(text.includes(wrong),false);
  }
});


test('asking devices rechecks current permission before invoking even an injected observation provider',async()=>{
  const {ctx}=fixture(true,async()=>denied);
  let asks=0;
  ctx.deps.observations={latest:async()=>[],observe:async()=>({observed:[],missing:null}),ask:async()=>{asks++;return [];}};
  await assert.rejects(askClaims(ctx,actor,workflow,[{inventory:'a'.repeat(64),device:'/devices/0',label:'合成设备',line:'help',keys:['meadow/allowed']}],run,undefined,'synthetic-trace'),refused);
  assert.equal(asks,0);
});

test('a final device permission refusal cannot be swallowed into an unknown device observation',async()=>{
  const {ctx}=fixture(true,async()=>null);
  let asks=0;
  ctx.deps.observations={latest:async()=>[],observe:async()=>({observed:[],missing:null}),ask:async()=>{
    asks++;
    throw new EffectBoundaryError({ok:false,clause:1,code:'ENVIRONMENT_PERMISSION_UNAVAILABLE',message:'测试环境的权限核对现在不能进行，这次没有执行',fix:'请联系管理员'});
  }};
  await assert.rejects(askClaims(ctx,actor,workflow,[{inventory:'a'.repeat(64),device:'/devices/0',label:'合成设备',line:'help',keys:['meadow/allowed']}],run,undefined,'synthetic-trace'),unavailable);
  assert.equal(asks,1);
});


test('later device permission refusal preserves earlier observation references in the tool error',async()=>{
  const {ctx}=fixture(true,async()=>null);
  const reference='src:'+'f'.repeat(64);
  const fact='测试环境的权限核对现在不能进行，后续请求没有执行；此前观察记录保留';
  ctx.deps.observations={latest:async()=>[],observe:async()=>({observed:[],missing:null}),ask:async()=>{
    throw new EffectBoundaryError({ok:false,clause:1,code:'ENVIRONMENT_PERMISSION_UNAVAILABLE',message:fact,fix:'请联系管理员；先前尝试按原请求核对，不要盲目重试',grounds:[reference]});
  }};
  let errors:ProtocolError[]=[];
  try{await askClaims(ctx,actor,workflow,[{inventory:'a'.repeat(64),device:'/devices/0',label:'合成设备',line:'help',keys:['meadow/allowed']}],run,undefined,'synthetic-trace');}
  catch(error){assert.ok(error instanceof Refusal);errors=error.errors;}
  assert.equal(errors[0].message,fact);
  assert.deepEqual(errors[0].grounds,[reference]);
  const text=toolText('start_run',{call_result:'error',errors},{caller:{role:'user'}});
  assert.ok(text.includes('后续请求没有执行'));
  for(const wrong of ['这次没有执行','原因缺资料','状态未知'])assert.equal(text.includes(wrong),false);
});


const ordinaryPrefix=TestEnvironment.parse({schema:'test-environment@1',id:'env_0'+'c'.repeat(25),name:null,target:null,prefixes:[{prefix:'meadow/',owner:actor.id,registered_at:'2026-11-14T00:00:00.000Z'}],resources:[],executors:[],enabled:true,missing_facts:[]});
const knownEnvironment=TestEnvironment.parse({schema:'test-environment@1',id:'env_0'+'d'.repeat(25),name:'合成已知环境',target:'synthetic-target',prefixes:[],resources:[{key:'meadow/env',owner:actor.id,registered_at:'2026-11-14T00:00:00.000Z'}],executors:['exe_0'+'e'.repeat(25)],enabled:true,missing_facts:[]});

test('formal booking-only keys preserve every returned field despite an unreadable environment completion marker',async()=>{
  let completed:boolean|null=false;
  const {ctx,events,tx}=fixture(true,async()=>{throw new Error('ordinary booking must not consult ENV assignments');},()=>completed);
  const resolutions:Array<{keys:readonly string[];tx:Transaction|undefined}>=[];
  Object.assign(ctx.deps.records,{testEnvironments:{resolve:async(keys:readonly string[],supplied?:Transaction)=>{
    resolutions.push({keys:[...keys],tx:supplied});
    return {environments:[],unregistered:[ordinaryPrefix]};
  }}});
  const requests:LeaseRequest[]=[{keys:['meadow/allowed'],ttl_seconds:30}];
  const before=await grantLeases(ctx,actor,workflow,requests,run,undefined);
  assert.deepEqual(resolutions,[],'verified pending false still follows the original lease rules');
  completed=null;
  const after=await grantLeases(ctx,actor,workflow,requests,run,undefined);
  assert.deepEqual(after,before);
  assert.deepEqual(events,['write','write'],'no ENV grant or partial compensation is introduced');
  assert.deepEqual(resolutions,[{keys:['meadow/allowed'],tx:undefined},{keys:['meadow/allowed'],tx}]);
  const otherWorkflow={...workflow,workflow:{...workflow.workflow,leases:{prefix:'outside/',max_ttl_seconds:600}}};
  await assert.rejects(grantLeases(ctx,actor,otherWorkflow,requests,run,undefined),error=>error instanceof Refusal&&error.errors[0]?.code==='LEASE_PREFIX');
});

test('completed true also bypasses only the ENV check for a positively resolved ordinary prefix',async()=>{
  const {ctx,events}=fixture(true,async()=>{throw new Error('not an environment assignment');});
  Object.assign(ctx.deps.records,{testEnvironments:{resolve:async()=>({environments:[],unregistered:[ordinaryPrefix]})}});
  await grantLeases(ctx,actor,workflow,[{keys:['meadow/allowed'],ttl_seconds:30}],run,undefined);
  assert.deepEqual(events,['write']);
});

for(const kind of ['mixed','known','overlap','partly ordinary','empty','unreadable'] as const)test('an unknown marker does not permit '+kind+' catalog facts',async()=>{
  const {ctx,events}=fixture(true,async()=>null,()=>null);
  Object.assign(ctx.deps.records,{testEnvironments:{resolve:async(keys:readonly string[]):Promise<TestEnvironmentResolution>=>{
    if(kind==='unreadable')throw new Error('synthetic catalog unavailable');
    if(kind==='empty')return {environments:[],unregistered:[]};
    if(kind==='known')return {environments:[knownEnvironment],unregistered:[]};
    if(kind==='overlap')return {environments:[knownEnvironment],unregistered:[ordinaryPrefix]};
    if(kind==='partly ordinary')return keys[0]==='meadow/allowed'?{environments:[],unregistered:[ordinaryPrefix]}:{environments:[],unregistered:[]};
    return keys[0]==='meadow/env'?{environments:[knownEnvironment],unregistered:[]}:{environments:[],unregistered:[ordinaryPrefix]};
  }}});
  const keys=kind==='mixed'?['meadow/allowed','meadow/env']:kind==='partly ordinary'?['meadow/allowed','meadow/other']:kind==='known'||kind==='overlap'?['meadow/env']:['meadow/allowed'];
  await assert.rejects(grantLeases(ctx,actor,workflow,[{keys,ttl_seconds:30}],run,undefined),unavailable);
  assert.deepEqual(events,[],'no lease write, ENV grant attempt or cleanup on refusal');
});


test('a completed marker with mixed keys still authorizes the entire request rather than bypassing its known environment',async()=>{
  const keys=['meadow/allowed','meadow/env'];
  const {ctx,events}=fixture(true,async(by,actual)=>{assert.equal(by,actor);assert.deepEqual(actual,keys);return denied;});
  Object.assign(ctx.deps.records,{testEnvironments:{resolve:async(actual:readonly string[])=>actual[0]==='meadow/env'?{environments:[knownEnvironment],unregistered:[]}:{environments:[],unregistered:[ordinaryPrefix]}}});
  await assert.rejects(grantLeases(ctx,actor,workflow,[{keys,ttl_seconds:30}],run,undefined),refused);
  assert.deepEqual(events,['authorize']);
});


for(const stage of ['preflight','locked'] as const)test('an unavailable assignment provider at '+stage+' rejects without any lease mutation',async()=>{
  let calls=0;
  const {ctx,events,locks}=fixture(true,async()=>{
    calls++;
    if(calls===(stage==='preflight'?1:2))throw new Error('synthetic permission provider unavailable');
    return null;
  });
  await assert.rejects(grantLeases(ctx,actor,workflow,[{keys:['meadow/allowed'],ttl_seconds:30}],run,undefined),unavailable);
  assert.deepEqual(events,stage==='preflight'?['authorize']:['authorize','authorize']);
  assert.equal(locks.length,stage==='preflight'?0:1);
});
