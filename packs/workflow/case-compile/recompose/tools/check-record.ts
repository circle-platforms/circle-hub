import { formatClientCallError } from '../functions/client-cli.ts';
// Read-only offline pre-check of lite recompose records, one file or a directory of them: UTF-8/JSON syntax, the single lite shape,
// item/method and duplicate items. With --run it also runs, on the same frozen run and locked command tree, what the Hub runs on a
// records submission: the structure check of the slot record against slots.schema.json and the function checks of this pack's
// checks.json (record, full_set), so a problem the Hub would refuse is reported here with the Hub's own words. It touches neither
// the Hub nor a token and writes nothing:
//   node <skill directory>/tools/check-record.ts --file <record JSON or directory> [--run <downloaded run directory>]
import { realpathSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSubmittedJson, readSubmittedFileBytes } from '../functions/hub-retry.ts';
import { readKnowledgeNodes, runLocalChecks, type CheckedOutcome, type KnowledgeNodes } from '../functions/local-checks.ts';
import { CallFailure, isRecord, parseCliOptions } from '../functions/text.ts';
import type { CallErrorCategory } from '../functions/generated/vocabulary.ts';
import { assertValidRecomposeShape, itemSubmission, submissionFor } from './submit-records.ts';
import type { Verdict } from '../../../../../contracts/generated/vocabulary.ts';

const OPTIONS: Record<string, boolean> = { file: true, run: false };
const USAGE = 'node <技能目录>/tools/check-record.ts --file <重组记录JSON或目录> [--run <运行目录>]';
const HELP_TEXT = [
  `用法：${USAGE}`,
  '',
  '用途：在 submit-records.ts 前离线检查重组记录：合法 UTF-8 JSON、符合单一精简格式（拒绝完整 recompose-record@1 结构、缺 item/method 或同 item 重复）。',
  '必带 --run <运行目录>（下载的运行目录，含 run.json 和 knowledge/nodes.jsonl）：再核对原始条目覆盖完整性，并用同一份冻结的运行和锁定命令树、同一批检查函数（本包 checks.json 里的 record、full_set）按 Hub 的方式核对每条记录，Hub 会拒绝的问题这里同样报出，措辞相同。',
  '不带 --run 只核对形状，结果里 hub_checks.ran 为 false：Hub 的检查没有跑，不能当作 Hub 会接受。',
].join('\n');

export interface RecordProblem {
  code?: string;
  file?: string;
  /** The frozen item the problem is about. */
  item?: string;
  /** The check of the pack's checks.json that gave it (absent for the format checks of this tool). */
  check?: string;
  verdict?: Extract<Verdict, 'refute' | 'unknown'>;
  pointer?: string;
  message: string;
  /** The machine-readable part of the check's outcome, as the Hub records it. */
  data?: Record<string, unknown>;
}

export interface CheckedRecordEntry {
  file: string;
  ok: boolean;
  item: string | null;
  method_kind: string | null;
  problems: RecordProblem[];
}

/** Which of the Hub's checks ran on the records, and which could not. */
export interface HubChecks {
  ran: boolean;
  run?: string;
  /** Why the Hub's checks did not run (only when `ran` is false). */
  why?: string;
  /** The structure checks of the pack's slots file run here, which the Hub runs first and refuses the whole record on. */
  structure: string[];
  /** The checks of the pack's checks.json run here, in declared order. */
  checks: string[];
  /** The declared checks not run here, each with the reason. */
  not_run: Array<{ check: string; why: string }>;
  /** Facts the Hub knows and the download does not carry, taken as stated here. */
  assumed: string[];
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
  hub_checks: HubChecks;
}

type RunRow = { [key: string]: any };
interface FrozenRun { run: RunRow; nodes: KnowledgeNodes }

const ASSUMED = ['产品声明的命令目录是否完整：下载里没有这条声明，本地按完整核对；若锁定根没有声明完整，Hub 会另外指出缺口'];

/** The one-line correct form every refused `--run` is answered with: the same line as in the case-compile pack's tools/workspace-path.ts (the packs are published apart; the pack tests compare the two). */
const RUN_DIRECTORY_FORM = "--run '<运行目录>'（放 run.json 的目录，不是 run.json 文件）";

