// Curated <5-minute regression suite ("npm run test:quick") across all six required dimensions:
// contracts, TypeScript typechecks, the six MCP tools, teams & permissions, named secrets/variables,
// and the mindmap compile path & fast acceptance checks. Existing tests remain untouched in full suites.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPostgres } from '../hub/testing/postgres.ts';
import type { TemporaryPostgres } from '../hub/testing/postgres.ts';
import { LOCAL_UNIT_SECONDS } from './local-test-timings.ts';
import { orderedArguments, slowestFirst, usesCoverage } from './ordered-test-runner.ts';
import { prepareTemplate, sharedEnv, UNIT_MEASURED_SECONDS } from './run-unit-tests.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSC_ENTRY = resolve(ROOT, 'node_modules/typescript/bin/tsc');

export type QuickCategoryId =
  | 'contracts'
  | 'typecheck'
  | 'six-tools'
  | 'teams-permissions'
  | 'named-secrets'
  | 'mindmap-compile-acceptance';

export interface QuickCommandSpec {
  readonly id: string;
  readonly label: string;
  readonly entry: string;
  readonly args: readonly string[];
}

export interface QuickCategory {
  readonly id: QuickCategoryId;
  readonly title: string;
  readonly rationale: string;
  readonly commands: readonly QuickCommandSpec[];
  readonly unitFiles: readonly string[];
  readonly acceptanceFiles: readonly string[];
}

