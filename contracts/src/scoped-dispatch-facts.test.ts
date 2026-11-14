import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  DispatchAttemptScopeSchema, DispatchAttemptFactsSchema, DispatchJobFactsSchema, ScopedDispatchFactsSchema,
  DispatchOutcomeFactsSchema, SCHEMA_REGISTRY,
} from '../api.ts';

const job = 'a'.repeat(64), result = `src:${'b'.repeat(64)}`, receipt = `rec:${'c'.repeat(64)}`;

test('an attempt scope requires the real job and positive round without synthesizing identity', () => {
  const value = { job, round: 2, request_id: 'synthetic-round-two' };
  assert.deepEqual(DispatchAttemptScopeSchema.parse(value), value);
  for (const bad of [{ job }, { round: 2 }, { job, round: 0 }, { job, round: 1.5 }, { job, round: -1 }, { job: 'job_name', round: 2 }]) assert.equal(DispatchAttemptScopeSchema.safeParse(bad).success, false);
  assert.equal(DispatchAttemptFactsSchema.safeParse({ outcome: 'not_dispatched' }).success, false);
  assert.deepEqual(DispatchAttemptFactsSchema.parse({ scope: { job, round: 2 } }), { scope: { job, round: 2 } });
});

test('program invocation and locally not sent can both be true in exactly the same attempt', () => {
  const value = { scope: { job, round: 2, request_id: 'synthetic-second-request' }, outcome: 'not_dispatched', not_sent: true, submit_invoked: true };
  assert.deepEqual(DispatchAttemptFactsSchema.parse(value), value);
  assert.equal(DispatchAttemptFactsSchema.safeParse({ scope: value.scope, not_sent: false }).success, false);
  assert.equal(DispatchAttemptFactsSchema.parse({ scope: value.scope }).submit_invoked, undefined, 'old complete.false is not defaulted or converted');
  assert.equal(DispatchAttemptFactsSchema.safeParse({ job, outcome: 'not_dispatched', submit_invoked: false }).success, false, 'old flat summaries are not an input alias');
});

test('job facts cannot carry an effect outcome, request/round scope or invocation aggregate', () => {
  const value = { scope: { job }, phase: 'complete', reservation_recorded: true, worker_settled: true, frozen: false, result, grounds: [receipt] };
  assert.deepEqual(DispatchJobFactsSchema.parse(value), value);
  for (const field of ['outcome', 'not_sent', 'submit_invoked', 'anyInvoke', 'any_submit_invoked', 'effect_outcome']) assert.equal(DispatchJobFactsSchema.safeParse({ ...value, [field]: true }).success, false, field);
  assert.equal(DispatchJobFactsSchema.safeParse({ scope: { job, round: 2 } }).success, false);
  assert.equal(DispatchJobFactsSchema.safeParse({ scope: { job, request_id: 'latest-is-not-job-scope' } }).success, false);
});

test('job result and the second attempt failure remain separate without inventing a job-wide effect', () => {
  const value = { job_facts: { scope: { job }, phase: 'complete', result, grounds: [receipt] }, dispatch_attempt: { scope: { job, round: 2 }, outcome: 'not_dispatched', not_sent: true, submit_invoked: true } };
  const parsed = ScopedDispatchFactsSchema.parse(value);
  assert.deepEqual(parsed, value);
  assert.equal(parsed.dispatch_attempt?.result, undefined);
  assert.equal('outcome' in parsed.job_facts, false);
  assert.equal(ScopedDispatchFactsSchema.safeParse({ dispatch_attempt: value.dispatch_attempt }).success, false);
});

test('readonly operations have no synthetic round and absent observations stay absent', () => {
  for (const operation of ['precheck', 'conformance'] as const) {
    const raw = { job_facts: { scope: { job }, operation, phase: 'complete' } };
    const parsed = ScopedDispatchFactsSchema.parse(raw);
    assert.equal(parsed.dispatch_attempt, undefined);
    assert.equal(parsed.job_facts.worker_settled, undefined);
    assert.equal(parsed.job_facts.frozen, undefined);
    assert.deepEqual(parsed, raw);
  }
  assert.equal(DispatchAttemptFactsSchema.safeParse({ scope: { job, round: 2 }, operation: 'precheck' }).success, false, 'operation belongs to the job group');
});

test('authorized reference shapes are validated without claiming source identity or visibility proof', () => {
  assert.equal(DispatchAttemptFactsSchema.safeParse({ scope: { job, round: 2 }, result: 'b'.repeat(64) }).success, false);
  assert.equal(DispatchJobFactsSchema.safeParse({ scope: { job }, grounds: ['c'.repeat(64)] }).success, false);
  assert.deepEqual(DispatchAttemptFactsSchema.parse({ scope: { job, round: 2 }, result, device_return: result, grounds: [receipt] }).grounds, [receipt]);
});

test('four additive declarations and public JSON schemas derive from the registered model', () => {
  const model = JSON.parse(readFileSync(new URL('../model.json', import.meta.url), 'utf8'));
  assert.ok(model.version >= 86);
  const entries = model.formatProposals.sharedInterfaces.definitions.filter((row: { name: string }) => ['DispatchAttemptScope', 'DispatchAttemptFacts', 'DispatchJobFacts', 'ScopedDispatchFacts'].includes(row.name));
  assert.equal(entries.length, 4);
  assert.equal(SCHEMA_REGISTRY['scoped-dispatch-facts@1'], ScopedDispatchFactsSchema);
  const json = JSON.parse(readFileSync(new URL('../generated/schemas/scoped-dispatch-facts.v1.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(json.required, ['job_facts']);
  assert.deepEqual(json.properties.dispatch_attempt.properties.scope.required, ['job', 'round']);
  assert.equal(json.properties.dispatch_attempt.properties.not_sent.const, true);
  assert.equal(json.properties.dispatch_attempt.properties.result.description, "Authorized result reference for this attempt's job and round; never an aggregate job outcome.");
  assert.equal('outcome' in json.properties.job_facts.properties, false);
  assert.equal(DispatchOutcomeFactsSchema.safeParse({ operation: 'precheck', phase: 'complete', outcome: 'not_dispatched' }).success, true, 'version-85 carrier stays available and unchanged');
});
