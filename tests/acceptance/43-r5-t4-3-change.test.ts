import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FedObservationSchema } from '../../contracts/src/feeding.ts';
import { INDEX } from '../../hub/runs/engine/store.ts';
import {
  capture, capturedArtifact, commandTarget, contribution, openOperationWorld, quote, startOperationRun,
} from './support/operation-acceptance.ts';

test('scenario 43: T4-3 preserves three synthetic configuration snapshots and the current indirect lease association', async t => {
  const world = await openOperationWorld(t);
  if (!world) return;
  const target = await commandTarget(world.client, world.root, '/commands/widget/health/interval');
  const readCommand = 'show health synthetic-pool';
  const changeCommand = `${target.command} synthetic-pool 30`;
  const restoreCommand = `${target.command} synthetic-pool 10`;
  for (const command of [readCommand, changeCommand, restoreCommand]) {
    const answer: import('./support/mcp.ts').Answer<import('./support/mcp.ts').Outputs['resolve_reference']> = await world.client.call('resolve_reference', { root: world.root, text: command, expect: 'command' });
    assert.equal(answer.isError, false, answer.text);
    assert.equal(answer.out.resolution, 'resolved', command);
  }

  const common = { bed: 'bench-a', device: 'edge-a', address: '192.0.2.44' };
  const before = await capture(world, 'ORBIT synthetic probe interval: 10\n', { ...common, command: readCommand });
  const changed = await capture(world, 'ORBIT synthetic probe interval: 30\n', { ...common, command: changeCommand });
  const changedRead = await capture(world, 'ORBIT synthetic probe interval: 30\n', { ...common, command: readCommand });
  const restored = await capture(world, 'ORBIT synthetic probe interval: 10\n', { ...common, command: restoreCommand });
  const restoredRead = await capture(world, 'ORBIT synthetic probe interval: 10\n', { ...common, command: readCommand });
  const captures = [before, changed, changedRead, restored, restoredRead];
  assert.deepEqual(captures.map(row => row.event.sequence), [1, 3, 5, 7, 9]);
  assert.deepEqual(captures.map(row => JSON.parse(row.event.input.summary).command), [
    readCommand, changeCommand, readCommand, restoreCommand, readCommand,
  ]);
  assert.notDeepEqual(changedRead.bytes, before.bytes);
  assert.deepEqual(restoredRead.bytes, before.bytes, 'the restored capture has exactly the pre-change content');
  const artifactDigests: string[] = [];
  for (const saved of captures) {
    assert.equal(saved.event.tool.name, 'ssh');
    assert.deepEqual(saved.event.targets, { bed: 'bench-a', device: 'edge-a' });
    assert.equal(saved.upload.provenance_type, 'client_captured');
    const artifact = await capturedArtifact(world, saved.event);
    artifactDigests.push(artifact.digest);
    assert.deepEqual(Buffer.from((await world.bed.hub.records.artifacts.source(
      world.bed.reviewer.principal, saved.event.output.sha256, { record: artifact.digest },
    ))?.bytes ?? []), saved.bytes);
  }
  assert.equal(new Set(artifactDigests).size, captures.length, 'every tool event has its own source artifact record');
  assert.deepEqual([before, changedRead, restoredRead].map(row => row.event.sequence), [1, 5, 9]);

  const run = await startOperationRun(world, captures.map(row => row.event));
  const key = 'bed/bench-a/edge-a';
  const acquired = await world.bed.hub.leases.acquire({
    keys: [key], holder: { user: world.bed.reviewer.user.id, run: run.run }, prefix: 'bed/',
  });
  assert.ok(acquired.ok, acquired.ok ? '' : acquired.message);
  assert.ok(acquired.ok);
  assert.deepEqual((await world.bed.hub.leases.holderSnapshot([key])).map(row => ({
    key: row.key, lease: row.lease, user: row.user, run: row.run, released: row.released,
  })), [{ key, lease: acquired.lease, user: world.bed.reviewer.user.id, run: run.run, released: false }]);

  const records: string[] = [];
  for (const [index, saved] of captures.entries()) {
    const actionText = ['捕获前状态', '修改合成间隔', '捕获改后状态', '恢复捕获值', '再次捕获状态'][index]!;
    const citation = quote(saved.event, 1, `ORBIT synthetic probe interval: ${index === 1 || index === 2 ? '30' : '10'}`);
    const feeding = {
      schema: 'fed-observation@1', product: world.productId, root: world.root, path: target.path,
      source: { system: 'upload', bytes: saved.event.output.sha256, artifact: saved.upload.source.artifact! }, action: actionText, result: citation,
    };
    const submitted: import('./support/mcp.ts').Answer<import('./support/mcp.ts').Outputs['submit_result']> = await world.client.call('submit_result', {
      run: run.run, model: 'integration-synthetic@1',
      items: [{
        item: 'assertion', handling: 'handled', slots: { contribution: [{
          code: 'assertion', text: actionText,
          data: {
            root: world.root, path: target.path,
            source: { reference: citation.reference, quote: citation.text }, feeding,
          },
        }] },
      }],
    });
    assert.equal(submitted.isError, false, submitted.text);
    assert.equal(submitted.out.acceptance, 'accepted', JSON.stringify(submitted.out.errors));
    const record = submitted.out.result?.contributions?.stored[0]?.record;
    assert.ok(record);
    records.push(record);
    const view = await contribution(world, target.path, record);
    const observation = FedObservationSchema.parse(view.contribution.feeding);
    assert.equal(observation.action, actionText);
    assert.deepEqual(observation.result, citation);
  }
  assert.equal(records.length, captures.length);

  const audit = await world.bed.hub.leases.actionLog('bed/bench-a/');
  const action = audit.find(row => row.op === 'acquire' && row.lease === acquired.lease);
  assert.deepEqual(action?.holder, { user: world.bed.reviewer.user.id, run: run.run });
  const linked = await world.bed.hub.records.store.find({ key: 'knowledge.contribution.run', value: run.run, kind: 'claim', limit: 10 });
  for (const record of records) assert.ok(linked.items.some(row => row.digest === record), 'the contribution and lease holder name the same run');
  // This original scenario keeps the indirect association; the added scenario below checks the capture-time lease itself.
});

