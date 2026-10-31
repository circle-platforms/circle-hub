// Cold process, real temporary PostgreSQL, synthetic documents and a fixed clock.
// R5 adds procedure/pitfall zero counters to the composition; its identity changes in the view.
// D05 R[8] names who syncs the product line in the unversioned-root note: 40 more bytes, nothing else changes.
// Payload length, entry coverage, query/RSS budgets and all other assertions stay fixed.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { benchmarkView, VIEW_PERF_RSS_LIMIT_KIB } from '../../tools/view-perf.ts';

test('a cold 49000-entry index preserves predecessor bytes, complete truncated counts and bounded queries/RSS', { timeout: 600_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hub-view-perf-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await benchmarkView(directory);
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.sha256, '7c9c0a04ea8e13d6c76bd41bfc03d680e18e22b9bca4d497f7ddcb3f26aaa69d');
  assert.equal(result.bytes, 15_665_069);
  assert.deepEqual([result.totalEntries, result.totalKeys, result.listed, result.truncated], [49_000, 1800, 30_199, true]);
  assert.deepEqual(result.totals, { entry_counts: { placed: 49_000, total: 49_000, unplaced: 0 } });
  assert.ok(result.queries <= 140, `${result.queries} SQL executions; predecessor used 217`);
  assert.ok(result.maxRSSKiB <= VIEW_PERF_RSS_LIMIT_KIB, `${result.maxRSSKiB} KiB RSS; accepted 494448 KiB plus 15% = ${VIEW_PERF_RSS_LIMIT_KIB} KiB`);
  assert.ok(result.wallMs < 30_000, `${result.wallMs} ms; loose contention allowance, controlled measurements establish the speed ratio`);
});
