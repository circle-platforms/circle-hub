// The server CLI's `knowledge sync --product <name> [--line <line>] [--dry-run] [--recheck] [--include-unreleased]`: argument
// parsing, the run, and the Chinese report text. The server wires the subcommand and the admin principal; this module never
// reads the environment.
import type { PacksPort, ResourceCatalogPort } from '../ports.ts';
import type { Principal } from '../records/api.ts';
import { KnowledgeError } from './errors.ts';
import type { Knowledge } from './service.ts';
import { KNOWLEDGE_SEED_USAGE, formatSeedReport, knowledgeSeed, parseKnowledgeSeedArgs } from './seed.ts';
import type { BuildOutcome, SyncReport } from './sync.ts';

export interface KnowledgeSyncArgs {
  /** Any name of the product, or its line id. */
  product: string;
  line: string | null;
  dryRun: boolean;
  recheck: boolean;
  includeUnreleased: boolean;
  /** List sources stored at most this many seconds ago are used again (null: the service's default; 0 reads every one). */
  maxAgeSeconds: number | null;
}

export const KNOWLEDGE_SYNC_USAGE = 'knowledge sync --product <产品名> [--line <版本线>] [--dry-run] [--recheck] [--include-unreleased] [--max-age <秒>]';

/** Parses the arguments after `knowledge sync`. Throws KnowledgeError with the usage on anything unknown or missing. */
export function parseKnowledgeSyncArgs(argv: readonly string[]): KnowledgeSyncArgs {
  const out: KnowledgeSyncArgs = { product: '', line: null, dryRun: false, recheck: false, includeUnreleased: false, maxAgeSeconds: null };
  const value = (name: string, inline: string | undefined, i: number): [string, number] => {
    if (inline !== undefined) return [inline, i];
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) throw new KnowledgeError(`${name} 缺少取值；用法：${KNOWLEDGE_SYNC_USAGE}`);
    return [next, i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg : arg.slice(0, eq);
    const inline = eq < 0 ? undefined : arg.slice(eq + 1);
    switch (name) {
      case '--product':
        [out.product, i] = value(name, inline, i);
        break;
      case '--line': {
        let line: string;
        [line, i] = value(name, inline, i);
        out.line = line;
        break;
      }
      case '--max-age': {
        let text: string;
        [text, i] = value(name, inline, i);
        if (!/^(0|[1-9][0-9]{0,9})$/.test(text)) throw new KnowledgeError(`--max-age 要是不小于 0 的整数秒；用法：${KNOWLEDGE_SYNC_USAGE}`);
        out.maxAgeSeconds = Number(text);
        break;
      }
      case '--dry-run':
      case '--recheck':
      case '--include-unreleased':
        if (inline !== undefined) throw new KnowledgeError(`${name} 不带取值；用法：${KNOWLEDGE_SYNC_USAGE}`);
        if (name === '--dry-run') out.dryRun = true;
        else if (name === '--recheck') out.recheck = true;
        else out.includeUnreleased = true;
        break;
      default:
        throw new KnowledgeError(`不认识的参数 ${arg.slice(0, 80)}；用法：${KNOWLEDGE_SYNC_USAGE}`);
    }
  }
  if (out.product.trim() === '') throw new KnowledgeError(`要用 --product 指定产品；用法：${KNOWLEDGE_SYNC_USAGE}`);
  if (out.line !== null && out.line.trim() === '') throw new KnowledgeError('--line 的取值不能为空');
  return out;
}

/** Runs `knowledge sync` for an admin: the product by any of its names (or its line id), one line when given. */
export async function knowledgeSync(knowledge: Knowledge, packs: PacksPort, by: Principal, args: KnowledgeSyncArgs): Promise<SyncReport> {
  const product = (await packs.productByName(args.product)) ?? (await packs.productById(args.product));
  if (product === null) throw new KnowledgeError(`没有叫 ${args.product.slice(0, 80)} 的已发布产品包`);
  return knowledge.syncProduct(product, {
    by,
    ...(args.line === null ? {} : { lines: [args.line] }),
    dryRun: args.dryRun,
    recheck: args.recheck,
    includeUnreleased: args.includeUnreleased,
    ...(args.maxAgeSeconds === null || args.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: args.maxAgeSeconds }),
  });
}

/** What the `knowledge` command needs of the server's CLI context (structurally the server's CliContext). */
export interface KnowledgeCliContext {
  io: { stdout(line: string): void; stderr(line: string): void };
  /** The admin the command acts as: `--as <name or id>`, or the only enabled admin. */
  actingAdmin(as?: string): Promise<Principal>;
}

export interface KnowledgeCliCommand {
  name: 'knowledge';
  summary: string;
  run(args: readonly string[], context: KnowledgeCliContext): Promise<number>;
}

/**
 * The `knowledge` command for the server's registerCommands: `knowledge sync ... [--as <admin>]`. Exit codes follow the
 * server CLI: 0 when nothing failed, 1 when the sync or a build failed, 2 on a usage error. `open` builds the service.
 */
