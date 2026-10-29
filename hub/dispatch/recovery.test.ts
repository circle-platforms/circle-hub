import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { observationLockFree, setup } from './testing/context.ts';

async function worker(c: Awaited<ReturnType<typeof setup>>) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./testing/worker.ts', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let output = ''; let errors = ''; child.stdout!.on('data', b => output += b); child.stderr!.on('data', b => errors += b);
  const exited = new Promise<{ code: number | null; signal: string | null; output: string; errors: string }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal, output, errors })));
  const ready = new Promise<void>(resolve => child.once('message', () => resolve()));
  child.stdin!.end(JSON.stringify({ config: { ...c.kit.config, database: c.kit.database }, now: c.now().toISOString(), detail: c.detail, admin: c.admin, executor: c.executor.id }));
  await Promise.race([ready, exited.then(e => { throw new Error(`synthetic worker exited before ready: ${e.code}`); })]);
  return { child, exited };
}

test('two independent processes dispatching identical bytes produce exactly one successful submission', { timeout: 30000 }, async t => {
  const c = await setup(); t.after(() => c.close());
  const a = await worker(c); const b = await worker(c); t.after(() => { a.child.kill('SIGKILL'); b.child.kill('SIGKILL'); });
  a.child.send('go'); b.child.send('go');
  const outcomes = await Promise.all([a.exited, b.exited]);
  assert.equal(outcomes.filter(o => o.code === 0).length, 1, JSON.stringify(outcomes));
  assert.equal(c.calls.filter(n => n === 'send_blob').length, 1);
  assert.ok(c.sawIntentAtSubmit);
});

test('a process killed during submission is recovered as unknown and never submits again', { timeout: 30000 }, async t => {
  let child: ChildProcess | undefined;
  const c = await setup({ onSubmit: async () => { child!.kill('SIGKILL'); } }); t.after(() => c.close());
  const w = await worker(c); child = w.child; t.after(() => child?.kill('SIGKILL')); child.send('go');
  const exit = await w.exited; assert.equal(exit.signal, 'SIGKILL');
  const intent = await c.kit.store.getByKey<any>('action', `dispatch.bytes:${c.payload.body.sha256}:1`);
  assert.ok(intent);
  await observationLockFree(c, intent.body.detail.job);
  const state = await c.service.resume(c.admin, intent.body.detail.job);
  assert.equal(state.outcome, 'unknown'); assert.equal(state.frozen, true);
  assert.equal(c.calls.filter(n => n === 'send_blob').length, 1);
  await assert.rejects(c.service.dispatch(c.admin, c.run, c.executor.id));
});

test('timeout, disconnect, rejection, inconsistent receipt and unknown states freeze without retry or release', async t => {
  for (const mode of ['timeout', 'disconnect', 'reject', 'receipt-sha', 'receipt-items', 'lost', 'unmapped']) {
    const c = await setup({ mode, timeout: 20 }); t.after(() => c.close());
    const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
    assert.equal(state.outcome, 'unknown', mode); assert.equal(state.frozen, true, mode);
    assert.equal(c.calls.filter(n => n === 'send_blob').length, 1, mode);
    await c.service.resume(c.admin, state.job);
    assert.equal(c.calls.filter(n => n === 'send_blob').length, 1, mode);
    assert.equal(c.calls.includes('close_slot'), false, mode);
    assert.ok((await c.service.journal.events(state.job)).some(e => e.body.detail.request_kind === 'disposition'));
  }
});

