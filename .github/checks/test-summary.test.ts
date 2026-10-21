import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { command, main, parseTestOutput, report } from './test-summary.ts';

// Output of `node --test` (Node 24, spec reporter, not a terminal) for a suite with a skipped test, a skipped suite, a todo
// and a skip without a reason.
const SPEC = [
  '▶ outer suite',
  '  ✔ passes (0.193584ms)',
  '  ﹣ inner skip (0.044292ms) # not here',
  '✔ outer suite (0.562875ms)',
  '﹣ skipped suite (0.02375ms) # skipped: only on macOS',
  '✔ todo one (0.03275ms) # later',
  '﹣ plain skip (0.029959ms) # SKIP',
  'ℹ tests 4',
  'ℹ suites 2',
  'ℹ pass 1',
  'ℹ fail 0',
  'ℹ cancelled 0',
  'ℹ skipped 2',
  'ℹ todo 1',
  'ℹ duration_ms 50.553833',
].join('\n');

const EMPTY = ['ℹ tests 0', 'ℹ suites 0', 'ℹ pass 0', 'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0', 'ℹ duration_ms 2.17'].join('\n');

const TAP = [
  'TAP version 13',
  '# Subtest: b',
  'ok 2 - b # SKIP why',
  '1..2',
  '# tests 2',
  '# suites 0',
  '# pass 1',
  '# fail 0',
  '# cancelled 0',
  '# skipped 1',
  '# todo 0',
  '# duration_ms 50.3',
].join('\n');

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'test-summary-'));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('parseTestOutput', () => {
  it('reads the spec summary and lists skipped tests and skipped suites', () => {
    const out = parseTestOutput(SPEC);
    assert.deepEqual(out.counts, { tests: 4, suites: 2, pass: 1, fail: 0, cancelled: 0, skipped: 2, todo: 1 });
    assert.deepEqual(out.skips, [
      { name: 'inner skip', reason: 'not here' },
      { name: 'skipped suite', reason: 'skipped: only on macOS' },
      { name: 'plain skip', reason: 'no reason given' },
    ]);
  });

  it('reads the TAP summary', () => {
    const out = parseTestOutput(TAP);
    assert.equal(out.counts?.tests, 2);
    assert.equal(out.counts?.skipped, 1);
    assert.deepEqual(out.skips, [{ name: 'b', reason: 'why' }]);
  });

  it('ignores colour codes', () => {
    const coloured = SPEC.split('\n')
      .map((line) => `\x1b[34m${line.replace(' (', ' \x1b[90m(')}\x1b[39m`)
      .join('\n');
    assert.deepEqual(parseTestOutput(coloured), parseTestOutput(SPEC));
  });

  it('takes the last summary when a test printed an earlier one', () => {
    assert.equal(parseTestOutput(`${EMPTY}\n${SPEC}`).counts?.tests, 4);
  });

  it('has no counts when the summary is missing or cut off', () => {
    assert.equal(parseTestOutput('✔ a (1ms)\n').counts, undefined);
    assert.equal(parseTestOutput(SPEC.split('\n').slice(0, 10).join('\n')).counts, undefined);
  });
});

