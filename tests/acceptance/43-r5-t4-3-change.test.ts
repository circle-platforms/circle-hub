import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FedObservationSchema } from '../../contracts/src/feeding.ts';
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
      source: { system: 'upload', bytes: saved.event.output.sha256 }, action: actionText, result: citation,
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
  // Full run-lease binding and the no-lease authorization marker are not present in the current operation schema.
});
