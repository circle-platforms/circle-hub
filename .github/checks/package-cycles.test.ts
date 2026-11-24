import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_EXCEPTIONS_PATH,
  PACKAGE_CYCLES_CHECK,
  cycleProblems,
  cycleProblemsFromModules,
  findPackageCycles,
  isProductionHubFile,
  loadHubProductionModules,
  type CheckException,
  type SourceModule,
} from './package-cycles.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('repository production modules match registered package-cycles exceptions', () => {
  const exceptionsFile = join(ROOT, DEFAULT_EXCEPTIONS_PATH);
  if (existsSync(exceptionsFile)) {
    assert.deepEqual(cycleProblems(ROOT), []);
    return;
  }

  const strictProblems = cycleProblems(ROOT);
  assert.ok(strictProblems.length >= 2);
  assert.equal(strictProblems[0], `${DEFAULT_EXCEPTIONS_PATH}: exceptions file is missing`);

  const modules = loadHubProductionModules(ROOT);
  assert.ok(modules.length > 300, `expected >300 production hub modules, got ${modules.length}`);

  const cycles = findPackageCycles(modules);
  assert.ok(cycles.length >= 1, 'live hub modules currently contain known C4 package cycles');
  const syntheticExceptions: CheckException[] = cycles.flatMap((cycle) =>
    cycle.edges.map((edge) => ({
      check: PACKAGE_CYCLES_CHECK,
      path: `hub/${edge.from}`,
      what: `${edge.from} -> ${edge.to}`,
      reason: `C4 baseline SCC [${cycle.members.join(', ')}]`,
      removeWhen: 'C4',
    })),
  );
  assert.deepEqual(cycleProblems(ROOT, { exceptions: syntheticExceptions }), []);

  const withoutUsageLeaf = cycles.map((cycle) => cycle.members);
  const withUsageLeaf = findPackageCycles(modules, { leafTargets: ['hub/telemetry/usage.ts'] }).map((cycle) => cycle.members);
  assert.ok(withoutUsageLeaf.some((members) => members.includes('records') && members.includes('telemetry')));
  assert.ok(!withUsageLeaf.some((members) => members.includes('records') && members.includes('telemetry')));
});

test('acyclic packages, leaves, intra-package imports and test/support files produce no cycles', () => {
  const modules: SourceModule[] = [
    {
      file: 'hub/a/api.ts',
      source: [
        "import { helper } from './internal.ts';",
        "import type { Port } from '../ports.ts';",
        "import { validListenAddress } from '../listen.ts';",
        "import type { RecordKind } from '../../contracts/generated/protocol.ts';",
        '// import { x } from "../b/api.ts";',
        'const text = "import { y } from \'../b/api.ts\'";',
        'export const a = { helper, validListenAddress, text };',
      ].join('\n'),
    },
    { file: 'hub/a/internal.ts', source: "import './api.ts';\nexport const helper = 1;" },
    { file: 'hub/b/api.ts', source: "import { a } from '../a/api.ts';\nexport const b = a;" },
    { file: 'hub/c/api.ts', source: "import { b } from '../b/api.ts';\nimport { a } from '../a/api.ts';\nexport const c = { a, b };" },
    { file: 'hub/a/cycle.test.ts', source: "import { c } from '../c/api.ts';" },
    { file: 'hub/a/testing/fixture.ts', source: "import { c } from '../c/api.ts';" },
    { file: 'hub/a/fakes.ts', source: "import { c } from '../c/api.ts';" },
    { file: 'hub/a/test-support.ts', source: "import { c } from '../c/api.ts';" },
    { file: 'hub/a/testing-helper.ts', source: "import { c } from '../c/api.ts';" },
    { file: 'hub/a/test-helper.ts', source: "import { c } from '../c/api.ts';" },
    { file: 'hub/health/fixtures/crash.ts', source: "import { c } from '../../c/api.ts';" },
    { file: 'hub/ports.ts', source: "import type { b } from './b/api.ts';" },
  ];

  assert.deepEqual(findPackageCycles(modules), []);
  assert.deepEqual(cycleProblemsFromModules(modules), []);
  assert.equal(isProductionHubFile('hub/server/console/index.ts'), true);
  assert.equal(isProductionHubFile('hub/server/console/testing-security.ts'), false);
  assert.equal(isProductionHubFile('hub/server/assemble/test-cli.ts'), false);
  assert.equal(isProductionHubFile('hub/testing/postgres.ts'), false);
  assert.equal(isProductionHubFile('contracts/src/run.ts'), false);
});