test('scenario 43: T4-3 binds a declared device to its capture-time lease and rejects foreign devices', async t => {
  const world = await openOperationWorld(t);
  if (!world) return;
  await world.bed.hub.assignPack(world.bed.reviewer.principal, 'test-bed');
  const target = await commandTarget(world.client, world.root, '/commands/widget/health/interval');
  const common = { command: 'show health synthetic-pool', bed: 'bench-a', device: 'edge-a', address: '192.0.2.44' };
  const beforeBooking = await capture(world, 'ORBIT synthetic probe interval: 10\n', common);
  const inventory = {
    schema: 'test-bed-manifest@1',
    beds: [{
      name: 'bench-a',
      devices: [
        { name: 'edge-a', type: 'router', ipv4: ['192.0.2.44/26'], ipv6: [], installed: { build: world.build } },
        { name: 'peer-a', type: 'client', ipv4: ['192.0.2.45/26'], ipv6: [] },
      ],
      services: [], reserved: [],
    }],
  };
  await world.bed.hub.hub.docs.put(world.bed.hub.admin.principal, 'operation-device-lease', new TextEncoder().encode(JSON.stringify(inventory)), { fileName: 'operation-device-lease.json' });
  const booked = await world.client.call('start_run', {
    pack: 'test-bed', inputs: { inventory: { external: 'doc:doc:operation-device-lease' } },
    parameters: { action: 'acquire', bed: 'bench-a', need: { devices: [{ type: 'router', count: 1 }], build: world.build } },
  });
  assert.equal(booked.isError, false, booked.text);
  const booking = booked.out.run?.run;
  assert.ok(booking);
  const key = 'bed/bench-a/edge-a';
  const bookingRun = await world.bed.hub.hub.runs.getRun(world.bed.reviewer.principal, booking);
  const lease = (bookingRun?.run as { leases?: Array<{ lease: string; keys: string[] }> } | undefined)?.leases?.find(row => row.keys.includes(key));
  assert.ok(lease);

  const duringBooking = await capture(world, 'ORBIT synthetic probe interval: 20\n', common);
  const subject = await world.client.upload(new TextEncoder().encode(JSON.stringify({ items: [{ id: 'assertion', title: '合成设备操作' }] })), 'operation-device-lease.json');
  const started = await world.client.call('start_run', {
    pack: 'knowledge-contribution', product: world.product, build: world.build, predecessor: booking,
    inputs: {
      subject: { reference: subject },
      originals: [beforeBooking, duringBooking].map(saved => ({ reference: `src:${saved.event.output.sha256}` })),
    },
  });
  assert.equal(started.isError, false, JSON.stringify(started.out.errors));
  const run = started.out.run?.run;
  assert.ok(run);
  const submit = async (
    saved: Awaited<ReturnType<typeof capture>>, device: string, action: string, extra: Record<string, unknown> = {},
  ): Promise<import('./support/mcp.ts').Answer<import('./support/mcp.ts').Outputs['submit_result']>> => {
    const citation = quote(saved.event, 1, saved.bytes.toString('utf8').split('\n')[0]!);
    return world.client.call('submit_result', {
      run, model: 'integration-synthetic@1',
      items: [{
        item: 'assertion', handling: 'handled', slots: { contribution: [{
          code: 'assertion', text: action,
          data: {
            root: world.root, path: target.path,
            source: { reference: citation.reference, quote: citation.text },
            feeding: {
              schema: 'fed-observation@1', product: world.productId, root: world.root, path: target.path,
              source: { system: 'upload', bytes: saved.event.output.sha256, artifact: saved.upload.source.artifact! }, action, result: citation, device, ...extra,
            },
          },
        }] },
      }],
    });
  };

  const beforeAnswer = await submit(beforeBooking, 'edge-a', '预订前采集');
  assert.equal(beforeAnswer.out.acceptance, 'accepted', JSON.stringify(beforeAnswer.out.errors));
  const beforeReceipt = beforeAnswer.out.result?.contributions?.stored[0];
  assert.ok(beforeReceipt);
  assert.equal(beforeReceipt.device, 'edge-a');
  assert.equal(beforeReceipt.lease, null);
  assert.match(beforeAnswer.text, /设备 edge-a；无租约（未授权）/);
  const beforeView = await contribution(world, target.path, beforeReceipt.record);
  const beforeFeeding = FedObservationSchema.parse(beforeView.contribution.feeding);
  assert.equal(beforeFeeding.device, 'edge-a');
  assert.equal(beforeFeeding.lease, null);
  assert.match(beforeView.note ?? '', /设备 edge-a；无租约（未授权）/);

  const duringAnswer = await submit(duringBooking, 'edge-a', '持有租约期间采集');
  assert.equal(duringAnswer.out.acceptance, 'accepted', JSON.stringify(duringAnswer.out.errors));
  const duringReceipt = duringAnswer.out.result?.contributions?.stored[0];
  assert.ok(duringReceipt);
  assert.equal(duringReceipt.device, 'edge-a');
  assert.equal(duringReceipt.lease, key);
  assert.equal(duringReceipt.lease_id, lease.lease);
  assert.match(duringAnswer.text, new RegExp(`设备 edge-a；租约 ${key}（记录 ${lease.lease}）`));
  const duringView = await contribution(world, target.path, duringReceipt.record);
  const duringFeeding = FedObservationSchema.parse(duringView.contribution.feeding);
  assert.equal(duringFeeding.device, 'edge-a');
  assert.equal(duringFeeding.lease, key);
  assert.equal(duringFeeding.lease_id, lease.lease);
  assert.match(duringView.note ?? '', new RegExp(`设备 edge-a；租约 ${key}（记录 ${lease.lease}）`));
  const linked = await world.bed.hub.records.store.find({ key: 'knowledge.contribution.lease', value: lease.lease, kind: 'claim', limit: 10 });
  assert.ok(linked.items.some(row => row.digest === duringReceipt.record));

  const foreign = await submit(duringBooking, 'edge-other', '清单外设备');
  assert.equal(foreign.out.acceptance, 'not_accepted');
  assert.equal(foreign.out.result?.contributions?.stored.length, 0);
  const message = JSON.stringify(foreign.out.errors);
  assert.match(message, /不在运行绑定的台架清单里/);
  assert.match(message, /edge-a/);
  assert.match(message, /peer-a/);
  const supplied = await submit(duringBooking, 'edge-a', '客户端自报租约', { lease: 'lse_client_supplied' });
  assert.equal(supplied.out.acceptance, 'not_accepted');
  assert.equal(supplied.out.result?.contributions?.stored.length, 0);
  assert.match(JSON.stringify(supplied.out.errors), /租约由 Hub 填写，删掉该字段后重交/);
});
