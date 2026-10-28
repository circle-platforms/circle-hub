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
  assert.match(workflow, /run: node .github\/checks\/platform-matrix.ts --windows-readiness/);
});
