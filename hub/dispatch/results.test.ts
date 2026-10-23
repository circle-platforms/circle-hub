import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Page, StoredRecord } from '../records/api.ts';
import { setup } from './testing/context.ts';

async function report(c: Awaited<ReturnType<typeof setup>>, reference: string) {
  const source = await c.kit.artifacts.source(c.owner, reference.slice(4));
  assert.ok(source?.bytes); return JSON.parse(new TextDecoder().decode(source.bytes));
}
test('reports retain target outcomes but never assert dynamic verdicts without certified attribution', async t => {
  const c = await setup(); t.after(() => c.close());
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  const value = await report(c, state.result!);
  assert.equal(value.rows[0].reported_terminal, 'pass'); assert.equal(value.rows[0].dynamic_terminal, 'no_verdict');
  assert.ok(value.rows[0].limits.includes('目标对本次派发的报告'));
  assert.ok(value.rows[0].limits.includes('未排除本地操作'));
  const other = await c.kit.principals.createUser(c.admin, '其他合成用户');
  assert.equal(await c.kit.artifacts.source(other, state.result!.slice(4)), null);
  assert.ok((await c.kit.artifacts.source(c.admin, state.result!.slice(4)))?.bytes);
});

test('incomplete channels and empty or unmapped rows have no verdict; mismatched result digest freezes', async t => {
  for (const mode of ['partial', 'empty', 'unmapped-row', 'result-sha']) {
    const c = await setup({ mode, alter: (name, v) => name !== 'read_blob' ? v : mode === 'empty' ? { ...v, rows: [{}] } : mode === 'unmapped-row' ? { ...v, rows: [{ id: 'synthetic-case', outcome: 'unmapped' }] } : v }); t.after(() => c.close());
    const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
    if (mode === 'result-sha') { assert.equal(state.frozen, true); assert.equal(state.result, undefined); }
    else { const r = await report(c, state.result!); assert.equal(r.rows[0].dynamic_terminal, 'no_verdict'); assert.equal(r.rows[0].reported_terminal, null); }
  }
});

test('heartbeat deadlines and interruptions are recorded while status reads continue; fencing changes are disclosed', async t => {
  for (const mode of ['heartbeat-failure', 'fencing']) {
    const c = await setup({ mode, ttl: 30 }); t.after(() => c.close());
    const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
    assert.equal(c.calls.filter(n => n === 'send_blob').length, 1);
    const events = await c.service.journal.events(state.job);
    if (mode === 'heartbeat-failure') {
      assert.ok(c.calls.includes('touch_slot'));
      assert.ok(events.some(e => e.body.detail.lease_interrupted === true));
      const r = await report(c, state.result!); assert.equal(r.lease_interrupted, true);
    } else assert.equal((await report(c, state.result!)).lease_drift, true);
    assert.ok(c.calls.includes('read_blob'));
  }
});

test('secrets are absent from every record, object, file, and reply projection even when echoed by the target', async t => {
  const c = await setup({ alter: (_name, value) => ({ ...value, debug: 'Bearer synthetic-secret' }) }); t.after(() => c.close());
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(state.outcome, 'effective');
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await walk(file); else assert.ok(!(await readFile(file)).includes(Buffer.from('synthetic-secret')), 'secret found in synthetic file output');
    }
  };
  await walk(c.kit.dataDir);
  const { RECORD_KINDS } = await import('../../contracts/generated/protocol.ts');
  for (const kind of RECORD_KINDS) {
    let cursor: string | null = null;
    do { const page: Page<StoredRecord> = await c.kit.store.list({ kind, limit: 500, ...(cursor ? { cursor } : {}) }); assert.ok(!JSON.stringify(page.items).includes('synthetic-secret')); cursor = page.next; } while (cursor);
  }
});

test('a fence change during result retrieval is recorded before publishing the result', async t => {
  const c = await setup({ mode: 'fencing-result' }); t.after(() => c.close());
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal((await report(c, state.result!)).lease_drift, true);
});

test('deployment-specific limitations are copied as executor declarations rather than inferred by the core', async t => {
  const c = await setup(); t.after(() => c.close());
  await c.registry.update(c.admin, c.executor.id, { ...c.executor.definition, limitations: ['合成运行环境使用实时文件，内容一致性未认证'] });
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  const result = await report(c, state.result!);
  assert.equal(result.executor_declarations.provenance, 'declared');
  assert.deepEqual(result.executor_declarations.limitations, ['合成运行环境使用实时文件，内容一致性未认证']);
  assert.ok(result.executor_declarations.definition_sha256);
});
