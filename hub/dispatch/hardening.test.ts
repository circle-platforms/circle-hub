import {addSyntheticExecutor} from './testing/credentials.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './testing/context.ts';
import { definition } from './testing/definition.ts';
import { startEndpoint } from './testing/server.ts';
import { ExecutorDefinition } from './definition.ts';
import { RpcClient } from './transport.ts';
import { sha256Hex } from '../records/api.ts';

test('prototype names are unmapped states and outcomes, not inherited dictionary entries', async t => {
  const c = await setup({ alter: (name, value) => name === 'inspect_blob' ? { state: '__proto__' } : value }); t.after(() => c.close());
  let waits = 0; (c.service as any).sleep = async () => { waits++; c.clock.ms += 1000000; };
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(state.frozen, true); assert.equal(waits, 0);
  const r = await setup({ alter: (name, value) => name === 'read_blob' ? { ...value, rows: [{ id: 'synthetic-case', outcome: 'constructor' }] } : value }); t.after(() => r.close());
  const result = await r.service.dispatch(r.admin, r.run, r.executor.id);
  const source = await r.kit.artifacts.source(r.owner, result.result!.slice(4));
  assert.equal(JSON.parse(new TextDecoder().decode(source!.bytes!)).rows[0].reported_terminal, null);
});

test('minimum conditions may bind seat counts and topology digest failures prevent all submissions', async t => {
  const c = await setup(); t.after(() => c.close());
  await c.registry.update(c.admin, c.executor.id, { ...c.executor.definition, conditions: [{ pointer: '/seats', at_least: { $value: 'seats' } }] });
  assert.equal((await c.service.precheck(c.admin, c.executor.id)).frozen, false);
  await c.registry.update(c.admin, c.executor.id, { ...c.executor.definition, conditions: [{ pointer: '/topology', sha256: 'f'.repeat(64) }] });
  assert.equal((await c.service.dispatch(c.admin, c.run, c.executor.id)).outcome, 'not_dispatched');
  assert.equal(c.calls.includes('send_blob'), false);
});

test('the verified bytes must occupy the declared artifact slot', async t => {
  const c = await setup(); t.after(() => c.close());
  c.detail.run.sources[0].slot = 'untrusted-slot';
  assert.equal((await c.service.dispatch(c.admin,c.run,c.executor.id)).outcome,'not_dispatched');
  assert.equal(c.calls.includes('send_blob'), false);
});

test('a key cannot be embedded literally in executor definitions or argument templates', async t => {
  const c = await setup(); t.after(() => c.close());
  await assert.rejects(addSyntheticExecutor(c.kit,c.registry,c.admin,{ ...definition(c.endpoint.endpoint), precheck_context: { marker: 'synthetic-third-key' } },'synthetic-third-key'));
  await assert.rejects(c.registry.update(c.admin, c.executor.id, { ...c.executor.definition, precheck_context: { marker: 'synthetic-secret' } }));
});

test('raw response transformations disclose received-byte hashes and operation times before interpretation', async t => {
  const endpoint = await startEndpoint(definition('x').allowed_tools, () => ({ ok: true, debug: 'synthetic-secret' })); t.after(() => endpoint.close());
  let metadata: any; let stored: Uint8Array | undefined;
  const time = () => new Date('2026-10-23T00:00:00.000Z');
  const client = new RpcClient(ExecutorDefinition.parse(definition(endpoint.endpoint)), 'synthetic-secret', 'synthetic-job', async (bytes, _status, role, _complete, meta) => { if (role === 'precheck') { metadata = meta; stored = bytes; } return 'src:' + sha256Hex(bytes); }, time);
  await client.connect(); await client.call('precheck', {});
  assert.equal(metadata.redacted, true); assert.notEqual(metadata.received_sha256, sha256Hex(stored!));
  assert.equal(metadata.started_at, time().toISOString()); assert.equal(metadata.ended_at, time().toISOString());
});

test('submission content cannot be replaced by a literal or sent through a read-only role', async t => {
  const c = await setup(); t.after(() => c.close());
  const original = definition(c.endpoint.endpoint);
  await assert.rejects(addSyntheticExecutor(c.kit,c.registry,c.admin,{ ...original, calls: { ...original.calls, submit: { ...original.calls.submit, arguments: { ...original.calls.submit.arguments, blob: 'different-base64-bytes' } } } },'synthetic-new-key'));
  await assert.rejects(addSyntheticExecutor(c.kit,c.registry,c.admin,{ ...original, calls: { ...original.calls, precheck: { ...original.calls.precheck, arguments: { extra: { $value: 'payload_base64' } } } } },'synthetic-new-key'));
});

test('one artifact proof cannot silently select the first item of a multi-item verification run', async t => {
  const c = await setup(); t.after(() => c.close());
  c.detail.run.items.push({ ...c.detail.run.items[0], id: 'another-synthetic-item' });
  c.detail.latest!.result.partitions.delivered.push({ ...c.detail.latest!.result.partitions.delivered[0], item: 'another-synthetic-item' });
  assert.equal((await c.service.dispatch(c.admin,c.run,c.executor.id)).outcome,'not_dispatched');
  assert.equal(c.calls.includes('send_blob'), false);
});
