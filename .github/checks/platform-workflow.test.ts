// Static safety contract for the explicitly triggered six-target synthetic workflow.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const workflow = readFileSync(new URL('../workflows/platform-matrix.yml', import.meta.url), 'utf8');
test('native matrix is restricted, read-only and fixed to six native runners', () => {
  assert.match(workflow, /^on:\n  push:\n    branches: \['synthetic-platform\/\*\*'\]\n  workflow_dispatch:\n/m);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(workflow, /secrets[.[]|environment:|pull_request_target|contents: write|gh release|upload-artifact|continue-on-error|pull_request:/);
  const rows = [...workflow.matchAll(/^          - \{ runner: ([^,]+), platform: ([^,]+), arch: ([^ }]+) \}$/gm)].map((m) => m.slice(1));
  assert.deepEqual(rows, [
    ['ubuntu-24.04', 'linux', 'x64'], ['ubuntu-24.04-arm', 'linux', 'arm64'],
    ['macos-15-intel', 'darwin', 'x64'], ['macos-15', 'darwin', 'arm64'],
    ['windows-2025', 'win32', 'x64'], ['windows-11-arm', 'win32', 'arm64'],
  ]);
  const actions = [...workflow.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.equal(actions.length, 2);
  for (const action of actions) assert.match(action, /^actions\/(checkout|setup-node)@[a-f0-9]{40}$/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.ok(workflow.includes('node .github/checks/platform-matrix.ts ${{ matrix.platform }} ${{ matrix.arch }}'));
  assert.ok(workflow.includes("if: ${{ !cancelled() && runner.os == 'Windows' }}"));
  assert.match(workflow, /name: Report unsupported Windows release readiness\n.*\n        run: node .github\/checks\/platform-matrix.ts --windows-readiness/);
});
test('Windows runners also run the service, Task Scheduler and loopback PostgreSQL fixtures, ARM64 on the x64 build', () => {
  const step = (name: string) => {
    const match = new RegExp(`      - name: ${name}\\n        if: (.*)\\n        run: (.*)\\n`).exec(workflow);
    assert.ok(match, name);
    return { condition: match[1], command: match[2] };
  };
  assert.deepEqual(step('Execute synthetic Windows service fixtures'), {
    condition: "${{ !cancelled() && runner.os == 'Windows' }}",
    command: 'node --test --test-reporter=tap --test-concurrency=1 hub/platform/windows-service.test.ts hub/platform/windows-scm.test.ts hub/platform/windows-task.test.ts',
  });
  assert.deepEqual(step('Install the x64 PostgreSQL build for the Windows ARM64 hybrid'), {
    condition: "${{ !cancelled() && runner.os == 'Windows' && matrix.arch == 'arm64' }}",
    command: 'node hub/platform/postgres-hybrid.ts',
  });
  assert.deepEqual(step('Execute synthetic loopback SCRAM PostgreSQL fixtures'), {
    condition: "${{ !cancelled() && runner.os == 'Windows' }}",
    command: 'node --test --test-reporter=tap --test-concurrency=1 hub/platform/postgres-loopback.test.ts hub/platform/postgres-hybrid.test.ts',
  });
  // The hybrid install comes after the native contracts (a failure there must not skip them) and before the PostgreSQL fixtures.
  const order = ['Check the native architecture', 'Install the x64 PostgreSQL build', 'Execute synthetic loopback SCRAM', 'Report unsupported Windows release readiness'].map((name) => workflow.indexOf(name));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every((index) => index > 0));
  assert.match(workflow, /^    timeout-minutes: 30$/m);
});
test('Windows release readiness is reported as unsupported without failing the synthetic matrix', () => {
  const script = readFileSync(new URL('./platform-matrix.ts', import.meta.url), 'utf8');
  const readiness = script.slice(script.indexOf("'--windows-readiness'"), script.indexOf('} else {'));
  assert.ok(readiness.includes('Windows 运行时打包、原生服务、凭证存储与规则沙箱尚未完成验收；当前不支持发布'));
  assert.match(readiness, /::warning title=Windows 发布就绪::/);
  assert.match(readiness, /GITHUB_STEP_SUMMARY/);
  assert.doesNotMatch(readiness, /exitCode|process\.exit\(/);
});
