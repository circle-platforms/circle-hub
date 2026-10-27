import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { ActionBody } from '../../records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { INDEX } from './store.ts';
import { sandboxSkip } from './testing/harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
import { openRetryHarness } from './testing/retry-harness.ts';

let postgres: TemporaryPostgres;
const skip = await sandboxSkip();
before(async () => { postgres = await startPostgres(); });
after(async () => { await postgres?.stop(); });

for (const mode of ['recover', 'exhaust', 'absence']) test(`exact source ${mode}: Hub faults never charge model repair or freeze a retry`, { skip }, async () => {
  const h = await openRetryHarness(postgres);
  try {
    const document = standardDocument(); document.groups = [{ ...document.groups[0], cases: [document.groups[0].cases[0]] }];
    const source = await h.upload(h.alice, toyMap(document));
    const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '10.6.1', build: 'Rel_MEADOW_10_6_1_7', inputs: { map: { reference: source } } }, h.call());
    assert.ok(started.run, JSON.stringify(started.errors)); const run = started.run; const item = run.items[0];
    const original = h.kit.artifacts.source.bind(h.kit.artifacts); let reads = 0; let broken = true;
    h.kit.artifacts.source = async (reader, digest, options) => {
      if (digest === source.slice(4)) {
        reads++;
        if (broken && mode === 'absence') return null;
        if (broken && (mode === 'exhaust' || reads < 3)) throw new Error('SyntheticPrivateReadFailure');
      }
      return original(reader, digest, options);
    };
    const submission = { run: run.run, model: 'synthetic-model', items: [{ item: item.id, handling: 'handled', slots: { findings: [{
      text: '合成核对', code: 'edge_case_gap', rank: 'major', location: item.location,
      quotes: [{ reference: item.location, text: mode === 'exhaust' ? '合成不逐字引用' : item.label }],
    }] } }], cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }] };
    const answer = await h.service.submitResult(h.alice, submission, h.call());
    const actions = async () => (await h.kit.store.find<ActionBody>({ key: INDEX.actionRun, value: run.run, kind: 'action' })).items.filter(record => record.body.action === 'validate');
    assert.ok(!JSON.stringify(answer).includes('SyntheticPrivateReadFailure'));
    if (mode === 'absence') {
      assert.equal(answer.acceptance, 'not_accepted'); assert.equal(answer.errors[0].code, 'REFERENCE_UNRESOLVED');
      assert.ok(reads >= 4, 'prefetch and later resolves each recheck current authorization; a previous absence is not an authorization cache'); assert.ok(!(await actions())[0].body.detail.hub_error); return;
    }
    if (mode === 'recover') assert.ok(reads > 3, 'after bounded recovery every later resolution rechecks current authorization');
    else assert.equal(reads, 3, 'a failed prefetch retries only three times before reporting an unfinished Hub check');
    if (mode === 'recover') {
      assert.equal(answer.acceptance, 'accepted'); assert.equal(answer.result?.rounds.used, 0);
      const attempts = ((await actions())[0].body.detail.retry_attempts as Array<Record<string, unknown>>).filter(attempt => attempt.operation === 'read');
      assert.deepEqual(attempts.map(attempt => attempt.attempt), [1, 2, 3]); return;
    }
    assert.ok(h.logs.some(entry => entry.detail.includes('SOURCE_RETRYABLE')));
    assert.ok(h.logs.every(entry => !entry.detail.includes('SyntheticPrivateReadFailure')), 'admin diagnostics do not contain untrusted source error text');
    assert.equal(answer.acceptance, 'not_accepted'); assert.equal(answer.result, undefined);
    assert.deepEqual(answer.errors.map(error => error.code), ['SOURCE_UNAVAILABLE']);
    assert.ok(answer.errors.every(error => error.rounds_left === undefined && error.requirement === undefined));
    assert.match(answer.errors[0].fix ?? '', /管理员.*恢复/);
    let saved = await actions(); assert.equal(saved.length, 1);
    assert.equal(saved[0].body.result, 'error'); assert.equal(saved[0].body.error_code, 'check_error');
    assert.equal(saved[0].body.acceptance, null);
    assert.match(String(saved[0].body.detail.fix), /管理员.*恢复.*原样重交/);
    assert.match(answer.errors[0].message, /Hub.*未完成/);
    const view = (await h.service.getRun(h.alice, run.run))!.submissions[0];
    assert.equal(view.acceptance, null); assert.equal(view.errors[0].message,'未校验（中断）');
    assert.match(view.errors[0].fix ?? '', /管理员.*恢复.*原样重交/);
    assert.equal(saved[0].body.detail.hub_error, true); assert.deepEqual(saved[0].body.detail.repair, []);
    assert.equal((await h.kit.store.find({ key: INDEX.resultRun, value: run.run, kind: 'validation_result' })).items.length, 0);
    const again = await h.service.submitResult(h.alice, submission, h.call());
    assert.equal(again.errors[0].code, 'SOURCE_UNAVAILABLE'); assert.equal(reads, 6);
    assert.equal((await h.kit.store.find({ key: INDEX.submissionRun, value: run.run, kind: 'submission' })).items.length, 1);
    broken = false;
    const modelError = await h.service.submitResult(h.alice, submission, h.call());
    assert.equal(modelError.acceptance, 'not_accepted'); assert.equal(modelError.errors[0].code, 'QUOTE_MISMATCH');
    assert.equal(modelError.result?.rounds.used, 0);
    const repaired = structuredClone(submission); repaired.items[0].slots.findings[0].quotes[0].text = item.label;
    const accepted = await h.service.submitResult(h.alice, repaired, h.call());
    assert.equal(accepted.acceptance, 'accepted'); assert.equal(accepted.result?.rounds.used, 1);
    saved = await actions(); const count = saved.length; const readCount = reads;
    assert.deepEqual(await h.service.submitResult(h.alice, repaired, h.call()), accepted);
    assert.equal((await actions()).length, count); assert.equal(reads, readCount);
  } finally { await h.close(); }
});
