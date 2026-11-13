import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CHECK_ID,
  DEFAULT_EXCEPTIONS_RELATIVE_PATH,
  compatHitsInRepo,
  compatHitsInSource,
  compatProblems,
  compatProblemsForHits,
  compatProblemsForSources,
  isProductionTarget,
  loadCompatExceptions,
  loadCompatRegister,
  splitIdentifierWords,
  summarizeCompatHits,
  trackedProductionFiles,
} from './no-compat-paths.ts';
import type { CompatRegister } from './no-compat-paths.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const TEST_REGISTER: CompatRegister = {
  schema: 'compat-register@1',
  excludePaths: ['hub/records/migrations.ts'],
  words: ['legacy', 'backcompat', 'compat', 'dual', 'shim', 'historical'],
  literals: ['bind-legacy', 'bind-skills'],
  prefixes: ['CIRCLE_SERVER_'],
  symbols: [
    'bindLegacySkills',
    'dualWrite',
    'verifyLocalFile',
    'RETIRED_PREFIX',
    'retiredEnvironmentKeys',
    'isRetiredName',
    'RetiredName',
  ],
};

test('splitIdentifierWords handles camelCase, acronyms, snake_case, and private names', () => {
  assert.deepEqual(splitIdentifierWords('legacyValue'), ['legacy', 'value']);
  assert.deepEqual(splitIdentifierWords('HTTPCompatMode'), ['http', 'compat', 'mode']);
  assert.deepEqual(splitIdentifierWords('RETIRED_NAMES'), ['retired', 'names']);
  assert.deepEqual(splitIdentifierWords('#legacySecret'), ['legacy', 'secret']);
  assert.deepEqual(splitIdentifierWords('refs.legacy-migration'), ['refs', 'legacy', 'migration']);
});

test('isProductionTarget keeps only hub/ and contracts/src/ production files', () => {
  assert.equal(isProductionTarget('hub/server/main.ts'), true);
  assert.equal(isProductionTarget('contracts/src/run.ts'), true);

  assert.equal(isProductionTarget('hub/records/migrations.ts'), false);
  assert.equal(isProductionTarget('hub/server/main.test.ts'), false);
  assert.equal(isProductionTarget('hub/testing/postgres.ts'), false);
  assert.equal(isProductionTarget('hub/refs/skill-lazy-support.ts'), false);
  assert.equal(isProductionTarget('hub/runs/fakes.ts'), false);
  assert.equal(isProductionTarget('hub/server/testing-real.ts'), false);
  assert.equal(isProductionTarget('hub/server/testingFoo.ts'), false);
  assert.equal(isProductionTarget('hub/server/assemble/test-cli.ts'), false);
  assert.equal(isProductionTarget('contracts/src/fixtures.ts'), false);
  assert.equal(isProductionTarget('contracts/src/feeding-fixtures.ts'), false);
  assert.equal(isProductionTarget('hub/health/fixtures/crash-child.ts'), false);
  assert.equal(isProductionTarget('docs/compat.ts'), false);
  assert.equal(isProductionTarget('hub/types.d.ts'), false);
});

test('compatHitsInSource ignores comments, JSDoc, regexes, domain retired status, and unrelated superstrings', () => {
  const cleanCode = [
    '// legacy compat fallback workaround',
    '/* bindLegacySkills dualWrite CIRCLE_SERVER_HOST */',
    '/** @deprecated Do not reintroduce retired legacy or bind-legacy paths */',
    "const packStatus: 'retired' | 'published' = 'retired';",
    'export function checkValues(individual: string, compatibility: boolean, shimmer: number, retiredCount: number) {',
    '  const residualPattern = /legacy|compat|bind-legacy|CIRCLE_SERVER_/i;',
    '  const template = `incompatible residual ${individual}`;',
    '  return { residualPattern, template, compatibility, shimmer, packStatus, retiredCount };',
    '}',
  ].join('\n');

  assert.deepEqual(compatHitsInSource('hub/example/clean.ts', cleanCode, TEST_REGISTER), []);
});

test('compatHitsInSource catches identifiers, declarations, private fields, strings, and templates', () => {
  const dirtyCode = [
    "import { bindLegacySkills, isRetiredName } from './helpers.ts';",
    'export interface CompatConfig { readonly backcompat?: boolean; }',
    'export type HistoricalState = { readonly "bind-legacy": string; readonly kind: RetiredName };',
    'export enum DualMode { Active = "active" }',
    'export class Adapter {',
    '  #legacyToken = "verifyLocalFile";',
    '  run(argCompat: string) {',
    '    const env = "CIRCLE_SERVER_HOST";',
    '    const cmd = `run bind-skills ${argCompat}-shim`;',
    '    const k = [RETIRED_PREFIX, ...retiredEnvironmentKeys()];',
    '    return { env, cmd, token: this.#legacyToken, fn: bindLegacySkills, ok: isRetiredName(k[0]) };',
    '  }',
    '}',
  ].join('\n');

  const hits = compatHitsInSource('hub/example/dirty.ts', dirtyCode, TEST_REGISTER);
  const whats = hits.map((hit) => `${hit.line}:${hit.what}`);

  assert.deepEqual(whats, [
    '1:symbol:bindLegacySkills',
    '1:symbol:isRetiredName',
    '2:word:compat',
    '2:word:backcompat',
    '3:word:historical',
    '3:literal:bind-legacy',
    '3:symbol:RetiredName',
    '4:word:dual',
    '6:word:legacy',
    '6:symbol:verifyLocalFile',
    '7:word:compat',
    '8:prefix:CIRCLE_SERVER_',
    '9:literal:bind-skills',
    '9:word:compat',
    '9:word:shim',
    '10:symbol:RETIRED_PREFIX',
    '10:symbol:retiredEnvironmentKeys',
    '11:word:legacy',
    '11:symbol:bindLegacySkills',
    '11:symbol:isRetiredName',
  ]);
});