/** Curated regression checks grouped strictly by the six required coverage dimensions. */
export const QUICK_CATEGORIES: readonly QuickCategory[] = [
  {
    id: 'contracts',
    title: '合约',
    rationale: '验证 model.json / codes.json 生成物零漂移、六工具输入输出 Schema、词表与共享接口/槽位投影生成。',
    commands: [
      {
        id: 'verify-contracts',
        label: '合约生成物一致性校验（gen-contracts --check）',
        entry: 'tools/gen-contracts.ts',
        args: ['--check'],
      },
    ],
    unitFiles: [
      'contracts/src/codes.test.ts',
      'contracts/src/vocabulary.test.ts',
      'contracts/src/tools.test.ts',
      'contracts/src/tool-shapes.test.ts',
      'contracts/src/mcp-client.test.ts',
      'contracts/src/variables.test.ts',
      'tools/gen-contracts.shared-interfaces.test.ts',
      'tools/gen-contracts.pack-vocabulary.test.ts',
      'tools/slot-schema.test.ts',
    ],
    acceptanceFiles: [],
  },
  {
    id: 'typecheck',
    title: '类型',
    rationale: '覆盖主仓库与 .github/checks 检查脚本的全部 TypeScript 严格类型约束（tsconfig.json）。',
    commands: [
      {
        id: 'tsc-root',
        label: '主仓库类型检查（tsc --noEmit）',
        entry: 'node_modules/typescript/bin/tsc',
        args: ['--noEmit'],
      },
      {
        id: 'tsc-checks',
        label: '仓库检查脚本类型检查（tsc --noEmit -p .github/checks）',
        entry: 'node_modules/typescript/bin/tsc',
        args: ['--noEmit', '-p', '.github/checks'],
      },
    ],
    unitFiles: [],
    acceptanceFiles: [],
  },
  {
    id: 'six-tools',
    title: '六个工具',
    rationale: '通过 MCP SDK 全工具端到端契约、tools/list、包目录与端口、客户端声明、读取恢复、本地工具、调用状态、命令参数与追加调用日志覆盖六个 MCP 工具边界。',
    commands: [],
    unitFiles: [
      'hub/server/mcp.test.ts',
      'hub/server/list-tools.test.ts',
      'hub/runs/packs/ports.test.ts',
      'hub/server/declared-clients.test.ts',
      'hub/server/model-declaration-mcp.test.ts',
      'hub/server/read-recovery-mcp.test.ts',
      'hub/server/local-tools.test.ts',
      'hub/server/call-status.test.ts',
      'hub/server/long-call-status.test.ts',
      'hub/server/command-parameters.test.ts',
      'hub/server/console/command-form.test.ts',
      'hub/records/calllog.test.ts',
    ],
    acceptanceFiles: [],
  },
  {
    id: 'teams-permissions',
    title: '团队和权限',
    rationale: '覆盖团队成员记录、包与资源授权边界、OAuth/RFC8628 标准授权、请求级权限快照、读范围、控制台团队管理与配额/授权视图、无包访问隔离与成员删退隔离。',
    commands: [],
    unitFiles: [
      'hub/records/teams.test.ts',
      'hub/records/authorizations.test.ts',
      'hub/records/standard-authorization.test.ts',
      'hub/records/request-permissions.test.ts',
      'hub/records/read-scope.test.ts',
      'hub/server/cli-team.test.ts',
      'hub/server/standard-authorization.test.ts',
      'hub/server/request-permissions.test.ts',
      'hub/server/console-clients.test.ts',
      'hub/server/console-teams.test.ts',
      'hub/server/console-team-capacity.test.ts',
      'hub/server/console/audience.test.ts',
      'hub/server/console/grant-dialog.test.ts',
      'hub/server/console/member-reads.test.ts',
      'hub/server/member-deletion-effect.test.ts',
      'hub/connectors/resource-access.test.ts',
    ],
    acceptanceFiles: [
      'tests/acceptance/06-user-without-pack.test.ts',
    ],
  },
  {
    id: 'named-secrets',
    title: '密钥按名字取值',
    rationale: '覆盖 C12 按名字引用密钥金库、sidecar 元数据、脱敏标签与短口令拒绝、连接器/调度重绑定、旧读写路径拒绝，以及全链路普通变量取值。',
    commands: [],
    unitFiles: [
      'hub/records/vault.test.ts',
      'hub/records/vault-secrets.test.ts',
      'hub/records/vault-sidecars.test.ts',
      'hub/records/variables.test.ts',
      'hub/records/variable-token-keys.test.ts',
      'hub/server/vault-secrets.test.ts',
      'hub/server/vault-legacy-read.test.ts',
      'hub/server/vault-legacy-execute.test.ts',
      'hub/server/secret-use-labels.test.ts',
      'hub/server/short-secret-reason.test.ts',
      'hub/server/variables.test.ts',
      'hub/connectors/vault-rebind.test.ts',
      'hub/connectors/variables.test.ts',
      'hub/dispatch/vault-rebind.test.ts',
      'hub/dispatch/variables.test.ts',
      'hub/knowledge/ordinary-variable-use.test.ts',
      'hub/knowledge/variables.test.ts',
      'hub/knowledge/unversioned-variables.test.ts',
    ],
    acceptanceFiles: [],
  },
  {
    id: 'mindmap-compile-acceptance',
    title: '脑图编译路径上的验收',
    rationale: '覆盖 case-compile 任务包发布与评审端到端契约、全脑图解析、函数生成/绑定/分块工作簿/保真与重组，以及块用例、重投影、技能包、调度规则、重启恢复、容量与覆盖路径验收。',
    commands: [],
    unitFiles: [
      'packs/workflow/case-compile/pack.test.ts',
      'packs/workflow/case-compile/publish.test.ts',
      'packs/workflow/case-compile/review/end-to-end.test.ts',
      'packs/workflow/case-compile/functions/whole-mindmap.test.ts',
      'packs/workflow/case-compile/functions/generate.test.ts',
      'packs/workflow/case-compile/functions/cases.test.ts',
      'packs/workflow/case-compile/functions/runtime-contract.test.ts',
      'packs/workflow/case-compile/functions/fidelity.test.ts',
      'packs/workflow/case-compile/functions/recomposition.test.ts',
      'packs/workflow/case-compile/functions/recompose-check.test.ts',
      'packs/workflow/case-compile/functions/block-workbook.test.ts',
      'packs/workflow/case-compile/functions/binding.test.ts',
      'packs/workflow/case-compile/recompose/tools/submit-records.test.ts',
      'packs/workflow/case-compile/tools/seal-recompose.test.ts',
    ],
    acceptanceFiles: [
      'tests/acceptance/38-r5-t4-1-block-cases.test.ts',
      'tests/acceptance/56-fed-case-reprojection.test.ts',
      'tests/acceptance/39-r5-t9-2-skill-packs.test.ts',
      'tests/acceptance/32-r5-dispatch-rules.test.ts',
      'tests/acceptance/40-r5-t9-3-process-restart.test.ts',
      'tests/acceptance/53-capacity.test.ts',
      'tests/acceptance/coverage-paths.test.ts',
    ],
  },
];

const QUICK_EXPECTED_SECONDS: Readonly<Record<string, number>> = {
  ...UNIT_MEASURED_SECONDS,
  ...LOCAL_UNIT_SECONDS,
  // Start the full HTTP MCP SDK test first so fast unit files overlap behind it.
  'hub/server/mcp.test.ts': 55,
};

