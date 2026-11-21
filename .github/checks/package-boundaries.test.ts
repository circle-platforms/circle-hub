import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CHECK_NAME,
  boundaryProblems,
  checkFileBoundaries,
  loadPackageEdges,
  main,
  reconcileExceptions,
  scanFileImports,
  scanRepositoryBoundaries,
  type ExceptionEntry,
  type PackageEdgesConfig,
} from './package-boundaries.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EDGES = loadPackageEdges(join(ROOT, '.github/checks/package-edges.json'));

function withTempGitRepo(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'package-boundaries-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    execFileSync('git', ['add', '.'], { cwd: dir });
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('repository production boundaries match package-edges.json and exceptions.json when present', () => {
  const exceptionsPath = join(ROOT, '.github/checks/exceptions.json');
  if (existsSync(exceptionsPath)) {
    assert.deepEqual(boundaryProblems(ROOT), []);
    return;
  }

  // Before exceptions.json lands on this branch, strict mode must fail on the missing manifest
  // while the underlying AST scan remains deterministic and preserves documented leaf exceptions.
  const strict = boundaryProblems(ROOT);
  assert.equal(strict.length, 1);
  assert.match(strict[0]!, /^missing exceptions manifest: \.github\/checks\/exceptions\.json/);

  const { violations, stats } = scanRepositoryBoundaries(ROOT);
  assert.ok(stats.filesScanned > 400, `expected > 400 production hub files, got ${stats.filesScanned}`);
  assert.ok(stats.specifiersScanned > 3000, `expected > 3000 import specifiers, got ${stats.specifiersScanned}`);
  assert.ok(stats.crossPackageImports > 500, `expected > 500 cross-package imports, got ${stats.crossPackageImports}`);
  assert.ok(violations.length > 0, 'expected live violations before C4/C6 cleanup');

  assert.equal(
    violations.some((v) => v.path === 'hub/refs/parser.ts' && v.target === 'hub/telemetry/usage.ts'),
    false,
    'refs -> hub/telemetry/usage.ts is a documented leaf exception',
  );
  assert.equal(
    violations.some((v) => v.path === 'hub/rules/sandbox/sandbox.ts' && v.target === 'hub/telemetry/usage.ts'),
    false,
    'rules -> hub/telemetry/usage.ts is a documented leaf exception',
  );
  assert.equal(
    violations.some((v) => v.path === 'hub/knowledge/directory-sources.ts' && v.target === 'packs/skill/adoc-format/api.ts'),
    false,
    'directory-sources.ts -> adoc-format/api.ts is allowed by pack_exceptions',
  );

  const recordsUsage = violations.filter((v) => v.path === 'hub/records/db.ts' && v.target === 'hub/telemetry/usage.ts');
  assert.deepEqual(
    recordsUsage.map((v) => v.kind),
    ['disallowed-dependency'],
    'records -> hub/telemetry/usage.ts should fail allowed_dependencies without being mislabeled as an entrypoint bypass',
  );
});

test('valid entrypoint, intra-package, shared leaf, and contracts imports pass cleanly', () => {
  const source = [
    "import { readFile } from 'node:fs/promises';",
    "import { z } from 'zod';",
    "import { canonicalize, type Principal } from '../records/api.ts';",
    "import type { SandboxOptions } from '../rules/api.ts';",
    "import { EXTERNAL_ARTIFACT, type ExternalReaderPort } from '../ports.ts';",
    "import { validListenAddress } from '../listen.ts';",
    "import type { ProtocolCode } from '../../contracts/generated/protocol.ts';",
    "import { IdSchema } from '../../contracts/src/common.ts';",
    "import { localHelper } from './helper.ts';",
    "// import { bogus } from '../records/db.ts';",
    "const text = \"import { fake } from '../records/db.ts';\";",
  ].join('\n');

  const result = checkFileBoundaries('hub/refs/resolve.ts', source, EDGES);
  assert.deepEqual(result.violations, []);
  assert.equal(result.crossPackageImports, 2);

  const serverConfig = checkFileBoundaries(
    'hub/server/sample.ts',
    "import type { HubConfig } from '../config/index.ts';",
    EDGES,
  );
  assert.deepEqual(serverConfig.violations, []);
  assert.equal(serverConfig.crossPackageImports, 1);
});

test('AST scanner catches value, type-only, re-export, dynamic import, and import-type bypasses while ignoring comments and strings', () => {
  const source = [
    "// import { x } from '../records/db.ts';",
    "const doc = `import type { Y } from '../records/store.ts'`;",
    "import { Database } from '../records/db.ts';",
    "import type { SchemaRow } from '../records/migrations.ts';",
    "import { type TokenRow } from '../records/principals.ts';",
    "export { callLog } from '../records/calllog.ts';",
    "export type { VaultEntry } from '../records/vault.ts';",
    "async function load() { return await import('../records/objects.ts'); }",
    "type Snap = import('../records/pointers.ts').Pointer;",
    "type Keys = typeof import('../records/keys.ts');",
  ].join('\n');

  const imports = scanFileImports('hub/refs/bad.ts', source);
  assert.equal(imports.length, 8);
  assert.deepEqual(
    imports.map((item) => [item.specifier, item.isTypeOnly]),
    [
      ['../records/db.ts', false],
      ['../records/migrations.ts', true],
      ['../records/principals.ts', true],
      ['../records/calllog.ts', false],
      ['../records/vault.ts', true],
      ['../records/objects.ts', false],
      ['../records/pointers.ts', true],
      ['../records/keys.ts', true],
    ],
  );

  const result = checkFileBoundaries('hub/refs/bad.ts', source, EDGES);
  assert.equal(result.violations.length, 8);
  assert.ok(result.violations.every((v) => v.kind === 'entrypoint-bypass'));
});

test('disallowed dependencies and telemetry/usage.ts boundaries are distinguished accurately', () => {
  const disallowedApi = checkFileBoundaries(
    'hub/refs/skills.ts',
    "import type { RunRecord } from '../runs/api.ts';",
    EDGES,
  );
  assert.deepEqual(
    disallowedApi.violations.map((v) => v.what),
    ['disallowed-dependency: hub/runs/api.ts'],
  );

  const bothBypassAndDisallowed = checkFileBoundaries(
    'hub/dispatch/rounds.ts',
    "import { computeRepetition } from '../runs/engine/repetition.ts';",
    EDGES,
  );
  assert.deepEqual(
    bothBypassAndDisallowed.violations.map((v) => v.what),
    ['entrypoint-bypass: hub/runs/engine/repetition.ts', 'disallowed-dependency: hub/runs/engine/repetition.ts'],
  );

  const allowedUsageRefs = checkFileBoundaries(
    'hub/refs/parser.ts',
    "import { step } from '../telemetry/usage.ts';",
    EDGES,
  );
  assert.deepEqual(allowedUsageRefs.violations, []);

  const allowedUsageRules = checkFileBoundaries(
    'hub/rules/sandbox/sandbox.ts',
    "import { addUsage } from '../../telemetry/usage.ts';",
    EDGES,
  );
  assert.deepEqual(allowedUsageRules.violations, []);

  const disallowedUsageAboveRecords = checkFileBoundaries(
    'hub/server/app.ts',
    "import { step } from '../telemetry/usage.ts';",
    EDGES,
  );
  assert.deepEqual(
    disallowedUsageAboveRecords.violations.map((v) => v.what),
    ['entrypoint-bypass: hub/telemetry/usage.ts'],
  );

  const disallowedUsageRecords = checkFileBoundaries(
    'hub/records/db.ts',
    "import { recordQuery } from '../telemetry/usage.ts';",
    EDGES,
  );
  assert.deepEqual(
    disallowedUsageRecords.violations.map((v) => v.what),
    ['disallowed-dependency: hub/telemetry/usage.ts'],
  );
});

test('shared_interfaces and shared_pure_modules enforce leaf purity rules', () => {
  const okPorts = checkFileBoundaries(
    'hub/ports.ts',
    [
      "import type { Principal } from './records/api.ts';",
      "import type { ProtocolCode } from '../contracts/generated/protocol.ts';",
      "export interface Port { principal: Principal; code: ProtocolCode; req: import('./requests/api.ts').RequestBody; }",
    ].join('\n'),
    EDGES,
  );
  assert.deepEqual(okPorts.violations, []);

  const badPorts = checkFileBoundaries(
    'hub/ports.ts',
    [
      "import { openRecords } from './records/api.ts';",
      "export type Feed = import('./knowledge/feeding.ts').FeedingLayer;",
    ].join('\n'),
    EDGES,
  );
  assert.deepEqual(
    badPorts.violations.map((v) => v.what),
    ['shared-interface-value-import: hub/records/api.ts', 'entrypoint-bypass: hub/knowledge/feeding.ts'],
  );

  const badPure = checkFileBoundaries(
    'hub/listen.ts',
    "import type { HubConfig } from './config/index.ts';",
    EDGES,
  );
  assert.deepEqual(
    badPure.violations.map((v) => v.what),
    ['shared-pure-import: hub/config/index.ts'],
  );
});

test('pack imports are blocked unless matched in pack_exceptions', () => {
  const allowedPack = checkFileBoundaries(
    'hub/knowledge/directory-sources.ts',
    "import { directoryOf } from '../../packs/skill/adoc-format/api.ts';",
    EDGES,
  );
  assert.deepEqual(allowedPack.violations, []);

  const bypassedPackInternal = checkFileBoundaries(
    'hub/knowledge/directory-sources.ts',
    "import { directoryOf } from '../../packs/skill/adoc-format/functions/directory.ts';",
    EDGES,
  );
  assert.deepEqual(
    bypassedPackInternal.violations.map((v) => v.what),
    ['pack-import: packs/skill/adoc-format/functions/directory.ts'],
  );

  const disallowedPack = checkFileBoundaries(
    'hub/dispatch/service.ts',
    "import { probe } from '../../packs/workflow/test-bed/api.ts';",
    EDGES,
  );
  assert.deepEqual(
    disallowedPack.violations.map((v) => v.what),
    ['pack-import: packs/workflow/test-bed/api.ts'],
  );
});

test('bidirectional exceptions reconciliation fails on missing file, unregistered violations, stale entries, and duplicates', () => {
  const { violations } = checkFileBoundaries(
    'hub/server/cli.ts',
    "import { Database } from '../records/db.ts';",
    EDGES,
  );
  assert.equal(violations.length, 1);

  const validException: ExceptionEntry = {
    check: CHECK_NAME,
    path: 'hub/server/cli.ts',
    what: 'entrypoint-bypass: hub/records/db.ts',
    reason: 'pending C4 cleanup',
    removeWhen: 'C4',
  };
  const otherCheckException: ExceptionEntry = {
    check: 'package-cycles',
    path: 'hub/records/db.ts',
    what: 'records -> telemetry',
  };

  assert.deepEqual(reconcileExceptions(violations, [validException, otherCheckException]), []);

  const unregistered = reconcileExceptions(violations, [otherCheckException]);
  assert.equal(unregistered.length, 1);
  assert.match(unregistered[0]!, /unregistered package-boundaries violation/);

  const stale = reconcileExceptions([], [validException]);
  assert.equal(stale.length, 1);
  assert.match(stale[0]!, /stale package-boundaries exception.*\[removeWhen: C4\]/);

  const duplicate = reconcileExceptions(violations, [validException, validException]);
  assert.equal(duplicate.length, 1);
  assert.match(duplicate[0]!, /duplicate exception entry/);
});

test('repository scan respects excluded patterns and strict exceptions.json loading in a synthetic git repo', () => {
  const customEdges: PackageEdgesConfig = {
    format_version: 1,
    entrypoints: {
      config: 'hub/config/index.ts',
      records: 'hub/records/api.ts',
      server: 'hub/server/api.ts',
    },
    allowed_dependencies: {
      config: [],
      records: ['config'],
      server: ['config', 'records'],
    },
    shared_interfaces: ['hub/ports.ts'],
    shared_pure_modules: ['hub/listen.ts'],
    excluded: EDGES.excluded,
  };

  const files: Record<string, string> = {
    'hub/config/index.ts': 'export const cfg = 1;\n',
    'hub/records/api.ts': "export { db } from './db.ts';\n",
    'hub/records/db.ts': "import { cfg } from '../config/index.ts';\nexport const db = cfg;\n",
    'hub/server/api.ts': "import { db } from '../records/db.ts';\nexport const srv = db;\n",
    'hub/server/api.test.ts': "import { db } from '../records/db.ts';\n",
    'hub/server/testing/helper.ts': "import { db } from '../../records/db.ts';\n",
    'hub/server/testing-browser.ts': "import { db } from '../records/db.ts';\n",
    'hub/server/test-cli.ts': "import { db } from '../records/db.ts';\n",
    'hub/server/fixtures/seed.ts': "import { db } from '../records/db.ts';\n",
    'hub/server/helper-support.ts': "import { db } from '../records/db.ts';\n",
    'hub/server/fakes.ts': "import { db } from '../records/db.ts';\n",
    'hub/testing/kit.ts': "import { db } from '../records/db.ts';\n",
    'hub/server/linux-listen-vm.ts': "import { db } from '../records/db.ts';\n",
    '.github/checks/package-edges.json': JSON.stringify(customEdges, null, 2),
  };

  withTempGitRepo(files, (dir) => {
    const missingProblems = boundaryProblems(dir);
    assert.equal(missingProblems.length, 1);
    assert.match(missingProblems[0]!, /^missing exceptions manifest:/);

    const { violations, stats } = scanRepositoryBoundaries(dir);
    assert.equal(stats.filesScanned, 4);
    assert.deepEqual(
      violations.map((v) => [v.path, v.what]),
      [['hub/server/api.ts', 'entrypoint-bypass: hub/records/db.ts']],
    );

    const exceptionsFile = join(dir, '.github/checks/exceptions.json');
    writeFileSync(
      exceptionsFile,
      JSON.stringify({
        exceptions: [
          {
            check: CHECK_NAME,
            path: 'hub/server/api.ts',
            what: 'entrypoint-bypass: hub/records/db.ts',
            reason: 'synthetic test exception',
            removeWhen: 'C4',
          },
        ],
      }),
      'utf8',
    );
    assert.deepEqual(boundaryProblems(dir), []);

    // Also verify top-level JSON array format and CLI main().
    writeFileSync(
      exceptionsFile,
      JSON.stringify([
        {
          check: CHECK_NAME,
          path: 'hub/server/api.ts',
          what: 'entrypoint-bypass: hub/records/db.ts',
          reason: 'synthetic test exception',
          removeWhen: 'C4',
        },
      ]),
      'utf8',
    );
    assert.deepEqual(boundaryProblems(dir), []);
    const lines: string[] = [];
    assert.equal(main(['--root', dir], (line) => lines.push(line)), 0);
    assert.deepEqual(lines, []);

    // Unregistered violation makes CLI fail with exit code 1.
    writeFileSync(exceptionsFile, '[]', 'utf8');
    const errLines: string[] = [];
    assert.equal(main(['--root', dir], (line) => errLines.push(line)), 1);
    assert.equal(errLines.length, 1);
    assert.match(errLines[0]!, /unregistered package-boundaries violation/);
  });
});
