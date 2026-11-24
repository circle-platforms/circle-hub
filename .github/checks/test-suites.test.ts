import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { unitFiles } from '../../tools/run-unit-tests.ts';
import { evaluateTestSuites, NOT_RUN, suiteTestFiles, testSuiteProblems, trackedTestFiles } from './test-suites.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('repository test suite coverage', () => {
  it('every tracked *.test.ts file belongs to a standard suite or an exact NOT_RUN entry', () => {
    assert.deepEqual(testSuiteProblems(ROOT), []);
    const tracked = trackedTestFiles(ROOT);
    assert.ok(tracked.length > 100);
    const run = new Set(suiteTestFiles(ROOT));
    const unit = new Set(unitFiles('all'));
    for (const file of [
      'scripts/real/circle-guard.test.ts',
      'scripts/real/circle-home.test.ts',
      'tests/acceptance/oracle/oracle.test.ts',
      'tests/acceptance/oracle/differential.test.ts',
      'tools/slot-schema.test.ts',
      'tests/fixtures/recompose/checks.test.ts',
      '.github/checks/workflow.test.ts',
      '.github/checks/test-suites.test.ts',
    ]) {
      assert.ok(run.has(file), `${file} must belong to a standard test suite`);
    }
    assert.ok(unit.has('scripts/real/circle-guard.test.ts'), 'circle-guard.test.ts runs in npm run test:unit');
    assert.ok(unit.has('scripts/real/circle-home.test.ts'), 'circle-home.test.ts runs in npm run test:unit');
  });

  it('NOT_RUN uses exact file paths without wildcards', () => {
    for (const [entry] of NOT_RUN) {
      assert.equal(/[*?[\]{}]/.test(entry), false, `wildcard pattern forbidden in NOT_RUN: ${entry}`);
    }
  });
});

describe('evaluateTestSuites rules', () => {
  it('flags orphan test files regardless of directory, including scripts/real', () => {
    const problems = evaluateTestSuites({
      tracked: ['hub/a.test.ts', 'scripts/real/unwired-guard.test.ts', 'tools/new-helper.test.ts'],
      run: ['hub/a.test.ts'],
      notRun: [],
      exists: () => true,
      npmTestScript: 'npm run verify:contracts && npm run test:unit && npm run test:docs && npm run test:acceptance',
    });
    assert.equal(problems.length, 2);
    assert.match(problems[0], /orphan tracked test file scripts\/real\/unwired-guard\.test\.ts/);
    assert.match(problems[1], /orphan tracked test file tools\/new-helper\.test\.ts/);
  });

  it('rejects wildcard exclusions, overlaps, duplicates, empty reasons, stale paths, and omitted npm test suites', () => {
    const problems = evaluateTestSuites({
      tracked: ['hub/a.test.ts', 'scripts/real/b.test.ts'],
      run: ['hub/a.test.ts'],
      notRun: [
        ['scripts/real/**/*.test.ts', 'too broad'],
        ['hub/a.test.ts', ''],
        ['hub/a.test.ts', 'duplicate and also run'],
        ['scripts/real/missing.test.ts', 'gone'],
      ],
      exists: (file) => file !== 'scripts/real/missing.test.ts',
      npmTestScript: 'npm run test:unit && npm run test:docs',
    });
    assert.ok(problems.some((p) => p.includes('test:acceptance')));
    assert.ok(problems.some((p) => p.includes('wildcard exclusion not allowed') && p.includes('scripts/real/**/*.test.ts')));
    assert.ok(problems.some((p) => p.includes('non-empty reason')));
    assert.ok(problems.some((p) => p.includes('duplicate NOT_RUN entry')));
    assert.ok(problems.some((p) => p.includes('stale NOT_RUN exclusion')));
    assert.ok(problems.some((p) => p.includes('both run by a test suite and listed in NOT_RUN')));
    assert.ok(problems.some((p) => p.includes('orphan tracked test file scripts/real/b.test.ts')));
  });
});

describe('temp git repo integration', () => {
  it('catches a newly tracked scripts/real/*.test.ts that is not in any suite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-suites-'));
    try {
      mkdirSync(join(dir, 'hub'), { recursive: true });
      mkdirSync(join(dir, 'scripts/real'), { recursive: true });
      mkdirSync(join(dir, '.github/checks'), { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          scripts: {
            'test:unit': 'node tools/run-unit-tests.ts',
            'test:acceptance': 'node tools/run-acceptance-tests.ts',
            'test:docs': 'node --test ".github/checks/*.test.ts"',
            test: 'npm run test:unit && npm run test:docs && npm run test:acceptance',
          },
        }),
      );
      writeFileSync(join(dir, 'hub/ok.test.ts'), '// ok\n');
      writeFileSync(join(dir, '.github/checks/docs.test.ts'), '// ok\n');
      writeFileSync(join(dir, 'scripts/real/orphan.test.ts'), '// orphan\n');
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['add', 'package.json', 'hub/ok.test.ts', '.github/checks/docs.test.ts', 'scripts/real/orphan.test.ts'], { cwd: dir });

      const problems = testSuiteProblems(dir, []);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /orphan tracked test file scripts\/real\/orphan\.test\.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
