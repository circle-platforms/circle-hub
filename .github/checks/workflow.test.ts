// The Hub checks workflow must count what each test job ran: an empty or skipped run is not a pass (AGENTS.md, Verification).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const WORKFLOW = readFileSync(new URL('../workflows/checks.yml', import.meta.url), 'utf8');

/** Steps of one job as text blocks (the workflow is plain enough that indentation finds them). */
function steps(job: string): string[] {
  const start = WORKFLOW.search(new RegExp(`^  ${job}:$`, 'm'));
  assert.notEqual(start, -1, `job ${job} exists`);
  const rest = WORKFLOW.slice(start + 1);
  const end = rest.search(/^ {2}\S/m);
  const body = end === -1 ? rest : rest.slice(0, end);
  return body.split(/^ {6}- /m).slice(1);
}

describe('test jobs count what ran', () => {
  for (const [job, command, log] of [
    ['unit_parts', 'npm run test:unit -- ${{ matrix.suite }}', 'unit'],
    ['acceptance', 'npm run test:acceptance', 'acceptance'],
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

it('the stable unit status requires both complete partitions, with no continue-on-error',()=>{
 assert.ok(WORKFLOW.includes('suite: [regular, parser-bounds]'));
 assert.ok(WORKFLOW.includes('needs: unit_parts'));
 assert.ok(WORKFLOW.includes("run: test '${{ needs.unit_parts.result }}' = 'success'"));
 assert.ok(WORKFLOW.includes('if: ${{ always() }}'));
 assert.doesNotMatch(WORKFLOW,/continue-on-error/);
});
