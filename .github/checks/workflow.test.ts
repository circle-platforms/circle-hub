// The Hub checks and macOS workflows must count what each test job ran: an empty or skipped run is not a pass (AGENTS.md,
// Verification). The pack sandbox's tests run under real Linux isolation on every pull request, never quietly skipped.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const WORKFLOW = readFileSync(new URL('../workflows/checks.yml', import.meta.url), 'utf8');
const MACOS = readFileSync(new URL('../workflows/macos.yml', import.meta.url), 'utf8');

/** One job as text (the workflows are plain enough that indentation finds it). */
function job(name: string, workflow = WORKFLOW): string {
  const start = workflow.search(new RegExp(`^  ${name}:$`, 'm'));
  assert.notEqual(start, -1, `job ${name} exists`);
  const rest = workflow.slice(start + 1);
  const end = rest.search(/^ {2}\S/m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Steps of one job as text blocks. */
function steps(name: string, workflow = WORKFLOW): string[] {
  return job(name, workflow).split(/^ {6}- /m).slice(1);
}

/** The run step of `command` keeps its output in `log` through bash and tee, and a later step counts that log after a failure. */
function assertCounted(all: readonly string[], command: string, log: string): void {
  const runIndex = all.findIndex((s) => s.includes(command));
  assert.notEqual(runIndex, -1, `runs ${command}`);
  const runStep = all[runIndex];
  assert.match(runStep, /shell: bash/, 'bash, so that pipefail keeps the exit code of the tests through tee');
  assert.ok(runStep.includes(`${command} 2>&1 | tee "$RUNNER_TEMP/${log}.log"`), `keeps the output in ${log}.log`);
  const summary = all.slice(runIndex + 1).find((s) => s.includes('node .github/checks/test-summary.ts'));
  assert.ok(summary !== undefined, `counts the output of ${command} after running it`);
  assert.ok(summary.includes(`"$RUNNER_TEMP/${log}.log"`), `counts the same log, ${log}.log`);
  assert.match(summary, /if: \$\{\{ !cancelled\(\) \}\}/, 'the count also runs when the tests failed');
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
    ['isolation_parts', 'node tools/run-guarded-tests.ts linux ${{ matrix.suite }}', 'isolation'],
    ['docs', 'node --test ".github/checks/*.test.ts"', 'docs'],
  ] as const) {
    it(`${job}: the output is kept and counted, and an empty run fails`, () => {
      assertCounted(steps(job), command, log);
    });
  }

  it('docs: the checks are type-checked', () => {
    assert.ok(steps('docs').some((s) => s.includes('npx tsc --noEmit -p .github/checks')));
  });

  it('no plain scalar holds a colon and a space, which YAML refuses (the whole workflow would then fail to start)', () => {
    for (const workflow of [WORKFLOW, MACOS]) {
      const refused = workflow.split('\n').filter((line) => {
        const value = /^\s*(?:- )?[\w-]+: (?!["'|>])(.*)$/.exec(line)?.[1];
        return value !== undefined && value.includes(': ');
      });
      assert.deepEqual(refused, []);
    }
  });

  it('no job reaches a secret', () => {
    assert.doesNotMatch(WORKFLOW, /secrets\./);
    assert.doesNotMatch(MACOS, /secrets\./);
  });
});

describe('sharded test jobs keep one stable status each', () => {
  for (const [aggregate, parts, variable] of [
    ['unit', 'unit_parts', 'UNIT_SHARD'],
    ['acceptance', 'acceptance_parts', 'ACCEPTANCE_SHARD'],
    ['isolation', 'isolation_parts', 'GUARDED_SHARD'],
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

  it('Linux isolation: the unit and the acceptance files each in complete shards, each within the job timeout', () => {
    const body = job('isolation_parts');
    let listed = 0;
    for (const suite of ['unit', 'acceptance']) {
      const suiteShards = [...body.matchAll(new RegExp(`\\{ suite: ${suite}, shard: ([\\d/]+) \\}`, 'g'))].map((m) => m[1]);
      assertCompleteShards(suiteShards, `Linux isolation ${suite}`);
      listed += suiteShards.length;
    }
    assert.equal(shards('isolation_parts').length, listed, 'no other Linux isolation partition');
    assert.match(body, /^    timeout-minutes: \d+$/m);
  });

  it('no job continues on error', () => {
    assert.doesNotMatch(WORKFLOW, /continue-on-error/);
    assert.doesNotMatch(MACOS, /continue-on-error/);
  });

  it('a newer push replaces the checks of a pull request but never of main', () => {
    assert.ok(WORKFLOW.includes('group: checks-${{ github.event.pull_request.number || github.sha }}'));
    assert.ok(WORKFLOW.includes("cancel-in-progress: ${{ github.event_name == 'pull_request' }}"));
  });
});

describe('backup, restore and deploy tests find pg_dump and pg_restore 18 on Ubuntu', () => {
  it('every regular unit shard installs the PostgreSQL 18 client before the tests, bounded and checked', () => {
    const all = steps('unit_parts');
    const install = all.findIndex((s) => s.includes('postgresql-client-18'));
    assert.notEqual(install, -1, 'unit_parts installs postgresql-client-18');
    assert.ok(install < all.findIndex((s) => s.includes('npm run test:unit')), 'before the tests run');
    const step = all[install];
    assert.ok(step.includes("if: ${{ matrix.suite == 'regular' }}"), 'in every regular shard, wherever the platform files land');
    assert.match(step, /timeout-minutes: \d+/);
    assert.match(step, /https:\/\/apt\.postgresql\.org\/pub\/repos\/apt/, 'from the PostgreSQL apt repository');
    assert.match(step, /--version \| grep -E ' 18\\\.'/, 'the installed tools report major 18');
    assert.ok(step.includes('echo /usr/lib/postgresql/18/bin >> "$GITHUB_PATH"'), 'first on PATH, where hub/platform/backup.ts looks on Linux');
  });
});

describe('the pack sandbox runs under Linux isolation on every pull request and push to main', () => {
  const all = steps('isolation_parts');
  const index = (text: string): number => all.findIndex((s) => s.includes(text));

  it('checks.yml runs on pull requests and on a push to main', () => {
    const triggers = WORKFLOW.slice(WORKFLOW.indexOf('\non:'), WORKFLOW.indexOf('\npermissions:'));
    assert.match(triggers, /^  push:\n    branches: \[main\]$/m);
    assert.match(triggers, /^  pull_request:$/m);
    assert.ok(job('isolation_parts').includes('runs-on: ubuntu-24.04'));
  });

  it('installs bubblewrap and the AppArmor tools, bounded, with retries, and checks both executables', () => {
    const install = all[index('install -y --no-install-recommends bubblewrap apparmor')];
    assert.ok(install !== undefined, 'installs bubblewrap and apparmor');
    assert.match(install, /timeout-minutes: \d+/);
    assert.match(install, /sudo timeout \d+ apt-get -o Acquire::Retries=\d+ update/);
    assert.match(install, /sudo timeout \d+ apt-get -o Acquire::Retries=\d+ install -y/);
    assert.ok(install.includes('test -x /usr/bin/bwrap') && install.includes('test -x /usr/bin/aa-exec'), 'the paths linux.ts runs');
  });

  it('loads the policy generated for the job\'s own Node, then requires isolation before any test runs', () => {
    const install = index('bubblewrap apparmor');
    const load = index('node hub/rules/sandbox/linux.ts');
    const ready = index('id: ready');
    const run = index('node tools/run-guarded-tests.ts linux');
    assert.ok(install !== -1 && install < load && load < ready && ready < run, 'install, load, require, run, in that order');
    assert.match(all[load], /node hub\/rules\/sandbox\/linux\.ts > "\$RUNNER_TEMP\/([\w.-]+)"[\s\S]*sudo apparmor_parser -r "\$RUNNER_TEMP\/\1"/);
    assert.ok(all[ready].includes('osIsolationAvailable()') && all[ready].includes('process.exit(1)'), 'missing isolation fails the job');
    assert.doesNotMatch(all[run], /\bif:/, 'the tests run only when every earlier step passed');
  });

  it('no workflow loosens the kernel\'s user namespace restriction: the profile\'s own userns rule is enough', () => {
    const loosening = /\bsysctl\s+(?:-\w+\s+)*-w\b|apparmor_restrict_unprivileged_userns\s*=|(?:>|\btee\b[^\n|]*)\s*\/proc\/sys\/kernel\/apparmor_restrict_unprivileged_userns/;
    for (const workflow of [WORKFLOW, MACOS]) assert.doesNotMatch(workflow, loosening);
    assert.match('sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0', loosening);
    assert.match('echo 0 | sudo tee /proc/sys/kernel/apparmor_restrict_unprivileged_userns', loosening);
    assert.ok(all[index('node hub/rules/sandbox/linux.ts')].includes('cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns'), 'the log shows the value in effect');
  });
});

describe('the macOS-only paths run outside pull requests', () => {
  it('runs on a push to main, nightly and on demand, never for a pull request', () => {
    const triggers = MACOS.slice(MACOS.indexOf('\non:'), MACOS.indexOf('\npermissions:'));
    assert.match(triggers, /^  push:\n    branches: \[main\]$/m);
    assert.match(triggers, /^  schedule:\n    - cron: '[^']+'$/m);
    assert.match(triggers, /^  workflow_dispatch:$/m);
    assert.doesNotMatch(triggers, /pull_request/, 'macOS runners are few and shared, so pull requests do not wait for them');
    assert.ok(MACOS.includes('cancel-in-progress: false'), 'a newer run waits instead of cancelling the running one');
  });

  it('one bounded macos-15 job with libpq 18 and working isolation before the tests', () => {
    const body = job('macos', MACOS);
    assert.ok(body.includes('runs-on: macos-15'));
    assert.match(body, /^    timeout-minutes: \d+$/m);
    const all = steps('macos', MACOS);
    const install = all.find((s) => s.includes('brew install postgresql@18'));
    assert.ok(install !== undefined && /timeout-minutes: \d+/.test(install), 'the PostgreSQL 18 client install is bounded');
    assert.ok(install.includes('CIRCLE_HUB_LIBPQ_BIN=$bin'), 'the platform tests are pointed at it');
    assert.ok(all.some((s) => s.includes('id: ready') && s.includes('osIsolationAvailable()') && s.includes('/usr/bin/security')), 'missing isolation fails the job');
  });

  for (const [kind, log] of [
    ['unit', 'macos-unit'],
    ['acceptance', 'macos-acceptance'],
  ] as const) {
    it(`${kind}: the selected files run, and the output is kept and counted`, () => {
      assertCounted(steps('macos', MACOS), `node tools/run-guarded-tests.ts macos ${kind}`, log);
    });
  }
});
