import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './testing/context.ts';

test('standalone precheck acquires, reads and releases without an intent or submission', async t => {
  const c = await setup(); t.after(() => c.close());
  const state = await c.service.precheck(c.admin, c.executor.id);
  const events = await c.service.journal.events(state.job);
  assert.ok(events.some(e => e.body.detail.readonly_verified === true));
  assert.ok(c.calls.includes('open_slot') && c.calls.includes('inspect_slot') && c.calls.includes('close_slot'));
  assert.equal(c.calls.includes('send_blob'), false);
  assert.equal(events.some(e => e.body.detail.phase === 'intent'), false);
});

test('failed read-only precheck releases the lease and records not-dispatched, never unknown', async t => {
  const c = await setup({ mode: 'build' }); t.after(() => c.close());
  const state = await c.service.precheck(c.admin, c.executor.id);
  assert.equal(state.outcome, 'not_dispatched'); assert.equal(state.frozen, false);
  assert.ok(c.calls.includes('close_slot'));
  assert.ok((await c.service.journal.events(state.job)).some(e => e.body.detail.readonly_verified === false));
});

test('bootstrap collection needs no invented manifest or resource keys, but dispatch remains forbidden', async t => {
  const c = await setup(); t.after(() => c.close());
  const input = { ...c.executor.definition, manifest_sha256: null, resources: [] };
  const draft = await c.registry.update(c.admin, c.executor.id, input);
    await c.freezeExecutor();
  assert.equal(draft.definition.manifest_sha256, null);
  const state = await c.service.precheck(c.admin, c.executor.id);
  assert.ok(c.calls.includes('inspect_slot')); assert.ok(c.calls.includes('close_slot'));
  await assert.rejects(c.service.dispatch(c.admin, c.run, c.executor.id), /先 precheck.*update/);
  assert.equal(c.calls.includes('send_blob'), false);
  await c.registry.disable(c.admin, c.executor.id);
  await assert.rejects(c.service.precheck(c.admin, c.executor.id));
});

test('multiple registered read-only sources are checked in order; a cache mismatch prevents intent', async t => {
  const { canonicalBytes, sha256Hex } = await import('../records/api.ts');
  for (const mismatch of [false, true]) {
    const c = await setup({ extraTools: ['peek_cache'], alter: (name, value) => name === 'peek_cache' ? { cached: { stable: !mismatch } } : value }); t.after(() => c.close());
    await c.registry.update(c.admin, c.executor.id, { ...c.executor.definition, allowed_tools: [...c.executor.definition.allowed_tools, 'peek_cache'], precheck_reads: [{ tool: 'peek_cache', arguments: { refresh: false }, conditions: [{ pointer: '/cached', sha256: sha256Hex(canonicalBytes({ stable: true })) }] }] });
    await c.freezeExecutor();
    const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
    assert.ok(c.calls.indexOf('peek_cache') > c.calls.indexOf('inspect_slot'));
    assert.equal(state.outcome, mismatch ? 'not_dispatched' : 'effective');
    assert.equal(c.calls.includes('send_blob'), !mismatch);
  }
});

test('missing fields do not satisfy explicit-null checks', async t => {
  const c = await setup(); t.after(() => c.close());
  await c.registry.update(c.admin, c.executor.id, { ...c.executor.definition, conditions: [{ pointer: '/missing', equals: null }] });
    await c.freezeExecutor();
  const state = await c.service.precheck(c.admin, c.executor.id);
  assert.ok((await c.service.journal.events(state.job)).some(e => e.body.detail.readonly_verified === false));
});

test('capture-only cached sources can bootstrap expectations but never make dispatch ready', async t => {
  const c = await setup({ extraTools: ['peek_cache'], alter: (name, value) => name === 'peek_cache' ? { cached: [1, 2] } : value }); t.after(() => c.close());
  await c.registry.update(c.admin, c.executor.id, { ...c.executor.definition, manifest_sha256: null, resources: [], conditions: [], capture_pointers: ['/build'], allowed_tools: [...c.executor.definition.allowed_tools, 'peek_cache'], precheck_reads: [{ tool: 'peek_cache', arguments: { refresh: false }, conditions: [], capture_pointers: ['/cached'] }] });
    await c.freezeExecutor();
  const state = await c.service.precheck(c.admin, c.executor.id);
  assert.ok(c.calls.includes('inspect_slot')); assert.ok(c.calls.includes('peek_cache'));
  assert.match(state.next_action!, /转换脚本.*update/);
  assert.ok((await c.service.journal.events(state.job)).some(e => e.body.detail.registration_ready === false));
  await assert.rejects(c.service.dispatch(c.admin, c.run, c.executor.id));
});

test('overprivileged credentials produce a concrete reason in both precheck and dispatch without tool calls',async t=>{
  const c=await setup({extraTools:['synthetic_admin_reset']});t.after(()=>c.close());
  await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,refused_tools:['synthetic_admin_reset']});
    await c.freezeExecutor();
  for(const state of [await c.service.precheck(c.admin,c.executor.id),await c.service.dispatch(c.admin,c.run,c.executor.id)]) {
    assert.equal(state.outcome,'not_dispatched');assert.match(state.reason!,/密钥权限超出运行权限/);
  }
  assert.equal(c.calls.length,0);
});
