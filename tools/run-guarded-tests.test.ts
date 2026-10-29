import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptanceFiles } from './run-acceptance-tests.ts';
import {
  GUARDED_MEASURED_SECONDS,
  guardedArguments,
  guardedFiles,
  guardedSeconds,
  guardedShardFiles,
  guardedTestFiles,
  hostUnavailable,
  needsHost,
} from './run-guarded-tests.ts';
import { unitFiles } from './run-unit-tests.ts';

test('the macOS run selects the guarded unit and acceptance files from the sources', () => {
  const { unit, acceptance } = guardedTestFiles('macos');
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

test('the Linux run selects the files that guard on the pack sandbox, and none that need macOS or libpq only', () => {
  const linux = guardedTestFiles('linux');
  const macos = guardedTestFiles('macos');
  for (const kind of ['unit', 'acceptance'] as const) {
    assert.deepEqual(linux[kind].filter((file) => !macos[kind].includes(file)), [], `every Linux ${kind} file is in the macOS run too`);
  }
  for (const file of [
    'hub/rules/sandbox/sandbox.test.ts',
    'hub/rules/sandbox/linux-isolation.test.ts',
    'hub/runs/engine/start.test.ts',
    'packs/product/famx/functions/sandbox.test.ts',
    'hub/server/assemble/cli-admin.test.ts',
  ]) {
    assert.ok(linux.unit.includes(file), file);
  }
  for (const file of ['tests/acceptance/28-device-run.test.ts', 'tests/acceptance/43-r5-t4-3-change.test.ts', 'tests/acceptance/oracle/differential.test.ts']) {
    assert.ok(linux.acceptance.includes(file), file);
  }
  for (const file of ['hub/platform/keychain.test.ts', 'hub/platform/launchd.test.ts', 'hub/platform/backup-live.test.ts', 'hub/server/assemble/operator-token.test.ts']) {
    assert.ok(!linux.unit.includes(file), `${file} needs macOS or libpq, not the pack sandbox`);
  }
});

test('a helper counts only when it skips by itself, and each host reads only its own guards', () => {
  const sources: Record<string, string> = {
    'tests/acceptance/support/skips.ts': "export async function run(t) { if (!await osIsolationAvailable()) { t.skip('x'); return; } }",
    'tests/acceptance/support/keychain.ts': "export async function run(t) { if (!await securityAvailable()) { t.skip('x'); return; } }",
    'hub/runs/engine/testing/harness.ts': "export async function sandboxSkip() { return (await osIsolationAvailable()) ? false : 'x'; }",
  };
  const read = (file: string): string | undefined => sources[file];
  for (const host of ['macos', 'linux'] as const) {
    assert.equal(needsHost(host, 'tests/acceptance/50-x.test.ts', "import { run } from './support/skips.ts';", read), true);
    assert.equal(needsHost(host, 'hub/runs/x.test.ts', "import { openHarness } from './engine/testing/harness.ts';", read), false);
    assert.equal(needsHost(host, 'hub/runs/x.test.ts', "import { openHarness, sandboxSkip } from './engine/testing/harness.ts';", read), true);
  }
  assert.equal(needsHost('macos', 'tests/acceptance/51-x.test.ts', "import { run } from './support/keychain.ts';", read), true);
  assert.equal(needsHost('linux', 'tests/acceptance/51-x.test.ts', "import { run } from './support/keychain.ts';", read), false);
  const darwin = "test('p', { skip: process.platform === 'darwin' ? false : 'macOS' }, () => {});";
  assert.equal(needsHost('macos', 'hub/platform/x.test.ts', darwin, read), true);
  assert.equal(needsHost('linux', 'hub/platform/x.test.ts', darwin, read), false);
  const files = ['a.test.ts', 'b.test.ts', 'c.test.ts'];
  const source = (file: string): string => (file === 'a.test.ts' ? 'const s = await securityAvailable();' : file === 'b.test.ts' ? 'if (await sandboxSkip()) return;' : 'plain');
  assert.deepEqual(guardedFiles('macos', files, source), ['a.test.ts', 'b.test.ts']);
  assert.deepEqual(guardedFiles('linux', files, source), ['b.test.ts']);
});

test('the Linux shards together run every selected file once', () => {
  for (const kind of ['unit', 'acceptance'] as const) {
    const all = guardedTestFiles('linux')[kind];
    for (const total of [2, 3]) {
      const slices = Array.from({ length: total }, (_, i) => guardedShardFiles('linux', kind, { index: i + 1, total }));
      assert.deepEqual(slices.flat().sort(), all, `${kind} in ${total} slices`);
      for (const slice of slices) assert.ok(slice.length > 0, `no empty ${kind} slice of ${total}`);
    }
    assert.deepEqual(guardedShardFiles('linux', kind, undefined), all);
  }
});

test('the two Linux slices of each kind stay balanced, and every measured file is in the Linux run', () => {
  const linux = guardedTestFiles('linux');
  for (const kind of ['unit', 'acceptance'] as const) {
    for (const file of Object.keys(GUARDED_MEASURED_SECONDS)) {
      if (file.startsWith('tests/acceptance/') === (kind === 'acceptance')) assert.ok(linux[kind].includes(file), `${file} is a Linux ${kind} file`);
    }
    const loads = [1, 2].map((index) => guardedShardFiles('linux', kind, { index, total: 2 }).reduce((sum, file) => sum + guardedSeconds(kind, file), 0));
    assert.ok(Math.max(...loads) <= Math.min(...loads) * 1.2, `balanced ${kind} slices: ${loads.join(', ')}`);
  }
});

test('unit files run with two workers, acceptance files one at a time, and an empty list is refused', () => {
  assert.deepEqual(guardedArguments('unit', ['a.test.ts']), ['--test', '--test-isolation=process', '--test-concurrency=2', 'a.test.ts']);
  assert.deepEqual(guardedArguments('acceptance', ['b.test.ts']), ['--test', '--test-concurrency=1', 'b.test.ts']);
  assert.throws(() => guardedArguments('unit', []), /拒绝空运行/);
});

test('a run refuses another platform and a machine without isolation, where every guarded test would skip', async () => {
  const yes = async (): Promise<boolean> => true;
  const no = async (): Promise<boolean> => false;
  const reason = (): string => 'bubblewrap_or_apparmor_tools_missing';
  assert.equal(await hostUnavailable('linux', 'linux', yes, reason), undefined);
  assert.equal(await hostUnavailable('macos', 'darwin', yes, reason), undefined);
  assert.match((await hostUnavailable('linux', 'darwin', yes, reason)) ?? '', /linux/);
  assert.match((await hostUnavailable('macos', 'linux', yes, reason)) ?? '', /darwin/);
  assert.match((await hostUnavailable('linux', 'linux', no, reason)) ?? '', /bubblewrap_or_apparmor_tools_missing.*拒绝运行/);
});
