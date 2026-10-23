import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { after, before, test } from 'node:test';
import type { ActionBody } from '../../records/api.ts';
import { SandboxError } from '../../rules/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { reviewPack, writePack } from './testing/packs.ts';
import { INDEX } from './store.ts';
import { sandboxSkip } from './testing/harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
import { openRetryHarness } from './testing/retry-harness.ts';

let postgres: TemporaryPostgres;
const skip = await sandboxSkip();
before(async () => { postgres = await startPostgres(); });
after(async () => { await postgres?.stop(); });

for (const operation of ['check', 'subject']) test(`recovered ${operation} attempts are stored once and replay remains idempotent`, { skip }, async () => {
  const h = await openRetryHarness(postgres);
  const spawn = childProcess.spawn; let failures = 0;
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-retry-pack-'));
  try {
    if (operation === 'subject') {
      const spec = reviewPack(); spec.version = '1.0.1';
      spec.files['functions/retry-subject.ts'] = 'export default input => ({ items: input.items });';
      spec.files['checks.json'] = { json: { schema: 'checks@1', checks: h.review.checks.map(check => check.id === 'structure'
        ? { ...check, subject: { module: 'functions/retry-subject.ts' } } : check) } };
      await h.workflows.add(await writePack(root, spec));
    }
    const document = standardDocument(); document.groups = [{ ...document.groups[0], cases: [document.groups[0].cases[0]] }];
    const source = await h.upload(h.alice, toyMap(document));
    const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '10.6.1', build: 'Rel_MEADOW_10_6_1_7', inputs: { map: { reference: source } } }, h.call());
    assert.ok(started.run, JSON.stringify(started.errors)); const run = started.run;
    childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
      if (args[1]?.some(arg => String(arg).endsWith('/bootstrap.ts')) && failures++ === 0) throw new SandboxError('SANDBOX_TIMEOUT', { limit: 'time' });
      return spawn(...args);
    }) as typeof spawn;
    syncBuiltinESMExports();
    const submission = { run: run.run, model: 'synthetic-model', items: run.items.map(item => ({ item: item.id, handling: 'handled', slots: { findings: [] } })),
      cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }] };
    const answer = await h.service.submitResult(h.alice, submission, h.call());
    assert.equal(answer.acceptance, 'accepted');
    const actions = async () => (await h.kit.store.find<ActionBody>({ key: INDEX.actionRun, value: run.run, kind: 'action' })).items.filter(record => record.body.action === 'validate');
    const saved = await actions(); assert.equal(saved.length, 1);
    const attempts = saved[0].body.detail.retry_attempts as Array<Record<string, unknown>>;
    assert.equal(attempts.length, 2); assert.deepEqual(attempts.map(attempt => attempt.attempt), [1, 2]);
    assert.equal(attempts[0].reason, 'timeout');
    assert.ok(attempts.every(attempt => attempt.code === undefined && attempt.component === run.pack)); assert.equal(attempts[0].delayMs, 50);
    assert.ok(attempts.every(attempt => attempt.operation === 'validate'));
    const before = failures;
    assert.deepEqual(await h.service.submitResult(h.alice, submission, h.call()), answer);
    assert.equal(failures, before); assert.equal((await actions()).length, 1);
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); await h.close(); await rm(root, { recursive: true, force: true }); }
});