describe('report', () => {
  it('fails when no test ran', () => {
    const r = report('Acceptance', parseTestOutput(EMPTY));
    assert.equal(r.ok, false);
    assert.match(r.annotations.join('\n'), /^::error::Acceptance: no test ran/m);
    assert.match(r.markdown, /verified nothing/);
  });

  it('fails on a failed or cancelled test', () => {
    assert.equal(report('Unit', parseTestOutput(SPEC.replace('ℹ fail 0', 'ℹ fail 1'))).ok, false);
    assert.equal(report('Unit', parseTestOutput(SPEC.replace('ℹ cancelled 0', 'ℹ cancelled 2'))).ok, false);
  });

  it('fails without a summary', () => {
    const r = report('Unit', parseTestOutput(''));
    assert.equal(r.ok, false);
    assert.match(r.annotations[0], /no node --test summary/);
  });

  it('passes with skips but warns and lists every skipped test and suite', () => {
    const r = report('Unit', parseTestOutput(SPEC));
    assert.equal(r.ok, true);
    assert.equal(r.annotations.length, 1);
    assert.match(r.annotations[0], /^::warning::Unit: 2 tests skipped, 3 skipped tests and suites/);
    assert.match(r.markdown, /\| 4 \| 1 \| 0 \| 0 \| 2 \| 1 \|/);
    assert.match(r.markdown, /- skipped suite: skipped: only on macOS/);
  });

  it('passes quietly when everything ran', () => {
    const clean = SPEC.replace(/^.*﹣.*$/gm, '').replace('ℹ skipped 2', 'ℹ skipped 0');
    const r = report('Unit', parseTestOutput(clean));
    assert.equal(r.ok, true);
    assert.deepEqual(r.annotations, []);
  });

  it('escapes workflow command data', () => {
    assert.equal(command('error', 'a%b\nc'), '::error::a%25b%0Ac');
  });
});

describe('main against real node --test runs', () => {
  // A nested `node --test` inherits NODE_TEST_CONTEXT from this runner and would report to it instead of printing; CI runs it
  // at top level, so the child gets the environment without it.
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env.NODE_TEST_CONTEXT;
  delete env.FORCE_COLOR;

  function run(files: Record<string, string>, pattern: string): string {
    const dir = scratch();
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    const child = spawnSync(process.execPath, ['--test', pattern], { cwd: dir, encoding: 'utf8', env });
    const log = join(dir, 'out.log');
    writeFileSync(log, `${child.stdout}${child.stderr}`);
    return log;
  }

  it('a pattern that matches no file exits 0 in node, and fails here', () => {
    const dir = scratch();
    const child = spawnSync(process.execPath, ['--test', 'tests/acceptance/*.test.ts'], { cwd: dir, encoding: 'utf8', env });
    assert.equal(child.status, 0, 'node --test treats an empty match as success; this is what the summary step guards');
    const log = join(dir, 'out.log');
    writeFileSync(log, `${child.stdout}${child.stderr}`);
    const lines: string[] = [];
    assert.equal(main([log, 'Acceptance'], {}, (line) => lines.push(line)), 1);
    assert.match(lines.join('\n'), /::error::Acceptance: no test ran/);
  });

  it('a run with a skip passes, warns and writes the job summary', () => {
    const log = run(
      {
        'a.test.ts': "import { test } from 'node:test';\ntest('runs', () => {});\ntest('needs macOS', { skip: 'skipped: only on macOS' }, () => {});\n",
      },
      '*.test.ts',
    );
    const summary = join(scratch(), 'summary.md');
    writeFileSync(summary, '');
    const lines: string[] = [];
    assert.equal(main([log, 'Unit tests'], { GITHUB_STEP_SUMMARY: summary }, (line) => lines.push(line)), 0);
    assert.match(lines.join('\n'), /::warning::Unit tests: 1 tests skipped/);
    const written = readFileSync(summary, 'utf8');
    assert.match(written, /### Unit tests/);
    assert.match(written, /- needs macOS: skipped: only on macOS/);
  });

  it('a failing run fails', () => {
    const log = run({ 'a.test.ts': "import { test } from 'node:test';\ntest('breaks', () => { throw new Error('no'); });\n" }, '*.test.ts');
    assert.equal(main([log, 'Unit tests'], {}, () => {}), 1);
  });

  it('a missing log fails and bad usage is refused', () => {
    const lines: string[] = [];
    assert.equal(main([join(scratch(), 'absent.log'), 'Unit tests'], {}, (line) => lines.push(line)), 1);
    assert.match(lines[0], /^::error::Unit tests: cannot read/);
    assert.equal(main(['only-one-argument'], {}, () => {}), 2);
  });
});