test('value, type-only, re-export, import() type and dynamic imports all count toward package cycles', () => {
  const modules: SourceModule[] = [
    { file: 'hub/alpha/api.ts', source: "import { beta } from '../beta/api.ts';\nexport const alpha = beta;" },
    { file: 'hub/beta/api.ts', source: "import type { Alpha } from '../alpha/api.ts';\nexport const beta = 1;" },
    { file: 'hub/gamma/a.ts', source: "import { type Delta } from '../delta/api.ts';\nexport const g = 1;" },
    { file: 'hub/delta/api.ts', source: "export type { Epsilon } from '../epsilon/api.ts';" },
    { file: 'hub/epsilon/api.ts', source: "export async function load() { return await import('../gamma/a.ts'); }" },
    { file: 'hub/zeta/api.ts', source: "export type Ref = import('../gamma/a.ts').NonExistent;" },
  ];

  const cycles = findPackageCycles(modules);
  assert.equal(cycles.length, 2);
  assert.deepEqual(cycles[0]?.members, ['alpha', 'beta']);
  assert.deepEqual(
    cycles[0]?.edges.map((e) => ({ from: e.from, to: e.to, kinds: e.sites.map((s) => s.kind) })),
    [
      { from: 'alpha', to: 'beta', kinds: ['value'] },
      { from: 'beta', to: 'alpha', kinds: ['type'] },
    ],
  );
  assert.deepEqual(cycles[1]?.members, ['delta', 'epsilon', 'gamma']);
  assert.deepEqual(
    cycles[1]?.edges.map((e) => ({ from: e.from, to: e.to, kinds: e.sites.map((s) => s.kind) })),
    [
      { from: 'delta', to: 'epsilon', kinds: ['type'] },
      { from: 'epsilon', to: 'gamma', kinds: ['value'] },
      { from: 'gamma', to: 'delta', kinds: ['type'] },
    ],
  );
});

