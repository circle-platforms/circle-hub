import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeployment, applyDeployment } from './cli-apply.ts';
import type { Session } from './cli-session.ts';

test('old definition rejection gives the exact administrator recovery action without opening records', async () => {
  const message='参数无效：这份定义文件的格式是 deployment@2，这个版本只接受 deployment@3。请在现有实例上用 circle-hub export 导出新的定义文件。';
  const session=new Proxy({ctx:{io:{cwd:'.'}}}, {get(target,key){if(key==='ctx')return target.ctx;throw new Error('old definition must be rejected before opening records');}}) as Session;
  assert.throws(()=>parseDeployment({schema:'deployment@2'}),error=>error instanceof Error && error.message===message);
  await assert.rejects(applyDeployment(session,{schema:'deployment@2'}),error=>error instanceof Error && error.message===message);
});

test('public definitions keep named environment owners, executor names and all audience forms without old registration inputs', () => {
  const input={schema:'deployment@3',bookingPrefixes:[{prefix:'ordinary/',owner:'合成责任人'}],testEnvironments:[{name:'合成环境',target:'合成目标',prefixes:[{prefix:'synthetic/',owner:'合成责任人'}],executors:['合成执行器']}],environmentAssignments:[
    {environment:'合成环境',team:'合成团队',expiresAt:'2099-01-01T00:00:00.000Z'},
    {environment:'合成环境',user:'合成账户'}, {environment:'合成环境',all:true},
  ]};
  const parsed=parseDeployment(input);
  assert.equal(parsed.testEnvironments[0].prefixes[0].owner,'合成责任人');
  assert.deepEqual(parsed.testEnvironments[0].executors,['合成执行器']);
  assert.equal(parsed.environmentAssignments.length,3);
  assert.deepEqual(parsed.bookingPrefixes,[{prefix:'ordinary/',owner:'合成责任人'}]);
  assert.throws(()=>parseDeployment({...input,leaseRegistrations:[]}));
  assert.equal(Object.hasOwn(parsed.testEnvironments[0].prefixes[0],'registered_at'),false);
});
