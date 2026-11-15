import test from 'node:test';
import assert from 'node:assert/strict';
import { newId, type Principal, type RecordsKit } from '../records/api.ts';
import { testEnvironmentCommand } from './cli-test-environment.ts';
import type { TestEnvironment } from '../../contracts/src/resources.ts';

function fixture() {
  const admin: Principal = { id: newId('usr'), name: '合成管理员', role: 'admin' };
  const team = { id: newId('tm'), name: '合成团队' };
  const account = { id: newId('usr'), name: '合成账户' };
  const environment: TestEnvironment = { schema: 'test-environment@1', id: newId('env'), name: '合成环境', target: '合成目标', enabled: true,
    prefixes: [{prefix:'synthetic/',owner:admin.id,registered_at:'2026-11-14T00:00:00.000Z'}], resources: [], executors: [], missing_facts: [] };
  const messages: string[] = [], writes: unknown[][] = [];
  const entries:Array<TestEnvironment & {isBookingPrefix?:boolean}>= [environment];
  let completion: boolean | null = true, conversions = 0;
  const records = {
    testEnvironments: {
      inheritance: async () => ({completed:completion,record:null,missingFacts:[]}),
      inherit: async (by: Principal) => { assert.equal(by.id,admin.id); conversions++; completion=true; return {completed:true,record:'a'.repeat(64),assignments:0}; },
      list: async () => entries,
      register: async (_by: Principal, input: unknown) => { writes.push(['register', input]); return {...environment,...input as object}; },
      reassignOwner: async (_by: Principal,id:string,input:unknown)=>{writes.push(['owner',id,input]);return environment;},
      remove: async (_by: Principal, id: string) => { writes.push(['remove', id]); },
      update: async (_by: Principal, id: string, input: unknown) => { writes.push(['update',id,input]); return {...environment,...input as object}; },
    },
    teams: { list: async () => [team] },
    principals: { findByName: async (name: string) => name === account.name ? account : null },
    authorizations: {
      assignResource: async (_by: Principal, id: string, subject: string, options: unknown) => { writes.push(['assign', id, subject, options]); },
      unassignResource: async (_by: Principal, id: string, subject: string) => { writes.push(['unassign', id, subject]); },
    },
  } as unknown as RecordsKit;
  return { admin, team, account, environment, messages, writes, addRegistration:(row:TestEnvironment & {isBookingPrefix?:boolean})=>entries.push(row), setCompletion: (value: boolean | null) => { completion=value; }, conversions: () => conversions, session: { admin: async () => admin, records: async () => records, out: (text: string) => messages.push(text) } };
}

test('ordinary registration is one invocation without a file, host login or internal identifier', async () => {
  const f = fixture();
  assert.equal(await testEnvironmentCommand(f.session, ['register','新合成环境','--target','新合成目标','--prefix','synthetic/new/']),0);
  assert.equal(f.writes.length,1);
  const input = f.writes[0][1] as {name:string;target:string;prefixes:Array<{owner:string;registered_at:string}>};
  assert.equal(input.name,'新合成环境'); assert.equal(input.target,'新合成目标');
  assert.equal(input.prefixes[0].owner,f.admin.id); assert.ok(Number.isFinite(Date.parse(input.prefixes[0].registered_at)));
  assert.deepEqual(f.messages,['已登记测试环境「新合成环境」']);
});

test('team, account and whole Hub assignment use the environment identity rather than an executor', async () => {
  for (const audience of ['team','user','all']) {
    const f = fixture(), args = audience === 'team' ? ['--team',f.team.name] : audience === 'user' ? ['--user',f.account.name] : ['--all'];
    await testEnvironmentCommand(f.session,['assign',f.environment.name!,...args]);
    assert.equal(f.writes[0][0],'assign'); assert.equal(f.writes[0][1],f.environment.id);
    assert.equal(f.writes[0][2],audience === 'team' ? f.team.id : audience === 'user' ? f.account.id : '*');
    assert.doesNotMatch(f.messages.join(''),/(?:env|exe|usr|tm)_[0-9a-z]{26}/);
  }
});

test('missing or conflicting assignment audience is refused before any mutation', async () => {
  for (const options of [[],['--team','合成团队','--all'],['--team','不存在的合成团队']]) {
    const f = fixture();
    await assert.rejects(testEnvironmentCommand(f.session,['assign',f.environment.name!,...options]));
    assert.deepEqual(f.writes,[]);
  }
});

