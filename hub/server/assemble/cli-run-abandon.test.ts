// Real CLI/temporary PostgreSQL with a scratch key provider and in-memory operator tokens only.
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {runRecord} from '../../../contracts/src/fixtures.ts';
import {RunRecord} from '../../../contracts/src/run.ts';
import {openRecords} from '../../records/index.ts';
import {createRequestService} from '../../requests/api.ts';
import {putRun,INDEX} from '../../runs/engine/store.ts';
import {loadServerConfig} from '../main.ts';
import {adminCommands} from '../cli-admin.ts';
import {createAssembly,createCommandAssembly} from './hub.ts';
import {memoryOperatorTokens} from './operator-token.ts';
import {openCliHarness,type CliHarness} from './test-cli.ts';
import type {AssemblyModule} from '../api.ts';
let harness:CliHarness;
before(async()=>{harness=await openCliHarness();});after(async()=>{await harness?.close();});
test('run abandon has no anonymous fallback and permits only the authenticated runner or administrator',async()=>{
  const deployment=await harness.deployment();const tokens=memoryOperatorTokens(null,'合成内存操作令牌');
  const options={tokens:()=>tokens,assembly:{requireOsIsolation:false}};
  const module:AssemblyModule={assemble:createAssembly(options.assembly),assembleCommand:createCommandAssembly(options.assembly),registerCommands:register=>{for(const command of adminCommands(options))register(command);}};
  const run=(argv:string[],extraEnv:Record<string,string>={})=>deployment.run(argv,{assembly:async()=>module,operatorTokens:()=>tokens},extraEnv);
  assert.equal((await run(['init-admin','合成管理员'])).code,0);
  const kit=await openRecords(loadServerConfig(deployment.env),{migrate:false,keyProvider:deployment.key});
  try{
    const admin=(await kit.principals.findByName('合成管理员'))!;
    const owner=await kit.principals.createUser(admin,'合成运行者'),other=await kit.principals.createUser(admin,'合成旁观者');
    const ownerToken=(await kit.principals.issueToken(admin,owner.id,'synthetic-owner')).token;
    const otherToken=(await kit.principals.issueToken(admin,other.id,'synthetic-other')).token;
    const frozen=RunRecord.parse({...runRecord,runner:owner.id,version:'10.6',build:'rel_demo_10_6_1',started_at:'2026-10-24T00:00:00.000Z',submission_due:'2026-10-26T00:00:00.000Z'});
    const stored=await putRun(kit.store,frozen,frozen.started_at);
    const requests=createRequestService(kit),question=await requests.write({run:frozen.run,kind:'disposition',audience:owner.id,due:'2026-10-26T00:00:00.000Z',source:stored.digest,code:'not_covered',missing:'合成管理选择',next_action:'续跑或管理放弃'});
    const argv=['run','abandon',frozen.run,'--answer-request',question.digest,'--reason','合成放弃理由'];
    const operator=tokens.value;tokens.value=null;
    assert.equal((await run(argv)).code,1,'no read-only administrator identity fallback on a write');
    assert.equal((await run(argv,{CIRCLE_HUB_TOKEN:otherToken})).code,1);
    assert.equal((await requests.inspect(question.digest))?.answered_by,null);
    const accepted=await run(argv,{CIRCLE_HUB_TOKEN:ownerToken});assert.equal(accepted.code,0,accepted.text);assert.match(accepted.text,/管理放弃/);
    const decision=(await requests.inspect(question.digest))!.answered_by!;
    const result=await kit.store.find({kind:'validation_result',key:INDEX.resultSystemInput,value:'rec:'+decision,limit:1});
    assert.equal(result.items.length,1);
    const repeated=await run(argv,{CIRCLE_HUB_TOKEN:ownerToken});assert.equal(repeated.code,0,repeated.text);assert.match(repeated.text,/已有回执/);
    for(const line of deployment.printed)for(const secret of [operator,ownerToken,otherToken])if(secret)assert.ok(!line.includes(secret));
  }finally{await kit.close();}
});