async function loadFrozenRun(runDir: string): Promise<FrozenRun> {
  const dirStat = await lstat(runDir).catch((error) => { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; });
  if (!dirStat) {
    throw new CallFailure("not_found", `找不到 --run 运行目录 ${runDir}。请确认目录存在或先运行 download-run.ts`, "先用 download-run.ts 保存完整运行目录，再用 --run 指定该目录", { legal_form: RUN_DIRECTORY_FORM });
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new CallFailure("invalid_parameters", `--run 路径 ${runDir} 必须是普通目录`, "把 --run 指向包含 run.json 的真实普通目录，不使用符号链接", { legal_form: RUN_DIRECTORY_FORM });
  }
  const runJsonPath = join(runDir, 'run.json');
  const bytes = await readSubmittedFileBytes(runJsonPath, 'run');
  const parsed = parseSubmittedJson('run', 'run.json', bytes, '重新下载运行目录');
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
    throw new CallFailure("invalid_parameters", '--run 目录下的 run.json 缺少 items 数组。请重新运行 download-run.ts 后重试', "重新下载该运行的完整 run.json，保留 items 数组后自检");
  }
  return { run: parsed as RunRow, nodes: await readKnowledgeNodes(runDir, parsed) };
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
  process.stderr.write(formatClientCallError(new CallFailure(category, `${summary}（${detail}${suffix}）`, nextStep)) + '\n');
}

/** An outcome of a Hub check as the problem the model reads: the Hub's own code and words (`code ?? reason`, `missing ?? statement`). */
function problemOf(file: string | undefined, { check, item, outcome }: CheckedOutcome): RecordProblem {
  return {
    code: outcome.code ?? outcome.reason,
    ...(file !== undefined ? { file } : {}),
    ...(item !== null ? { item } : {}),
    check,
    verdict: outcome.verdict,
    ...(typeof outcome.pointer === 'string' ? { pointer: outcome.pointer } : {}),
    message: outcome.missing ?? outcome.statement,
    ...(isRecord(outcome.data) ? { data: outcome.data } : {}),
  };
}

interface CheckedFile {
  entry: CheckedRecordEntry;
  /** The validated file and its submission entry, when it passed every check before the Hub's. */
  row?: RunRow;
  submitted?: { item: string; slots: RunRow };
}

/** The format checks of one file, and, with a frozen run, its membership and the submission entry the Hub's checks run on. */
async function checkFile(name: string, path: string, label: string, frozen: FrozenRun | null, seen: Map<string, string> | null): Promise<CheckedFile> {
  const problems: RecordProblem[] = [];
  let itemId: string | null = null;
  let methodKind: string | null = null;
  let submitted: CheckedFile['submitted'];
  let row: RunRow | undefined;
  try {
    const bytes = await readSubmittedFileBytes(path, 'file');
    const parsed = parseSubmittedJson('file', name, bytes, '再做用例重组');
    const validated = assertValidRecomposeShape(parsed, label, true);
    itemId = validated.item as string;
    methodKind = validated.method.kind as string;
    const earlier = seen?.get(itemId);
    if (earlier !== undefined) {
      problems.push({ code: 'duplicate_item', file: name, message: `${earlier} 和 ${name} 是同一个条目 ${itemId}；每个条目只留一个文件` });
    } else {
      seen?.set(itemId, name);
      if (frozen !== null) {
        const matched = (frozen.run.items as RunRow[]).find((it) => it.id === itemId);
        if (!matched) {
          problems.push({ file: name, message: `条目 ${itemId} 不属于 --run ${frozen.run.run ?? ''} 的本次原始用例` });
        } else {
          const built = itemSubmission(matched, validated, 'check-record');
          row = validated;
          submitted = { item: itemId, slots: built.slots };
        }
      }
    }
  } catch (error) {
    problems.push({ file: name, message: error instanceof Error ? error.message : String(error) });
  }
  return { entry: { file: name, ok: problems.length === 0, item: itemId, method_kind: methodKind, problems }, ...(problems.length === 0 && submitted !== undefined ? { row, submitted } : {}) };
}

