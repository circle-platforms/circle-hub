import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptanceFiles } from './run-acceptance-tests.ts';
import { macosArguments, macosFiles, macosTestFiles, needsMacos } from './run-macos-tests.ts';
import { unitFiles } from './run-unit-tests.ts';

test('the macOS run selects the guarded unit and acceptance files from the sources', () => {
  const { unit, acceptance } = macosTestFiles();
  const all = new Set(unitFiles('all'));
  for (const file of unit) assert.ok(all.has(file), `${file} is a unit file`);
  assert.deepEqual(acceptance.filter((file) => !acceptanceFiles().includes(file)), []);
  for (const file of [
    'hub/platform/keychain.test.ts',
    'hub/platform/launchd.test.ts',
    'hub/platform/backup-live.test.ts',
    'hub/server/assemble/operator-token.test.ts',
    'hub/rules/sandbox/sandbox.test.ts',
    'packs/product/famx/functions/sandbox.test.ts',
  ]) {
    assert.ok(unit.includes(file), file);
  }
  // 42, 43 and 44 skip through tests/acceptance/support/operation-acceptance.ts, not by a guard of their own.
  for (const file of ['tests/acceptance/28-device-run.test.ts', 'tests/acceptance/42-r5-t4-2-operations.test.ts', 'tests/acceptance/44-r5-t5-1-webui.test.ts']) {
    assert.ok(acceptance.includes(file), file);
  }
  assert.ok(!unit.includes('tools/run-unit-tests.test.ts'), 'a file without a guard stays on Ubuntu only');
});

test('a helper counts only when it skips by itself', () => {
  const sources: Record<string, string> = {
    'tests/acceptance/support/skips.ts': "export async function run(t) { if (!await osIsolationAvailable()) { t.skip('x'); return; } }",
    'hub/runs/engine/testing/harness.ts': "export async function sandboxSkip() { return (await osIsolationAvailable()) ? false : 'x'; }",
  };
  const read = (file: string): string | undefined => sources[file];
  assert.equal(needsMacos('tests/acceptance/50-x.test.ts', "import { run } from './support/skips.ts';", read), true);
  assert.equal(needsMacos('hub/runs/x.test.ts', "import { openHarness } from './engine/testing/harness.ts';", read), false);
  assert.equal(needsMacos('hub/runs/x.test.ts', "import { openHarness, sandboxSkip } from './engine/testing/harness.ts';", read), true);
  assert.equal(needsMacos('hub/platform/x.test.ts', "test('p', { skip: process.platform === 'darwin' ? false : 'macOS' }, () => {});", read), true);
  assert.deepEqual(macosFiles(['a.test.ts', 'b.test.ts'], (file) => (file === 'a.test.ts' ? 'const s = await securityAvailable();' : 'plain')), ['a.test.ts']);
});

test('unit files run with two workers, acceptance files one at a time, and an empty list is refused', () => {
  assert.deepEqual(macosArguments('unit', ['a.test.ts']), ['--test', '--test-isolation=process', '--test-concurrency=2', 'a.test.ts']);
  assert.deepEqual(macosArguments('acceptance', ['b.test.ts']), ['--test', '--test-concurrency=1', 'b.test.ts']);
  assert.throws(() => macosArguments('unit', []), /拒绝空运行/);
});
