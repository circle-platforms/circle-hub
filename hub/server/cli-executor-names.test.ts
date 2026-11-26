import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExecutorNames, ExecutorRegistry } from '../dispatch/api.ts';
import { executorCommand, type JobCommandSession } from './cli-job.ts';
import { UsageError } from './errors.ts';
import type { RecordsKit, Principal } from '../records/api.ts';

const actor:Principal={id:'usr_'+ '0'.repeat(26),name:'synthetic-admin',role:'admin'};
const executor='exe_'+ '0'.repeat(26);
function fixture(){
  let reads=0;const lines:string[]=[];
  const records={} as RecordsKit;
  const session:JobCommandSession={ctx:{io:{cwd:'.'}},options:{readSecret:async()=>{reads++;throw new Error('secret reads forbidden');}},
    admin:async()=>actor,records:async()=>records,hub:async()=>({dispatch:null,records,executorRegistry:new ExecutorRegistry(records)}),out:line=>lines.push(line),err:line=>lines.push(line)};
  return {session,lines,get reads(){return reads;}};
}
test('administrator adoption passes the exact explicit name and never reads a definition or secret',async t=>{
  const f=fixture();let writes=0;
  t.mock.method(ExecutorNames.prototype,'assign',async(by:Principal,id:string,name:string)=>{assert.equal(by,actor);assert.equal(id,executor);assert.equal(name,'synthetic-runner');writes++;return {created:true,binding:{schema:'executor-name@1' as const,executor:id,name}};});
  assert.equal(await executorCommand(f.session,['name',executor,'synthetic-runner']),0);
  assert.equal(writes,1);assert.equal(f.reads,0);assert.match(f.lines.join('\n'),/synthetic-runner.*源定义和历史未改变/);
});
test('new registration and existing adoption require real explicit names before any write',async t=>{
  const f=fixture();let writes=0;
  t.mock.method(ExecutorNames.prototype,'assign',async()=>{writes++;throw new Error('must not write');});
  for(const args of [['add','missing.json'],['name',executor],['name',executor,executor],['name',executor,'synthetic-runner','--reference=src:'+ 'a'.repeat(64)]])await assert.rejects(executorCommand(f.session,args),UsageError);
  assert.equal(writes,0);assert.equal(f.reads,0);
  f.session.admin=async()=>{throw new Error('disabled actor');};
  await assert.rejects(executorCommand(f.session,['name',executor,'synthetic-runner']),/disabled actor/);assert.equal(writes,0);
});
