import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { acceptanceFiles } from './run-acceptance-tests.ts';
import { classifyLanes, unitFiles } from './run-unit-tests.ts';
import {
  QUICK_CATEGORIES,
  orderedQuickUnitFiles,
  quickAcceptanceFiles,
  quickAllFiles,
  quickCommandSteps,
  quickUnitConcurrency,
  quickUnitFiles,
} from './run-quick-tests.ts';
import type { QuickCategoryId } from './run-quick-tests.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_CATEGORIES: readonly QuickCategoryId[] = [
  'contracts',
  'typecheck',
  'six-tools',
  'teams-permissions',
  'named-secrets',
  'mindmap-compile-acceptance',
];

test('quick suite covers all six required categories without gaps', () => {
  const ids = QUICK_CATEGORIES.map((category) => category.id);
  assert.deepEqual(ids, REQUIRED_CATEGORIES);
  for (const category of QUICK_CATEGORIES) {
    const totalItems = category.commands.length + category.unitFiles.length + category.acceptanceFiles.length;
    assert.ok(totalItems > 0, `${category.id} must declare checks or test files`);
  }
  const mindmap = QUICK_CATEGORIES.find((category) => category.id === 'mindmap-compile-acceptance')!;
  assert.ok(mindmap.unitFiles.length > 0, 'mindmap compile unit tests are included');
  assert.ok(mindmap.acceptanceFiles.length > 0, 'acceptance tests are included');
});

test('every declared file and command entry in the quick suite exists without duplicates', () => {
  const unitSet = new Set(unitFiles('all'));
  const acceptanceSet = new Set(acceptanceFiles());
  const units = quickUnitFiles();
  const acceptances = quickAcceptanceFiles();
  const all = quickAllFiles();

  assert.equal(new Set(all).size, all.length, 'quick suite has no duplicate file entries');
  for (const cmd of quickCommandSteps()) {
    assert.ok(existsSync(resolve(ROOT, cmd.entry)), `missing command entry: ${cmd.entry}`);
  }
  for (const file of units) {
    assert.ok(existsSync(resolve(ROOT, file)), `missing unit test file: ${file}`);
    assert.ok(unitSet.has(file), `unit file not registered in unitFiles: ${file}`);
  }
  for (const file of acceptances) {
    assert.ok(existsSync(resolve(ROOT, file)), `missing acceptance test file: ${file}`);
    assert.ok(acceptanceSet.has(file), `acceptance file not registered in acceptanceFiles: ${file}`);
  }
});

test('quick unit files stay inside the shared PostgreSQL lane and start mcp.test.ts first', () => {
  const units = quickUnitFiles();
  const lanes = classifyLanes(units);
  assert.deepEqual(lanes.isolated, [], 'isolated-cluster tests stay out of the quick shared lane');
  assert.deepEqual(lanes.sentinel, [], 'timing-sentinel tests stay out of the parallel quick lane');
  assert.equal(orderedQuickUnitFiles()[0], 'hub/server/mcp.test.ts');
  const concurrency = quickUnitConcurrency(units.length);
  assert.ok(concurrency >= 2 && concurrency <= 6, `bounded concurrency: ${concurrency}`);
});

test('package.json defines test:quick and does not alter full test commands', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts['test:quick'], 'node tools/run-quick-tests.ts');
  assert.equal(pkg.scripts['test:unit'], 'node tools/run-unit-tests.ts');
  assert.equal(pkg.scripts['test:acceptance'], 'node tools/run-acceptance-tests.ts');
});

test('CLI supports --list and --dry-run without running PostgreSQL and rejects invalid flags', () => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;

  for (const flag of ['--list', '--dry-run']) {
    const out = spawnSync(process.execPath, ['tools/run-quick-tests.ts', flag], { cwd: ROOT, encoding: 'utf8', env });
    assert.equal(out.status, 0, out.stderr);
    for (const id of REQUIRED_CATEGORIES) assert.match(out.stdout, new RegExp(`\\[${id}\\]`));
  }

  const bad = spawnSync(process.execPath, ['tools/run-quick-tests.ts', '--unknown'], { cwd: ROOT, encoding: 'utf8', env });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /用法：/);
});