export interface QuickStageResult {
  readonly label: string;
  readonly code: number;
  readonly seconds: number;
}

export interface QuickRunOptions {
  readonly list?: boolean;
  readonly dryRun?: boolean;
}

/** Command checks included in the quick suite. */
export function quickCommandSteps(): QuickCommandSpec[] {
  return QUICK_CATEGORIES.flatMap((category) => [...category.commands]);
}

/** Unit and workflow-pack test files included in the quick suite, in declaration order. */
export function quickUnitFiles(): string[] {
  return QUICK_CATEGORIES.flatMap((category) => [...category.unitFiles]);
}

/** Acceptance test files included in the quick suite, in declaration order. */
export function quickAcceptanceFiles(): string[] {
  return QUICK_CATEGORIES.flatMap((category) => [...category.acceptanceFiles]);
}

/** All test files (unit + acceptance) included in the quick suite. */
export function quickAllFiles(): string[] {
  return [...quickUnitFiles(), ...quickAcceptanceFiles()];
}

/** Bounded parallelism for the shared-PG unit lane in test:quick. */
export function quickUnitConcurrency(fileCount: number): number {
  const cap = Math.max(2, Math.min(6, availableParallelism() - 1));
  return Math.max(1, Math.min(cap, fileCount));
}

/** Unit files ordered slowest-first so the longest file starts immediately. */
export function orderedQuickUnitFiles(): string[] {
  return slowestFirst(quickUnitFiles(), (file) => QUICK_EXPECTED_SECONDS[file] ?? 2);
}

function cleanBaseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && !key.startsWith('HUB_UNIT_PG_') && key !== 'NODE_TEST_CONTEXT') {
      env[key] = value;
    }
  }
  return env;
}

function runSpawned(args: readonly string[], env: NodeJS.ProcessEnv, children: ChildProcess[]): Promise<number> {
  const child = spawn(process.execPath, [...args], { cwd: ROOT, env, stdio: 'inherit' });
  children.push(child);
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolvePromise(code ?? 1));
  });
}

async function timedStage(label: string, fn: () => Promise<number>): Promise<QuickStageResult> {
  const began = Date.now();
  process.stderr.write(`\n=== ${label} ===\n`);
  const code = await fn();
  const seconds = (Date.now() - began) / 1000;
  process.stderr.write(`--- ${label} 结束：exit=${code} 耗时=${seconds.toFixed(2)}s ---\n`);
  return { label, code, seconds };
}

function formatPlan(dryRun: boolean): string {
  const lines: string[] = [];
  if (dryRun) {
    lines.push('test:quick 预演模式（不启动 PostgreSQL，不执行测试）');
    lines.push(`1. 合约校验: node tools/gen-contracts.ts --check`);
    lines.push(`2. 类型检查: node ${TSC_ENTRY} --noEmit && -p .github/checks`);
    lines.push(`3. 单元测试（共享 PG 模板, 并发=${quickUnitConcurrency(quickUnitFiles().length)}）: ${quickUnitFiles().length} 个文件`);
    lines.push(`4. 验收测试（共享 PG 模板, 并发=1）: ${quickAcceptanceFiles().length} 个文件`);
    lines.push('');
  }
  for (const category of QUICK_CATEGORIES) {
    lines.push(`[${category.id}] ${category.title} — ${category.rationale}`);
    for (const cmd of category.commands) lines.push(`  命令: ${cmd.entry} ${cmd.args.join(' ')}`);
    for (const file of category.unitFiles) lines.push(`  单测: ${file}`);
    for (const file of category.acceptanceFiles) lines.push(`  验收: ${file}`);
  }
  lines.push('');
  lines.push(
    `总计: ${quickCommandSteps().length} 项校验命令 + ${quickUnitFiles().length} 个单测文件 + ${quickAcceptanceFiles().length} 个验收文件`,
  );
  return `${lines.join('\n')}\n`;
}

function printSummary(results: readonly QuickStageResult[], totalSeconds: number): void {
  process.stderr.write('\n=== test:quick 汇总 ===\n');
  for (const result of results) {
    process.stderr.write(`  ${result.code === 0 ? 'PASS' : 'FAIL'} | ${result.seconds.toFixed(2)}s | ${result.label}\n`);
  }
  process.stderr.write(`  总计墙钟耗时: ${totalSeconds.toFixed(2)}s（目标上限 300.00s）\n`);
}

