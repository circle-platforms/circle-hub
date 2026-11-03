// Cold process, real temporary PostgreSQL, synthetic documents and a fixed clock.
// R5 adds procedure/pitfall zero counters to the composition; its identity changes in the view.
// credential-scan@3 changes source observation records, their composition, scope-part references and the bound cursor.
// The reviewed four-field difference and predecessor digest are documented in kw-console.md; content stays identical.
// Payload length, entry coverage, query budget and all other assertions stay fixed.
// Process peak RSS moved with GC timing on shared runners, so it is disclosed, not asserted. What the RSS ceiling
// guarded is asserted exactly instead: what the read holds at once at the store and records boundaries it streams through.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { benchmarkView, heldBoundViolations, VIEW_PERF_PARTS } from '../../tools/view-perf.ts';

test('a cold 49000-entry index preserves reviewed bytes, complete truncated counts and bounded queries and holdings', { timeout: 600_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hub-view-perf-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await benchmarkView(directory);
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.sha256, '955e3658a3f9cbf443c4cede60c6b02572305ac68dc30b0df643f98edb9e04e9');
  assert.equal(result.bytes, 15_665_029);
  assert.deepEqual([result.totalEntries, result.totalKeys, result.listed, result.truncated], [49_000, 1800, 30_199, true]);
  assert.deepEqual(result.totals, { entry_counts: { placed: 49_000, total: 49_000, unplaced: 0 } });
  assert.ok(result.queries <= 140, `${result.queries} SQL executions; predecessor used 217`);
  assert.deepEqual(heldBoundViolations(result.held, VIEW_PERF_PARTS), [], JSON.stringify(result.held));
  assert.ok(result.wallMs < 30_000, `${result.wallMs} ms; loose contention allowance, controlled measurements establish the speed ratio`);
});
