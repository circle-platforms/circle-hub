import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openHarness, sandboxSkip, type HarnessOptions } from './testing/harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';

let postgres: TemporaryPostgres;
const skip = await sandboxSkip();

before(async () => {
  postgres = await startPostgres();
});
after(async () => {
  await postgres?.stop();
});

/** A pattern that backtracks exponentially on `aaaa…!` in a native regular expression. */
const EXPLOSIVE = '^(a+)+$';

async function startWith(options: HarnessOptions, parameters?: Record<string, unknown>) {
  const h = await openHarness(postgres, options);
  try {
    const map = await h.upload(h.alice, toyMap(standardDocument()));
    const reads = h.external.reads.length;
    const began = Date.now();
    const answer = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } }, ...(parameters ? { parameters } : {}) }, h.call());
    return { answer, ms: Date.now() - began, read: h.external.reads.length - reads, runs: (await h.service.listRuns(h.alice)).items.length, logs: h.logs };
  } finally {
    await h.close();
  }
}

test('a slot data schema with a regular expression is refused at start_run: the Hub never runs it on model input', { skip }, async () => {
  const { answer, ms, read, runs, logs } = await startWith({ review: { findingsData: { type: 'object', properties: { suggestion: { type: 'string', pattern: EXPLOSIVE } } } } });
  assert.deepEqual(answer.errors.map((e) => [e.code, e.path]), [['SUBMISSION_SCHEMA_VIOLATION', '/pack']]);
  assert.match(answer.errors[0].message, /slots\.schema\.json \/item\/findings\/data.*pattern/);
  assert.deepEqual([read, runs], [0, 0], 'nothing read, no run');
  assert.ok(ms < 5000, `refused without matching anything (${ms} ms)`);
  assert.ok(logs.some((l) => l.what === 'start_run' && /cannot enforce/.test(l.detail)));
});

test('a schema the Hub cannot read fails closed: refused, never an unchecked value', { skip }, async () => {
  const { answer } = await startWith({ review: { findingsData: { type: 'object', properties: { suggestion: { type: 'string' } }, unevaluatedProperties: false } } });
  assert.deepEqual(answer.errors.map((e) => [e.code, e.path]), [['SUBMISSION_SCHEMA_VIOLATION', '/pack']]);
  assert.match(answer.errors[0].message, /读不懂/);
});

test('a parameter schema with a regular expression is refused the same way; a property named pattern is only a name', { skip }, async () => {
  const refused = await startWith({ review: { parameterSchema: { type: 'string', pattern: EXPLOSIVE } } }, { strict: `${'a'.repeat(40)}!` });
  assert.deepEqual(refused.answer.errors.map((e) => [e.code, e.path]), [['SUBMISSION_SCHEMA_VIOLATION', '/pack']]);
  assert.match(refused.answer.errors[0].message, /workflow\.json \/parameters\/0\/schema（参数 strict）/);
  assert.ok(refused.ms < 5000, `${refused.ms} ms`);
  const named = await startWith({ review: { findingsData: { type: 'object', properties: { pattern: { type: 'string' } }, additionalProperties: false } } });
  assert.equal(named.answer.call_result, 'ok', JSON.stringify(named.answer.errors));
});
