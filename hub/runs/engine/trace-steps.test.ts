// The engine's rounds and calls as traces: a maintenance pass and the citation index are background traces of their own,
// a start and a submission show the steps that matter. Runs on the engine harness, so it needs the sandbox.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { installTraceSink, startTrace, type SpanRow } from '../../telemetry/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { sandboxSkip, type Harness } from './testing/harness.ts';
import { openRetryHarness as openHarness } from './testing/retry-harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';

let pg: TemporaryPostgres; let h: Harness; const skip = await sandboxSkip();
before(async () => { pg = await startPostgres(); if (!skip) h = await openHarness(pg); });
after(async () => { await h?.close(); await pg?.stop(); });

const names = (rows: readonly SpanRow[]): Set<string> => new Set(rows.map((row) => row.name));

test('a start shows its steps under one root, and a maintenance pass is a background trace with what it read', { skip }, async (t) => {
  const rows: SpanRow[] = [];
  t.after(installTraceSink({ push: (row) => rows.push(row) }));
  const map = await h.upload(h.alice, toyMap(standardDocument()));
  const started = await startTrace({ name: 'start_run', origin: 'mcp' }, () => h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '10.6.1', build: 'Rel_MEADOW_10_6_1_7', inputs: { map: { reference: map } } }, h.call()));
  assert.ok(started.run);
  const seen = names(rows);
  for (const name of ['start_run', 'check-permission', 'read-source', 'parse-document', 'run-function']) assert.ok(seen.has(name), `${name} among ${[...seen].join(', ')}`);
  const root = rows.find((row) => row.is_root)!;
  assert.ok(rows.every((row) => row.trace_id === root.trace_id));
  assert.ok((root.usage['db.rows'] ?? 0) > 0);
  assert.ok((root.usage['source.reads'] ?? 0) > 0, 'the source was read from the object store');
  assert.ok((root.usage['sandbox.runs'] ?? 0) > 0);

  rows.length = 0;
  const submission = { run: started.run.run, model: 'synthetic-model', items: started.run.items.map((item) => ({ item: item.id, handling: 'handled', slots: { findings: [] } })),
    cross_item: [{ nature: 'judgment', statement: '一般', grounds: [], code: 'draft_level', rank: 'P4' }] };
  const answer = await startTrace({ name: 'submit_result', origin: 'mcp' }, () => h.service.submitResult(h.alice, submission, h.call()));
  assert.equal(answer.acceptance, 'accepted');
  const submitted = names(rows);
  for (const name of ['validate-submission', 'run-check', 'append-record']) assert.ok(submitted.has(name), `${name} among ${[...submitted].join(', ')}`);
  assert.equal(rows.find((row) => row.name === 'run-check')?.type, 'evaluator');
  assert.equal(rows.find((row) => row.name === 'validate-submission')?.type, 'guardrail');

  rows.length = 0;
  await h.service.maintain();
  const pass = rows.find((row) => row.name === 'maintain-runs');
  assert.equal(pass?.origin, 'background');
  assert.equal(pass?.is_root, true);
  assert.ok((pass?.usage['db.rows'] ?? 0) > 0, 'what an idle pass reads is written on it');
  assert.ok((pass?.usage['db.bytes'] ?? 0) > 0);

  rows.length = 0;
  await h.service.startMaintenance();
  await h.service.stopMaintenance();
  assert.ok(names(rows).has('maintain-runs'));
  assert.ok(names(rows).has('index-citations'), 'the citation index is a round of its own');
  assert.equal(rows.find((row) => row.name === 'index-citations')?.origin, 'background');
});
