import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import { root, until } from './harness.ts';
import {loopbackTLS,checkedRequest} from '../fixtures/loopback-tls.ts';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {sha256} from '../../packages/contracts/src/index.ts';

for(const protocol of ['http','https'])test(`npm run dev:stack starts PostgreSQL server and workers over ${protocol} and cleans its scratch directory`, async t => {
  const tls=protocol==='https'?await loopbackTLS(t):undefined,env={...process.env,CIRCLE_SERVER_PORT:'0',CIRCLE_SERVER_TLS_CONFIG:tls?.configFile,NODE_EXTRA_CA_CERTS:tls?.caFile,NODE_TLS_REJECT_UNAUTHORIZED:undefined};
  const fetch=(url:string,options:{method?:string;headers?:Record<string,string>;body?:string|Buffer}={})=>checkedRequest(url,{...options,ca:tls?.ca});
  const child = spawn('npm',['run','dev:stack'],{ cwd:root,env,
    detached:process.platform !== 'win32',stdio:['ignore','pipe','pipe'] });
  // A supervised test process group reproduces the terminal's Ctrl+C delivery through npm.
  let output = ''; let errors = ''; let stackPid: number | undefined;
  child.stdout!.on('data',data => { output += data.toString(); }); child.stderr!.on('data',data => { errors += data.toString(); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child,'exit');
    if (stackPid) process.kill(stackPid,'SIGTERM'); else child.kill('SIGTERM'); await exited; } });
  const ready = await until(async () => {
    if (child.exitCode !== null) throw new Error(`Development stack exited: ${errors}`);
    for (const line of output.split('\n')) { try { const value = JSON.parse(line); if (value.type === 'dev-stack-ready') return value; } catch { /* partial line */ } }
    return false;
  },20_000);
  stackPid = ready.pid;
  assert.equal(new URL(ready.url).protocol,`${protocol}:`);
  assert.match(ready.postgresVersion,/PostgreSQL 18\.4/);
  const login = await fetch(`${ready.url}/v1/auth/dev-login`,{ method:'POST',headers:{ 'content-type':'application/json' },body:JSON.stringify(ready.login) });
  assert.equal(login.status,200); const token = (await login.json() as any).data.token;
  const workers=(await(await fetch(`${ready.url}/v1/admin/workers`,{headers:{authorization:`Bearer ${token}`}})).json() as any).data;assert.deepEqual(workers.map((worker:any)=>worker.workerId).sort(),['lab-east-01','lab-east-02']);
  const directory=await fetch(`${ready.url}/v1/tools`,{headers:{authorization:`Bearer ${token}`}});assert.equal(directory.status,200);
  const tools=(await directory.json() as any).data;for(const name of ['buildsite.command_check','docs.search','zentao.bug_detail','env.inventory','knowledge.claim_submit'])assert.ok(tools.some((tool:any)=>tool.name===name));
  const checked=await fetch(`${ready.url}/v1/tools/buildsite.command_check/call`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({args:{build:'Rel_PHOTON_10_5_0_101',commands:['service create port 443']},idempotencyKey:'dev-stack-command-check'})});
  assert.equal(checked.status,200);assert.equal((await checked.json() as any).data.result.commands[0].status,'hit');
  const sourceResponse = await fetch(`${ready.url}/v1/sources`,{ method:'POST',headers:{ authorization:`Bearer ${token}`,'content-type':'application/octet-stream',
    'x-scope-id':ready.scopeId,'x-file-name':'synthetic-mindmap.xmind' },body:await readFile(ready.samplePath) });
  assert.equal(sourceResponse.status,201); const source = (await sourceResponse.json() as any).data;
  const taskResponse = await fetch(`${ready.url}/v1/tasks/submit`,{ method:'POST',headers:{ authorization:`Bearer ${token}`,'content-type':'application/json' },
    body:JSON.stringify({ scopeId:ready.scopeId,capabilityPackId:'mindmap-compile',input:{ sourceRevisionId:source.sourceRevisionId },idempotencyKey:'dev-stack-compile' }) });
  assert.equal(taskResponse.status,202); const task = (await taskResponse.json() as any).data;
  const result = await until(async () => {
    const response = await fetch(`${ready.url}/v1/tasks/${task.taskId}/result`,{ headers:{ authorization:`Bearer ${token}` } });
    const value = (await response.json() as any).data; return value.phase === 'delivered' ? value : false;
  });
  assert.equal(result.status,'succeeded'); assert.equal(result.artifacts.length,1);
  const artifact=await fetch(`${ready.url}${result.artifacts[0].downloadPath}`,{headers:{authorization:`Bearer ${token}`}});assert.equal(artifact.status,200);assert.equal(sha256(Buffer.from(await artifact.arrayBuffer())),result.artifacts[0].sha256);
  if(tls){const before=(await(await fetch(`${ready.url}/v1/status`,{headers:{authorization:`Bearer ${token}`}})).json() as any).data,restarted=await promisify(execFile)(process.execPath,['apps/server/src/cli.ts','admin','restart','--graceful'],{cwd:root,env:{...env,CIRCLE_SERVER_URL:ready.url,CIRCLE_SERVER_TOKEN:token}});assert.equal(JSON.parse(restarted.stdout).restarted,true);const after=(await(await fetch(`${ready.url}/v1/status`,{headers:{authorization:`Bearer ${token}`}})).json() as any).data;assert.notEqual(after.bootId,before.bootId);const delivered=(await(await fetch(`${ready.url}/v1/tasks/${task.taskId}/result`,{headers:{authorization:`Bearer ${token}`}})).json() as any).data;assert.equal(delivered.status,'succeeded');}
  const exited = once(child,'exit');
  if (process.platform === 'win32') process.kill(ready.pid,'SIGTERM'); else process.kill(-child.pid!,'SIGINT');
  await exited;
  await until(async () => { try { await stat(ready.scratchDirectory); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return true; } },8000);
});
