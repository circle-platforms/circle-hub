import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CORE_NAMES_CHECK,
  DEFAULT_EXCEPTIONS_PATH,
  coreNameHitsInFile,
  coreNameProblemsFromModules,
  coreNamesNoPackProblems,
  findPackNameHits,
  isCoreProductionFile,
  loadCoreProductionModules,
  loadPackCatalog,
  type CheckException,
  type PackManifestInfo,
  type SourceModule,
} from './core-names-no-pack.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function withTempGitRepo(run: (root: string, git: (...args: string[]) => void) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'core-names-no-pack-'));
  const git = (...args: string[]): void => {
    execFileSync(
      'git',
      ['-c', 'user.name=Synthetic Check', '-c', 'user.email=check@example.com', '-c', 'commit.gpgsign=false', ...args],
      { cwd: root, stdio: 'pipe' },
    );
  };
  try {
    git('init', '-b', 'main');
    run(root, git);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeRepoFile(root: string, relPath: string, content: string): void {
  const fullPath = join(root, relPath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content);
}

test('repository production modules under hub/ and contracts/src/ match core-names-no-pack exceptions', () => {
  const exceptionsFile = join(ROOT, DEFAULT_EXCEPTIONS_PATH);
  if (existsSync(exceptionsFile)) {
    assert.deepEqual(coreNamesNoPackProblems(ROOT), []);
    return;
  }

  // Standalone mode without .github/checks/exceptions.json must fail rather than silently skipping.
  const strictProblems = coreNamesNoPackProblems(ROOT);
  assert.ok(strictProblems.length >= 2);
  assert.equal(strictProblems[0], `${DEFAULT_EXCEPTIONS_PATH}: exceptions file is missing`);

  const packs = loadPackCatalog(ROOT);
  const modules = loadCoreProductionModules(ROOT);
  assert.ok(modules.length > 400, `expected >400 core production modules, got ${modules.length}`);

  const hits = findPackNameHits(modules, packs);
  assert.ok(hits.length > 0, 'live core modules currently contain known pack references');
  const syntheticExceptions: CheckException[] = hits.map((hit) => ({
    check: CORE_NAMES_CHECK,
    path: hit.path,
    what: hit.what,
    reason: 'Live baseline hit pending C6 or policy registration',
    removeWhen: 'C6',
  }));
  assert.deepEqual(coreNamesNoPackProblems(ROOT, { exceptions: syntheticExceptions }), []);
});

test('pack enumeration dynamically reads packs/{product,skill,system,workflow}/*/pack.json from disk', () => {
  const diskManifests = globSync('packs/{product,skill,system,workflow}/*/pack.json', { cwd: ROOT })
    .map((p) => p.replaceAll('\\', '/'))
    .sort();
  const discovered = loadPackCatalog(ROOT);
  assert.equal(discovered.length, diskManifests.length);
  assert.deepEqual(
    discovered.map((pack) => pack.manifestPath),
    diskManifests,
  );
  for (const pack of discovered) {
    const json = JSON.parse(readFileSync(join(ROOT, pack.manifestPath), 'utf8')) as { id: string; kind: string };
    assert.equal(pack.id, json.id);
    assert.equal(pack.kind, json.kind);
  }
  assert.deepEqual([...new Set(discovered.map((pack) => pack.kind))].sort(), ['product', 'skill', 'system', 'workflow']);
});

test('adding a new pack.json immediately makes core references to its id fail without checker edits', () => {
  withTempGitRepo((root, git) => {
    writeRepoFile(root, 'packs/workflow/dynamic-demo/pack.json', JSON.stringify({ id: 'dynamic-demo', kind: 'workflow' }));
    writeRepoFile(root, 'hub/runs/router.ts', "export const target = 'dynamic-demo';\n");
    writeRepoFile(root, '.github/checks/exceptions.json', '[]\n');
    git('add', '.');
    git('commit', '-m', 'Add synthetic pack and core reference');

    const problems = coreNamesNoPackProblems(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^hub\/runs\/router\.ts:1: unregistered pack reference "dynamic-demo"/);
  });
});

test('AST detection catches imports, exports, dynamic imports, requires, import types, pack paths and string/template literals', () => {
  const packs: PackManifestInfo[] = [
    { id: 'alpha-flow', kind: 'workflow', manifestPath: 'packs/workflow/alpha-flow/pack.json', directory: 'packs/workflow/alpha-flow' },
    { id: 'beta-skill', kind: 'skill', manifestPath: 'packs/skill/beta-skill/pack.json', directory: 'packs/skill/beta-skill' },
    { id: 'gamma-sys', kind: 'system', manifestPath: 'packs/system/gamma-sys/pack.json', directory: 'packs/system/gamma-sys' },
    { id: 'delta-prod', kind: 'product', manifestPath: 'packs/product/delta-prod/pack.json', directory: 'packs/product/delta-prod' },
  ];

  const sample = [
    "import { run } from '../../packs/workflow/alpha-flow/api.ts';",
    "import type { SkillType } from '../../packs/skill/beta-skill/api.ts';",
    "export { ping } from '../../packs/system/gamma-sys/api.ts';",
    "export async function loadProd() { return await import('../../packs/product/delta-prod/api.ts'); }",
    "const cjs = require('../../packs/workflow/alpha-flow/helper.cjs');",
    "export type TypeRef = import('../../packs/skill/beta-skill/types.ts').Entry;",
    'export async function dyn(name: string) { return await import(`../../packs/workflow/${name}/api.ts`); }',
    "const exact = 'alpha-flow';",
    'const noSub = `beta-skill`;',
    'const templateMsg = `invoke ${exact} with gamma-sys now`;',
    "const nonImportPath = 'read packs/product/delta-prod/manifest.json';",
    'const map = { "delta-prod": true };',
    'export type PackLiteral = "alpha-flow";',
  ].join('\n');

  const hits = coreNameHitsInFile('hub/runs/sample.ts', sample, packs.map((p) => p.id), packs.map((p) => p.kind));
  assert.deepEqual(
    hits.map((h) => ({ what: h.what, lines: h.lines })),
    [
      { what: 'alpha-flow', lines: [8, 13] },
      { what: 'beta-skill', lines: [9] },
      { what: 'delta-prod', lines: [12] },
      { what: 'gamma-sys', lines: [10] },
      { what: 'import packs/product/delta-prod/api.ts', lines: [4] },
      { what: 'import packs/skill/beta-skill/api.ts', lines: [2] },
      { what: 'import packs/skill/beta-skill/types.ts', lines: [6] },
      { what: 'import packs/system/gamma-sys/api.ts', lines: [3] },
      { what: 'import packs/workflow', lines: [7] },
      { what: 'import packs/workflow/alpha-flow/api.ts', lines: [1] },
      { what: 'import packs/workflow/alpha-flow/helper.cjs', lines: [5] },
      { what: 'packs/product/delta-prod', lines: [11] },
    ],
  );
});

test('comments, internal ./packs modules, console routes, case mismatches, boundary extensions and non-production files pass cleanly', () => {
  const packs: PackManifestInfo[] = [
    { id: 'alpha-flow', kind: 'workflow', manifestPath: 'packs/workflow/alpha-flow/pack.json', directory: 'packs/workflow/alpha-flow' },
    { id: 'svn', kind: 'system', manifestPath: 'packs/system/svn/pack.json', directory: 'packs/system/svn' },
  ];

  const modules: SourceModule[] = [
    {
      file: 'hub/runs/api.ts',
      source: [
        '// alpha-flow and ../../packs/workflow/alpha-flow/api.ts in a comment',
        '/* svn in a block comment */',
        "import { registry } from './packs/registry.ts';",
        "import { ports } from '../runs/packs/ports.ts';",
        "const route = '/console/packs/-/publish';",
        "const backupPrefix = 'packs/';",
        "const stage = 'packs/stage';",
        "const protocol = 'SVN';",
        "const longerToken = 'alpha-flow-extended';",
        "const prefixToken = 'my-alpha-flow';",
        'export const ok = { registry, ports, route, backupPrefix, stage, protocol, longerToken, prefixToken };',
      ].join('\n'),
    },
    { file: 'contracts/src/clean.ts', source: "export const kind = 'workflow';\n" },
    // All non-production and out-of-scope files must be ignored even when referencing pack ids/paths.
    { file: 'contracts/generated/shared-interfaces.ts', source: "export const id = 'alpha-flow';\n" },
    { file: 'packs/workflow/alpha-flow/functions/index.ts', source: "export const id = 'alpha-flow';\n" },
    { file: 'hub/runs/sample.test.ts', source: "import '../../packs/workflow/alpha-flow/api.ts';\nexport const id = 'alpha-flow';\n" },
    { file: 'hub/testing/records.ts', source: "export const id = 'alpha-flow';\n" },
    { file: 'hub/runs/engine/testing/harness.ts', source: "export const id = 'alpha-flow';\n" },
    { file: 'hub/health/fixtures/crash-child.ts', source: "export const id = 'alpha-flow';\n" },
    { file: 'hub/knowledge/test-support.ts', source: "export const id = 'alpha-flow';\n" },
    { file: 'hub/server/fakes.ts', source: "export const id = 'alpha-flow';\n" },
    { file: 'hub/server/testing-real.ts', source: "export const id = 'alpha-flow';\n" },
    { file: 'hub/server/assemble/test-packs.ts', source: "export const id = 'alpha-flow';\n" },
    { file: 'contracts/src/feeding-fixtures.ts', source: "export const id = 'svn';\n" },
  ];

  assert.deepEqual(findPackNameHits(modules, packs), []);
  assert.deepEqual(coreNameProblemsFromModules(modules, packs), []);

  assert.equal(isCoreProductionFile('hub/runs/api.ts'), true);
  assert.equal(isCoreProductionFile('contracts/src/pack.ts'), true);
  assert.equal(isCoreProductionFile('contracts/generated/protocol.ts'), false);
  assert.equal(isCoreProductionFile('hub/testing/postgres.ts'), false);
  assert.equal(isCoreProductionFile('hub/refs/skill-lazy-support.ts'), false);
  assert.equal(isCoreProductionFile('hub/server/fakes.ts'), false);
  assert.equal(isCoreProductionFile('hub/server/console/testing-wording.ts'), false);
  assert.equal(isCoreProductionFile('hub/server/assemble/test-packs.ts'), false);
  assert.equal(isCoreProductionFile('contracts/src/feeding-fixtures.ts'), false);
});

test('strict bidirectional exception verification catches missing, stale, duplicate and malformed entries', () => {
  withTempGitRepo((root, git) => {
    writeRepoFile(root, 'packs/workflow/sample-flow/pack.json', JSON.stringify({ id: 'sample-flow', kind: 'workflow' }));
    writeRepoFile(root, 'packs/skill/sample-skill/pack.json', JSON.stringify({ id: 'sample-skill', kind: 'skill' }));
    writeRepoFile(root, 'hub/runs/use.ts', "export const pack = 'sample-flow';\n");
    writeRepoFile(root, 'contracts/src/schema.ts', "export const note = 'uses sample-skill';\n");
    git('add', '.');
    git('commit', '-m', 'Add synthetic core pack references');

    // Absent exceptions.json fails in default standalone mode.
    const missingFileProblems = coreNamesNoPackProblems(root);
    assert.equal(missingFileProblems.length, 3);
    assert.equal(missingFileProblems[0], `${DEFAULT_EXCEPTIONS_PATH}: exceptions file is missing`);

    const validEntries: CheckException[] = [
      { check: 'package-cycles', path: 'hub/runs', what: 'runs -> dispatch', reason: 'unrelated check', removeWhen: 'C4' },
      { check: CORE_NAMES_CHECK, path: 'hub/runs/use.ts', what: 'sample-flow', reason: 'pending C6', removeWhen: 'C6' },
      { check: CORE_NAMES_CHECK, path: 'contracts/src/schema.ts', what: 'sample-skill', reason: 'pending C6', removeWhen: 'C6' },
    ];
    writeRepoFile(root, '.github/checks/exceptions.json', JSON.stringify(validEntries, null, 2));
    assert.deepEqual(coreNamesNoPackProblems(root), []);

    // Custom exceptionsPath (relative and absolute) also works.
    const customRel = '.github/checks/custom-exceptions.json';
    writeRepoFile(root, customRel, JSON.stringify(validEntries, null, 2));
    assert.deepEqual(coreNamesNoPackProblems(root, { exceptionsPath: customRel }), []);
    assert.deepEqual(coreNamesNoPackProblems(root, { exceptionsPath: join(root, customRel) }), []);

    // Missing one live hit fails.
    assert.equal(coreNamesNoPackProblems(root, { exceptions: validEntries.slice(0, 2) }).length, 1);

    // Stale exception fails when code no longer hits.
    const withStale: CheckException[] = [
      ...validEntries,
      { check: CORE_NAMES_CHECK, path: 'hub/runs/fixed.ts', what: 'sample-flow', reason: 'already removed', removeWhen: 'C6' },
    ];
    const staleProblems = coreNamesNoPackProblems(root, { exceptions: withStale });
    assert.equal(staleProblems.length, 1);
    assert.match(staleProblems[0], /^hub\/runs\/fixed\.ts: stale core-names-no-pack exception/);

    // Duplicate exception fails.
    const dupProblems = coreNamesNoPackProblems(root, { exceptions: [...validEntries, validEntries[1]] });
    assert.equal(dupProblems.length, 1);
    assert.match(dupProblems[0], /^hub\/runs\/use\.ts: duplicate core-names-no-pack exception/);

    // Incomplete exception entry fails.
    const badProblems = coreNamesNoPackProblems(root, {
      exceptions: [{ check: CORE_NAMES_CHECK, path: 'hub/runs/use.ts', what: 'sample-flow', reason: '  ', removeWhen: 'C6' }],
    });
    assert.ok(badProblems.some((p) => p.includes('must have non-empty string path, what, reason and removeWhen')));

    // Invalid JSON file fails cleanly.
    writeRepoFile(root, '.github/checks/exceptions.json', '{not-json');
    const jsonProblems = coreNamesNoPackProblems(root);
    assert.equal(jsonProblems.length, 1);
    assert.match(jsonProblems[0], /failed to parse JSON/);
  });
});