test('bidirectional exception verification catches unregistered edges, stale entries, duplicates and malformed rows', () => {
  const modules: SourceModule[] = [
    { file: 'hub/a/api.ts', source: "import { b } from '../b/api.ts';\nexport const a = b;" },
    { file: 'hub/b/api.ts', source: "import { a } from '../a/api.ts';\nexport const b = a;" },
  ];

  const validExceptions: CheckException[] = [
    { check: 'package-boundaries', path: 'hub/a/api.ts', what: 'unrelated', reason: 'other check', removeWhen: 'C4' },
    { check: PACKAGE_CYCLES_CHECK, path: 'hub/a', what: 'a -> b', reason: 'known cycle', removeWhen: 'C4' },
    { check: PACKAGE_CYCLES_CHECK, path: 'hub/b', what: 'b -> a', reason: 'known cycle', removeWhen: 'C4' },
  ];
  assert.deepEqual(cycleProblemsFromModules(modules, { exceptions: validExceptions }), []);

  const missingOne = cycleProblemsFromModules(modules, { exceptions: [validExceptions[1]!] });
  assert.equal(missingOne.length, 1);
  assert.match(missingOne[0]!, /^hub\/b: unregistered package cycle edge b -> a in SCC \[a, b\] \(hub\/b\/api\.ts:1 -> hub\/a\/api\.ts \[value\]\)$/);

  const withNewEdge: SourceModule[] = [
    { file: 'hub/a/api.ts', source: "import { b } from '../b/api.ts';\nimport { c } from '../c/api.ts';\nexport const a = b + c;" },
    { file: 'hub/b/api.ts', source: "import { c } from '../c/api.ts';\nexport const b = c;" },
    { file: 'hub/c/api.ts', source: "import { a } from '../a/api.ts';\nexport const c = a;" },
  ];
  const threeWayBase: CheckException[] = [
    { check: PACKAGE_CYCLES_CHECK, path: 'hub/a', what: 'a -> b', reason: 'cycle', removeWhen: 'C4' },
    { check: PACKAGE_CYCLES_CHECK, path: 'hub/b', what: 'b -> c', reason: 'cycle', removeWhen: 'C4' },
    { check: PACKAGE_CYCLES_CHECK, path: 'hub/c', what: 'c -> a', reason: 'cycle', removeWhen: 'C4' },
  ];
  const newEdgeProblems = cycleProblemsFromModules(withNewEdge, { exceptions: threeWayBase });
  assert.equal(newEdgeProblems.length, 1);
  assert.match(newEdgeProblems[0]!, /^hub\/a: unregistered package cycle edge a -> c in SCC \[a, b, c\]/);

  const brokenCycle: SourceModule[] = [
    { file: 'hub/a/api.ts', source: "import { b } from '../b/api.ts';\nexport const a = b;" },
    { file: 'hub/b/api.ts', source: 'export const b = 1;' },
  ];
  const staleProblems = cycleProblemsFromModules(brokenCycle, { exceptions: validExceptions });
  assert.equal(staleProblems.length, 2);
  assert.match(staleProblems[0]!, /^hub\/a: stale package-cycles exception for a -> b/);
  assert.match(staleProblems[1]!, /^hub\/b: stale package-cycles exception for b -> a/);

  const badEntries: CheckException[] = [
    { check: PACKAGE_CYCLES_CHECK, path: 'hub/a', what: 'a -> b', reason: 'first', removeWhen: 'C4' },
    { check: PACKAGE_CYCLES_CHECK, path: 'hub/a', what: 'a -> b', reason: 'dup', removeWhen: 'C4' },
    { check: PACKAGE_CYCLES_CHECK, path: 'hub/b', what: 'b -> a', reason: ' ', removeWhen: 'C4' },
  ];
  const badProblems = cycleProblemsFromModules(modules, { exceptions: badEntries });
  assert.ok(badProblems.some((p) => p.includes('duplicate package-cycles exception')));
  assert.ok(badProblems.some((p) => p.includes('must have non-empty string')));
});

test('cycleProblems reports missing, malformed or non-array exceptionsPath files without leaking absolute paths', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'package-cycles-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const missingPath = join(dir, 'absent.json');
  const missingProblems = cycleProblems(ROOT, { exceptionsPath: missingPath });
  assert.match(missingProblems[0]!, /absent\.json: exceptions file is missing$/);

  const invalidJsonPath = join(dir, 'invalid.json');
  writeFileSync(invalidJsonPath, '{not json');
  const parseProblems = cycleProblems(ROOT, { exceptionsPath: invalidJsonPath });
  assert.equal(parseProblems.length, 1);
  assert.match(parseProblems[0]!, /invalid\.json: failed to parse JSON/);

  const objectJsonPath = join(dir, 'object.json');
  writeFileSync(objectJsonPath, '{}');
  const arrayProblems = cycleProblems(ROOT, { exceptionsPath: objectJsonPath });
  assert.equal(arrayProblems.length, 1);
  assert.match(arrayProblems[0]!, /object\.json: exceptions JSON must be an array/);

  const validJsonPath = join(dir, 'valid.json');
  const liveExceptions: CheckException[] = findPackageCycles(loadHubProductionModules(ROOT)).flatMap((cycle) =>
    cycle.edges.map((edge) => ({
      check: PACKAGE_CYCLES_CHECK,
      path: `hub/${edge.from}`,
      what: `${edge.from} -> ${edge.to}`,
      reason: `C4 baseline SCC [${cycle.members.join(', ')}]`,
      removeWhen: 'C4',
    })),
  );
  writeFileSync(validJsonPath, JSON.stringify(liveExceptions, null, 2));
  assert.deepEqual(cycleProblems(ROOT, { exceptionsPath: validJsonPath }), []);
});
