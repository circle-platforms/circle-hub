// Cold process, real temporary PostgreSQL, generated synthetic source documents. The frozen hash is the predecessor's output.
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
  assert.equal(result.sha256, '40a072e1766819c451b2c8c1031cbc3d025bc2cb213e39d83a52518629953ef2');
  assert.equal(result.bytes, 15_658_488);
  assert.deepEqual([result.totalEntries, result.totalKeys, result.listed, result.truncated], [49_000, 1800, 30_189, true]);
  assert.deepEqual(result.totals, {}, 'IndexView.totals contains optional product-wide counts; build counts remain at the top level when truncated');
  assert.ok(result.queries <= 140, `${result.queries} SQL executions; predecessor used 217`);
  assert.ok(result.maxRSSKiB <= VIEW_PERF_RSS_LIMIT_KIB, `${result.maxRSSKiB} KiB RSS; accepted 494448 KiB plus 15% = ${VIEW_PERF_RSS_LIMIT_KIB} KiB`);
  assert.ok(result.wallMs < 30_000, `${result.wallMs} ms; loose contention allowance, controlled measurements establish the speed ratio`);
});
