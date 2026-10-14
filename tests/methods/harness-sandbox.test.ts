import assert from 'node:assert/strict';
import {ApiError} from '../../packages/contracts/src/index.ts';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {probeSandboxHost,sandboxHost,isSandboxUnavailable} from '../acceptance/harness.ts';

test('Harness sandbox probe: unsupported hosts fail closed and cannot be turned into verified isolation by an override',async()=>{
 const unsupported=await probeSandboxHost({platform:'linux'});assert.equal(unsupported.available,false);assert.match(unsupported.reason??'',/^SANDBOX_UNAVAILABLE:/);assert.ok(!JSON.stringify(unsupported).includes('/usr/bin/'));
 if(process.platform!=='darwin'){const declaredMac=await probeSandboxHost({platform:'darwin'});assert.equal(declaredMac.available,false);assert.match(declaredMac.reason??'',/^SANDBOX_UNAVAILABLE:/);}
});
test('Harness sandbox probe: the once-per-process actual result reports either executable isolation or a fixed unavailability reason',()=>{
 assert.equal(typeof sandboxHost.available,'boolean');if(sandboxHost.available){assert.equal(process.platform,'darwin');assert.equal(sandboxHost.reason,undefined);}else assert.match(sandboxHost.reason??'',/^SANDBOX_UNAVAILABLE:/);
});
test('Harness sandbox probe: an unsupported synthetic test host skips only isolated bodies and keeps ordinary tests running',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'circle-hub-sandbox-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));const fixture=join(directory,'unsupported.test.mjs');
 await writeFile(fixture,`import {test} from 'node:test'; import {sandboxTest,sandboxSubtest} from ${JSON.stringify(new URL('../acceptance/harness.ts',import.meta.url).href)}; sandboxTest('isolated body must not run',()=>{throw Error('UNSAFE_BODY_EXECUTED');}); test('ordinary body still runs',()=>{}); test('portable parent still runs',async t=>{await sandboxSubtest(t,'isolated child must not run',()=>{throw Error('UNSAFE_BODY_EXECUTED');});});`);
 const childEnv:NodeJS.ProcessEnv={...process.env,CIRCLE_HUB_TEST_SANDBOX_PLATFORM:'linux'};delete childEnv.NODE_TEST_CONTEXT;const result=spawnSync(process.execPath,['--test',fixture],{env:childEnv,encoding:'utf8'});assert.equal(result.status,0,result.stderr+result.stdout);assert.match(result.stdout,/SANDBOX_UNAVAILABLE:/);assert.ok(!result.stdout.includes('UNSAFE_BODY_EXECUTED'));assert.match(result.stdout,/tests 4/);assert.match(result.stdout,/pass 2/);assert.match(result.stdout,/skipped 2/);assert.match(result.stdout,/fail 0/);
});

test('Harness sandbox probe: only explicit adapter unavailability is a skip and product or dependency failures remain errors',()=>{
 assert.equal(isSandboxUnavailable(new ApiError('SANDBOX_UNAVAILABLE','Synthetic unsupported host')),true);assert.equal(isSandboxUnavailable({code:'EPERM',path:'/usr/bin/sandbox-exec'}),true);assert.equal(isSandboxUnavailable({code:71,stderr:'sandbox-exec: sandbox_apply: Operation not permitted\n'}),true);
 for(const code of ['HOOK_FAILED','IMPORT_NOT_DECLARED','RUNTIME_VERSION_MISMATCH','SOURCE_HASH_MISMATCH'])assert.equal(isSandboxUnavailable(new ApiError(code,'Synthetic real failure')),false);for(const failure of [{code:'ENOENT',path:'synthetic-missing-node-dependency'},{code:3,stderr:'Synthetic assertion failed'},new Error('Synthetic invalid probe result')])assert.equal(isSandboxUnavailable(failure),false);
});
