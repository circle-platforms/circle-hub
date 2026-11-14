import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256Hex, type ActionBody } from '../records/api.ts';
import type { JobStatus } from './service.ts';
import { setup } from './testing/context.ts';

type Context = Awaited<ReturnType<typeof setup>>;

async function draft(c: Context, extraRead = false) {
  await c.kit.teams.remove(c.admin, c.environmentTeam.id, c.admin.id);
  assert.equal((await c.kit.testEnvironments.inheritance()).completed, true);
  assert.equal(c.service.options.enforceEnvironmentAssignments, true);
  assert.equal(await c.kit.testEnvironments.canUse(c.admin, c.environment.id), false);
  return c.registry.update(c.admin, c.executor.id, {
    ...c.executor.source, manifest_sha256: null, resources: [], conditions: [],
    capture_pointers: ['/topology'],
    ...(extraRead ? {
      allowed_tools: [...c.executor.source.allowed_tools, 'peek_cache'],
      precheck_reads: [{ tool: 'peek_cache', arguments: { refresh: false }, conditions: [], capture_pointers: ['/cached'] }],
    } : {}),
  });
}

async function bookings(c: Context) {
  return { view: await c.leases.view('', true), actions: await c.leases.actionLog('') };
}

async function noEffects(c: Context, before: Awaited<ReturnType<typeof bookings>>, job?: string) {
  assert.equal(c.calls.includes('send_blob'), false);
  assert.equal(c.submitted.length, 0);
  assert.deepEqual(await bookings(c), before, 'capture cannot create, renew or release a formal Hub booking');
  const actions = await c.kit.store.findMany<ActionBody>({ kind: 'action', key: 'dispatch.executor', values: [c.executor.id] });
  assert.equal(actions.some(row => row.body.detail.phase === 'intent' || row.body.detail.phase === 'probe_intent'), false);
  if (job) {
    const events = await c.service.journal.events(job);
    assert.equal(events.some(event => event.body.detail.phase === 'round'), false, 'collection is not an execution round');
  }
}

async function auditedCapture(c: Context, state: JobStatus, digest: string, phases: readonly string[]) {
  const binding = await c.service.journal.binding(state.job);
  assert.equal(binding.initiated_by, c.admin.id);
  assert.equal(binding.user, c.admin.id);
  assert.equal(binding.executor, c.executor.id);
  assert.equal(binding.executor_digest, digest);
  assert.equal(binding.scope?.target, c.executor.definition.target);
  assert.deepEqual(binding.resources, []);
  const events = await c.service.journal.events(state.job);
  for (const event of events) assert.equal(event.body.detail.initiated_by, c.admin.id);
  for (const phase of phases) {
    const event = events.find(event => event.body.detail.phase === phase);
    assert.ok(event, `the actual read has an audit event: ${phase}`);
    const source = event.body.inputs.find(reference => reference.startsWith('src:'));
    const record = event.body.inputs.find(reference => reference.startsWith('rec:'));
    assert.ok(source); assert.ok(record);
    const bytes = await c.kit.objects.get(source.slice(4));
    assert.ok(bytes); assert.equal(sha256Hex(bytes), source.slice(4));
    assert.ok(await c.kit.store.get(record.slice(4)), 'the captured original has a durable artifact record');
    assert.equal(event.body.detail.complete, true);
  }
  const reply = events.find(event => event.body.detail.phase === 'precheck.response')!;
  const source = reply.body.inputs.find(reference => reference.startsWith('src:'))!;
  const bytes = await c.kit.objects.get(source.slice(4)); assert.ok(bytes);
  assert.deepEqual(JSON.parse(Buffer.from(bytes).toString('utf8')).result.structuredContent.topology, { synthetic: true });
  const completion = events.find(event => event.body.detail.phase === 'complete');
  assert.ok(completion); assert.equal(completion.body.detail.registration_ready, false);
  assert.equal(state.outcome, 'not_dispatched');
  assert.ok(c.calls.includes('open_slot') && c.calls.includes('inspect_slot') && c.calls.includes('close_slot'));
  assert.equal(c.calls.filter(name => name === 'open_slot').length, c.calls.filter(name => name === 'close_slot').length);
  for (const name of c.calls) assert.ok(['open_slot', 'touch_slot', 'inspect_slot', 'peek_cache', 'close_slot'].includes(name), name);
  const represented = c.endpoint.calls.filter(call => call.method === 'tools/call');
  assert.ok(represented.length > 0);
  for (const call of represented) assert.equal(call.headers['x-circle-hub-actor'], `${c.admin.id}/${state.job}`);
}

test('an unassigned real administrator captures an enabled known target without intent, submission or a Hub booking', async t => {
  const c = await setup(); t.after(() => c.close());
  const registered = await draft(c);
  const before = await bookings(c);
  const state = await c.service.precheck(c.admin, c.executor.id);
  await auditedCapture(c, state, registered.resolved_digest, ['precheck.response', 'release.response']);
  await assert.rejects(c.service.dispatch(c.admin, c.run, c.executor.id), /先 precheck.*update/);
  await noEffects(c, before, state.job);
});

test('capture-only additional sources retain their originals and release the read-only remote ticket', async t => {
  const c = await setup({ extraTools: ['peek_cache'], alter: (name, value) => name === 'peek_cache' ? { cached: [1, 2] } : value });
  t.after(() => c.close());
  const registered = await draft(c, true);
  const before = await bookings(c);
  const state = await c.service.precheck(c.admin, c.executor.id);
  assert.ok(c.calls.indexOf('peek_cache') > c.calls.indexOf('inspect_slot'));
  await auditedCapture(c, state, registered.resolved_digest, ['precheck.response', 'precheck.1.response', 'release.response']);
  await noEffects(c, before, state.job);
});

