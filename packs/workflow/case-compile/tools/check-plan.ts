// 只读检查自动化用例 JSON、自动化用例目录或场景保真判断（.verdict.json）的语法、长度占位与结构，不用令牌，不写入磁盘：
//   node <技能目录>/tools/check-plan.ts --file <计划或判断JSON> [--brief <核对文件>]
import { realpathSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BRIEF_SCHEMA,
  FIDELITY_VERDICTS,
  fidelityProblems,
  validateModelDisclosure,
  validateModelJudgment,
  type FidelityBrief,
  type FidelityRow,
  type ModelJudgment,
} from '../functions/fidelity.ts';
import { describeExpansions, expandValue } from '../functions/length-literals.ts';
import { isItemHandling, ITEM_HANDLING, type ItemHandling } from '../functions/generated/vocabulary.ts';
import { readSlots } from '../functions/slots.ts';
import { planDataOf } from '../functions/subject.ts';
import { formatCallError, isRecord, parseCliOptions, type CallErrorCategory } from '../functions/text.ts';
import { parsedPlanFile } from './submit-plans.ts';

const OPTIONS: Record<string, boolean> = { file: true, brief: false };
const USAGE = 'node <技能目录>/tools/check-plan.ts --file <计划或判断JSON> [--brief <核对文件>]';

export interface CheckProblem {
  code?: string;
  pointer: string;
  message: string;
}

export interface PlanCheckResult {
  ok: boolean;
  file: string;
  item: string | null;
  handling: string | null;
  kind: 'flat' | 'blocks' | 'skipped' | null;
  expansions: string[];
  counts: {
    blocks: number;
    steps: number;
    expects: number;
    cleanup_steps: number;
    replacements: number;
  } | null;
  problems: CheckProblem[];
}

function parseOptions(argv: string[]): { file: string; brief?: string } {
  const values = parseCliOptions(argv, OPTIONS, USAGE);
  return values.brief !== undefined ? { file: values.file!, brief: values.brief } : { file: values.file! };
}

function checkPlanObject(file: string, parsed: unknown): PlanCheckResult {
  const problems: CheckProblem[] = [];
  if (!isRecord(parsed)) {
    return {
      ok: false,
      file,
      item: null,
      handling: null,
      kind: null,
      expansions: [],
      counts: null,
      problems: [{ pointer: '', message: '文件顶层必须是 JSON 对象' }],
    };
  }
  const item = typeof parsed.item === 'string' && parsed.item.trim() ? parsed.item.trim() : null;
  const rawHandling = typeof parsed.handling === 'string' ? parsed.handling : null;
  if (!item) {
    problems.push({ pointer: '/item', message: '缺少非空的 item 字符串标识' });
  }
  if (!isItemHandling(rawHandling)) {
    problems.push({ pointer: '/handling', message: `handling 只能是 ${ITEM_HANDLING.join(' 或 ')}` });
    return { ok: false, file, item, handling: rawHandling, kind: null, expansions: [], counts: null, problems };
  }
  const handling: ItemHandling = rawHandling;
  if (handling === 'skipped') {
    if (typeof parsed.reason !== 'string' || !parsed.reason.trim()) {
      problems.push({ pointer: '/reason', message: 'handling 为 skipped 时必须写明非空的 reason' });
    }
    return {
      ok: problems.length === 0,
      file,
      item,
      handling,
      kind: 'skipped',
      expansions: [],
      counts: null,
      problems,
    };
  }

  let expanded: { value: unknown; expansions: ReturnType<typeof expandValue>['expansions'] };
  try {
    expanded = expandValue(parsed);
  } catch (error) {
    problems.push({
      pointer: '/slots/plan',
      message: error instanceof Error ? error.message : '长度占位无法展开',
    });
    return { ok: false, file, item, handling, kind: null, expansions: [], counts: null, problems };
  }

  const expandedRecord = isRecord(expanded.value) ? expanded.value : {};
  const slots = isRecord(expandedRecord.slots) ? expandedRecord.slots : null;
  if (!slots) {
    problems.push({ pointer: '/slots', message: 'handling 为 handled 时缺少 slots 对象' });
    return {
      ok: false,
      file,
      item,
      handling,
      kind: null,
      expansions: describeExpansions(file, expanded.expansions),
      counts: null,
      problems,
    };
  }
  if (Array.isArray(slots.plan)) {
    if (slots.plan.length !== 1) {
      problems.push({ pointer: '/slots/plan', message: 'slots.plan 必须恰好包含 1 个元素' });
    }
  } else if (!isRecord(slots.plan)) {
    problems.push({ pointer: '/slots/plan', message: '缺少 slots.plan' });
  }

  const planData = planDataOf(expandedRecord);
  const checked = readSlots(planData);
  if (!checked.ok) {
    for (const p of checked.problems) {
      problems.push({ pointer: p.pointer, message: p.message });
    }
    return {
      ok: false,
      file,
      item,
      handling,
      kind: null,
      expansions: describeExpansions(file, expanded.expansions),
      counts: null,
      problems,
    };
  }

  const s = checked.slots;
  const kind = s.blocks.length > 0 ? 'blocks' : 'flat';
  const cleanupSteps =
    s.steps.filter((step) => step.cleanup === true).length +
    s.blocks.filter((b) => isRecord(b) && b.kind === 'CLEANUP').length;

  return {
    ok: problems.length === 0,
    file,
    item,
    handling,
    kind,
    expansions: describeExpansions(file, expanded.expansions),
    counts: {
      blocks: s.blocks.length,
      steps: s.steps.length,
      expects: s.expects.length,
      cleanup_steps: cleanupSteps,
      replacements: s.replacements.length,
    },
    problems,
  };
}

