import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, mkdir, writeFile } from 'node:fs/promises';
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


  const mmIn = join(work, 'mm-in.json');
  await writeFile(mmIn, '{"root":{"data":{"id":"c1"},"children":[]}}');
  const sealRunDir = join(work, 'seal-run');
  const sealParts = join(work, 'seal-parts.json');
  await mkdir(sealRunDir);
  await writeFile(join(sealRunDir, 'run.json'), JSON.stringify({ run: RUN_ID, items: [] }));
  await writeFile(sealParts, '[]');

  await writeLookupDownload(join(work, 'lookup-run'), lookupFixture());
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

async function pipelineProbes(workRoot: string): Promise<CliProbe[]> {
  const base = join(workRoot, 'pipeline');
  const k = (n: number) => String(n).padStart(2, '0'), autoid = (n: number) => `99000000000000${1000 + n}`;
  const row = (n: number, stage: string, attempts: { recompose: number; write: number }, extra: Record<string, unknown> = {}) => ({ k: k(n), autoid: autoid(n), title: `合成用例 ${k(n)}`, recompose: { index: k(n), item: `n/r${k(n)}` }, plan: { index: k(n), item: `doc:${k(n)}` }, stage, attempts, ...extra });
  const state = (cases: unknown[]) => JSON.stringify({ schema: 'compile-pipeline@1', width: 6, max_attempts: 3, model: 'synthetic-model', recompose_run: RUN_ID, plan_run: RUN_ID_2, recompose_dir: 'recompose-run', plan_dir: 'plan-run', records_dir: 'records', cases });
  const STOPPED = '脚本编写 3 次仍未通过：合成停下原因';
  const dirs = { init: join(base, 'init'), resume: join(base, 'resume'), next: join(base, 'next'), status: join(base, 'status'), collect: join(base, 'collect'), retry: join(base, 'retry'), rework: join(base, 'rework'), reopen: join(base, 'reopen'), judge: join(base, 'judge'), jev: join(base, 'judge-jev') };
  for (const run of ['recompose-run', 'plan-run']) await mkdir(join(dirs.init, run, 'items'), { recursive: true });
  await writeFile(join(dirs.init, 'recompose-run', 'items', '00.json'), JSON.stringify({ id: 'n/r00', fields: { case_id: autoid(0), node: 'n/00' } }));
  await writeFile(join(dirs.init, 'plan-run', 'items', '00.json'), JSON.stringify({ id: 'doc:00', fields: { autoid: autoid(0), title: '合成用例 00' }, location: { selector: 'n/00' } }));
  await writeFile(join(dirs.init, 'open-compile.json'), JSON.stringify({ schema: 'open-compile@1', ready: true, recompose_run: RUN_ID, plan_run: RUN_ID_2 }));
  await writeFile(join(dirs.init, 'scope.md'), `整份合成脑图，共 1 条用例（${autoid(0)}）。\n`);
  await cp(dirs.init, dirs.retry, { recursive: true });
  await writeFile(join(dirs.retry, 'pipeline.json'), state([row(0, 'stopped', { recompose: 3, write: 0 }, { stopped: '用例重组 3 次仍未通过：合成原因' })]));
  await mkdir(dirs.next, { recursive: true });
  await writeFile(join(dirs.next, 'pipeline.json'), state([row(0, 'writing', { recompose: 1, write: 3 })]));
  await mkdir(dirs.resume, { recursive: true });
  await writeFile(join(dirs.resume, 'pipeline.json'), state([row(0, 'ready', { recompose: 1, write: 1 })]));
  await mkdir(dirs.status, { recursive: true });
  await writeFile(join(dirs.status, 'pipeline.json'), state([row(0, 'ready', { recompose: 1, write: 1 }), row(1, 'stopped', { recompose: 1, write: 3 }, { stopped: STOPPED }), row(2, 'recomposing', { recompose: 1, write: 0 }), row(3, 'writing', { recompose: 1, write: 1 }), row(4, 'queued', { recompose: 0, write: 0 })]));
  await mkdir(join(dirs.collect, 'cases', '00', 'plan'), { recursive: true });
  await writeFile(join(dirs.collect, 'cases', '00', 'plan', '00.json'), JSON.stringify({ item: 'doc:00', handling: 'handled', slots: { plan: [{ data: goodData() }] } }));
  await writeFile(join(dirs.collect, 'pipeline.json'), state([row(0, 'ready', { recompose: 1, write: 1 }), row(1, 'stopped', { recompose: 1, write: 3 }, { stopped: STOPPED })]));
  await mkdir(join(dirs.rework, 'returns-1'), { recursive: true });
  await writeFile(join(dirs.rework, 'pipeline.json'), state([row(0, 'ready', { recompose: 1, write: 1 })]));
  await writeFile(join(dirs.rework, 'open-compile.json'), JSON.stringify({ schema: 'open-compile@1', ready: true, subject: 'agile:mindmap:900001', product: 'widget', build: 'Fixture_Build_A', booking: RUN_ID, recompose_run: RUN_ID, recompose_record: 'rec:' + 'a'.repeat(64), plan_run: RUN_ID_2 }));
  await writeFile(join(dirs.rework, 'returns-1', 'index.json'), JSON.stringify({ schema: 'device-returns@1', jobs: [{ outcome: 'not_dispatched', missing_facts: [{ fact: '合成原因' }], rows: [] }] }));
  await mkdir(dirs.judge, { recursive: true });
  await writeFile(join(dirs.judge, 'pipeline.json'), JSON.stringify({ ...JSON.parse(state([row(0, 'ready', { recompose: 1, write: 1 })])), judge: 'model' }));
  await mkdir(dirs.jev, { recursive: true });
  await writeFile(join(dirs.jev, 'pipeline.json'), JSON.stringify({ ...JSON.parse(state([row(0, 'ready', { recompose: 1, write: 1 })])), judge: 'jev' }));
  await mkdir(dirs.reopen, { recursive: true });
  await writeFile(join(dirs.reopen, 'pipeline.json'), state([row(0, 'stopped', { recompose: 1, write: 3 }, { stopped: STOPPED, retried: RUN_ID_2 })]));
  await cp(join(dirs.rework, 'open-compile.json'), join(dirs.reopen, 'open-compile.json'));
  const line = (value: unknown) => JSON.stringify(value) + '\n';
  return [
    { argv: ['init', '--recompose-run', 'recompose-run', '--plan-run', 'plan-run', '--open', 'open-compile.json', '--model', 'synthetic-model', '--state', 'pipeline.json'], cwd: dirs.init, subcommand: 'init', stdinValues: [], complete: { status: 0, stderr: '' } },
    {
      argv: ['next', '--state', 'pipeline.json', '--finished', '编写 00', '--hub', 'https://hub.example.invalid/mcp', '--plumb', 'https://plumb.example.invalid'], cwd: dirs.next, subcommand: 'next', stdinValues: ['synthetic-hub-token', 'synthetic-plumb-key', 'synthetic-jev-key'],
      complete: { status: 0, stdout: line({ actions: [], running: [], ready: [], stopped: [{ label: `00 ${autoid(0)}`, reason: '脚本编写 3 次仍未通过：没有写出 cases/00/plan/00.json' }], queued: 0, all_done: true, message: '全部 1 条走完流水线：0 条计划就绪，1 条停下（见 stopped）。下一步：stopped 里没标 retried 的每条先跑一次 pipeline.ts retry（--note \'模型决定：<针对停下原因的改法>\'），再照第 0 节启动编写循环（workflows/compile-loop.js）' }), stderr: '' },
      empty: { status: 1, stdout: '流水线工具没有完成：标准输入要三行：第一行 %HUB_TOKEN%，第二行 %PLUMB_API_KEY%，第三行 %JEV_API_KEY%\n', stderr: '' },
    },
    {
      argv: ['resume', '--state', 'pipeline.json', '--hub', 'https://hub.example.invalid/mcp', '--plumb', 'https://plumb.example.invalid'], cwd: dirs.resume, subcommand: 'resume', stdinValues: ['synthetic-hub-token', 'synthetic-plumb-key', 'synthetic-jev-key'],
      complete: { status: 0, stdout: line({ actions: [], running: [], ready: ['00'], stopped: [], queued: 0, all_done: true, message: '全部 1 条走完流水线：1 条计划就绪。下一步：pipeline.ts collect 收拢到新目录，再后台跑合并工具 open-merge.ts（SKILL.md 第 3 节）' }), stderr: '' },
      empty: { status: 1, stdout: '流水线工具没有完成：标准输入要三行：第一行 %HUB_TOKEN%，第二行 %PLUMB_API_KEY%，第三行 %JEV_API_KEY%\n', stderr: '' },
    },
    { argv: ['judge', '--state', 'pipeline.json'], cwd: dirs.status, subcommand: 'judge', stdinValues: [], complete: { status: 0, stdout: line({ judge: 'plumb' }), stderr: '' } },
    { argv: ['judge', '--state', 'pipeline.json'], cwd: dirs.judge, subcommand: 'judge', stdinValues: [], complete: { status: 0, stdout: line({ judge: 'model' }), stderr: '' } },
    { argv: ['judge', '--state', 'pipeline.json'], cwd: dirs.jev, subcommand: 'judge', stdinValues: [], complete: { status: 0, stdout: line({ judge: 'jev' }), stderr: '' } },
    {
      argv: ['status', '--state', 'pipeline.json'], cwd: dirs.status, subcommand: 'status', stdinValues: [],
      complete: { status: 0, stdout: line({ actions: [], running: ['重组 02', '编写 03'], ready: ['00'], stopped: [{ label: `01 ${autoid(1)}`, reason: STOPPED }], queued: 1, all_done: false, message: '待派 0 个子代理；在跑 2 个（含待派），排队 1 条，就绪 1 条，停下 1 条' }), stderr: '' },
    },
    {
      argv: ['collect', '--state', 'pipeline.json', '--out', 'plans'], cwd: dirs.collect, subcommand: 'collect', stdinValues: [],
      complete: { status: 0, stdout: line({ copied: 1, stopped: [{ autoid: autoid(1), reason: STOPPED }], not_done: [] }), stderr: '' },
    },
    { argv: ['retry', '--state', 'pipeline.json', '--case', '00', '--note', '合成决定：按手册改写'], cwd: dirs.retry, subcommand: 'retry', stdinValues: [], complete: { status: 0, stderr: '' } },
    {
      argv: ['rework', '--state', 'pipeline.json', '--open', 'open-compile.json', '--returns', 'returns-1', '--hub', 'https://hub.example.invalid/mcp', '--plumb', 'https://plumb.example.invalid'], cwd: dirs.rework, subcommand: 'rework', stdinValues: ['synthetic-hub-token', 'synthetic-plumb-key', 'synthetic-jev-key'],
      complete: { status: 1, stdout: '流水线工具没有完成：returns-1 里没有一轮上机的结果：这次上机没有发到设备（合成原因），不算一轮上机，也不返工：按 missing_facts 的原因和下一步处理；Hub 要原样重交时，用合并时的计划目录和模型对这次脚本合并运行再跑一次 submit-plans.ts，再下载回传；不重跑合并工具，也不为读进展重交计划\n', stderr: '' },
      empty: { status: 1, stdout: '流水线工具没有完成：标准输入要三行：第一行 %HUB_TOKEN%，第二行 %PLUMB_API_KEY%，第三行 %JEV_API_KEY%\n', stderr: '' },
    },
    {
      argv: ['reopen', '--state', 'pipeline.json', '--open', 'open-compile.json', '--hub', 'https://hub.example.invalid/mcp', '--plumb', 'https://plumb.example.invalid'], cwd: dirs.reopen, subcommand: 'reopen', stdinValues: ['synthetic-hub-token', 'synthetic-plumb-key', 'synthetic-jev-key'],
      complete: { status: 0, stdout: line({ running: [], ready: [], stopped: [], queued: 0, all_done: true, excluded: [{ label: `00 ${autoid(0)}`, reason: `retry 后仍停下：${STOPPED}` }], to_start: [], message: 'retry 后又停下的 1 条（00）不进这次编译，没有就绪的计划可以合并：这次编译没有自动化用例 Excel，也不上机验证；最后回复写原始用例共几条、生成成功 0 条，逐条写停下的原因' }), stderr: '' },
      empty: { status: 1, stdout: '流水线工具没有完成：标准输入要三行：第一行 %HUB_TOKEN%，第二行 %PLUMB_API_KEY%，第三行 %JEV_API_KEY%\n', stderr: '' },
    },
  ];
}