test('a member cannot use incomplete registration as bootstrap admission', async t => {
  const c = await setup(); t.after(() => c.close());
  await draft(c); const before = await bookings(c);
  const state = await c.service.precheck(c.owner, c.executor.id);
  assert.equal(state.outcome, 'not_dispatched');
  assert.equal(state.call_error_category, 'not_found');
  assert.match(state.missing_fact ?? state.reason ?? '', /登记.*未完成|还没有登记完成/);
  assert.match(state.next_action ?? '', /管理员.*登记/);
  assert.doesNotMatch(state.missing_fact ?? state.reason ?? '', /没有.*使用.*分配/);
  assert.equal(c.endpoint.calls.length, 0);
  await noEffects(c, before, state.job);
});

test('a forged administrator role on an unassigned stored member neither admits capture nor reveals the target', async t => {
  const c = await setup(); t.after(() => c.close());
  await draft(c);
  const member = await c.kit.principals.createUser(c.admin, '合成未分配成员');
  assert.equal((await c.kit.principals.get(member.id))?.role, 'user');
  const before = await bookings(c);
  const state = await c.service.precheck({ ...member, role: 'admin' }, c.executor.id);
  assert.equal(state.outcome, 'not_dispatched');
  assert.equal(state.call_error_category, 'not_found');
  assert.match(state.missing_fact ?? state.reason ?? '', /登记.*未完成|还没有登记完成/);
  assert.doesNotMatch(JSON.stringify(state), /synthetic-bed/);
  assert.equal(c.endpoint.calls.length, 0);
  await noEffects(c, before, state.job);
});

test('declaring resources closes bootstrap and an administrator still needs the ordinary environment use grant', async t => {
  const c = await setup(); t.after(() => c.close());
  await draft(c); const before = await bookings(c);
  const captured = await c.service.precheck(c.admin, c.executor.id);
  assert.ok(c.calls.includes('inspect_slot'));
  await c.registry.update(c.admin, c.executor.id, c.executor.source);
  assert.equal(await c.kit.testEnvironments.canUse(c.admin, c.environment.id), false);
  const callCount = c.endpoint.calls.length;
  const refused = await c.service.precheck(c.admin, c.executor.id);
  assert.equal(refused.outcome, 'not_dispatched');
  assert.equal(refused.error_code, 'SOURCE_NOT_PERMITTED');
  assert.equal(c.endpoint.calls.length, callCount, 'an earlier bootstrap never grants another read after resources are declared');
  await noEffects(c, before, captured.job);
  await noEffects(c, before, refused.job);
});

test('a disabled executor cannot enter bootstrap collection', async t => {
  const c = await setup(); t.after(() => c.close());
  await draft(c); await c.registry.disable(c.admin, c.executor.id);
  const before = await bookings(c);
  await assert.rejects(c.service.precheck(c.admin, c.executor.id), /不可用|禁用/);
  assert.equal(c.endpoint.calls.length, 0);
  await noEffects(c, before);
});

test('an ordinary target variable whose original cannot be read cannot enter bootstrap collection', async t => {
  const c = await setup(); t.after(() => c.close());
  await draft(c);
  await c.kit.variables.setVariable(c.admin, 'BOOTSTRAP_TARGET', c.executor.definition.target, '合成普通目标变量');
  const current = await c.registry.readSource(c.executor.id); assert.ok(current);
  await c.registry.update(c.admin, c.executor.id, { ...current.source, target: '${var:BOOTSTRAP_TARGET}' });
  const before = await bookings(c);
  const read = c.kit.variables.valueAt.bind(c.kit.variables);
  c.kit.variables.valueAt = async (name, decision, tx) => {
    if (name === 'BOOTSTRAP_TARGET') throw new Error('合成普通目标变量原件不可读');
    return read(name, decision, tx);
  };
  t.after(() => { c.kit.variables.valueAt = read; });
  await assert.rejects(c.service.precheck(c.admin, c.executor.id), /合成普通目标变量原件不可读/);
  assert.equal(c.endpoint.calls.length, 0);
  await noEffects(c, before);
});

test('a refused bootstrap read keeps the original and actor audit and releases its remote ticket', async t => {
  const c = await setup({ alter: (name, value) => name === 'inspect_slot' ? { ok: false, reason: 'synthetic read refusal' } : value });
  t.after(() => c.close());
  await draft(c); const before = await bookings(c);
  const state = await c.service.precheck(c.admin, c.executor.id);
  const binding = await c.service.journal.binding(state.job);
  assert.equal(binding.initiated_by, c.admin.id);
  assert.equal(binding.executor, c.executor.id);
  const events = await c.service.journal.events(state.job);
  const response = events.find(event => event.body.detail.phase === 'precheck.response'); assert.ok(response);
  assert.equal(response.body.detail.initiated_by, c.admin.id);
  const reference = response.body.inputs.find(value => value.startsWith('src:')); assert.ok(reference);
  const bytes = await c.kit.objects.get(reference.slice(4)); assert.ok(bytes);
  assert.equal(sha256Hex(bytes), reference.slice(4));
  assert.equal(JSON.parse(Buffer.from(bytes).toString('utf8')).result.isError, true);
  assert.ok(events.some(event => event.body.detail.phase === 'precheck.failure'));
  assert.equal(state.outcome, 'not_dispatched');
  assert.equal(state.frozen, false);
  assert.equal(c.calls.filter(name => name === 'open_slot').length, 1);
  assert.equal(c.calls.filter(name => name === 'close_slot').length, 1);
  await noEffects(c, before, state.job);
});
