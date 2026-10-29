import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptanceFiles, expectedSeconds, MEASURED_SECONDS } from './run-acceptance-tests.ts';
import { parseShard, shardFiles, slices } from './test-shards.ts';

test('every slice count runs every acceptance file exactly once', () => {
  const all = acceptanceFiles();
  assert.ok(all.length > 0);
  for (let total = 1; total <= 8; total++) {
    const parts = Array.from({ length: total }, (_, i) => shardFiles(all, { index: i + 1, total }, expectedSeconds));
    const union = parts.flat();
    assert.equal(union.length, all.length, `${total} slices have no overlap`);
    assert.deepEqual([...union].sort(), all, `${total} slices cover every file`);
    assert.deepEqual(parts, slices(all, total, expectedSeconds), 'the same input gives the same slices');
  }
  assert.deepEqual(shardFiles(all, undefined, expectedSeconds), all, 'without a shard the whole suite runs');
});

test('the four CI slices each run tests and stay within a fifth of each other', () => {
  const all = acceptanceFiles();
  const loads = slices(all, 4, expectedSeconds).map((slice) => {
    assert.ok(slice.some((file) => expectedSeconds(file) > 0), 'each slice has a file that runs on Ubuntu, so its summary counts tests');
    return slice.reduce((sum, file) => sum + expectedSeconds(file), 0);
  });
  assert.ok(Math.max(...loads) <= Math.min(...loads) * 1.2, `balanced slices: ${loads.join(', ')}`);
});

test('measured durations name existing acceptance files', () => {
  const all = new Set(acceptanceFiles());
  for (const file of Object.keys(MEASURED_SECONDS)) assert.ok(all.has(file), file);
});

test('a shard is <index>/<total> with the index inside the total', () => {
  assert.equal(parseShard(undefined), undefined);
  assert.equal(parseShard(''), undefined);
  assert.deepEqual(parseShard('2/4'), { index: 2, total: 4 });
  for (const bad of ['0/4', '5/4', '1/0', '2', '1/4/2', ' 1/4', 'a/b']) assert.throws(() => parseShard(bad), /分片/, bad);
});
