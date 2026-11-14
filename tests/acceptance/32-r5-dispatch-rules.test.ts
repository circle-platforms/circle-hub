// R5 synthetic dispatch rules. Addresses stay in 192.0.2.0/24. No live device, key file, or environment file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DispatchService } from '../../hub/dispatch/service.ts';
import { setup } from '../../hub/dispatch/testing/context.ts';

test('a lost submit receipt stays frozen until an administrator reconciles the original request', async (t) => {
  const c = await setup({ mode: 'disconnect' });
  t.after(() => c.close());
  const frozen = await c.service.dispatch(c.admin, c.run, c.executor.id);
  const original = frozen.dispatch_attempt; assert.ok(original);
  assert.ok(original.scope.operation === 'dispatch');
  assert.equal(original.scope.job, frozen.job);
  assert.equal(original.outcome, 'unknown');
  assert.equal(frozen.job_facts.frozen, true);
  assert.equal(frozen.job_facts.awaiting_disposition, true);
  assert.match(original.next_action ?? original.missing_fact ?? '', /管理员|对账|dispose/);
  assert.equal(c.calls.filter((name) => name === 'send_blob').length, 1);
  const recovered = await c.service.dispose(c.admin, frozen.job, { choice: 'reconcile', remote_id: 'synthetic-remote' });
  assert.equal(recovered.job_facts.frozen, false);
  assert.equal(recovered.job_facts.awaiting_disposition, false);
  const reconciled = await c.service.scopedFacts(c.admin, frozen.job, original.scope.round);
  assert.deepEqual(reconciled.dispatch_attempt?.scope, original.scope);
  assert.equal(reconciled.dispatch_attempt?.outcome, 'effective');
  assert.equal(c.calls.filter((name) => name === 'send_blob').length, 1);
  await assert.rejects(c.service.dispatch(c.admin, c.run, c.executor.id), /已有派发意图|已派发成功/);
});

test('restarting the dispatch service keeps the stored result and continues a late report', async (t) => {
  let ready = false;
  const c = await setup({
    alter: (name, value) => {
      if (name !== 'read_blob') return value;
      const complete = ready;
      return {
        ...value,
        ownership: 'staging_directory',
        complete,
        rows: [{ id: 'synthetic-case', outcome: complete ? 'good' : 'unreported', log: 'CHECK_ONE_PASS\nSYNTHETIC_END', stale: false }],
      };
    },
  });
  t.after(() => c.close());
  const certification = await c.kit.artifacts.ingest({
    bytes: Buffer.from('synthetic ownership certification'),
    mediaType: 'text/plain',
    origin: { upload: { session: 'synthetic' } },
    author: { user: c.admin.id },
    provenanceType: 'declared',
    visibility: { readers: [c.admin.id], admins: true, packs: [], shareable: false },
  });
  await c.registry.update(c.admin, c.executor.id, {
    ...c.executor.definition,
    premises: { result_ownership: { version: '1', evidence: [`src:${certification.body.sha256}`] } },
    result: {
      ...c.executor.definition.result,
      ownership: { pointer: '/ownership', value: 'staging_directory', reason: '/ownership_reason' },
      request_id: '/request',
      log: '/log',
      log_stale: '/stale',
      closing_marker: 'SYNTHETIC_END',
    },
  });
  await c.freezeExecutor();
  const quiet = { ...c.service.options, sleep: async () => {} };
  const first = new DispatchService(quiet);
  const pending = await first.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(pending.job_facts.report_pending, true);
  assert.ok(pending.job_facts.result);
  const stored = Buffer.from((await c.kit.objects.get(pending.job_facts.result.slice(4)))!);
  const restarted = new DispatchService(quiet);
  ready = true;
  const continued = await restarted.resume(c.admin, pending.job);
  assert.deepEqual(Buffer.from((await c.kit.objects.get(pending.job_facts.result.slice(4)))!), stored);
  assert.notEqual(continued.job_facts.result, pending.job_facts.result);
  const source = await c.kit.artifacts.source(c.admin, continued.job_facts.result!.slice(4));
  assert.ok(source?.bytes);
  const report = JSON.parse(Buffer.from(source.bytes).toString()) as { rows: Array<{ dynamic_terminal: string }> };
  assert.equal(report.rows[0]?.dynamic_terminal, 'pass');
  assert.equal(c.calls.filter((name) => name === 'send_blob').length, 1);
});