function checkStandaloneVerdict(verdict: unknown): { problems: CheckProblem[]; rows: FidelityRow[] } {
  const problems: CheckProblem[] = [];
  const rows: FidelityRow[] = [];
  if (!isRecord(verdict)) {
    return { problems: [{ code: 'fidelity_shape', pointer: '', message: '判断文件顶层必须是 JSON 对象' }], rows };
  }
  for (const key of Object.keys(verdict)) {
    if (!['brief_sha256', 'steps', 'disclosure', 'model_disclosure'].includes(key)) {
      problems.push({
        code: 'fidelity_shape',
        pointer: `/${key}`,
        message: '多余字段；.verdict.json 只允许 brief_sha256、steps、disclosure 及可选 model_disclosure',
      });
    }
  }
  if (typeof verdict.brief_sha256 !== 'string' || !verdict.brief_sha256.trim()) {
    problems.push({ code: 'fidelity_shape', pointer: '/brief_sha256', message: '缺少非空的 brief_sha256' });
  }
  if (typeof verdict.disclosure !== 'string' || !verdict.disclosure.trim()) {
    problems.push({ code: 'fidelity_shape', pointer: '/disclosure', message: 'disclosure 必须是非空中文说明' });
  }
  if (verdict.model_disclosure !== undefined) {
    const md = validateModelDisclosure(verdict.model_disclosure, '/model_disclosure');
    if (!md.ok) problems.push({ code: 'fidelity_shape', pointer: md.pointer, message: md.message });
  }
  if (!Array.isArray(verdict.steps) || !verdict.steps.length) {
    problems.push({ code: 'fidelity_shape', pointer: '/steps', message: 'steps 必须是非空数组' });
    return { problems, rows };
  }
  const seen = new Set<string>();
  const rowAllowed = new Set(['n', 'verdict', 'step_indices', 'rationale', 'model_judgment']);
  for (const [index, raw] of verdict.steps.entries()) {
    const at = `/steps/${index}`;
    if (!isRecord(raw) || Object.keys(raw).some((k) => !rowAllowed.has(k)) || !['n', 'verdict', 'step_indices', 'rationale'].every((req) => Object.hasOwn(raw, req))) {
      problems.push({
        code: 'fidelity_shape',
        pointer: at,
        message: '每行必须写 n、verdict、step_indices、rationale（可选 model_judgment）',
      });
      continue;
    }
    let modelJudgment: ModelJudgment | undefined;
    if (raw.model_judgment !== undefined) {
      const mj = validateModelJudgment(raw.model_judgment, `${at}/model_judgment`);
      if (!mj.ok) {
        problems.push({ code: 'fidelity_shape', pointer: mj.pointer, message: mj.message });
      } else {
        modelJudgment = mj.value;
      }
    }
    if (typeof raw.n !== 'string' || !raw.n.trim()) {
      problems.push({ code: 'fidelity_shape', pointer: `${at}/n`, message: 'n 必须是非空作者步骤号' });
    } else if (seen.has(raw.n)) {
      problems.push({ code: 'fidelity_shape', pointer: `${at}/n`, message: `作者步骤 ${raw.n} 判了两次` });
    } else {
      seen.add(raw.n);
    }
    if (!(FIDELITY_VERDICTS as readonly unknown[]).includes(raw.verdict)) {
      problems.push({
        code: 'fidelity_shape',
        pointer: `${at}/verdict`,
        message: `verdict 只能是 ${FIDELITY_VERDICTS.join('、')}`,
      });
    }
    if (
      !Array.isArray(raw.step_indices) ||
      raw.step_indices.some((v) => typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
    ) {
      problems.push({
        code: 'fidelity_shape',
        pointer: `${at}/step_indices`,
        message: 'step_indices 必须是非负整数数组',
      });
    } else if (raw.verdict === 'preserved' && !raw.step_indices.length) {
      problems.push({
        code: 'author_step_unbound',
        pointer: `${at}/step_indices`,
        message: `作者步骤 ${String(raw.n)} 判 preserved 时 step_indices 不能为空`,
      });
    }
    if (typeof raw.rationale !== 'string' || !raw.rationale.trim()) {
      problems.push({ code: 'fidelity_shape', pointer: `${at}/rationale`, message: 'rationale 必须是非空说明' });
    }
    if (
      typeof raw.n === 'string' &&
      (FIDELITY_VERDICTS as readonly unknown[]).includes(raw.verdict) &&
      Array.isArray(raw.step_indices) &&
      typeof raw.rationale === 'string'
    ) {
      rows.push({
        n: raw.n,
        verdict: raw.verdict as FidelityRow['verdict'],
        step_indices: raw.step_indices as number[],
        rationale: raw.rationale.trim(),
        ...(modelJudgment ? { model_judgment: modelJudgment } : {}),
      });
    }
  }
  return { problems, rows };
}

function isBriefObject(value: unknown): value is FidelityBrief {
  return (
    isRecord(value) &&
    value.schema === BRIEF_SCHEMA &&
    typeof value.brief_sha256 === 'string' &&
    Array.isArray(value.author_steps) &&
    Array.isArray(value.blocks)
  );
}

function looksLikeVerdict(filePath: string, parsed: unknown): boolean {
  if (basename(filePath).endsWith('.verdict.json')) return true;
  return (
    isRecord(parsed) &&
    !('item' in parsed) &&
    !('handling' in parsed) &&
    ('brief_sha256' in parsed || ('steps' in parsed && 'disclosure' in parsed))
  );
}

function writeProblemStderr(
  category: CallErrorCategory,
  summary: string,
  problems: readonly CheckProblem[],
  nextStep: string,
): void {
  const detail = problems
    .slice(0, 5)
    .map((p) => (p.pointer ? `${p.pointer}: ${p.message}` : p.message))
    .join('；');
  const suffix = problems.length > 5 ? `（另有 ${problems.length - 5} 处见 stdout）` : '';
  process.stderr.write(formatCallError(`${summary}（${detail}${suffix}）。${nextStep}`, { category }) + '\n');
}

export async function main(argv: string[]): Promise<number> {
  try {
    const args = parseOptions(argv);
    const targetInfo = await stat(args.file);

    if (targetInfo.isDirectory()) {
      if (args.brief !== undefined) {
        throw new Error('--brief 只能配合单个 .verdict.json 使用，不能和目录一起使用。请指定具体的判断文件后重试');
      }
      const entries = (await readdir(args.file)).filter((name) => name.endsWith('.json')).sort();
      if (!entries.length) {
        throw new Error(`不存在：目录 ${args.file} 里没有 .json 文件。请核对计划目录路径或先写出计划文件后重试`);
      }
      const results: PlanCheckResult[] = [];
      const seenItems = new Map<string, string>();
      const dirProblems: CheckProblem[] = [];

      for (const name of entries) {
        const fullPath = join(args.file, name);
        let parsed: unknown;
        try {
          parsed = parsedPlanFile(name, await readFile(fullPath));
        } catch (error) {
          results.push({
            ok: false,
            file: name,
            item: null,
            handling: null,
            kind: null,
            expansions: [],
            counts: null,
            problems: [{ pointer: '', message: error instanceof Error ? error.message : '无法解析文件' }],
          });
          continue;
        }
        const res = checkPlanObject(name, parsed);
        if (res.item) {
          const earlier = seenItems.get(res.item);
          if (earlier !== undefined) {
            const msg = `${earlier} 和 ${name} 对应同一条原始用例 ${res.item}`;
            res.problems.push({ code: 'duplicate_item', pointer: '/item', message: msg });
            res.ok = false;
            dirProblems.push({ code: 'duplicate_item', pointer: `/${name}`, message: msg });
          } else {
            seenItems.set(res.item, name);
          }
        }
        results.push(res);
      }

      const failedItems = results.filter((r) => !r.ok);
      const passedCount = results.length - failedItems.length;
      const allProblems = [
        ...dirProblems,
        ...failedItems.flatMap((r) =>
          r.problems.map((p) => ({
            ...(p.code ? { code: p.code } : {}),
            pointer: p.pointer ? `${r.file}${p.pointer}` : r.file,
            message: p.message,
          })),
        ),
      ];
      const ok = failedItems.length === 0;
      process.stdout.write(
        JSON.stringify({
          ok,
          mode: 'directory',
          directory: args.file,
          checked: results.length,
          passed: passedCount,
          failed: failedItems.length,
          items: results,
          problems: allProblems,
        }) + '\n',
      );
      if (!ok) {
        const onlyDuplicate =
          allProblems.length > 0 && allProblems.every((p) => p.code === 'duplicate_item');
        writeProblemStderr(
          onlyDuplicate ? '已被占用' : '参数无效',
          onlyDuplicate
            ? `目录 ${args.file} 中存在重复对应同一条原始用例的文件`
            : `目录 ${args.file} 中有 ${failedItems.length} 份文件未通过检查`,
          allProblems,
          onlyDuplicate ? '请只保留每条原始用例对应的唯一计划文件后重检' : '请按 stdout 中的 problems 字段修改对应文件后重检',
        );
        return 1;
      }
      return 0;
    }

    if (!targetInfo.isFile()) {
      throw new Error(`${args.file} 不是常规文件或目录。请指定计划 JSON、.verdict.json 或计划目录后重试`);
    }

    const name = basename(args.file);
    const bytes = await readFile(args.file);
    let parsed: unknown;
    try {
      parsed = parsedPlanFile(name, bytes);
    } catch (error) {
      const msg = error instanceof Error ? error.message : '无法解析文件';
      const problem: CheckProblem = { pointer: '', message: msg };
      process.stdout.write(
        JSON.stringify({ ok: false, mode: args.brief || name.endsWith('.verdict.json') ? 'verdict' : 'plan', file: args.file, problems: [problem] }) + '\n',
      );
      process.stderr.write(formatCallError(error, { category: '参数无效' }) + '\n');
      return 1;
    }

    if (args.brief !== undefined || looksLikeVerdict(args.file, parsed)) {
      if (args.brief !== undefined) {
        const briefInfo = await stat(args.brief);
        if (!briefInfo.isFile()) {
          throw new Error(`--brief 指定的 ${args.brief} 不是常规文件。请传入 fidelity-brief.ts 生成的 .brief.json 文件`);
        }
        const briefObj = parsedPlanFile(basename(args.brief), await readFile(args.brief));
        if (!isBriefObject(briefObj)) {
          throw new Error(`--brief 指定的 ${args.brief} 不是有效的场景保真核对简报。请使用 fidelity-brief.ts 生成的 .brief.json 文件`);
        }
        const checked = fidelityProblems(briefObj, parsed);
        const ok = checked.problems.length === 0;
        process.stdout.write(
          JSON.stringify({
            ok,
            mode: 'verdict',
            file: args.file,
            brief: args.brief,
            steps: checked.rows.length,
            rows: checked.rows,
            problems: checked.problems,
          }) + '\n',
        );
        if (!ok) {
          writeProblemStderr(
            '参数无效',
            `${name} 对照 ${basename(args.brief)} 未通过检查`,
            checked.problems,
            '请按 stdout 中的 problems 修正判断文件或重跑 fidelity-brief.ts 后重检',
          );
          return 1;
        }
        return 0;
      }

      const checked = checkStandaloneVerdict(parsed);
      const ok = checked.problems.length === 0;
      process.stdout.write(
        JSON.stringify({
          ok,
          mode: 'verdict',
          file: args.file,
          brief: null,
          steps: checked.rows.length,
          rows: checked.rows,
          problems: checked.problems,
        }) + '\n',
      );
      if (!ok) {
        writeProblemStderr(
          '参数无效',
          `${name} 结构检查未通过`,
          checked.problems,
          '请按 stdout 中的 problems 字段修正 .verdict.json 后重检',
        );
        return 1;
      }
      return 0;
    }

    const res = checkPlanObject(name, parsed);
    process.stdout.write(JSON.stringify({ mode: 'plan', ...res }) + '\n');
    if (!res.ok) {
      writeProblemStderr(
        '参数无效',
        `${name} 结构检查未通过`,
        res.problems,
        '请按 stdout 中的 problems 字段对照 slots.schema.json 修改后重检',
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
