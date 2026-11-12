// Cold process, real temporary PostgreSQL, synthetic documents and a fixed clock.
// R5 adds procedure/pitfall zero counters to the composition; its identity changes in the view.
// credential-scan@3 changes source observation records, their composition, scope-part references and the bound cursor.
// The reviewed four-field difference and predecessor digest are documented in kw-console.md; content stays identical.
// D05 R[8] names who syncs the product line in the unversioned-root note: 40 more bytes, nothing else changes.
// fed-case-reprojection says on case views that the missing product-wide root does not affect case projections: the
// note gains 69 bytes (；不分版本的根只补它自己的条目，不影响用例投影), nothing else changes.
// Decisions 154 and 161 (issue 194): the sources are stored under the content scan (credential-scan@4), which changes their
// observation records, composition, scope-part references and bound cursor once more; length and content stay identical,
// and main run without the detectors gives these same bytes.
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
  assert.equal(result.sha256, '0f74324bb0a24bd5be0a44e15b136c2c375ff13aa59dc2267d620af9757c701d');
  assert.equal(result.bytes, 15_665_138);
  assert.deepEqual([result.totalEntries, result.totalKeys, result.listed, result.truncated], [49_000, 1800, 30_199, true]);
  assert.deepEqual(result.totals, { entry_counts: { placed: 49_000, total: 49_000, unplaced: 0 } });
  assert.ok(result.queries <= 140, `${result.queries} SQL executions; predecessor used 217`);
  assert.deepEqual(heldBoundViolations(result.held, VIEW_PERF_PARTS), [], JSON.stringify(result.held));
  // No wall-clock bound: the view runs in a child process, whose CPU time this process cannot measure, so its cost is held
  // by counts (the SQL executions above) and its exact output bytes, not by the machine's speed.
});
