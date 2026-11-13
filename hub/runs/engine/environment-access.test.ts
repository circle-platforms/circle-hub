import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import type { LoadedWorkflow } from '../api.ts';
import type { EngineContext } from './deps.ts';
import { Refusal } from './errors.ts';
import { grantLeases, type LeaseRequest } from './start.ts';

const actor = {id:'usr_0'+'a'.repeat(25),name:'合成成员',role:'user' as const};
const run = 'run_0'+'a'.repeat(25);
const denied: ProtocolError = {code:'SOURCE_NOT_PERMITTED',message:'没有分配相应运行环境',fix:'请管理员分配'};
const workflow = {pack:{id:'synthetic-workflow'},workflow:{leases:{prefix:'meadow/',max_ttl_seconds:600}}} as LoadedWorkflow;

function fixture(authorizeKeys?: (by: typeof actor, keys: readonly string[]) => Promise<ProtocolError|null>) {
  const events: string[] = [];
  const holder = {key:'meadow/allowed',user:actor.id,run,released:false,expires_at:'2026-11-14T06:00:00.000Z',lease:'lse_0'+'a'.repeat(25),fencing:1};
  const mutate = async () => { events.push('write'); return {ok:true,lease:holder.lease,keys:[holder.key],until:holder.expires_at}; };
  const ctx = {now:()=>new Date('2026-11-14T03:00:00.000Z'),deps:{
    leases:{holders:async()=>[holder],registrations:async()=>[],acquire:mutate,extend:mutate,release:mutate,register:mutate},
    ...(authorizeKeys?{environmentAccess:{authorizeKeys:async(by:typeof actor,keys:readonly string[])=>{events.push('authorize');return authorizeKeys(by,keys);}}}:{}),
  }} as unknown as EngineContext;
  return {ctx,events};
}

const refused = (error: unknown): boolean => error instanceof Refusal && error.errors[0]?.code === 'SOURCE_NOT_PERMITTED' && /没有分配|未配置/.test(error.errors[0].message);

test('booking without the environment permission provider is refused before every lease mutation', async () => {
  const {ctx,events} = fixture();
  await assert.rejects(grantLeases(ctx,actor,workflow,[{keys:['meadow/allowed'],ttl_seconds:30}],run,undefined),refused);
  assert.deepEqual(events,[]);
});

test('the entire acquire and extend key set is authorized before register, extend or acquire can write', async () => {
  for (const op of ['acquire','extend'] as const) {
    const {ctx,events} = fixture(async(by,keys)=>{
      assert.equal(by,actor);
      assert.deepEqual(keys,['meadow/allowed','meadow/unassigned']);
      return denied;
    });
    const requests: LeaseRequest[] = [
      {op:'register',prefix:'meadow/new/'},
      {keys:['meadow/allowed'],ttl_seconds:30},
      {op,keys:['meadow/unassigned'],ttl_seconds:30},
    ];
    await assert.rejects(grantLeases(ctx,actor,workflow,requests,run,undefined),refused);
    assert.deepEqual(events,['authorize'],'no partial mutation or compensating write');
  }
});

test('authorized acquire and extend keep their known lease checks and write after authorization', async () => {
  for (const op of ['acquire','extend'] as const) {
    const {ctx,events} = fixture(async(by,keys)=>{
      assert.equal(by,actor);assert.deepEqual(keys,['meadow/allowed']);return null;
    });
    assert.equal((await grantLeases(ctx,actor,workflow,[{op,keys:['meadow/allowed'],ttl_seconds:30}],run,undefined)).length,1);
    assert.deepEqual(events,['authorize','write']);
  }
});

test('loss of use permission does not prevent the holder from releasing its own lease', async () => {
  const {ctx,events} = fixture(async()=>{throw new Error('release is cleanup, not acquisition');});
  assert.equal((await grantLeases(ctx,actor,workflow,[{op:'release',keys:['meadow/allowed']}],run,undefined)).length,1);
  assert.deepEqual(events,['write']);
});
