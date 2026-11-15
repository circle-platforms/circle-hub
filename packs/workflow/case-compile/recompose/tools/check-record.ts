// 只读离线预检查用例重组（recompose）单条或整目录记录文件：UTF-8/JSON 语法、单一精简形状、item/method/重复 item 及可选 --run 原句完整性，不接触 Hub 或令牌，不写入磁盘：
//   node <技能目录>/tools/check-record.ts --file <重组记录JSON或目录> [--run <下载运行目录>]
import { realpathSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSubmittedJson, readSubmittedFileBytes } from '../functions/hub-retry.ts';
import { formatCallError, isRecord, parseCliOptions, type CallErrorCategory } from '../functions/text.ts';
import { assertValidRecomposeShape, recordFor, submissionFor } from './submit-records.ts';

const OPTIONS: Record<string, boolean> = { file: true, run: false };
const USAGE = 'node <技能目录>/tools/check-record.ts --file <重组记录JSON或目录> [--run <下载运行目录>]';
const HELP_TEXT = [
  `用法：${USAGE}`,
  '',
  '用途：在 submit-records.ts 前离线检查重组记录是否为合法 UTF-8 JSON 且符合单一精简格式（拒绝完整 recompose-record@1 结构、缺 item/method 或同 item 重复）。',
  '可选：传入 --run <下载的运行目录>（含 run.json）可额外离线核对原始条目覆盖完整性与原句/期望引用一致。',
].join('\n');

export interface RecordProblem {
  code?: string;
  file?: string;
  message: string;
}

export interface CheckedRecordEntry {
  file: string;
  ok: boolean;
  item: string | null;
  method_kind: string | null;
  problems: RecordProblem[];
}

export interface CheckRecordReport {
  ok: boolean;
  mode: 'file' | 'directory';
  target: string;
  checked: number;
  passed: number;
  failed: number;
  items: CheckedRecordEntry[];
  problems: RecordProblem[];
}

type RunRow = { [key: string]: any };

async function loadOptionalRun(runDir: string): Promise<RunRow> {
  const dirStat = await lstat(runDir).catch(() => null);
  if (!dirStat) {
    throw new Error(`不存在：找不到 --run 运行目录 ${runDir}。请确认目录存在或先运行 download-run.ts`);
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error(`参数无效：--run 路径 ${runDir} 必须是普通目录`);
  }
  const runJsonPath = join(runDir, 'run.json');
  const bytes = await readSubmittedFileBytes(runJsonPath, 'run');
  const parsed = parseSubmittedJson('run', 'run.json', bytes, '重新下载运行目录');
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
    throw new Error('参数无效：--run 目录下的 run.json 缺少 items 数组。请重新运行 download-run.ts 后重试');
  }
  return parsed as RunRow;
}

function writeProblemStderr(
  category: CallErrorCategory,
  summary: string,
  problems: readonly RecordProblem[],
  nextStep: string,
): void {
  const detail = problems
    .slice(0, 5)
    .map((p) => (p.file ? `${p.file}: ${p.message}` : p.message))
    .join('；');
  const suffix = problems.length > 5 ? `（另有 ${problems.length - 5} 处见 stdout）` : '';
  process.stderr.write(formatCallError(`${summary}（${detail}${suffix}）。${nextStep}`, { category }) + '\n');
}