export async function buildLocalCliProbes(stagedCaseDir: string, workRoot: string): Promise<{ caseCompile: Record<string, CliProbe[]>; recompose: Record<string, CliProbe[]> }> {
  const invocations = await fixtureInvocations(workRoot, stagedCaseDir);
  const caseCompile: Record<string, CliProbe[]> = {};
  for (const [tool, spec] of Object.entries(invocations)) caseCompile[tool] = [{ argv: spec.argv, cwd: spec.cwd ?? workRoot, subcommand: null, stdinValues: [], complete: { status: 0 } }];
  for (const form of [['--method', 'widget-host.shell'], ['--methods', 'widget-seat'], ['--block', 'CAPTURE_COMPARE']]) caseCompile['tools/cmd-lookup.ts']!.push({ argv: ['--run', 'contract-run', ...form], cwd: invocations['tools/cmd-lookup.ts']!.cwd ?? workRoot, subcommand: null, stdinValues: [], complete: { status: 0 } });
  caseCompile['tools/pipeline.ts'] = await pipelineProbes(workRoot);
  const mergeDir = join(workRoot, 'open-merge');
  await mkdir(join(mergeDir, 'plans'), { recursive: true });
  await writeFile(join(mergeDir, 'open-compile.json'), JSON.stringify({ schema: 'open-compile@1', ready: true, subject: 'agile:mindmap:900001', product: 'widget', build: 'Fixture_Build_A', booking: 'run_01cccccccccccccccccccccccc', recompose_run: RUN_ID, recompose_record: `rec:${'a'.repeat(64)}`, plan_run: RUN_ID_2 }));
  caseCompile['tools/open-merge.ts'] = [{
    argv: ['--hub', 'https://hub.example.invalid/mcp', '--open', 'open-compile.json', '--plans', 'plans', '--model', 'synthetic-model', '--out', 'merge'], cwd: mergeDir, subcommand: null, stdinValues: ['synthetic-hub-token'],
    complete: { status: 1, stdout: '合并不了：计划没有交上去：不存在：--plans 目录里没有 .json 文件。请先写入自动化用例 JSON 文件再再做脚本合并。位置：plans。\n', stderr: '' },
    empty: { status: 1, stdout: "合并不了：合并工具出错：标准输入里没有令牌（标准输入为空，常见原因是 node 命令行与 <<'EOF' 之间多打了换行或漏了 <<'EOF'）\n", stderr: '' },
  }];
  const rcWork = join(workRoot, 'rc-local'); await mkdir(rcWork, { recursive: true });
  await writeFile(join(rcWork, 'record.json'), JSON.stringify({ item: 'n/case1', method: { kind: 'declared', text: '合成方法', sources: ['ref'], basis: '合成依据' } }));
  return { caseCompile, recompose: { 'tools/check-record.ts': [{ argv: ['--file', 'record.json'], cwd: rcWork, subcommand: null, stdinValues: [], complete: { status: 0 } }] } };
}
