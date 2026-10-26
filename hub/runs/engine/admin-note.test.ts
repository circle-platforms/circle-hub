// The real reasons behind the engine's answers reach the admin note of the call they belong to (CallContext.adminNote) and
// the process-wide adminLog: a neutral start_run, submit_result and resolve_reference, two calls of one trace at once each
// with its own reason, a note that throws changing nothing, and an expected source that could not be read named in the note
// of the start that bound it. Temporary PostgreSQL; the start that reads its expected sources needs the real sandbox
// (skipped where sandbox-exec is missing, which is not a pass).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { CallContext } from '../../ports.ts';
import type { ActionBody } from '../../records/api.ts';
import { INDEX } from './store.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openHarness, sandboxSkip, traceId, type Harness } from './testing/harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';

const skip = await sandboxSkip();
let postgres: TemporaryPostgres;
let h: Harness;

before(async () => {
  postgres = await startPostgres();
  h = await openHarness(postgres);
});
after(async () => {
  await h?.close();
  await postgres?.stop();
});

/** A call context whose admin notes are collected. */
function noted(trace = traceId()): { context: CallContext; notes: string[] } {
  const notes: string[] = [];
  return { context: { traceId: trace, sessionId: 'sess-note', adminNote: (reason) => notes.push(reason) }, notes };
}

const ABSENT_RUN = 'run_7zzzzzzzzzzzzzzzzzzzzzzzzz';

describe('the admin note of a call', () => {
  test('the reason behind a neutral answer is the call\'s note and an adminLog entry; the caller never sees it', async () => {
    const start = noted();
    const answer = await h.service.startRun(h.bob, { pack: 'toy-review', inputs: {} }, start.context);
    assert.deepEqual(answer.errors.map((e) => [e.code, e.message]), [['SOURCE_UNAVAILABLE', '对你不可用']]);
    assert.deepEqual(start.notes, [`start_run: pack toy-review is unknown, not assigned to ${h.bob.id}, withdrawn or not a workflow pack`]);
    assert.ok(h.logs.some((entry) => entry.traceId === start.context.traceId && entry.what === 'start_run'), 'the adminLog has it too, with the trace');
    assert.ok(!JSON.stringify(answer).includes('not assigned'));

    const submit = noted();
    const submitted = await h.service.submitResult(h.alice, { run: ABSENT_RUN, model: 'm', items: [] }, submit.context);
    assert.equal(submitted.errors[0]?.code, 'SOURCE_UNAVAILABLE');
    assert.deepEqual(submit.notes, [`submit_result: run ${ABSENT_RUN} is unknown or not visible to ${h.alice.id}`]);

    const resolve = noted();
    const resolved = await h.service.resolveReference(h.alice, { run: ABSENT_RUN, text: 'zone set' }, resolve.context);
    assert.equal(resolved.errors[0]?.code, 'SOURCE_UNAVAILABLE');
    assert.deepEqual(resolve.notes, [`resolve_reference: run ${ABSENT_RUN} is unknown or not visible to ${h.alice.id}`]);
  });

  test('two calls of one trace at once: each note gets its own call\'s reason only, whatever the trace says', async () => {
    const trace = traceId();
    const first = noted(trace);
    const second = noted(trace);
    await Promise.all([
      h.service.startRun(h.bob, { pack: 'toy-verify', inputs: {} }, first.context),
      h.service.submitResult(h.bob, { run: ABSENT_RUN, model: 'm', items: [] }, second.context),
    ]);
    assert.equal(first.notes.length, 1);
    assert.match(first.notes[0], /^start_run: pack toy-verify is unknown/);
    assert.equal(second.notes.length, 1);
    assert.match(second.notes[0], /^submit_result: run run_7z+ is unknown/);
  });

  test('a note that throws changes nothing; a call without adminNote is answered the same', async () => {
    const throwing: CallContext = {
      traceId: traceId(),
      sessionId: null,
      adminNote: () => {
        throw new Error('a note store that fails');
      },
    };
    const withThrowing = await h.service.startRun(h.bob, { pack: 'toy-review', inputs: {} }, throwing);
    const without = await h.service.startRun(h.bob, { pack: 'toy-review', inputs: {} }, { traceId: traceId(), sessionId: null });
    assert.deepEqual(withThrowing, without);
  });

  test('an expected source that could not be read is named in the note of the start that bound it', { skip }, async () => {
    // This valid JSON fixture deliberately has 404 in its digest: a hash is not an error message.
    const bytes = Buffer.concat([toyMap(standardDocument()), Buffer.from('\n'.repeat(16))]);
    const map = await h.upload(h.alice, bytes);
    assert.ok(map.includes('404'), 'the regression fixture must exercise a digest containing 404');
    const start = noted();
    const answer = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', inputs: { map: { reference: map } } }, start.context);
    assert.equal(answer.call_result, 'ok', JSON.stringify(answer.errors));
    assert.ok(start.notes.some((note) => note.startsWith('expected source toy:broken:offline: ')), JSON.stringify(start.notes));
    assert.ok(start.notes.every((note) => note.isWellFormed() && [...note].length <= 1000), 'notes are well-formed and short');
    const reason = 'synthetic system answered 404 for toy:broken:offline';
    assert.ok(start.notes.includes(`expected source toy:broken:offline: ${reason}`));
    const actions = await h.kit.store.find<ActionBody>({ key: INDEX.actionRun, value: answer.run!.run, kind: 'action' });
    const parse = actions.items.find(action => action.body.action === 'parse');
    assert.deepEqual(parse?.body.detail.unavailable, [{ external: 'toy:broken:offline', role: 'expected', reason: '对你不可用' }]);
    assert.ok(!JSON.stringify(answer).includes(reason), 'the complete internal reason is not in the answer');
  });
});
