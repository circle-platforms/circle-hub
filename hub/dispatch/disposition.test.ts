import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './testing/context.ts';

test('keep-unknown and unconfirmed mark-failed preserve the freeze; confirmed risk acceptance releases it', async t => {
  const c = await setup({ mode: 'reject' }); t.after(() => c.close());
  const first = await c.service.dispatch(c.admin, c.run, c.executor.id);
  const original = (await c.service.journal.events(first.job)).find(e => e.body.detail.uncertain === true)!;
  assert.equal((await c.service.dispose(c.admin, first.job, { choice: 'keep_unknown' })).frozen, true);
  assert.equal((await c.service.dispose(c.admin, first.job, { choice: 'mark_failed', reason: '合成审计未找到记录' })).frozen, true);
  await assert.rejects(c.service.dispose(c.owner, first.job, { choice: 'mark_failed', reason: '合成原因', acceptPossibleDuplicateEffects: true }));
  await assert.rejects(c.service.dispose(c.admin, first.job, { choice: 'mark_failed', acceptPossibleDuplicateEffects: true }));
  const released = await c.service.dispose(c.admin, first.job, { choice: 'mark_failed', reason: '合成原因', acceptPossibleDuplicateEffects: true });
  assert.equal(released.frozen, false); assert.equal(released.outcome, 'unknown');
  assert.deepEqual((await c.kit.store.get(original.digest))!.body, original.body);
  const confirmed = (await c.service.journal.events(first.job)).find(e => e.body.detail.risk_confirmed === true)!;
  assert.equal(confirmed.body.detail.confirmed_by, c.admin.id); assert.equal(confirmed.body.detail.confirmed_at, c.now().toISOString());
  assert.ok(confirmed.body.detail.confirmation);
  await assert.rejects(c.service.dispatch(c.admin, c.run, c.executor.id), 'unfreezing never permits resending the same bytes');
});

test('reconciliation verifies remote identity and bytes without comparing foreign delivery time', async t => {
  const c = await setup({ mode: 'reject' }); t.after(() => c.close());
  const first = await c.service.dispatch(c.admin, c.run, c.executor.id);
  const reconciled = await c.service.dispose(c.admin, first.job, { choice: 'reconcile', remote_id: 'synthetic-remote' });
  assert.equal(reconciled.frozen, false); assert.equal(reconciled.outcome, 'effective');
  assert.equal(c.calls.filter(n => n === 'send_blob').length, 1);
});

test('structural reconciliation faults remain frozen while foreign wall-clock skew is record only', async t => {
  for (const fault of ['absent', 'digest', 'identity', 'time-fast', 'time-slow']) {
    const c = await setup({ mode: 'reject', alter: (name, value) => name !== 'read_blob' ? value : fault === 'absent' ? {} : fault === 'digest' ? { ...value, digest: 'f'.repeat(64) } : fault === 'identity' ? { ...value, key: 'another' } : { ...value, submitted: new Date(Date.parse(String(value.submitted))+(fault==='time-fast'?1:-1)*7*3600000).toISOString() } });
    t.after(() => c.close());
    const first = await c.service.dispatch(c.admin, c.run, c.executor.id);
    if(fault==='time-fast'||fault==='time-slow'){assert.equal((await c.service.dispose(c.admin,first.job,{choice:'reconcile',remote_id:'synthetic-remote'})).frozen,false);}
    else {await assert.rejects(c.service.dispose(c.admin, first.job, { choice: 'reconcile', remote_id: 'synthetic-remote' }));
    assert.equal((await c.service.status(c.admin, first.job)).frozen, true);}
  }
});

test('freeze blocks a different artifact on the same physical resources until explicit risk disposition', async t => {
  const c = await setup({ mode: 'reject' }); t.after(() => c.close());
  const first = await c.service.dispatch(c.admin, c.run, c.executor.id);
  const source = await c.kit.artifacts.ingest({ bytes: new TextEncoder().encode('different synthetic verified bytes'), mediaType: 'application/octet-stream', origin: { upload: { session: 'synthetic' } }, author: { user: c.owner.id }, provenanceType: 'declared', visibility: { readers: [c.owner.id], admins: true, packs: [], shareable: false } });
  const proof = c.detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].statement.data as any;
  c.effectDocument.effects[0].parameters.values.sha256.push(source.body.sha256);
  proof.sha256 = source.body.sha256; c.detail.run.sources.push({ reference: `src:${source.body.sha256}`, role: 'artifact_under_verification', slot: 'synthetic-artifact' });
  await assert.rejects(c.service.dispatch(c.admin, c.run, c.executor.id));
  await c.service.dispose(c.admin, first.job, { choice: 'mark_failed', reason: '合成风险确认', acceptPossibleDuplicateEffects: true });
  await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(c.calls.filter(n => n === 'send_blob').length, 2);
});

test('numeric remote ids remain typed and reconcile without guessing string equivalence', async t => {
  const c = await setup({ mode: 'reject', alter: (name, value) => name === 'read_blob' || name === 'send_blob' ? { ...value, key: 17 } : value }); t.after(() => c.close());
  const first = await c.service.dispatch(c.admin, c.run, c.executor.id);
  await assert.rejects(c.service.dispose(c.admin, first.job, { choice: 'reconcile', remote_id: '17' }));
  assert.equal((await c.service.dispose(c.admin, first.job, { choice: 'reconcile', remote_id: 17 })).frozen, false);
});
