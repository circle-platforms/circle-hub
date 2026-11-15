// Staged publish-time & runtime verification for tool <name>.cli.json pure-data stdin declarations.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCompileBrief } from '../functions/authoring-brief.ts';
import { canonicalJson } from '../functions/canonical-json.ts';
import { generateWorkbook } from '../functions/generate.ts';
import { sha256 } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { CONTRACT_DOC, MANIFEST_DOC, PROFILE_DOC, goodData } from '../functions/test-support.ts';
import REQUIREMENTS from '../requirements.json' with { type: 'json' };
import { generationFixture } from './workbook.ts';

export interface ParsedCliDecl {
  schema: 'tool-cli@1';
  stdin: string[];
}

export interface StagedToolInvocation {
  argv: string[];
  cwd?: string;
}

const CASE_COMPILE_HELPERS = new Set([
  'tools/authoring-brief.ts',
  'tools/rework-inputs.ts',
  'tools/workspace-path.ts',
  'tools/case-writers/extension.ts',
]);

const RUN_ID = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
const RUN_ID_2 = 'run_01bbbbbbbbbbbbbbbbbbbbbbbb';

export function parseCliDeclFile(filePath: string): ParsedCliDecl {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${filePath}: expected JSON object`);
  const rec = parsed as Record<string, unknown>;
  assert.equal(rec.schema, 'tool-cli@1', `${filePath}: schema must be tool-cli@1`);
  for (const key of Object.keys(rec)) {
    assert.ok(key === 'schema' || key === 'stdin', `${filePath}: unexpected key ${key}`);
  }
  assert.ok(
    Array.isArray(rec.stdin) && rec.stdin.every((v) => typeof v === 'string' && /^%[A-Z][A-Z0-9_]*%$/.test(v)),
    `${filePath}: stdin must be an array of placeholder strings`,
  );
  return { schema: 'tool-cli@1', stdin: [...(rec.stdin as string[])] };
}

/** Checks that every staged pack.json CLI tool has a valid .cli.json matching bytes on disk. */
export function verifyPackCliManifest(
  stagedDir: string,
  helpers: ReadonlySet<string> = new Set(),
): Map<string, ParsedCliDecl> {
  const manifest = JSON.parse(readFileSync(join(stagedDir, 'pack.json'), 'utf8')) as {
    id: string;
    files: Array<{ path: string; sha256: string; size: number }>;
  };
  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  const decls = new Map<string, ParsedCliDecl>();

  for (const entry of manifest.files) {
    const abs = join(stagedDir, entry.path);
    const bytes = readFileSync(abs);
    assert.equal(bytes.byteLength, entry.size, `${manifest.id}: ${entry.path} size mismatch`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${manifest.id}: ${entry.path} sha256 mismatch`);

    if (entry.path.startsWith('tools/') && entry.path.endsWith('.ts') && !entry.path.endsWith('.test.ts')) {
      if (helpers.has(entry.path)) {
        assert.ok(!listed.has(`${entry.path.slice(0, -3)}.cli.json`), `${manifest.id}: internal helper ${entry.path} must not have .cli.json`);
        continue;
      }
      const cliRel = `${entry.path.slice(0, -3)}.cli.json`;
      assert.ok(listed.has(cliRel), `${manifest.id}: missing ${cliRel} for CLI tool ${entry.path}`);
      decls.set(entry.path, parseCliDeclFile(join(stagedDir, cliRel)));
    } else if (entry.path.startsWith('tools/') && entry.path.endsWith('.cli.json')) {
      const toolRel = `${entry.path.slice(0, -'.cli.json'.length)}.ts`;
      assert.ok(listed.has(toolRel) && !helpers.has(toolRel), `${manifest.id}: orphaned ${entry.path}`);
    }
  }
  return decls;
}

