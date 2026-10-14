import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {root,setup,until} from './harness.ts';
import {API_VERSION} from '../../packages/contracts/src/index.ts';

function newEnvironment(source:NodeJS.ProcessEnv){const env={...source};for(const key of Object.keys(env))if(key.startsWith('CIRCLE_SERVER_')){const replacement=key.replace('CIRCLE_SERVER_','CIRCLE_HUB_');if(env[replacement]===undefined)env[replacement]=env[key];delete env[key];}return env;}
test('Hub naming: server supervisor worker and admin CLI accept only CIRCLE_HUB inputs while HTTP contracts stay unchanged',async t=>{
 const h=await setup(t);await h.stop();h.env=newEnvironment(h.env);await h.startServer();assert.equal((await h.request('/v1/status')).apiVersion,API_VERSION);const worker=await h.startWorker('lab-east-01',{CIRCLE_HUB_URL:h.url,CIRCLE_SERVER_URL:undefined as any});assert.equal(worker.exitCode,null);const token=await h.login('admin'),result=await promisify(execFile)(process.execPath,['apps/server/src/cli.ts','admin','tasks'],{cwd:root,env:{...newEnvironment(h.env),CIRCLE_HUB_URL:h.url,CIRCLE_HUB_TOKEN:token}});assert.ok(Array.isArray(JSON.parse(result.stdout)));assert.equal(result.stderr,'');
 await h.stop(worker);await h.stop();const child=spawn(process.execPath,['apps/server/src/supervisor.ts'],{cwd:root,env:h.env,stdio:['ignore','pipe','pipe']});h.children.add(child);let out='',errors='';child.stdout!.on('data',data=>out+=String(data));child.stderr!.on('data',data=>errors+=String(data));await until(async()=>{if(child.exitCode!==null)throw Error(errors);return out.split('\n').some(line=>{try{return JSON.parse(line).type==='ready';}catch{return false;}});});assert.ok(!errors.includes('hub.environment.deprecated'));await h.stop(child);
});
test('Hub naming: dev stack uses the circle-hub scratch prefix and new-only startup environment',async t=>{
 const child=spawn(process.execPath,['scripts/dev-stack.ts'],{cwd:root,env:{...newEnvironment(process.env),CIRCLE_HUB_PORT:'0'},stdio:['ignore','pipe','pipe']}),exited=once(child,'exit');let output='',errors='',stackPid:number|undefined;child.stdout!.on('data',data=>output+=String(data));child.stderr!.on('data',data=>errors+=String(data));t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){if(stackPid)process.kill(stackPid,'SIGTERM');else child.kill('SIGTERM');await exited;}});const ready=await until(async()=>{if(child.exitCode!==null)throw Error(errors);for(const line of output.split('\n'))try{const event=JSON.parse(line);if(event.type==='dev-stack-ready')return event;}catch{}return false;},30_000);stackPid=ready.pid;assert.match(ready.scratchDirectory,/circle-hub-dev-/);assert.ok(!errors.includes('hub.environment.deprecated'));const response=await fetch(ready.url+'/v1/auth/dev-login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(ready.login)});assert.equal(response.status,200);process.kill(stackPid!,'SIGTERM');await exited;
});
