// Synthetic local CLI inputs reuse the package's existing brief/workbook fixtures.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCompileBrief } from '../../../packs/workflow/case-compile/functions/authoring-brief.ts';
import { canonicalJson } from '../../../packs/workflow/case-compile/functions/canonical-json.ts';
import { CONTRACT_DOC, MANIFEST_DOC, PROFILE_DOC, COMMAND_CATALOG, goodData } from '../../../packs/workflow/case-compile/functions/test-support.ts';
import REQUIREMENTS from '../../../packs/workflow/case-compile/requirements.json' with { type: 'json' };
import { contractFixture, writeContractDownload } from '../../../packs/workflow/case-compile/testing/contract-lookup-fixture.ts';
import { lookupFixture, writeLookupDownload } from '../../../packs/workflow/case-compile/testing/lookup-fixture.ts';
import { generationFixture } from '../../../packs/workflow/case-compile/testing/workbook.ts';
import type { CliProbe } from '../verify-tool-cli.ts';
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const RUN_ID = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', RUN_ID_2 = 'run_01bbbbbbbbbbbbbbbbbbbbbbbb';

async function fixtureInvocations(
  workRoot: string, stagedCaseDir: string,
): Promise<Record<string, {argv:string[];cwd?:string}>> {
  const work = join(workRoot, 'cc-work');
  await mkdir(work, { recursive: true });
  const skippedPlanPath = join(work, 'skipped-plan.json');
  await writeFile(skippedPlanPath, JSON.stringify({ item: 'item1', handling: 'skipped', reason: '合成跳过原因' }));

  const emptyPlans = join(work, 'empty-plans');
  await mkdir(emptyPlans);
  // --run of every tool that reads a run is the run directory, the folder that holds run.json.
  const fidRunDir = join(work, 'fid-run');
  await mkdir(fidRunDir);
  await writeFile(join(fidRunDir, 'run.json'), JSON.stringify({ run: RUN_ID, items: [] }));

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
    locks: { pack: `case-compile@${JSON.parse(readFileSync(join(stagedCaseDir, 'pack.json'), 'utf8')).version}`, pack_digest: wbRun.pack_digest, root: wbRun.root },
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


  // normalize-mindmap & seal-recompose minimal inputs
  const mmIn = join(work, 'mm-in.json');
  await writeFile(mmIn, '{"root":{"data":{"id":"c1"},"children":[]}}');
  const sealRunDir = join(work, 'seal-run');
  const sealParts = join(work, 'seal-parts.json');
  await mkdir(sealRunDir);
  await writeFile(join(sealRunDir, 'run.json'), JSON.stringify({ run: RUN_ID, items: [] }));
  await writeFile(sealParts, '[]');

  // cmd-lookup reads a download, named by its run directory (the folder with run.json and knowledge/), here the synthetic tree and manual of the lookup tests.
  await writeLookupDownload(join(work, 'lookup-run'), lookupFixture());
  // The method and block forms read the sources and the frozen slot schema of a download, here the synthetic frozen run of the lookup tests.
  await writeContractDownload(join(work, 'contract-run'), contractFixture());

  await writeFile(join(work, 'scope.md'), '只做 case-101 合成用例。\n');
  await writeFile(join(work, 'writer-brief.md'), '# 合成编写简报\n');
  await writeFile(join(work, 'precheck-input.json'), JSON.stringify({ root: COMMAND_CATALOG.root, contract: CONTRACT_DOC, profile: PROFILE_DOC, inventory: MANIFEST_DOC, catalog: COMMAND_CATALOG, plan: goodData() }));

  return {
    'tools/carry-plans.ts': { argv: ['--source', 'carry-src', '--target', 'carry-dst', '--source-plans', 'carry-src-plans', '--plans', 'carry-dst-plans'], cwd: work },
    'tools/check-brief.ts': { argv: ['--file', '00.round-1.json'], cwd: work },
    'tools/check-plan.ts': { argv: ['--file', skippedPlanPath] },
    'tools/fidelity-apply.ts': { argv: ['--run', fidRunDir, '--plans', emptyPlans, '--briefs', join(work, 'fid-briefs-empty')] },
    'tools/fidelity-brief.ts': { argv: ['--run', fidRunDir, '--plans', emptyPlans, '--out', join(work, 'fid-briefs-out')] },
    'tools/generate-workbook.ts': {
      argv: [
        '--run', wbDir,
        '--result', join(wbDir, 'result.json'),
        '--submission', join(wbDir, 'submission.json'),
        '--contract', join(wbDir, 'contract.json'),
        '--profile', join(wbDir, 'profile.json'),
        '--inventory', join(wbDir, 'inventory.json'),
        '--out', join(work, 'out.xlsx'),
      ],
    },
    'tools/normalize-mindmap.ts': { argv: ['--in', mmIn, '--out', join(work, 'mm-out.json')] },
    'tools/seal-recompose.ts': { argv: ['--run', sealRunDir, '--parts', sealParts, '--model', 'synthetic-model', '--out', join(work, 'sealed.json')] },
    'tools/task-brief.ts': { argv: ['--role', '脚本编写', '--case', 'case-101', '--brief', 'writer-brief.md', '--out', 'writer-plan.json', '--task-file', 'writer-task.md'], cwd: work },
    'tools/command-domain-precheck.ts': { argv: ['--input', 'precheck-input.json', '--out', 'precheck-output.json'], cwd: work },
    'tools/cmd-lookup.ts': { argv: ['--run', 'lookup-run', '--param', 'orbit beacon add'], cwd: work },
  };
}

/** Supplies one local CLI invocation per local tool; remote stdin tools are supplied by remote-cli-probes.ts. */
export async function buildLocalCliProbes(stagedCaseDir: string, stagedRecomposeDir: string, workRoot: string): Promise<{ caseCompile: Record<string, CliProbe[]>; recompose: Record<string, CliProbe[]> }> {
  const invocations = await fixtureInvocations(workRoot, stagedCaseDir);
  const caseCompile: Record<string, CliProbe[]> = {};
  for (const [tool, spec] of Object.entries(invocations)) caseCompile[tool] = [{ argv: spec.argv, cwd: spec.cwd ?? workRoot, subcommand: null, stdinValues: [], complete: { status: 0 } }];
  // cmd-lookup has five forms that read different parts of a download: one probe each beyond the first.
  for (const form of [['--method', 'widget-host.shell'], ['--methods', 'widget-seat'], ['--block', 'CAPTURE_COMPARE']]) caseCompile['tools/cmd-lookup.ts']!.push({ argv: ['--run', 'contract-run', ...form], cwd: invocations['tools/cmd-lookup.ts']!.cwd ?? workRoot, subcommand: null, stdinValues: [], complete: { status: 0 } });
  const rcWork = join(workRoot, 'rc-local'); await mkdir(rcWork, { recursive: true });
  await writeFile(join(rcWork, 'record.json'), JSON.stringify({ item: 'n/case1', method: { kind: 'declared', text: '合成方法', sources: ['ref'], basis: '合成依据' } }));
  return { caseCompile, recompose: { 'tools/check-record.ts': [{ argv: ['--file', 'record.json'], cwd: rcWork, subcommand: null, stdinValues: [], complete: { status: 0 } }] } };
}
