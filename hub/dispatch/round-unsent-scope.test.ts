import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { setup } from './testing/context.ts';

test('characterize the old job-wide no-send summary after an accepted first round and a zero-write second submit', { timeout: 60000 }, async t => {
  const c = await setup({ alter: (name, value) => name === 'read_blob'
    ? { ...value, ownership: 'staging_directory', ownership_reason: null, rows: [{ id: 'synthetic-case', outcome: 'good', log: 'SYNTHETIC_END' }] }
    : value });
  t.after(() => c.close());
  // Use the same declared repeat policy and certified ownership as the normal multi-round fixture.
  (c.effectDocument.effects[0] as { repetition?: number }).repetition = 2;
  c.detail.run.requirements = [{
    key: 'workbook_verified', name: '合成核验', description: '合成', layers: ['dynamic'], done_rule: 'gating', accepted_producer: 'fact',
    repair_rounds: 0, rules: [], run_interpreters: [],
    repetition: { count: 2, aggregation: 'all', basis: 'explicit', declared: { count: true, aggregation: true, k: false } },
  }] as typeof c.detail.run.requirements;
  const proof = await c.kit.artifacts.ingest({ bytes: new TextEncoder().encode('synthetic attribution certification'), mediaType: 'text/plain', origin: { upload: { session: 'synthetic' } }, author: { user: c.admin.id }, provenanceType: 'declared', visibility: { readers: [c.admin.id], admins: true, packs: [], shareable: false } });
  await c.registry.update(c.admin, c.executor.id, {
    ...c.executor.definition,
    premises: { result_ownership: { version: '1', evidence: [`src:${proof.body.sha256}`] } },
    result: { ...c.executor.definition.result, ownership: { pointer: '/ownership', value: 'staging_directory', reason: '/ownership_reason' }, request_id: '/request', log: '/log', closing_marker: 'SYNTHETIC_END' },
  });
  await c.freezeExecutor();
  let interrupted = false;
  const request = http.request;
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  c.service.options.beforeRound = async round => {
    assert.equal(round, 2);
    assert.equal(c.calls.filter(name => name === 'send_blob').length, 1);
    // Fault seam: abort the next native HTTP request before any socket is allocated.
    // RpcClient still performs classification and persists its actual response/write count.
    // Do not forge SubmissionNotSentError, response events, or the final completion.
    t.mock.method(http, 'request', (url: URL, options: http.RequestOptions, listener: (response: http.IncomingMessage) => void) => {
      interrupted = true;
      t.mock.restoreAll();
      syncBuiltinESMExports();
      return request(url, { ...options, signal: AbortSignal.abort() }, listener);
    });
    syncBuiltinESMExports();
  };
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(interrupted, true);
  assert.equal(c.calls.filter(name => name === 'send_blob').length, 1);
  const events = await c.service.journal.events(state.job);
  const intents = events.filter(event => event.body.detail.phase === 'intent');
  assert.deepEqual(intents.map(event => event.body.detail.round), [1, 2]);
  const receipts = events.filter(event => event.body.detail.phase === 'receipt');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].body.detail.acceptance, 'accepted');
  assert.equal(receipts[0].body.detail.remote_id, 'synthetic-remote');
  const firstRound = events.find(event => event.body.detail.phase === 'round' && event.body.detail.round === 1);
  assert.equal(firstRound?.body.detail.terminal, 'pass');
  const secondIntentIndex = events.indexOf(intents[1]);
  assert.ok(events.indexOf(receipts[0]) < secondIntentIndex);
  const zeroWrite = events.slice(secondIntentIndex + 1).find(event => event.body.detail.phase === 'submit.response');
  assert.ok(zeroWrite, 'the real transport must persist its failed second submit response');
  assert.equal(zeroWrite.body.detail.complete, false);
  assert.equal(zeroWrite.body.detail.http_status, 0);
  assert.equal(zeroWrite.body.detail.request_bytes_written, 0);
  const complete = events.filter(event => event.body.detail.phase === 'complete').at(-1);
  assert.ok(complete);
  assert.ok(events.indexOf(complete) > events.indexOf(zeroWrite));
  assert.equal(complete.body.detail.submit_invoked, false);
  assert.equal(complete.body.detail.outcome, 'not_dispatched');
  assert.ok(complete.body.inputs.includes(`rec:${intents[1].digest}`), 'the no-send evidence refers to the second intent');
  // Deliberately characterize the existing defect, rather than changing production to hide it.
  assert.equal(state.outcome, 'not_dispatched');
  assert.equal(state.not_sent, true);
  assert.equal(Object.hasOwn(state, 'round'), false);
  assert.equal(Object.hasOwn(complete.body.detail, 'round'), false);
  t.diagnostic(JSON.stringify({ baseline: 'd44fadfb72', gateway_submits: 1, intent_rounds: [1, 2], accepted_receipts: receipts.length, first_round: firstRound?.body.detail.terminal, second_submit_bytes: zeroWrite.body.detail.request_bytes_written, outcome: state.outcome, not_sent: state.not_sent, summary_round_present: Object.hasOwn(state, 'round') }));
});