function testLaneArgs(files: readonly string[], concurrency: number): string[] {
  if (usesCoverage()) {
    return ['--test', '--test-isolation=process', `--test-concurrency=${concurrency}`, ...files];
  }
  return orderedArguments(files, concurrency);
}

/** Runs the curated quick regression set and resolves to the exit code. */
export async function runQuickTests(options: QuickRunOptions = {}): Promise<number> {
  if (options.list || options.dryRun) {
    process.stdout.write(formatPlan(Boolean(options.dryRun)));
    return 0;
  }

  const wallBegan = Date.now();
  const children: ChildProcess[] = [];
  const stopChildren = (): void => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
    }
  };
  process.once('SIGINT', stopChildren);
  process.once('SIGTERM', stopChildren);

  const results: QuickStageResult[] = [];
  let postgres: TemporaryPostgres | undefined;
  let compileCache: string | undefined;

  try {
    const baseEnv = cleanBaseEnv();
    const contractResult = await timedStage('[1/4] 合约生成物一致性校验', () =>
      runSpawned(['tools/gen-contracts.ts', '--check'], baseEnv, children),
    );
    results.push(contractResult);
    if (contractResult.code !== 0) {
      printSummary(results, (Date.now() - wallBegan) / 1000);
      return contractResult.code;
    }

    const typeResult = await timedStage('[2/4] TypeScript 类型检查（主仓库 + .github/checks）', async () => {
      const rootCode = await runSpawned([TSC_ENTRY, '--noEmit'], baseEnv, children);
      const checksCode = await runSpawned([TSC_ENTRY, '--noEmit', '-p', '.github/checks'], baseEnv, children);
      return rootCode !== 0 ? rootCode : checksCode;
    });
    results.push(typeResult);
    if (typeResult.code !== 0) {
      printSummary(results, (Date.now() - wallBegan) / 1000);
      return typeResult.code;
    }

    if (
      process.env.NODE_DISABLE_COMPILE_CACHE !== '1'
      && !usesCoverage()
    ) {
      compileCache = await mkdtemp(join(tmpdir(), 'circle-hub-quick-compile-'));
    }

    const pgBegan = Date.now();
    postgres = await startPostgres({ maxConnections: 500, sharedBuffers: '512MB', autovacuum: false, private: true });
    await prepareTemplate(postgres);
    process.stderr.write(`\n共享 PostgreSQL 模板准备完成 (${((Date.now() - pgBegan) / 1000).toFixed(2)}s)\n`);

    const laneEnv: NodeJS.ProcessEnv = {
      ...sharedEnv(postgres),
      ...(compileCache ? { NODE_COMPILE_CACHE: compileCache } : {}),
    };
    delete laneEnv.NODE_TEST_CONTEXT;

    const unitOrdered = orderedQuickUnitFiles();
    const unitConcurrency = quickUnitConcurrency(unitOrdered.length);
    const unitResult = await timedStage(
      `[3/4] 快速单元测试（${unitOrdered.length} 文件，concurrency=${unitConcurrency}）`,
      () => runSpawned(testLaneArgs(unitOrdered, unitConcurrency), laneEnv, children),
    );
    results.push(unitResult);

    const acceptanceOrdered = quickAcceptanceFiles();
    const acceptanceResult = await timedStage(
      `[4/4] 快速验收测试（${acceptanceOrdered.length} 文件，concurrency=1）`,
      () => runSpawned(testLaneArgs(acceptanceOrdered, 1), laneEnv, children),
    );
    results.push(acceptanceResult);

    const totalSeconds = (Date.now() - wallBegan) / 1000;
    printSummary(results, totalSeconds);
    return results.find((result) => result.code !== 0)?.code ?? 0;
  } finally {
    process.off('SIGINT', stopChildren);
    process.off('SIGTERM', stopChildren);
    try {
      await postgres?.stop();
    } finally {
      if (compileCache) await rm(compileCache, { recursive: true, force: true });
    }
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const valid = args.every((arg) => arg === '--list' || arg === '--dry-run');
  if (!valid || args.length > 1) {
    process.stderr.write('用法：node tools/run-quick-tests.ts [--list|--dry-run]\n');
    process.exitCode = 2;
  } else {
    runQuickTests({
      list: args.includes('--list'),
      dryRun: args.includes('--dry-run'),
    }).then(
      (code) => {
        process.exitCode = code;
      },
      (error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 2;
      },
    );
  }
}
