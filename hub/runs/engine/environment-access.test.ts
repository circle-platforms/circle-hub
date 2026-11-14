import {MemberEnvironments} from '../../dispatch/member-environments.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import type { LoadedWorkflow } from '../../ports.ts';
import type { EngineContext } from './deps.ts';
import { Refusal } from './errors.ts';
import { grantLeases, type LeaseRequest } from './start.ts';

const actor = {id:'usr_0'+'a'.repeat(25),name:'合成成员',role:'user' as const};
const run = 'run_0'+'a'.repeat(25);
const denied: ProtocolError = {code:'SOURCE_NOT_PERMITTED',message:'没有分配相应运行环境',fix:'请管理员分配'};
const workflow = {pack:{id:'synthetic-workflow'},workflow:{leases:{prefix:'meadow/',max_ttl_seconds:600}}} as LoadedWorkflow;

function fixture(enforceEnvironmentAssignments: boolean | undefined, authorizeKeys?: (by: typeof actor, keys: readonly string[]) => Promise<ProtocolError|null>, completion: () => boolean|null = () => true) {
  const events: string[] = [];
  const holder = {key:'meadow/allowed',user:actor.id,run,released:false,expires_at:'2026-11-14T06:00:00.000Z',lease:'lse_0'+'a'.repeat(25),fencing:1};
  const mutate = async () => { events.push('write'); return {ok:true,lease:holder.lease,keys:[holder.key],until:holder.expires_at}; };
  const ctx = {now:()=>new Date('2026-11-14T03:00:00.000Z'),deps:{
    ...(enforceEnvironmentAssignments !== undefined ? {enforceEnvironmentAssignments} : {}),
    leases:{holders:async()=>[holder],registrations:async()=>[],acquire:mutate,extend:mutate,release:mutate},
    ...(authorizeKeys?{environmentAccess:{inheritance:async()=>({completed:completion()}),authorizeKeys:async(by:typeof actor,keys:readonly string[])=>{events.push('authorize');return authorizeKeys(by,keys);}}}:{}),
  }} as unknown as EngineContext;
  return {ctx,events};
}

const unavailable = (error: unknown): boolean => error instanceof Refusal && error.errors[0]?.code === 'SOURCE_UNAVAILABLE';
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
    assert.deepEqual(events,['authorize','write']);
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
      resolve:async()=>[],
      canUse:async()=>{throw new Error('ordinary prefixes do not acquire environment grants');},
    },
  } as unknown as ConstructorParameters<typeof MemberEnvironments>[0],{} as ConstructorParameters<typeof MemberEnvironments>[1],{} as ConstructorParameters<typeof MemberEnvironments>[2]);
  const {ctx,events}=fixture(false,(by,keys)=>catalog.authorizeKeys(by,keys),()=>completed);
  const requests:LeaseRequest[]=[{keys:['meadow/allowed'],ttl_seconds:30}];
  const before=await grantLeases(ctx,actor,workflow,requests,run,undefined);
  completed=true;
  const after=await grantLeases(ctx,actor,workflow,requests,run,undefined);
  assert.deepEqual(after,before,'all returned lease fields remain identical with the controlled same lease outcome');
  assert.deepEqual(events,['write','authorize','write']);

  await assert.rejects(grantLeases(ctx,actor,workflow,[{keys:['outside/key'],ttl_seconds:30}],run,undefined),error=>error instanceof Refusal&&error.errors[0]?.code==='LEASE_PREFIX');
  assert.deepEqual(events,['write','authorize','write','authorize'],'skipping only environment authorization cannot write outside the workflow prefix');

  catalog.records.testEnvironments.resolve=async()=>{throw new Error('synthetic catalog unavailable');};
  await assert.rejects(grantLeases(ctx,actor,workflow,requests,run,undefined),unavailable);
  assert.deepEqual(events,['write','authorize','write','authorize','authorize'],'unreadable catalog causes no lease mutation');
});
