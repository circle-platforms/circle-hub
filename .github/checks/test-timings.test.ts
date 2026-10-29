import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileTimings, main, timingsMarkdown } from './test-timings.ts';

// The shape of Node 24's junit report: absolute file paths, a suite without a file of its own, a name with an unescaped '>',
// a skipped test and a failure.
const JUNIT = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testcase name="top a &lt;b> &amp; c" time="0.423780" classname="test" file="/ci/checkout/hub/a.test.ts"/>
	<testsuite name="suite one" time="0.257214" disabled="0" errors="0" tests="2" failures="0" skipped="1">
		<testsuite name="nested" time="0.200000" tests="1">
			<testcase name="deep" time="0.200000" classname="nested" file="/ci/checkout/hub/a.test.ts"/>
		</testsuite>
		<testcase name="inner 2" time="0.000679" classname="suite one" file="/ci/checkout/hub/a.test.ts">
			<skipped type="skipped" message="not here"/>
		</testcase>
	</testsuite>
	<testcase name="b one" time="2.5" classname="test" file="/ci/checkout/packs/b.test.ts"/>
	<testcase name="b fails" time="0.000147" classname="test" file="/ci/checkout/packs/b.test.ts" failure="x">
		<failure type="testCodeFailure" message="x">
Error: x at TestContext.&lt;anonymous> (file:///ci/checkout/packs/b.test.ts:3:31)
		</failure>
	</testcase>
	<testcase name="elsewhere" time="0.1" classname="test" file="/elsewhere/c.test.ts"/>
	<!-- tests 5 -->
	<!-- duration_ms 777.221667 -->
</testsuites>
`;

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'test-timings-'));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('fileTimings', () => {
  it('sums the top-level tests and suites of each file, slowest first, with paths from the repository root', () => {
    const timings = fileTimings(JUNIT, '/ci/checkout');
    assert.deepEqual(
      timings.map((t) => ({ ...t, seconds: Number(t.seconds.toFixed(6)) })),
      [
        { file: 'packs/b.test.ts', tests: 2, seconds: 2.500147 },
        { file: 'hub/a.test.ts', tests: 2, seconds: 0.680994 },
        { file: '/elsewhere/c.test.ts', tests: 1, seconds: 0.1 },
      ],
    );
  });

  it('takes the file of a suite from its first test, however deep', () => {
    const junit = '<testsuites><testsuite name="s" time="3"><testsuite name="t" time="3"><testcase name="x" time="3" file="/r/x.test.ts"/></testsuite></testsuite></testsuites>';
    assert.deepEqual(fileTimings(junit, '/r'), [{ file: 'x.test.ts', tests: 1, seconds: 3 }]);
  });

  it('keeps what a cancelled run wrote before it stopped, and reads an empty report as no test', () => {
    const cut = JUNIT.slice(0, JUNIT.indexOf('<testcase name="b fails"'));
    assert.deepEqual(
      fileTimings(cut, '/ci/checkout').map((t) => t.file),
      ['packs/b.test.ts', 'hub/a.test.ts'],
    );
    assert.deepEqual(fileTimings('', '/ci/checkout'), []);
  });
});

describe('timingsMarkdown', () => {
  it('lists at most the limit, with each file\'s share of the whole', () => {
    const md = timingsMarkdown('Unit tests / regular 1/3', [
      { file: 'a.test.ts', tests: 3, seconds: 3 },
      { file: 'b.test.ts', tests: 1, seconds: 1 },
    ], 1);
    assert.match(md, /^### Unit tests \/ regular 1\/3: slowest test files$/m);
    assert.match(md, /2 files, 4\.0 s of test time in all/);
    assert.match(md, /^\| 1 \| `a\.test\.ts` \| 3 \| 3\.0 \| 75\.0% \|$/m);
    assert.doesNotMatch(md, /b\.test\.ts/);
  });

  it('says so when the report holds no test', () => {
    assert.match(timingsMarkdown('Acceptance 1/4', []), /The junit report holds no test\./);
  });
});

describe('main', () => {
  it('appends the table to the job summary', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'unit.xml'), JUNIT);
    const summary = join(dir, 'summary.md');
    writeFileSync(summary, '### Unit tests / regular 1/3\n');
    assert.equal(main([join(dir, 'unit.xml'), 'Unit tests / regular 1/3'], { GITHUB_STEP_SUMMARY: summary }, () => {}, '/ci/checkout'), 0);
    const written = readFileSync(summary, 'utf8');
    assert.ok(written.startsWith('### Unit tests / regular 1/3\n'), 'appended after the counts');
    assert.match(written, /\| 1 \| `packs\/b\.test\.ts` \| 2 \| 2\.5 \|/);
  });

  it('notes a missing report without failing, and refuses bad usage', () => {
    const lines: string[] = [];
    assert.equal(main([join(scratch(), 'absent.xml'), 'Acceptance 2/4'], {}, (line) => lines.push(line)), 0);
    assert.match(lines.join('\n'), /### Acceptance 2\/4: slowest test files\n\nNo junit report was written: `ENOENT/);
    assert.equal(main(['only-one-argument'], {}, () => {}), 2);
  });

  it('reads the report of a real node --test run', () => {
    // Node names the files by their real path, and a temporary directory can sit behind a symbolic link (macOS).
    const dir = realpathSync(scratch());
    mkdirSync(join(dir, 'sub'));
    writeFileSync(
      join(dir, 'a.test.ts'),
      "import { before, describe, it, test } from 'node:test';\n" +
        'before(() => new Promise((resolve) => setTimeout(resolve, 150)));\n' +
        "test('first', () => {});\n" +
        "describe('group', () => { it('inside', () => {}); });\n",
    );
    writeFileSync(join(dir, 'sub', 'b.test.ts'), "import { test } from 'node:test';\ntest('quick', () => {});\n");
    // A nested `node --test` inherits NODE_TEST_CONTEXT from this runner and would report to it instead of writing its own report.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--test', '--test-reporter=junit', '--test-reporter-destination=report.xml', 'a.test.ts', 'sub/b.test.ts'], {
      cwd: dir,
      encoding: 'utf8',
      env,
    });
    assert.equal(child.status, 0, child.stderr);
    const timings = fileTimings(readFileSync(join(dir, 'report.xml'), 'utf8'), dir);
    assert.deepEqual(
      timings.map((t) => [t.file, t.tests]),
      [
        ['a.test.ts', 2],
        ['sub/b.test.ts', 1],
      ],
    );
    assert.ok(timings[0].seconds >= 0.1, `the top-level before counts in the first test: ${timings[0].seconds}`);
  });
});
