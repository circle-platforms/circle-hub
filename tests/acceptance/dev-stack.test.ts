import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import { root, until } from './harness.ts';

test('npm run dev:stack starts PostgreSQL server and worker and cleans its scratch directory', async t => {
  const child = spawn('npm',['run','dev:stack'],{ cwd:root,env:{ ...process.env,CIRCLE_SERVER_PORT:'0' },
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
  assert.match(ready.postgresVersion,/PostgreSQL 18\.4/);
  const login = await fetch(`${ready.url}/v1/auth/dev-login`,{ method:'POST',headers:{ 'content-type':'application/json' },body:JSON.stringify(ready.login) });
  assert.equal(login.status,200); const token = (await login.json() as any).data.token;
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
  const exited = once(child,'exit');
  if (process.platform === 'win32') process.kill(ready.pid,'SIGTERM'); else process.kill(-child.pid!,'SIGINT');
  await exited;
  await until(async () => { try { await stat(ready.scratchDirectory); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return true; } },8000);
});