test('an accepted job resumes status reads after restart without a new submission', { timeout: 30000 }, async t => {
  let child: ChildProcess | undefined; let killed = false;
  const c = await setup({ alter: (name, value) => {
    if (name === 'inspect_blob') {
      if (!killed) { killed = true; child!.kill('SIGKILL'); return { state: 'working' }; }
      return { state: 'ended' };
    }
    return value;
  } }); t.after(() => c.close());
  const w = await worker(c); child = w.child; t.after(() => child?.kill('SIGKILL')); child.send('go');
  assert.equal((await w.exited).signal, 'SIGKILL');
  const intent = await c.kit.store.getByKey<any>('action', `dispatch.bytes:${c.payload.body.sha256}:1`);
  const job = intent!.body.detail.job;
  // The killed worker held the job's observation lock on its own database session; PostgreSQL frees it only once it
  // notices that connection is gone. Until then resume rightly reports the job as being observed elsewhere, so wait
  // for the lock to be free rather than for an amount of time.
  await observationLockFree(c, job);
  const state = await c.service.resume(c.admin, job);
  assert.equal(state.outcome, 'effective'); assert.equal(state.frozen, false);
  assert.equal(c.calls.filter(n => n === 'send_blob').length, 1);
});

test('transient status and result read failures retry only reads and do not turn an accepted submission into unknown', async t => {
  for (const mode of ['transient-status', 'transient-result']) {
    const c = await setup({ mode }); t.after(() => c.close());
    const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
    assert.equal(state.outcome, 'effective', mode); assert.equal(state.frozen, false, mode);
    assert.equal(c.calls.filter(n => n === 'send_blob').length, 1);
  }
});

test('a committed intent with a lost acknowledgement is locally proven not dispatched', async t => {
  const c = await setup(); t.after(() => c.close());
  const transaction = c.kit.store.withTransaction.bind(c.kit.store); let injected = false;
  c.kit.store.withTransaction = async (fn, outer) => {
    const value = await transaction(fn, outer);
    if (!injected && await c.kit.store.getByKey('action', `dispatch.bytes:${c.payload.body.sha256}:1`)) { injected = true; throw new Error('synthetic commit acknowledgement loss'); }
    return value;
  };
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(state.outcome, 'not_dispatched'); assert.equal(state.frozen, false);
  assert.equal(c.calls.filter(n => n === 'send_blob').length, 0);
});

test('a process killed after journal admission resumes by request identity without a second submission', {timeout:30000},async t=>{
  const {setupJournal}=await import('./testing/journal.ts');let child:ChildProcess|undefined;
  const c=await setupJournal({lost:true,onSubmit:async()=>{child!.kill('SIGKILL');}});t.after(()=>c.close());
  const w=await worker(c);child=w.child;t.after(()=>child?.kill('SIGKILL'));child.send('go');
  assert.equal((await w.exited).signal,'SIGKILL');
  const intent=await c.kit.store.getByKey<any>('action',`dispatch.bytes:${c.payload.body.sha256}:1`);assert.ok(intent);
  await observationLockFree(c,intent.body.detail.job);
  const state=await c.service.resume(c.admin,intent.body.detail.job);
  assert.equal(state.outcome,'effective');assert.equal(state.frozen,false);
  assert.equal(c.calls.filter(n=>n==='send_blob').length,1);assert.ok(c.calls.includes('lookup_blob'));
});

test('a compatible observation policy repair lets an administrator reconcile the original job without retransmission',async t=>{
  const c=await setup({mode:'unmapped'});t.after(()=>c.close());
  const original=await c.service.dispatch(c.admin,c.run,c.executor.id);assert.equal(original.frozen,true);
  await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,status:{...c.executor.definition.status,map:{...c.executor.definition.status.map,unmapped:{action_result:'completed',effect_outcome:'effective'}}}});
  const result=await c.service.dispose(c.admin,original.job,{choice:'reconcile',remote_id:'synthetic-remote'});
  assert.equal(result.outcome,'effective');assert.equal(result.frozen,false);assert.equal(c.calls.filter(n=>n==='send_blob').length,1);
});

test('R15 terminal hangup during the one submission does not cancel it',{timeout:30000},async t=>{
  let child:ChildProcess|undefined;
  const c=await setup({onSubmit:async()=>{child!.kill('SIGHUP');await new Promise(resolve=>setTimeout(resolve,30));}});t.after(()=>c.close());
  const w=await worker(c);child=w.child;t.after(()=>child?.kill('SIGKILL'));child.send('go');
  const exit=await w.exited;assert.equal(exit.code,0);assert.equal(exit.signal,null);assert.equal(c.calls.filter(n=>n==='send_blob').length,1);
});
