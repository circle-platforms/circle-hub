import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { guardProblem, guardProblems, isolatedImports } from './sandbox-guards.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('every tracked test file that runs pack functions in the sandbox uses a shared guard', () => {
  assert.deepEqual(guardProblems(ROOT), []);
});

test('a test that calls a pack function without a guard is reported', () => {
  const source = [
    "import { test } from 'node:test';",
    "import {",
    '  callPackFunction,',
    '  SandboxError,',
    "} from '../../hub/rules/api.ts';",
    "test('runs', async () => { await callPackFunction({ packDir: 'p', module: 'm', export: 'e' }, {}); });",
  ].join('\n');
  const problem = guardProblem('packs/sample/functions.test.ts', source);
  assert.ok(problem !== undefined);
  assert.match(problem, /^packs\/sample\/functions\.test\.ts: imports callPackFunction from hub\/rules\/api\.ts but never uses sandboxSkip/);
});

test('each shared guard, or the declared opt-out, satisfies the rule', () => {
  const imports = "import { callPackFunction } from '../../hub/rules/api.ts';\n";
  for (const guard of [
    "import { sandboxSkip } from '../../hub/runs/engine/testing/harness.ts';\nconst skip = await sandboxSkip();",
    "import { osIsolationAvailable } from '../../hub/rules/api.ts';\nconst os = await osIsolationAvailable();",
    'await callPackFunction(target, {}, {}, { requireOsIsolation: false });',
  ]) {
    assert.equal(guardProblem('packs/sample/functions.test.ts', imports + guard), undefined, guard);
  }
});

test('imports are resolved from the test file, with aliases, namespaces and the sandbox modules themselves', () => {
  assert.deepEqual(isolatedImports('hub/rules/sandbox/batch.test.ts', "import { callPackFunctionBatch as batch } from './sandbox.ts';"), [
    'callPackFunctionBatch from hub/rules/sandbox/sandbox.ts',
  ]);
  assert.deepEqual(isolatedImports('hub/runs/x.test.ts', "import * as rules from '../rules/api.ts';\nawait rules.callPackFunction(t, {});"), [
    'callPackFunction from hub/rules/api.ts',
  ]);
  assert.deepEqual(isolatedImports('hub/rules/sandbox/probe.test.ts', "import { isolatedCommand } from './isolation.ts';"), ['isolatedCommand from hub/rules/sandbox/isolation.ts']);
});

test('type imports, other exports and same-named modules elsewhere are not sandbox calls', () => {
  assert.deepEqual(isolatedImports('hub/runs/x.test.ts', "import type { SandboxResult } from '../rules/api.ts';"), []);
  assert.deepEqual(isolatedImports('hub/runs/x.test.ts', "import { type SandboxOptions, SandboxError } from '../rules/api.ts';"), []);
  assert.deepEqual(isolatedImports('hub/runs/x.test.ts', "import { callPackFunction } from './api.ts';"), []);
  assert.deepEqual(isolatedImports('hub/runs/x.test.ts', "import * as rules from '../rules/api.ts';\nrules.SANDBOX_ERRORS;"), []);
});