/** Validates one lite recompose record file or a directory of `.json` record files offline. */
export async function checkRecordTarget(options: { file: string; run?: string }): Promise<CheckRecordReport> {
  const targetStat = await lstat(options.file).catch(() => null);
  if (!targetStat) {
    throw new Error(`不存在：找不到 --file 路径 ${options.file}。请先写入重组记录 JSON 文件或目录后再自检`);
  }
  if (targetStat.isSymbolicLink()) {
    throw new Error(`参数无效：--file 路径 ${options.file} 不能是符号链接。请改用真实文件或目录后再自检`);
  }
  const runData = options.run !== undefined ? await loadOptionalRun(options.run) : null;

  if (targetStat.isDirectory()) {
    const names = (await readdir(options.file)).filter((name) => name.endsWith('.json')).sort();
    if (names.length === 0) {
      throw new Error(`不存在：--file 目录 ${options.file} 里没有 .json 文件。请先写入重组记录文件后再自检`);
    }
    const items: CheckedRecordEntry[] = [];
    const seen = new Map<string, string>();
    const validRows: RunRow[] = [];
    const dirProblems: RecordProblem[] = [];

    for (const name of names) {
      const fullPath = join(options.file, name);
      const problems: RecordProblem[] = [];
      let itemId: string | null = null;
      let methodKind: string | null = null;
      try {
        const bytes = await readSubmittedFileBytes(fullPath, 'file');
        const parsed = parseSubmittedJson('file', name, bytes, '再做用例重组');
        const validated = assertValidRecomposeShape(parsed, `--file 目录下的 ${name}`, true);
        itemId = validated.item as string;
        methodKind = validated.method.kind as string;
        const earlier = seen.get(itemId);
        if (earlier !== undefined) {
          const msg = `${earlier} 和 ${name} 是同一个条目 ${itemId}；每个条目只留一个文件`;
          problems.push({ code: 'duplicate_item', file: name, message: msg });
        } else {
          seen.set(itemId, name);
          if (runData !== null) {
            const matched = (runData.items as RunRow[]).find((it) => it.id === itemId);
            if (!matched) {
              problems.push({ file: name, message: `条目 ${itemId} 不属于 --run ${runData.run ?? ''} 的本次原始用例` });
            } else {
              recordFor(matched, validated, 'check');
            }
          }
          if (problems.length === 0) validRows.push(validated);
        }
      } catch (error) {
        problems.push({ file: name, message: error instanceof Error ? error.message : String(error) });
      }
      items.push({ file: name, ok: problems.length === 0, item: itemId, method_kind: methodKind, problems });
    }

    if (runData !== null && items.every((entry) => entry.ok)) {
      try {
        submissionFor(runData, validRows, 'check');
      } catch (error) {
        dirProblems.push({ message: error instanceof Error ? error.message : String(error) });
      }
    }

    const failedItems = items.filter((entry) => !entry.ok);
    const allProblems: RecordProblem[] = [
      ...dirProblems,
      ...failedItems.flatMap((entry) => entry.problems),
    ];
    return {
      ok: allProblems.length === 0,
      mode: 'directory',
      target: options.file,
      checked: items.length,
      passed: items.length - failedItems.length,
      failed: failedItems.length,
      items,
      problems: allProblems,
    };
  }

  if (!targetStat.isFile()) {
    throw new Error(`参数无效：--file 路径 ${options.file} 必须是普通 .json 文件或目录`);
  }

  const name = basename(options.file);
  const problems: RecordProblem[] = [];
  let itemId: string | null = null;
  let methodKind: string | null = null;
  try {
    const bytes = await readSubmittedFileBytes(options.file, 'file');
    const parsed = parseSubmittedJson('file', name, bytes, '再做用例重组');
    const validated = assertValidRecomposeShape(parsed, `重组记录 ${name}`, true);
    itemId = validated.item as string;
    methodKind = validated.method.kind as string;
    if (runData !== null) {
      const matched = (runData.items as RunRow[]).find((it) => it.id === itemId);
      if (!matched) {
        problems.push({ file: name, message: `条目 ${itemId} 不属于 --run ${runData.run ?? ''} 的本次原始用例` });
      } else {
        recordFor(matched, validated, 'check');
      }
    }
  } catch (error) {
    problems.push({ file: name, message: error instanceof Error ? error.message : String(error) });
  }
  const ok = problems.length === 0;
  return {
    ok,
    mode: 'file',
    target: options.file,
    checked: 1,
    passed: ok ? 1 : 0,
    failed: ok ? 0 : 1,
    items: [{ file: name, ok, item: itemId, method_kind: methodKind, problems }],
    problems,
  };
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write(HELP_TEXT + '\n');
      return 0;
    }
    const args = parseCliOptions(argv, OPTIONS, USAGE);
    const report = await checkRecordTarget({
      file: args.file!,
      ...(args.run !== undefined ? { run: args.run } : {}),
    });
    process.stdout.write(JSON.stringify(report) + '\n');
    if (!report.ok) {
      const onlyDuplicate =
        report.problems.length > 0 && report.problems.every((p) => p.code === 'duplicate_item');
      writeProblemStderr(
        onlyDuplicate ? '已被占用' : '参数无效',
        onlyDuplicate
          ? `目录 ${args.file} 中有多个文件使用了同一条目 item`
          : `${report.mode === 'directory' ? `目录 ${args.file}` : `文件 ${args.file}`} 未通过重组记录自检`,
        report.problems,
        onlyDuplicate
          ? '请为每条原始用例只保留一个文件后再提交'
          : '请按单一精简格式修改对应文件后重新自检',
      );
      return 1;
    }
    return 0;
  } catch (error) {
    process.stderr.write(formatCallError(error) + '\n');
    return 1;
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