/** Verifies every CLI tool's actual empty-stdin subprocess behavior matches its staged .cli.json declaration. */
export function verifyPackToolCliBehavior(
  stagedDir: string,
  invocations: Readonly<Record<string, StagedToolInvocation>>,
  helpers: ReadonlySet<string> = new Set(),
): Map<string, ParsedCliDecl> {
  const decls = verifyPackCliManifest(stagedDir, helpers);
  for (const rel of decls.keys()) {
    assert.ok(Object.hasOwn(invocations, rel), `${stagedDir}: missing test invocation spec for ${rel}`);
  }

  for (const [rel, decl] of decls) {
    const spec = invocations[rel];
    const result = spawnSync(process.execPath, [join(stagedDir, rel), ...spec.argv], {
      cwd: spec.cwd ?? stagedDir,
      input: '',
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (decl.stdin.length > 0) {
      assert.notEqual(
        result.status,
        0,
        `${rel} declares stdin=${JSON.stringify(decl.stdin)}, expected non-zero exit when given empty stdin (stdout=${result.stdout})`,
      );
      assert.match(
        result.stderr,
        /标准输入里没有令牌/,
        `${rel} declares stdin=${JSON.stringify(decl.stdin)}, expected missing-token refusal on empty stdin, got stderr=${JSON.stringify(result.stderr)}`,
      );
      for (const placeholder of decl.stdin) {
        assert.ok(
          result.stderr.includes(placeholder),
          `${rel} error message should cite declared placeholder ${placeholder}: ${result.stderr}`,
        );
      }
    } else {
      assert.equal(
        result.status,
        0,
        `${rel} declares stdin=[], expected exit 0 with empty stdin, got status=${result.status} stderr=${JSON.stringify(result.stderr)}`,
      );
    }
  }

  return decls;
}

/** Verifies docs and tool header `// node ...` usage lines agree with `.cli.json` heredoc expectations. */
export function verifyPackDocsMatchCliDecls(
  stagedDir: string,
  docFiles: readonly string[],
  decls: ReadonlyMap<string, ParsedCliDecl>,
): void {
  const checkCommandLines = (label: string, text: string) => {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /(?:tools\/)([a-z0-9-]+\.ts)['"`\s]/.exec(lines[i]);
      if (!m || !lines[i].includes('node ')) continue;
      const rel = `tools/${m[1]}`;
      const decl = decls.get(rel);
      if (!decl) continue;
      const lineHasHeredoc = lines[i].includes("<<'EOF'");
      if (decl.stdin.length > 0) {
        if (!lineHasHeredoc && lines[i].includes('%HUB_URL%')) {
          assert.fail(`${label}:${i + 1}: ${rel} declares stdin=${JSON.stringify(decl.stdin)} but command lacks <<'EOF': ${lines[i]}`);
        }
        if (lineHasHeredoc) {
          for (let j = 0; j < decl.stdin.length; j++) {
            assert.equal(lines[i + 1 + j], decl.stdin[j], `${label}:${i + 2 + j}: expected ${decl.stdin[j]}`);
          }
          assert.equal(lines[i + 1 + decl.stdin.length], 'EOF', `${label}: missing closing EOF`);
        }
      } else {
        assert.ok(!lineHasHeredoc, `${label}:${i + 1}: ${rel} declares stdin=[] but command has <<'EOF': ${lines[i]}`);
      }
    }
  };

  for (const docRel of docFiles) {
    const abs = join(stagedDir, docRel);
    if (existsSync(abs)) checkCommandLines(docRel, readFileSync(abs, 'utf8'));
  }
  for (const rel of decls.keys()) {
    const header = readFileSync(join(stagedDir, rel), 'utf8')
      .split('\n')
      .slice(0, 40)
      .map((l) => l.replace(/^\/\/\s*/, ''))
      .join('\n');
    checkCommandLines(rel, header);
  }
}

export async function buildCaseCompileInvocations(
  workRoot: string,
): Promise<Record<string, StagedToolInvocation>> {
  const work = join(workRoot, 'cc-work');
  await mkdir(work, { recursive: true });
  const notesPath = join(work, 'notes.json');
  await writeFile(notesPath, JSON.stringify({ schema: 'delivery-notes@1', cases: [] }));

  const plansDir = join(work, 'plans');
  await mkdir(plansDir);
  const validPlanPath = join(plansDir, '00.json');
  await writeFile(validPlanPath, JSON.stringify({ item: 'item1', handling: 'handled', slots: { plan: [{ data: goodData() }] } }));

  const skippedPlanPath = join(work, 'skipped-plan.json');
  await writeFile(skippedPlanPath, JSON.stringify({ item: 'item1', handling: 'skipped', reason: '合成跳过原因' }));

  const emptyPlans = join(work, 'empty-plans');
  await mkdir(emptyPlans);
  const fidRunPath = join(work, 'fid-run.json');
  await writeFile(fidRunPath, JSON.stringify({ run: RUN_ID, items: [] }));

  const briefRecord = {
    case: { id: 'case-1', title: '合成用例' },
    expectation_slots: [{ slot: 'e1', atom: 'a2', reference: `src:${'a'.repeat(64)}/kityminder@1/n/e1`, text: '期望动作' }],
    atoms: [
      { id: 'a1', kind: 'action', text: '动作一', reference: `src:${'a'.repeat(64)}/kityminder@1/n/a1` },
      { id: 'a2', kind: 'expectation', text: '期望动作', reference: `src:${'a'.repeat(64)}/kityminder@1/n/e1` },
    ],
    sources: { candidates: [], governing: [], states: [] },
    ledgers: { adapted: [] },
  };
  const briefObj = buildCompileBrief({
    item: {
      id: 'item-1',
      fields: {
        autoid: '990000000000000001',
        title: '合成用例',
        expected_nodes: [{ reference: `src:${'a'.repeat(64)}/kityminder@1/n/e1`, text: '期望动作' }],
        recomposition: { receipt: `rec:${'b'.repeat(64)}`, record: briefRecord },
      },
    },
    index: '00',
    knowledge: { root: 'a'.repeat(64), nodes: new Map(), lines: new Map() },
    policy: null,
  });
  assert.ok(briefObj, 'expected synthetic compile-brief@1');
  const briefPath = join(work, '00.round-1.json');
  await writeFile(briefPath, JSON.stringify(briefObj));

  // carry-plans minimal source & target
  const carrySource = join(work, 'carry-src');
  const carryTarget = join(work, 'carry-dst');
  const carrySourcePlans = join(work, 'carry-src-plans');
  await mkdir(carrySource);
  await mkdir(carryTarget);
  await mkdir(carrySourcePlans);
  const commonCarry = { product: 'orbit', build: 'Rel_ORBIT_1', root: 'e'.repeat(64), sources: [], items: [{ id: 'doc:c1', fields: { autoid: '100000000000000001', title: 'c1' } }] };
  await writeFile(join(carrySource, 'run.json'), JSON.stringify({ ...commonCarry, run: RUN_ID }));
  await writeFile(join(carryTarget, 'run.json'), JSON.stringify({ ...commonCarry, run: RUN_ID_2 }));
  await writeFile(join(carrySourcePlans, '00.json'), JSON.stringify({ item: 'doc:c1', handling: 'handled', slots: { plan: [{ data: goodData() }] } }));

  // generate-workbook minimal fixture
  const recipe = generationFixture();
  const wbDir = join(work, 'wb');
  await mkdir(wbDir);
  const contractBytes = Buffer.from(JSON.stringify(CONTRACT_DOC));
  const profileBytes = Buffer.from(JSON.stringify(PROFILE_DOC));
  const inventoryBytes = Buffer.from(JSON.stringify(MANIFEST_DOC));
  const submission = { run: recipe.plan_run, model: 'synthetic-model', items: [{ item: 'fixture-case', handling: 'handled', slots: { plan: [{ data: recipe.slots }] } }] };
  const wbRun = {
    run: recipe.plan_run,
    pack: 'case-compile',
    pack_digest: 'b'.repeat(64),
    root: (recipe.fields.command_catalog as { root: string }).root,
    build: recipe.build,
    items: [{ id: 'fixture-case', fields: recipe.fields }],
    requirements: REQUIREMENTS.requirements.map((v) => ({ key: v.key, accepted_producer: v.accepted_producer })),
    sources: [
      { slot: 'contract', role: 'expected', reference: `src:${sha256(contractBytes)}` },
      { slot: 'profile', role: 'expected', reference: `src:${sha256(profileBytes)}` },
      { slot: 'inventory', role: 'expected', reference: `src:${sha256(inventoryBytes)}` },
    ],
  };
  const wbResult = {
    schema: 'validation@1',
    run: wbRun.run,
    submission: sha256(canonicalJson(submission)),
    acceptance: 'accepted',
    errors: [],
    locks: { pack: `case-compile@${JSON.parse(readFileSync(new URL('../pack.json', import.meta.url), 'utf8')).version}`, pack_digest: wbRun.pack_digest, root: wbRun.root },
    coverage: { complete: true, examined: 1, total: 1 },
    partitions: {
      delivered: [
        {
          item: 'fixture-case',
          requirements: REQUIREMENTS.requirements.map((v) => ({
            requirement: v.key,
            status: v.key === 'workbook_verified' ? 'unresolved' : 'satisfied',
            claims:
              v.key === 'commands_known'
                ? [{ statement: { verdict: 'support', data: { command_catalog: recipe.fields.command_catalog } } }]
                : v.key === 'contract_methods'
                  ? [
                      {
                        statement: {
                          verdict: 'support',
                          data: { runtime_version: recipe.contract.runtimeVersion, contract_sha256: recipe.contract.pinned.identity },
                        },
                      },
                    ]
                  : [],
          })),
        },
      ],
    },
  };
  await writeFile(join(wbDir, 'run.json'), JSON.stringify(wbRun));
  await writeFile(join(wbDir, 'result.json'), JSON.stringify(wbResult));
  await writeFile(join(wbDir, 'submission.json'), JSON.stringify(submission));
  await writeFile(join(wbDir, 'contract.json'), contractBytes);
  await writeFile(join(wbDir, 'profile.json'), profileBytes);
  await writeFile(join(wbDir, 'inventory.json'), inventoryBytes);
  void generateWorkbook;

  // normalize-mindmap & seal-recompose minimal inputs
  const mmIn = join(work, 'mm-in.json');
  await writeFile(mmIn, '{"root":{"data":{"id":"c1"},"children":[]}}');
  const sealRun = join(work, 'seal-run.json');
  const sealParts = join(work, 'seal-parts.json');
  await writeFile(sealRun, JSON.stringify({ run: RUN_ID, items: [] }));
  await writeFile(sealParts, '[]');

  return {
    'tools/assemble-delivery.ts': { argv: ['--hub', 'http://127.0.0.1:1', '--runs', RUN_ID, '--notes', notesPath, '--out', join(work, 'deliv-out')] },
    'tools/download-returns.ts': { argv: ['--hub', 'http://127.0.0.1:1', '--run', RUN_ID, '--out', join(work, 'ret-out')] },
    'tools/download-run.ts': { argv: ['--hub', 'http://127.0.0.1:1', '--run', RUN_ID, '--out', join(work, 'dl-out')] },
    'tools/fetch-run.ts': { argv: ['--hub', 'http://127.0.0.1:1', '--run', RUN_ID, '--out', join(work, 'fetch-out')] },
    'tools/submit-plans.ts': { argv: ['--hub', 'http://127.0.0.1:1', '--run', RUN_ID, '--model', 'synthetic-model', '--plans', plansDir] },
    'tools/carry-plans.ts': { argv: ['--source', 'carry-src', '--target', 'carry-dst', '--source-plans', 'carry-src-plans', '--plans', 'carry-dst-plans'], cwd: work },
    'tools/check-brief.ts': { argv: ['--file', '00.round-1.json'], cwd: work },
    'tools/check-plan.ts': { argv: ['--file', skippedPlanPath] },
    'tools/fidelity-apply.ts': { argv: ['--run', fidRunPath, '--plans', emptyPlans, '--briefs', join(work, 'fid-briefs-empty')] },
    'tools/fidelity-brief.ts': { argv: ['--run', fidRunPath, '--plans', emptyPlans, '--out', join(work, 'fid-briefs-out')] },
    'tools/generate-workbook.ts': {
      argv: [
        '--run', join(wbDir, 'run.json'),
        '--result', join(wbDir, 'result.json'),
        '--submission', join(wbDir, 'submission.json'),
        '--contract', join(wbDir, 'contract.json'),
        '--profile', join(wbDir, 'profile.json'),
        '--inventory', join(wbDir, 'inventory.json'),
        '--out', join(work, 'out.xlsx'),
      ],
    },
    'tools/install-agents.ts': { argv: ['--out', 'agents-out'], cwd: work },
    'tools/normalize-mindmap.ts': { argv: ['--in', mmIn, '--out', join(work, 'mm-out.json')] },
    'tools/seal-recompose.ts': { argv: ['--run', sealRun, '--parts', sealParts, '--model', 'synthetic-model', '--out', join(work, 'sealed.json')] },
    'tools/task-brief.ts': { argv: ['--help'] },
  };
}

export async function buildRecomposeInvocations(workRoot: string): Promise<Record<string, StagedToolInvocation>> {
  const work = join(workRoot, 'rc-work');
  const recDir = join(work, 'records');
  await mkdir(recDir, { recursive: true });
  await writeFile(
    join(recDir, '01.json'),
    JSON.stringify({ item: 'n/case1', method: { kind: 'declared', text: '合成方法', sources: ['ref'], basis: '合成依据' } }),
  );
  return {
    'tools/check-record.ts': { argv: ['--help'] },
    'tools/download-run.ts': { argv: ['--hub', 'http://127.0.0.1:1', '--run', RUN_ID, '--out', join(work, 'rc-dl-out')] },
    'tools/submit-records.ts': { argv: ['--hub', 'http://127.0.0.1:1', '--run', RUN_ID, '--model', 'synthetic-model', '--records', recDir] },
  };
}

/** Full publish-time and runtime verification for staged case-compile packs. */
export async function verifyCaseCompileStagedCli(stagedDir: string): Promise<void> {
  const workRoot = await mkdtemp(join(tmpdir(), 'cc-cli-verify-'));
  try {
    const invocations = await buildCaseCompileInvocations(workRoot);
    const decls = verifyPackToolCliBehavior(stagedDir, invocations, CASE_COMPILE_HELPERS);
    verifyPackDocsMatchCliDecls(
      stagedDir,
      ['SKILL.md', 'tools/delivery.md', 'tools/fidelity.md', 'agents/compile-writer.md', 'agents/compile-fidelity.md'],
      decls,
    );
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

/** Full publish-time and runtime verification for staged recompose packs. */
export async function verifyRecomposeStagedCli(stagedDir: string): Promise<void> {
  const workRoot = await mkdtemp(join(tmpdir(), 'rc-cli-verify-'));
  try {
    const invocations = await buildRecomposeInvocations(workRoot);
    const decls = verifyPackToolCliBehavior(stagedDir, invocations);
    verifyPackDocsMatchCliDecls(stagedDir, ['SKILL.md'], decls);
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}
