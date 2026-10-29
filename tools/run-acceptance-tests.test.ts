import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acceptanceArguments, acceptanceFiles, expectedSeconds, MEASURED_SECONDS } from './run-acceptance-tests.ts';
import { junitArguments } from './test-report.ts';
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

test('a junit report adds its reporters before the files and keeps spec on stdout', () => {
  assert.deepEqual(junitArguments(undefined), []);
  assert.deepEqual(junitArguments(''), []);
  assert.deepEqual(acceptanceArguments(['a.test.ts']), ['--test', '--test-concurrency=1', 'a.test.ts']);
  assert.deepEqual(acceptanceArguments(['a.test.ts'], 'r.xml'), [
    '--test',
    '--test-concurrency=1',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=junit',
    '--test-reporter-destination=r.xml',
    'a.test.ts',
  ]);
});

test('a run with a junit report still prints the spec summary that the CI count reads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'junit-report-'));
  try {
    writeFileSync(join(dir, 'a.test.ts'), "import { test } from 'node:test';\ntest('runs', () => {});\n");
    // A nested `node --test` inherits NODE_TEST_CONTEXT from this runner and would report to it instead of printing.
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
    delete env.NODE_TEST_CONTEXT;
    delete env.FORCE_COLOR;
    const child = spawnSync(process.execPath, acceptanceArguments(['a.test.ts'], 'report.xml'), { cwd: dir, encoding: 'utf8', env });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /^ℹ tests 1$/m);
    assert.match(readFileSync(join(dir, 'report.xml'), 'utf8'), /<testcase name="runs" time="[\d.]+" classname="test" file="[^"]*a\.test\.ts"\/>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
