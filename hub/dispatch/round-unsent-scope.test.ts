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
  t.mock.method(c.service, 'status', () => { throw new Error('the scoped reader must not call the legacy summary'); });
  const beforeRead = events.map(event => event.digest);
  const scoped = await c.service.scopedFacts(c.admin, state.job);
  assert.deepEqual(scoped.job_facts.scope, { job: state.job });
  assert.equal(scoped.job_facts.reservation_recorded, true);
  assert.equal(Object.hasOwn(scoped.job_facts, 'outcome'), false);
  assert.equal(Object.hasOwn(scoped.job_facts, 'not_sent'), false);
  assert.equal(Object.hasOwn(scoped.job_facts, 'submit_invoked'), false);
  assert.equal(Object.hasOwn(scoped.job_facts, 'worker_settled'), false, 'journal history does not observe this process worker settlement');
  assert.deepEqual(scoped.dispatch_attempt?.scope, { job: state.job, round: 2, request_id: intents[1].body.detail.request_id });
  assert.equal(scoped.dispatch_attempt?.outcome, 'not_dispatched');
  assert.equal(scoped.dispatch_attempt?.not_sent, true);
  assert.equal(scoped.dispatch_attempt?.submit_invoked, true, 'the program called submit even though the transport wrote zero bytes');
  assert.ok(scoped.dispatch_attempt?.grounds?.includes(`rec:${intents[1].digest}`));
  assert.ok(scoped.dispatch_attempt?.grounds?.includes(`rec:${zeroWrite.digest}`));
  assert.ok(scoped.dispatch_attempt?.grounds?.includes(`rec:${complete.digest}`));
  assert.ok(!scoped.dispatch_attempt?.grounds?.includes(`rec:${receipts[0].digest}`));
  const firstScope = await c.service.scopedFacts(c.admin, state.job, 1);
  assert.deepEqual(firstScope.dispatch_attempt?.scope, { job: state.job, round: 1, request_id: intents[0].body.detail.request_id });
  assert.equal(firstScope.dispatch_attempt?.outcome, 'issued', 'a receipt proves acceptance, not additional physical effects');
  assert.equal(firstScope.dispatch_attempt?.not_sent, undefined, 'the second-round complete cannot become a first-round no-send fact');
  assert.equal(firstScope.dispatch_attempt?.submit_invoked, true);
  assert.ok(firstScope.dispatch_attempt?.grounds?.includes(`rec:${receipts[0].digest}`));
  assert.ok(!firstScope.dispatch_attempt?.grounds?.includes(`rec:${complete.digest}`));
  const absentScope = await c.service.scopedFacts(c.admin, state.job, 3);
  assert.equal(absentScope.dispatch_attempt, undefined, 'a requested but unobserved round is not manufactured');
  await assert.rejects(c.service.scopedFacts(c.owner, state.job));
  assert.deepEqual((await c.service.journal.events(state.job)).map(event => event.digest), beforeRead, 'the scoped reader never rewrites or adds events');
  assert.equal(c.calls.filter(name => name === 'send_blob').length, 1, 'the scoped reader never makes an RPC');
  assert.equal((await c.service.journal.events(state.job)).find(event => event.digest === receipts[0].digest)?.body.detail.acceptance, 'accepted');
  assert.equal((await c.service.journal.events(state.job)).find(event => event.digest === firstRound?.digest)?.body.detail.terminal, 'pass');
  t.diagnostic(JSON.stringify({ baseline: 'd44fadfb72', gateway_submits: 1, intent_rounds: [1, 2], accepted_receipts: receipts.length, first_round: firstRound?.body.detail.terminal, second_submit_bytes: zeroWrite.body.detail.request_bytes_written, outcome: state.outcome, not_sent: state.not_sent, summary_round_present: Object.hasOwn(state, 'round') }));
});


test('new single-round intents provide explicit scope while precheck has no invented attempt', { timeout: 60000 }, async t => {
  const c = await setup();
  t.after(() => c.close());
  const precheck = await c.service.precheck(c.admin, c.executor.id);
  const readOnly = await c.service.scopedFacts(c.admin, precheck.job);
  assert.equal(readOnly.dispatch_attempt, undefined);
  assert.equal(readOnly.job_facts.missing_facts, undefined, 'precheck without an intent has no missing dispatch round');
  assert.equal(readOnly.job_facts.next_action, undefined);
  const precheckBinding = await c.service.journal.binding(precheck.job);
  assert.equal(Reflect.get(precheckBinding, 'operation'), 'precheck');
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  const events = await c.service.journal.events(state.job);
  const intent = events.find(event => event.body.detail.phase === 'intent');
  assert.ok(intent);
  assert.equal(intent.body.detail.round, 1, 'the writer knows the program round; the reader does not guess');
  assert.equal(Reflect.get(await c.service.journal.binding(state.job), 'operation'), 'dispatch');
  const scoped = await c.service.scopedFacts(c.admin, state.job);
  assert.deepEqual(scoped.dispatch_attempt?.scope, { job: state.job, round: 1, request_id: intent.body.detail.request_id });
});


test('a real single-round flow without the new intent metadata stays unscoped when read', { timeout: 60000 }, async t => {
  const c = await setup();
  t.after(() => c.close());
  const append = c.service.journal.append.bind(c.service.journal);
  // Historical-writer fixture: omit only the newly added round metadata before the
  // real journal persists the intent. All responses, receipts and completions are
  // still produced by the real service and gateway, never fabricated or rewritten.
  t.mock.method(c.service.journal, 'append', (...args: Parameters<typeof append>) => {
    const [binding, phase, action, result, detail = {}, ...rest] = args;
    if (phase === 'intent') {
      const { round: _newMetadata, ...historicalDetail } = detail;
      return append(binding, phase, action, result, historicalDetail, ...rest);
    }
    return append(...args);
  });
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  const events = await c.service.journal.events(state.job);
  const intent = events.find(event => event.body.detail.phase === 'intent');
  assert.ok(intent);
  assert.equal(Object.hasOwn(intent.body.detail, 'round'), false);
  assert.ok(events.some(event => event.body.detail.phase === 'receipt' && event.body.detail.acceptance === 'accepted'));
  assert.equal(c.calls.filter(name => name === 'send_blob').length, 1);
  const scoped = await c.service.scopedFacts(c.admin, state.job);
  assert.equal(scoped.dispatch_attempt, undefined);
  assert.deepEqual(scoped.job_facts.scope, { job: state.job });
  assert.equal(scoped.job_facts.reservation_recorded, true);
  assert.deepEqual(scoped.job_facts.missing_facts, [{
    fact: '原派发意图缺少可核对的轮次范围，当前不能确定它属于哪一轮',
    next_action: '只读核对该原意图记录，保留范围未知；不要为了补齐轮次而重新派发',
  }]);
  assert.ok(scoped.job_facts.missing_facts);
  assert.equal(scoped.job_facts.next_action, scoped.job_facts.missing_facts[0].next_action);
  assert.ok(scoped.job_facts.grounds?.includes(`rec:${intent.digest}`));
  assert.equal((await c.service.scopedFacts(c.admin, state.job, 1)).dispatch_attempt, undefined);
  assert.deepEqual((await c.service.journal.events(state.job)).map(event => event.digest), events.map(event => event.digest));
});
