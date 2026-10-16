import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn,spawnSync,execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {root,setup,until} from './harness.ts';
import {API_VERSION} from '../../packages/contracts/src/index.ts';

function retiredKeys(env:NodeJS.ProcessEnv){return Object.keys(env).filter(key=>key.startsWith('CIRCLE_SERVER_'));}
test('Hub naming: server supervisor worker and admin CLI run on CIRCLE_HUB inputs only while HTTP contracts stay unchanged',async t=>{
 const h=await setup(t);assert.deepEqual(retiredKeys(h.env),[]);assert.equal((await h.request('/v1/status')).apiVersion,API_VERSION);const worker=await h.startWorker('lab-east-01',{CIRCLE_HUB_URL:h.url});assert.equal(worker.exitCode,null);const token=await h.login('admin'),result=await promisify(execFile)(process.execPath,['apps/server/src/cli.ts','admin','tasks'],{cwd:root,env:{...h.env,CIRCLE_HUB_URL:h.url,CIRCLE_HUB_TOKEN:token}});assert.ok(Array.isArray(JSON.parse(result.stdout)));assert.equal(result.stderr,'');
 await h.stop(worker);await h.stop();const child=spawn(process.execPath,['apps/server/src/supervisor.ts'],{cwd:root,env:h.env,stdio:['ignore','pipe','pipe']});h.children.add(child);let out='',errors='';child.stdout!.on('data',data=>out+=String(data));child.stderr!.on('data',data=>errors+=String(data));await until(async()=>{if(child.exitCode!==null)throw Error(errors);return out.split('\n').some(line=>{try{return JSON.parse(line).type==='ready';}catch{return false;}});});assert.ok(!errors.includes('HubEnvironmentError'));await h.stop(child);
});
test('Hub naming: a leftover CIRCLE_SERVER input stops server supervisor worker and admin CLI instead of starting with defaults',async t=>{
 const h=await setup(t),token=await h.login('admin'),secret=h.env.CIRCLE_HUB_DATABASE_CONFIG!;
 // The configured hub keeps serving; each refused process starts beside valid
 // CIRCLE_HUB_* input, so a silent fallback or alias would have started it.
 const entries:[string[],string,NodeJS.ProcessEnv][]=[
  [['apps/server/src/main.ts'],'DATABASE_CONFIG',{CIRCLE_SERVER_DATABASE_CONFIG:secret}],
  [['apps/server/src/supervisor.ts'],'DATABASE_CONFIG',{CIRCLE_SERVER_DATABASE_CONFIG:secret}],
  [['apps/worker/src/main.ts'],'URL',{CIRCLE_WORKER_USERNAME:'lab-east-02',CIRCLE_WORKER_PASSWORD:'synthetic-only-password',CIRCLE_SERVER_URL:h.url}],
  [['apps/server/src/cli.ts','admin','tasks'],'TOKEN',{CIRCLE_SERVER_TOKEN:token}],
 ];
 for(const [entry,suffix,retired] of entries){
  const run=spawnSync(process.execPath,entry,{cwd:root,env:{...h.env,CIRCLE_HUB_URL:h.url,CIRCLE_HUB_TOKEN:token,...retired},encoding:'utf8',timeout:20_000});
  assert.equal(run.status,1,`${entry[0]}: ${run.stderr}`);assert.equal(run.stdout,'',entry[0]);assert.ok(run.stderr.includes(`CIRCLE_SERVER_${suffix} -> CIRCLE_HUB_${suffix}`),entry[0]);
  for(const value of [secret,token,h.url])assert.ok(!run.stderr.includes(value),entry[0]);
 }
 assert.equal((await h.request('/v1/status')).apiVersion,API_VERSION);
});
test('Hub naming: dev stack uses the circle-hub scratch prefix and new-only startup environment',async t=>{
 const env={...process.env,CIRCLE_HUB_PORT:'0'};assert.deepEqual(retiredKeys(env),[]);const child=spawn(process.execPath,['scripts/dev-stack.ts'],{cwd:root,env,stdio:['ignore','pipe','pipe']}),exited=once(child,'exit');let output='',errors='',stackPid:number|undefined;child.stdout!.on('data',data=>output+=String(data));child.stderr!.on('data',data=>errors+=String(data));t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){if(stackPid)process.kill(stackPid,'SIGTERM');else child.kill('SIGTERM');await exited;}});const ready=await until(async()=>{if(child.exitCode!==null)throw Error(errors);for(const line of output.split('\n'))try{const event=JSON.parse(line);if(event.type==='dev-stack-ready')return event;}catch{}return false;},30_000);stackPid=ready.pid;assert.match(ready.scratchDirectory,/circle-hub-dev-/);assert.ok(!errors.includes('HubEnvironmentError'));const response=await fetch(ready.url+'/v1/auth/dev-login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(ready.login)});assert.equal(response.status,200);process.kill(stackPid!,'SIGTERM');await exited;
});
