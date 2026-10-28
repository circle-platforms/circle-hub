// The Hub checks workflow must count what each test job ran: an empty or skipped run is not a pass (AGENTS.md, Verification).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const WORKFLOW = readFileSync(new URL('../workflows/checks.yml', import.meta.url), 'utf8');

/** One job as text (the workflow is plain enough that indentation finds it). */
function job(name: string): string {
  const start = WORKFLOW.search(new RegExp(`^  ${name}:$`, 'm'));
  assert.notEqual(start, -1, `job ${name} exists`);
  const rest = WORKFLOW.slice(start + 1);
  const end = rest.search(/^ {2}\S/m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Steps of one job as text blocks. */
function steps(name: string): string[] {
  return job(name).split(/^ {6}- /m).slice(1);
}

/** The `<index>/<total>` shards a job's matrix lists, in order. */
function shards(name: string): string[] {
  return [...job(name).matchAll(/shard: \[?([\d/, ]+?)\]?(?: \}|$)/gm)].flatMap((m) => m[1].split(/,\s*/));
}

/** Shards 1/n .. n/n, each once, so the slices together run the whole suite. */
function assertCompleteShards(listed: readonly string[], label: string): void {
  assert.ok(listed.length > 0, `${label} lists its shards`);
  const total = Number(listed[0].split('/')[1]);
  assert.deepEqual(listed, Array.from({ length: total }, (_, i) => `${i + 1}/${total}`), `${label} runs every shard once`);
}

describe('test jobs count what ran', () => {
  for (const [job, command, log] of [
    ['unit_parts', 'npm run test:unit -- ${{ matrix.suite }}', 'unit'],
    ['acceptance_parts', 'npm run test:acceptance', 'acceptance'],
    ['docs', 'node --test ".github/checks/*.test.ts"', 'docs'],
  ] as const) {
    it(`${job}: the output is kept and counted, and an empty run fails`, () => {
      const all = steps(job);
      const runIndex = all.findIndex((s) => s.includes(command));
      assert.notEqual(runIndex, -1, `${job} runs ${command}`);
      const runStep = all[runIndex];
      assert.match(runStep, /shell: bash/, 'bash, so that pipefail keeps the exit code of the tests through tee');
      assert.ok(runStep.includes(`${command} 2>&1 | tee "$RUNNER_TEMP/${log}.log"`), `${job} keeps the output in ${log}.log`);
      const summary = all.slice(runIndex + 1).find((s) => s.includes('node .github/checks/test-summary.ts'));
      assert.ok(summary !== undefined, `${job} counts the output after running it`);
      assert.ok(summary.includes(`"$RUNNER_TEMP/${log}.log"`), `${job} counts the same log`);
      assert.match(summary, /if: \$\{\{ !cancelled\(\) \}\}/, 'the count also runs when the tests failed');
    });
  }

  it('docs: the checks are type-checked', () => {
    assert.ok(steps('docs').some((s) => s.includes('npx tsc --noEmit -p .github/checks')));
  });

  it('no job reaches a secret', () => {
    assert.doesNotMatch(WORKFLOW, /secrets\./);
  });
});

describe('sharded test jobs keep one stable status each', () => {
  for (const [aggregate, parts, variable] of [
    ['unit', 'unit_parts', 'UNIT_SHARD'],
    ['acceptance', 'acceptance_parts', 'ACCEPTANCE_SHARD'],
  ] as const) {
    it(`${aggregate} requires every ${parts} job, with no continue-on-error`, () => {
      const body = job(aggregate);
      assert.ok(body.includes(`needs: ${parts}`));
      assert.ok(body.includes('if: ${{ always() }}'), 'the status is reported also when a part failed or was skipped');
      assert.ok(body.includes(`run: test '\${{ needs.${parts}.result }}' = 'success'`));
      assert.ok(job(parts).includes(`${variable}: \${{ matrix.shard }}`), `${parts} hands the shard to the runner`);
      assert.ok(steps(parts).some((s) => s.includes('test-summary.ts') && s.includes('${{ matrix.shard }}')), 'each part has its own summary label');
    });
  }

  it('unit tests: regular in complete shards, parser-bounds whole', () => {
    const body = job('unit_parts');
    const regular = [...body.matchAll(/\{ suite: regular, shard: ([\d/]+) \}/g)].map((m) => m[1]);
    assertCompleteShards(regular, 'regular');
    assert.deepEqual([...body.matchAll(/\{ suite: parser-bounds, shard: ([\d/]+) \}/g)].map((m) => m[1]), ['1/1']);
    assert.equal(shards('unit_parts').length, regular.length + 1, 'no other unit partition');
  });

  it('acceptance: complete shards, each within the job timeout', () => {
    assertCompleteShards(shards('acceptance_parts'), 'acceptance');
    assert.match(job('acceptance_parts'), /timeout-minutes: \d+/);
  });

  it('no job continues on error', () => {
    assert.doesNotMatch(WORKFLOW, /continue-on-error/);
  });

  it('a newer push replaces the checks of a pull request but never of main', () => {
    assert.ok(WORKFLOW.includes('group: checks-${{ github.event.pull_request.number || github.sha }}'));
    assert.ok(WORKFLOW.includes("cancel-in-progress: ${{ github.event_name == 'pull_request' }}"));
  });
});