test('compatProblemsForSources enforces strict bidirectional alignment with exceptions', () => {
  const sources = [
    { path: 'hub/records/migrations.ts', content: 'export const legacyMigration = 1;' },
    { path: 'hub/runs/legacy-only.test.ts', content: 'export const compat = 1;' },
    { path: 'hub/runs/active.ts', content: 'export const legacyFlag = true;\nexport const cmd = "bind-legacy";' },
  ];

  const validExceptions = [
    { check: 'other-check', path: 'hub/runs/active.ts', what: 'word:legacy', reason: 'wrong check', removeWhen: 'never' },
    { check: CHECK_ID, path: 'hub/runs/active.ts', what: 'word:legacy', reason: 'pending C3 cleanup', removeWhen: 'C3' },
    { check: CHECK_ID, path: 'hub/runs/active.ts', what: 'literal:bind-legacy', reason: 'pending C3 cleanup', removeWhen: 'C3' },
  ];

  assert.deepEqual(compatProblemsForSources(sources, validExceptions, TEST_REGISTER), []);

  const missingProblems = compatProblemsForSources(sources, [validExceptions[1]], TEST_REGISTER);
  assert.equal(missingProblems.length, 1);
  assert.match(missingProblems[0], /hub\/runs\/active\.ts:2: unlisted compat path \[literal:bind-legacy\]/);

  const staleProblems = compatProblemsForSources(
    sources,
    [
      ...validExceptions,
      { check: CHECK_ID, path: 'hub/runs/deleted.ts', what: 'symbol:dualWrite', reason: 'old', removeWhen: 'C3' },
    ],
    TEST_REGISTER,
  );
  assert.equal(staleProblems.length, 1);
  assert.match(staleProblems[0], /stale no-compat-paths exception for hub\/runs\/deleted\.ts \[symbol:dualWrite\] \(removeWhen: C3\)/);

  const duplicateAndInvalid = compatProblemsForSources(
    sources,
    [
      ...validExceptions,
      { check: CHECK_ID, path: 'hub/runs/active.ts', what: 'word:legacy', reason: 'dup', removeWhen: 'C3' },
      { check: CHECK_ID, path: 'hub/runs/active.ts', what: 'badprefix:foo', reason: 'bad', removeWhen: 'C3' },
    ],
    TEST_REGISTER,
  );
  assert.equal(duplicateAndInvalid.length, 2);
});

test('loadCompatExceptions supports array JSON, object wrapper JSON, and explicit missing-path errors', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'compat-check-test-'));
  try {
    writeFileSync(join(tempRoot, 'sample.ts'), 'export const compatFlag = 1;\n', 'utf8');
    const arrayPath = join(tempRoot, 'exceptions-array.json');
    const objectPath = join(tempRoot, 'exceptions-object.json');

    const entries = [
      { check: CHECK_ID, path: 'hub/sample.ts', what: 'word:compat', reason: 'temp', removeWhen: 'C3' },
    ];
    writeFileSync(arrayPath, JSON.stringify(entries), 'utf8');
    writeFileSync(objectPath, JSON.stringify({ schema: 'exceptions@1', exceptions: entries }), 'utf8');

    assert.equal(loadCompatExceptions(tempRoot, arrayPath).length, 1);
    assert.equal(loadCompatExceptions(tempRoot, objectPath).length, 1);
    assert.deepEqual(loadCompatExceptions(tempRoot), []);

    assert.throws(() => loadCompatExceptions(tempRoot, 'missing-exceptions.json'), /Exceptions file not found/);

    const hits = compatHitsInSource('hub/sample.ts', 'export const compatFlag = 1;', TEST_REGISTER);
    assert.deepEqual(compatProblemsForHits(hits, loadCompatExceptions(tempRoot, objectPath)), []);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('repository scan excludes migrations and tests and aligns with exceptions when present', () => {
  const register = loadCompatRegister(REPO_ROOT);
  const files = trackedProductionFiles(REPO_ROOT, register.excludePaths);
  assert.ok(files.length > 450, `Expected >450 production files, found ${files.length}`);
  assert.equal(files.includes('hub/records/migrations.ts'), false);
  assert.equal(files.some((file) => file.endsWith('.test.ts') || file.startsWith('hub/testing/')), false);

  const exceptionsPath = join(REPO_ROOT, DEFAULT_EXCEPTIONS_RELATIVE_PATH);
  if (existsSync(exceptionsPath)) {
    assert.deepEqual(compatProblems(REPO_ROOT), []);
    return;
  }

  const hits = compatHitsInRepo(REPO_ROOT, { register });
  const summary = summarizeCompatHits(hits);
  assert.ok(summary.uniquePairs > 0);

  const generatedExceptions = summary.pairs.map((pair) => ({
    check: CHECK_ID,
    path: pair.path,
    what: pair.what,
    reason: 'Pending owner approval / C3 removal',
    removeWhen: 'C3',
  }));
  assert.deepEqual(compatProblems(REPO_ROOT, { register, exceptions: generatedExceptions }), []);
  assert.ok(compatProblems(REPO_ROOT, { register, exceptions: [] }).length === summary.uniquePairs);
});
