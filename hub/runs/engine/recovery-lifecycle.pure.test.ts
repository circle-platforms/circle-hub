import assert from 'node:assert/strict';
import {test} from 'node:test';
import {maintainRuns} from './maintenance.ts';
import {createRunsService} from './service.ts';
import type {EngineContext, RunsEngineDeps} from './deps.ts';

function context(recoverPending: () => Promise<void>): EngineContext {
  return {deps: {
    dispatch: {recoverPending},
    records: new Proxy({}, {get() {throw new Error('no record or administrator read before recovery scheduling');}}),
  }} as unknown as EngineContext;
}

test('a maintenance pass schedules pending recovery before run scans or administrator selection', async () => {
  let stop=false, scheduled=0;
  const ctx=context(async()=>{scheduled++;stop=true;});
  await maintainRuns(ctx,()=>stop);
  assert.equal(scheduled,1);
});

test('every pass retries scheduling without requiring a changed journal or events_after value', async () => {
  let stop=false, scans=0;
  const ctx=context(async()=>{scans++;stop=true;});
  await maintainRuns(ctx,()=>stop);
  stop=false;
  await maintainRuns(ctx,()=>stop);
  assert.equal(scans,2);
});

test('a failed recovery scan is visible and the next pass can retry before touching run records', async () => {
  const failure=new Error('synthetic recovery scan failure');
  let scans=0, stop=false;
  const ctx=context(async()=>{scans++;if(scans===1)throw failure;stop=true;});
  await assert.rejects(maintainRuns(ctx,()=>stop),error=>error===failure);
  await maintainRuns(ctx,()=>stop);
  assert.equal(scans,2);
});

test('an already aborted pass cannot start a new recovery scan', async () => {
  const ctx=context(async()=>{assert.fail('must not schedule after stop');});
  await maintainRuns(ctx,()=>true);
});

test('scheduling does not wait for the remote worker that its port started', async () => {
  let release:()=>void=()=>{}, stop=false, settled=false;
  const worker=new Promise<void>(resolve=>{release=resolve;}).then(()=>{settled=true;});
  const ctx=context(async()=>{void worker;stop=true;});
  await maintainRuns(ctx,()=>stop);
  assert.equal(settled,false);
  release();await worker;
});

test('actual startMaintenance invokes the same recovery port on its initial pass and a later unchanged retry', async () => {
  let calls=0;
  const failure=new Error('synthetic stop after scheduling');
  const engine=createRunsService({
    records: {store:{},objects:{},artifacts:{},variables:{}},
    dispatch: {recoverPending:async()=>{calls++;throw failure;}},
    adminLog:()=>{},
  } as unknown as RunsEngineDeps);
  try {
    await assert.rejects(engine.startMaintenance(),error=>error===failure);
    await assert.rejects(engine.maintain(),error=>error===failure);
    assert.equal(calls,2);
  } finally {await engine.stopMaintenance({abort:true});}
});
