import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { knowledgeRetract } from '../../hub/knowledge/api.ts';
import { artifactShareKey } from '../../hub/records/constants.ts';
import {
  capture, capturedArtifact, commandTarget, contribution, integrate,
  nodeContributions, openOperationWorld, quote, startOperationRun,
} from './support/operation-acceptance.ts';

// Synthetic after_tool events stand in for Circle's SSH operations. No SSH client, device or external account is used.
describe('scenario 42: T4-2 and T6 operation evidence through the capture hook and the real Hub', () => {
  test('T4-2 and T6-1 resolve a readonly command, retain an unknown command capture, and return the operation on its node', async t => {
    const world = await openOperationWorld(t);
    if (!world) return;
    const target = await commandTarget(world.client, world.root);
    const known = await world.client.call('resolve_reference', { root: world.root, text: target.command, expect: 'command' });
    assert.equal(known.isError, false, known.text);
    assert.equal(known.out.resolution, 'resolved');
    assert.ok(known.out.references.some(row => row.reference.startsWith(`tree:${world.root}`)));

    const unknownCommand = 'synthetic-diagnostic-outside-tree';
    const unknown = await world.client.call('resolve_reference', { root: world.root, text: unknownCommand, expect: 'command' });
    assert.equal(unknown.isError, false, unknown.text);
    assert.equal(unknown.out.resolution, 'unresolved');
    assert.deepEqual(unknown.out.references, []);

    const before = Date.now();
    const knownCapture = await capture(world, `${target.command}\nORBIT read-only status: ready\n`, {
      command: target.command, bed: 'bench-a', device: 'edge-a', address: '192.0.2.44',
    });
    const outsideCapture = await capture(world, `${unknownCommand}\nORBIT synthetic unknown output\n`, {
      command: unknownCommand, bed: 'bench-a', device: 'edge-a', address: '192.0.2.44',
    });
    for (const saved of [knownCapture, outsideCapture]) {
      assert.equal(saved.event.session, world.session);
      assert.equal(saved.event.tool.name, 'ssh');
      assert.deepEqual(saved.event.targets, { bed: 'bench-a', device: 'edge-a' });
      assert.ok(Number.isFinite(Date.parse(saved.event.captured_at)));
      assert.ok(Date.parse(saved.event.captured_at) >= before);
      assert.match(saved.event.input.summary, /192\.0\.2\.44/);
      assert.equal(saved.upload.provenance_type, 'client_captured');
      assert.ok(saved.upload.sequence > saved.event.sequence);
      const artifact = await capturedArtifact(world, saved.event);
      assert.ok(Date.parse(artifact.body.captured_at) >= Date.parse(saved.event.captured_at));
    }

    const citation = quote(knownCapture.event, 2, 'ORBIT read-only status: ready');
    const receipt = await integrate(world, [{
      capture: knownCapture.event.output.sha256, kind: 'observation', path: target.path,
      statement: '合成只读排障已记录', action: '执行只读状态检查',
      quote: { line: 2, text: citation.text },
    }]);
    assert.equal(receipt.result.contributions.stored.length, 1);
    const record = receipt.result.contributions.stored[0].record;
    const run = await world.bed.hub.hub.runs.getRun(world.bed.reviewer.principal, receipt.result.run);
    assert.equal(run?.run.build, world.build);
    assert.equal(run?.run.root, world.root);

    const view = await contribution(world, target.path, record);
    const body = view.contribution;
    assert.equal(view.status, 'valid');
    assert.equal(body.kind, 'assertion');
    assert.equal(body.session, world.session);
    assert.ok(Number.isFinite(Date.parse(body.submitted_at)));
    assert.equal(body.source.provenance, 'client_captured');
    assert.equal(body.source.reference, citation.reference);
    assert.equal(body.source.quote, citation.text);
    assert.equal(body.basis_rank, 'judgment');
    assert.ok(body.source.records.includes((await capturedArtifact(world, knownCapture.event)).digest));
    const feeding = body.feeding;
    assert.equal(feeding?.schema, 'fed-observation@1');
    assert.ok(feeding && 'result' in feeding);
    assert.deepEqual(feeding.result, citation);
    assert.deepEqual(feeding.binding, { source: 'run_lock', build: world.build, line: world.bed.site.LINE });
    assert.equal(feeding.by, world.bed.reviewer.user.id);
    assert.equal(feeding.run, receipt.result.run);

    const samePage = await world.client.call('get_nodes', { root: world.root, paths: [target.path], depth: 0 });
    assert.equal(samePage.isError, false, samePage.text);
    assert.ok(samePage.out.nodes?.[0]?.contributions?.some(row => row.record === record));
    assert.match(samePage.text, /客户端捕获/);
    assert.match(samePage.text, /依据 声明/);
    const outsideArtifact = await capturedArtifact(world, outsideCapture.event);
    assert.equal(outsideArtifact.body.provenance_type, 'client_captured');
    // The quote-alteration counterexample is exercised by scenario 37 against this same real Hub.
  });

  test('T6-2 lets another account retrieve a shared pitfall in a new session with its grade, provenance and verbatim quote', async t => {
    const world = await openOperationWorld(t);
    if (!world) return;
    const target = await commandTarget(world.client, world.root);
    const saved = await capture(world, 'COMET display empty\nCheck the synthetic input before retrying\n', {
      command: target.command, bed: 'bench-b', device: 'edge-b',
    });
    const citation = quote(saved.event, 1, 'COMET display empty');
    const receipt = await integrate(world, [{
      capture: saved.event.output.sha256, kind: 'pitfall', path: target.path,
      statement: '合成空显示先核对输入', phenomenon: '合成显示为空', suggestion: '先核对合成输入',
      quote: { line: 1, text: citation.text },
    }]);
    const record = receipt.result.contributions.stored[0].record;
    const reader = await world.bed.user('合成教训读者', ['case-review']);
    const otherSession = await world.bed.connect(reader, 'circle-synthetic-pitfall-reader');
    assert.deepEqual(await nodeContributions(world, target.path, otherSession), []);
    const denied = await otherSession.call('get_nodes', { reference: `src:${saved.event.output.sha256}` });
    assert.equal(denied.isError, true);

    const artifact = await capturedArtifact(world, saved.event);
    await world.bed.hub.records.authorizations.share(
      world.bed.hub.admin.principal, artifactShareKey(artifact), [reader.user.id], '合成团队只读分享',
    );
    const original = await otherSession.call('get_nodes', { reference: citation.reference });
    assert.equal(original.isError, false, original.text);
    assert.equal(original.out.content?.readable, true);
    assert.equal(original.out.content?.text, citation.text);

    const view = await contribution(world, target.path, record, otherSession);
    const body = view.contribution;
    assert.equal(body.kind, 'assertion');
    assert.equal(body.session, world.session);
    assert.notEqual(body.session, 'circle-synthetic-pitfall-reader');
    assert.equal(body.source.provenance, 'client_captured');
    assert.equal(body.source.quote, citation.text);
    assert.equal(body.basis_rank, 'judgment');
    assert.equal(body.submitted_by, world.bed.reviewer.user.id);
    assert.ok(Number.isFinite(Date.parse(body.submitted_at)));
    const feeding = body.feeding;
    assert.equal(feeding?.schema, 'fed-pitfall@1');
    assert.ok(feeding && 'quote' in feeding);
    assert.deepEqual(feeding.quote, citation);
    assert.deepEqual(feeding.binding, { source: 'run_lock', build: world.build, line: world.bed.site.LINE });
    assert.equal(feeding.at, artifact.body.captured_at);
    const entries = await world.bed.hub.hub.knowledge.feeding?.entries(reader.principal, world.productId);
    const stored = entries?.find(row => row.body.schema === 'fed-pitfall@1' && row.body.object === feeding.object);
    assert.equal(stored?.validity, 'valid');
    assert.equal(stored?.claim.qualifier.nature, 'unknown');
    assert.equal(stored?.claim.qualifier.provenance, 'client_captured');
    // Scenario 37 covers a changed quote; operation-records.test.ts covers a model-supplied version.
  });

  test('T6-3 keeps both operation endpoints of a contradiction and qualifies retraction without deleting records', async t => {
    const world = await openOperationWorld(t);
    if (!world) return;
    const target = await commandTarget(world.client, world.root);
    const saved = await capture(world, 'ORBIT synthetic status ready\nORBIT synthetic display empty\n', {
      command: target.command, bed: 'bench-c', device: 'edge-c',
    });
    const baseline = await world.client.call('get_nodes', { root: world.root, paths: [target.path], depth: 0 });
    const observationQuote = quote(saved.event, 1, 'ORBIT synthetic status ready');
    const first = await integrate(world, [{
      capture: saved.event.output.sha256, kind: 'observation', path: target.path,
      statement: '合成状态已读取', action: '执行合成状态读取', quote: { line: 1, text: observationQuote.text },
    }]);
    const observationRecord = first.result.contributions.stored[0].record;
    const observation = await contribution(world, target.path, observationRecord);
    assert.equal(observation.contribution.feeding?.schema, 'fed-observation@1');
    assert.ok(observation.contribution.feeding && 'object' in observation.contribution.feeding);
    const object = observation.contribution.feeding.object;

    const run = await startOperationRun(world, [saved.event]);
    const citation = quote(saved.event, 2, 'ORBIT synthetic display empty');
    const feeding = {
      schema: 'fed-pitfall@1', product: world.productId, root: world.root, path: target.path,
      source: { system: 'upload', bytes: saved.event.output.sha256 },
      phenomenon: '合成显示为空', suggestion: '先核对合成输入',
      quote: citation, relations: [{ kind: 'contradicts', object, quote: citation }],
    };
    const submitted = await world.client.call('submit_result', {
      run: run.run, model: 'integration-synthetic@1',
      items: [{
        item: 'assertion', handling: 'handled', slots: { contribution: [{
          code: 'assertion', text: '合成操作教训与观察矛盾',
          data: { root: world.root, path: target.path, source: { reference: citation.reference, quote: citation.text }, feeding },
        }] },
      }],
    });
    assert.equal(submitted.isError, false, submitted.text);
    assert.equal(submitted.out.acceptance, 'accepted', JSON.stringify(submitted.out.errors));
    assert.equal(submitted.out.result?.contributions?.stored.length, 1);
    const record = submitted.out.result.contributions.stored[0].record;
    const view = await contribution(world, target.path, record);
    const beforeBody = structuredClone(view.contribution);
    const beforeRecord = await world.bed.hub.records.store.get(record);
    assert.ok(beforeRecord);
    assert.ok(beforeBody.feeding && 'relations' in beforeBody.feeding);
    assert.deepEqual(beforeBody.feeding.relations, [{ kind: 'contradicts', object, quote: citation }]);

    const both = await world.client.call('get_nodes', { root: world.root, paths: [target.path], depth: 0 });
    assert.equal(both.isError, false, both.text);
    assert.deepEqual(both.out.nodes?.[0]?.entries, baseline.out.nodes?.[0]?.entries, 'the original tree is not adjudicated or rewritten');
    for (const endpoint of [observationRecord, record]) assert.ok(both.out.nodes?.[0]?.contributions?.some(row => row.record === endpoint));
    assert.match(both.text, /矛盾已标记，两边都留，不裁决/);
    assert.doesNotMatch(both.text, /裁决为/);

    const feedingRecord = beforeBody.feeding_record;
    assert.ok(feedingRecord);
    const layer = world.bed.hub.hub.knowledge.feeding;
    assert.ok(layer);
    await knowledgeRetract(layer, world.bed.hub.admin.principal, {
      entries: [feedingRecord], runs: [], objects: [], reason: '合成管理员撤回教训',
      at: world.bed.hub.hub.knowledge.__context.now().toISOString(),
    });
    const withdrawn = await contribution(world, target.path, record);
    assert.equal(withdrawn.status, 'grounds_withdrawn');
    assert.match(withdrawn.note ?? '', /失效|撤回/);
    assert.deepEqual(withdrawn.contribution, beforeBody, 'withdrawal does not rewrite the immutable contribution');
    assert.deepEqual(await world.bed.hub.records.store.get(record), beforeRecord, 'the stored record and digest are unchanged');
    assert.equal((await contribution(world, target.path, observationRecord)).status, 'valid');
    const qualified = await world.client.call('get_nodes', { reference: `rec:${record}` });
    assert.equal(qualified.isError, false, qualified.text);
    assert.match(qualified.out.content?.note ?? '', /失效|撤回/);
    const after = await world.client.call('get_nodes', { root: world.root, paths: [target.path], depth: 0 });
    assert.deepEqual(after.out.nodes?.[0]?.entries, baseline.out.nodes?.[0]?.entries);
  });
});