test('ordinary revoke and removal retain name-based operator inputs', async () => {
  const f = fixture();
  await testEnvironmentCommand(f.session,['unassign',f.environment.name!,'--all']);
  await testEnvironmentCommand(f.session,['remove',f.environment.name!]);
  assert.deepEqual(f.writes,[['unassign',f.environment.id,'*'],['remove',f.environment.id]]);
});

test('registration and team assignment each serialize from one ordinary form submission', async () => {
  const { buildCommandArgv, commandParameterShape } = await import('./command-parameters.ts');
  const registration = buildCommandArgv('bed.register', {name:'新合成环境',target:'新合成目标',prefix:['synthetic/new/']});
  assert.deepEqual(registration,['bed','register','新合成环境','--target=新合成目标','--prefix=synthetic/new/']);
  assert.deepEqual(buildCommandArgv('bed.assign',{environment:'合成环境',team:'合成团队'}),['bed','assign','合成环境','--team=合成团队']);
  assert.deepEqual(commandParameterShape('bed.register').stdin,[]);
  assert.throws(()=>buildCommandArgv('bed.register',{name:'合成环境',target:'合成目标'}));
  assert.throws(()=>buildCommandArgv('bed.assign',{environment:'合成环境',team:'合成团队',all:true}));
});


test('editing preserves environment identity and existing registration responsibility', async () => {
  const f = fixture();
  await testEnvironmentCommand(f.session,['update',f.environment.name!,'--name','更新后的合成环境','--disable']);
  assert.equal(f.writes[0][0],'update'); assert.equal(f.writes[0][1],f.environment.id);
  const input = f.writes[0][2] as TestEnvironment;
  assert.equal(input.name,'更新后的合成环境'); assert.equal(input.enabled,false);
  assert.deepEqual(input.prefixes,f.environment.prefixes);
  assert.equal(input.target,f.environment.target);
  const wrong = fixture();
  await assert.rejects(testEnvironmentCommand(wrong.session,['update',wrong.environment.name!,'--target','另一个合成目标']));
  assert.deepEqual(wrong.writes,[]);
});


test('an authenticated ordinary management action continues only verified pending inheritance', async () => {
  const f = fixture(); f.setCompletion(false);
  await testEnvironmentCommand(f.session,['assign',f.environment.name!,'--all']);
  assert.equal(f.conversions(),1);
  await testEnvironmentCommand(f.session,['unassign',f.environment.name!,'--all']);
  assert.equal(f.conversions(),1);
  const unknown = fixture(); unknown.setCompletion(null);
  await testEnvironmentCommand(unknown.session,['unassign',unknown.environment.name!,'--all']);
  assert.equal(unknown.conversions(),0);
  const read = fixture(); read.setCompletion(false);
  await testEnvironmentCommand(read.session,['list']);
  assert.equal(read.conversions(),0);
});


test('explicit responsibility reassignment uses names and never issues a use assignment', async()=>{
  const f=fixture();
  await testEnvironmentCommand(f.session,['owner',f.environment.name!,'--prefix','synthetic/','--user',f.account.name]);
  assert.deepEqual(f.writes,[['owner',f.environment.id,{prefix:'synthetic/',owner:f.account.id}]]);
  assert.doesNotMatch(f.messages.join(''),/(?:env|usr)_[0-9a-z]{26}/);
});

test('a booking-only prefix can change its responsible account without becoming a test environment',async()=>{
  const f=fixture(),id=newId('env');
  f.addRegistration({...f.environment,id,name:null,target:null,prefixes:[{prefix:'ordinary/',owner:f.admin.id,registered_at:'2026-11-14T00:00:00.000Z'}],isBookingPrefix:true});
  await testEnvironmentCommand(f.session,['prefix-owner','ordinary/','--user',f.account.name]);
  assert.deepEqual(f.writes,[['owner',id,{prefix:'ordinary/',owner:f.account.id}]]);
});

test('ordinary registration automatically preserves the exact owner facts of an adopted prefix',async()=>{
  const f=fixture(),original={prefix:'ordinary/',owner:f.account.id,registered_at:'2026-11-13T00:00:00.000Z'};
  f.addRegistration({...f.environment,id:newId('env'),name:null,target:null,prefixes:[original],isBookingPrefix:true});
  await testEnvironmentCommand(f.session,['register','新环境','--target','新目标','--prefix','ordinary/']);
  assert.deepEqual((f.writes[0][1] as TestEnvironment).prefixes,[original]);
});