/** Validates one lite recompose record file or a directory of `.json` record files offline. */
export async function checkRecordTarget(options: { file: string; run?: string }): Promise<CheckRecordReport> {
  const targetStat = await lstat(options.file).catch((error) => { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; });
  if (!targetStat) {
    throw new CallFailure("not_found", `找不到 --file 路径 ${options.file}。请先写入重组记录 JSON 文件或目录后再自检`, "先写入本次重组记录，再用 --file 指定存在的 JSON 文件或目录");
  }
  if (targetStat.isSymbolicLink()) {
    throw new CallFailure("invalid_parameters", `--file 路径 ${options.file} 不能是符号链接。请改用真实文件或目录后再自检`, "把 --file 指向真实普通文件或目录，不使用符号链接");
  }
  const frozen = options.run !== undefined ? await loadFrozenRun(options.run) : null;
  const directory = targetStat.isDirectory();
  if (!directory && !targetStat.isFile()) {
    throw new CallFailure("invalid_parameters", `--file 路径 ${options.file} 必须是普通 .json 文件或目录`, "把 --file 指向普通 .json 文件或含重组记录 JSON 的目录");
  }

  let names: string[];
  if (directory) {
    names = (await readdir(options.file)).filter((name) => name.endsWith('.json')).sort();
    if (names.length === 0) {
      throw new CallFailure("not_found", `--file 目录 ${options.file} 里没有 .json 文件。请先写入重组记录文件后再自检`, "在 --file 目录中为每条原始用例写一个 .json 重组记录后重新自检");
    }
  } else {
    names = [basename(options.file)];
  }
  const seen = directory ? new Map<string, string>() : null;
  const files: CheckedFile[] = [];
  for (const name of names) files.push(await checkFile(name, directory ? join(options.file, name) : options.file, directory ? `--file 目录下的 ${name}` : `重组记录 ${name}`, frozen, seen));

  const dirProblems: RecordProblem[] = [];
  let hub: CheckRecordReport['hub_checks'] = { ran: false, why: '没有 --run：只核对了单一精简格式；Hub 的重组检查没有运行，不能当作 Hub 会接受。下一步：用 --run <运行目录> 重检', structure: [], checks: [], not_run: [], assumed: [] };
  if (frozen !== null) {
    // The run-level checks need every frozen item; the tool-level wording for a missing item is the one submit-records gives too.
    let complete: true | string;
    if (!directory) complete = '单个文件只核对这一条；整批封批要用目录模式核对';
    else if (files.some((file) => !file.entry.ok)) complete = '还有文件没有通过上面的检查，整批封批无从核对';
    else {
      complete = true;
      try {
        submissionFor(frozen.run, files.map((file) => file.row!), 'check-record');
      } catch (error) {
        dirProblems.push({ message: error instanceof Error ? error.message : String(error) });
        complete = '还有原始用例没有重组后的用例，整批封批无从核对';
      }
    }
    const result = await runLocalChecks({ run: frozen.run, nodes: frozen.nodes, items: files.flatMap((file) => (file.submitted ? [file.submitted] : [])), complete });
    for (const checked of result.outcomes) {
      if (checked.outcome.verdict === 'support') continue;
      const owner = checked.item === null ? undefined : files.find((file) => file.entry.item === checked.item && file.submitted !== undefined);
      if (owner !== undefined) {
        owner.entry.problems.push(problemOf(owner.entry.file, checked));
        owner.entry.ok = false;
      } else {
        dirProblems.push(problemOf(undefined, checked));
      }
    }
    hub = { ran: true, run: String(frozen.run.run), structure: result.structure, checks: result.checks, not_run: result.not_run, assumed: ASSUMED };
  }

  const items = files.map((file) => file.entry);
  const failedItems = items.filter((entry) => !entry.ok);
  const allProblems: RecordProblem[] = [...dirProblems, ...failedItems.flatMap((entry) => entry.problems)];
  return {
    ok: allProblems.length === 0,
    mode: directory ? 'directory' : 'file',
    target: options.file,
    checked: items.length,
    passed: items.length - failedItems.length,
    failed: failedItems.length,
    items,
    problems: allProblems,
    hub_checks: hub,
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
        onlyDuplicate ? 'occupied' : 'invalid_parameters',
        onlyDuplicate
          ? `目录 ${args.file} 中有多个文件使用了同一条目 item`
          : `${report.mode === 'directory' ? `目录 ${args.file}` : `文件 ${args.file}`} 未通过重组记录自检`,
        report.problems,
        onlyDuplicate
          ? '请为每条原始用例只保留一个文件后再提交'
          : '请按问题点名的位置和值修改对应文件后重新自检',
      );
      return 1;
    }
    return 0;
  } catch (error) {
    process.stderr.write(formatClientCallError(error) + '\n');
    return 1;
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