export function knowledgeCliCommand(open: () => Promise<{ knowledge: Knowledge; packs: PacksPort; resources?: ResourceCatalogPort }>): KnowledgeCliCommand {
  return {
    name: 'knowledge',
    summary: `知识：${KNOWLEDGE_SYNC_USAGE} [--as <管理员>]；${KNOWLEDGE_SEED_USAGE} [--as <管理员>]`,
    async run(args, context) {
      if (args[0] !== 'sync' && args[0] !== 'seed') {
        context.io.stderr(`用法：${KNOWLEDGE_SYNC_USAGE} [--as <管理员>]\n${KNOWLEDGE_SEED_USAGE} [--as <管理员>]`);
        return 2;
      }
      const rest = [...args.slice(1)];
      let as: string | undefined;
      const at = rest.findIndex((arg) => arg === '--as' || arg.startsWith('--as='));
      if (at >= 0) {
        const arg = rest[at];
        as = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rest[at + 1];
        rest.splice(at, arg.includes('=') ? 1 : 2);
        if (as === undefined || as === '' || as.startsWith('--')) {
          context.io.stderr('--as 缺少取值');
          return 2;
        }
      }
      if (args[0] === 'seed') {
        let parsed;
        try {
          parsed = parseKnowledgeSeedArgs(rest);
        } catch (error) {
          context.io.stderr((error as Error).message);
          return 2;
        }
        try {
          const by = await context.actingAdmin(as);
          const opened = await open();
          const report = await knowledgeSeed(opened.knowledge, opened.packs, by, parsed, opened.resources);
          for (const line of formatSeedReport(report).trimEnd().split('\n')) context.io.stdout(line);
          return report.ok ? 0 : 1;
        } catch (error) {
          context.io.stderr((error as Error).message);
          return 1;
        }
      }
      let parsed: KnowledgeSyncArgs;
      try {
        parsed = parseKnowledgeSyncArgs(rest);
      } catch (error) {
        context.io.stderr((error as Error).message);
        return 2;
      }
      try {
        const by = await context.actingAdmin(as);
        const { knowledge, packs } = await open();
        const report = await knowledgeSync(knowledge, packs, by, parsed);
        for (const line of formatSyncReport(report).trimEnd().split('\n')) context.io.stdout(line);
        return report.error === null && report.counts.failed === 0 ? 0 : 1;
      } catch (error) {
        context.io.stderr((error as Error).message);
        return 1;
      }
    },
  };
}

// Labels of the brief's three outcome words plus the name-only registration; no vocabulary axis holds them yet
// (README, Needs from contracts); keep them here only.
const OUTCOME_TEXT = { produced: '产出', registered: '登记', skipped: '跳过', failed: '失败' } as const satisfies Record<BuildOutcome, string>;

/** The report as Chinese text for the terminal. */
export function formatSyncReport(report: SyncReport): string {
  const lines: string[] = [];
  lines.push(`知识同步 ${report.sync}：产品 ${report.product}（${report.pack}）${report.dry_run ? '，试运行' : ''}`);
  if(report.dry_run)lines.push('试运行不写知识结果，读取仍留审计');
  lines.push(`开始 ${report.started_at}，结束 ${report.ended_at}`);
  if (report.error !== null) lines.push(`同步失败：${report.error}`);
  for(const variable of report.variables??[])lines.push(`变量 ${variable.name}：${variable.default?'试运行使用默认值':`第 ${variable.version} 版`}`);
  const plan = report.plan;
  lines.push(
    `计划：${plan.rounds} 轮，读了 ${plan.reads} 页（失败 ${plan.failed_reads.length} 页），列出 ${plan.builds} 个构建，${plan.done ? '计划已完成' : '计划未完成'}` +
      (plan.note ? `；${plan.note}` : ''),
  );
  if (plan.limits.rounds) lines.push(`  达到轮数上限 ${plan.limits.max_rounds}`);
  if (plan.limits.reads) lines.push(`  达到读页上限 ${plan.limits.max_reads}`);
  for (const failed of plan.failed_reads) lines.push(`  读取失败 ${failed.id}：${failed.reason}`);
  lines.push(`${report.scope === undefined ? '构建' : '构建与不分版本'}：产出 ${report.counts.produced}，只登记名字 ${report.counts.registered}，跳过 ${report.counts.skipped}，失败 ${report.counts.failed}`);
  for (const build of report.builds) {
    lines.push(`  [${OUTCOME_TEXT[build.outcome]}] ${build.name}（${build.family}，${build.line}${build.base === build.name ? '' : `，基于 ${build.base}`}）：${build.reason}${build.root ? ` 根 ${build.root}` : ''}`);
  }
  if(report.scope){const scope=report.scope;lines.push(`  不分版本 [${OUTCOME_TEXT[scope.outcome]}]：构建未声明；${scope.reason}${scope.root ? ` 根 ${scope.root}` : ''}`);}
  for (const pointer of report.pointers) {
    lines.push(`  当前根 ${pointer.line ?? '不分版本'}：${pointer.moved ? `${pointer.from ?? '（无）'} → ${pointer.to}（${pointer.build}）` : pointer.reason}`);
  }
  for (const warning of report.warnings) lines.push(`注意：${warning}`);
  return `${lines.join('\n')}\n`;
}
