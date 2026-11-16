import {callBoundaryGaps} from '../functions/call-boundaries.ts';
import {parseRuntimeContract} from '../functions/runtime-contract.ts';
import {parseProfile} from '../functions/profile.ts';
import {parseManifest} from '../functions/manifest.ts';
import { formatClientCallError } from '../functions/client-cli.ts';
import { CallFailure } from '../functions/text.ts';
import { planStateOf } from '../functions/plan-state.ts';
// 只读检查自动化用例 JSON、自动化用例目录或场景保真判断（.verdict.json）的语法、长度占位与结构，不用令牌，不写入磁盘：
//   node <技能目录>/tools/check-plan.ts --file <计划或判断JSON> [--brief <核对文件>] [--run <冻结运行JSON>]
import { realpathSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BRIEF_SCHEMA,
  fidelityJudgmentProblems,
  type FidelityBrief,
} from '../functions/fidelity.ts';
import { describeExpansions, expandValue } from '../functions/length-literals.ts';
import { isItemHandling, ITEM_HANDLING, type ItemHandling } from '../functions/generated/vocabulary.ts';
import { readSlots } from '../functions/slots.ts';
import { planDataOf } from '../functions/subject.ts';
import { isRecord, parseCliOptions, type CallErrorCategory } from '../functions/text.ts';
import { parsedPlanFile } from './submit-plans.ts';

const OPTIONS: Record<string, boolean> = { file: true, brief: false, run: false };
const USAGE = 'node <技能目录>/tools/check-plan.ts --file <计划或判断JSON> [--brief <核对文件>] [--run <冻结运行JSON>]';

export interface CheckProblem {
  code?: string;
  requested?:import('../functions/call-boundaries.ts').CallBoundaryGap['requested'];
  allowed_calls?:import('../functions/call-boundaries.ts').CallBoundaryGap['allowed_calls'];
  allowed_seats?:string[];
  step_pointer?:string;
  pointer: string;
  message: string;
}

export interface PlanCheckResult {
  structure_ok?:boolean;
  authority_checked?:boolean;
  disclosure?:string;
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

function parseOptions(argv: string[]): { file: string; brief?: string;run?:string } {
  const values = parseCliOptions(argv, OPTIONS, USAGE);
  return {file:values.file!,...(values.brief!==undefined?{brief:values.brief}:{}),...(values.run!==undefined?{run:values.run}:{})};
}

export function checkPlanObject(file: string, parsed: unknown, run?:unknown): PlanCheckResult {
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
  if (!planStateOf(parsed).process) {
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
  const structureOk=problems.length===0;
  let authorityChecked=false;
  if(run===undefined)problems.push({code:'missing_frozen_run',pointer:'/run',message:'缺冻结权限输入；用 --run <本次运行下载的run.json> 重检。结构通过不等于允许调用'});
  if(run!==undefined){
    const groups=isRecord(run)&&Array.isArray(run.groups)?run.groups:[];
    const groupsForPack=groups.filter(group=>isRecord(group)&&group.kind==='case-compile');
    const group=groupsForPack.length===1?groupsForPack[0]:null;
    const items=isRecord(run)&&Array.isArray(run.items)?run.items:[];
    if(!group||!items.some(row=>isRecord(row)&&row.id===item))problems.push({pointer:'/run',message:'冻结运行缺唯一 case-compile 组或不包含此 item；用本次计划运行下载的 run.json'});
    else{
      const contract=parseRuntimeContract(group.contract),manifest=parseManifest(group.manifest);
      const profile=contract.ok&&manifest.ok?parseProfile(group.profile,contract.contract,manifest.beds):null;
      if(!contract.ok||!manifest.ok||!profile?.ok)problems.push({pointer:'/run/groups',message:'冻结合约、清单或运行环境配置无效；重新下载本次运行完整 run.json，不手写冻结输入'});
      else{authorityChecked=true;problems.push(...callBoundaryGaps(contract.contract,profile.profile,s).map(gap=>({...gap,code:'case-compile.method_forbidden'})));}
    }
  }
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
    structure_ok:structureOk,
    authority_checked:authorityChecked,
    disclosure:authorityChecked?'已核对结构、冻结共同方法集合和设备应答者座位；其他 Hub 检查仍以提交回执为准':'只核对结构；未核对冻结权限，提供 --run <本次运行下载的run.json> 后核对共同方法集合和设备应答者座位',
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
  category: import('../functions/generated/vocabulary.ts').CallErrorCategory,
  summary: string,
  problems: readonly CheckProblem[],
  nextStep: string,
): void {
  const detail = problems
    .slice(0, 5)
    .map((p) => (p.pointer ? `${p.pointer}: ${p.message}` : p.message))
    .join('；');
  const suffix = problems.length > 5 ? `（另有 ${problems.length - 5} 处见 stdout）` : '';
  process.stderr.write(formatClientCallError(new CallFailure(category, `${summary}（${detail}${suffix}）`, nextStep, { path: problems[0]?.pointer })) + '\n');
}

export async function main(argv: string[]): Promise<number> {
  try {
    const args = parseOptions(argv);
    const targetInfo = await stat(args.file);
    const run=args.run!==undefined?parsedPlanFile(basename(args.run),await readFile(args.run)):undefined;

    if (targetInfo.isDirectory()) {
      if (args.brief !== undefined) {
        throw new CallFailure('invalid_parameters', '--brief 只能配合单个 .verdict.json 使用，不能和目录一起使用。请指定具体的判断文件后重试', "请使用 --file 指向计划或两字段判断文件；核对判断时同时提供 --brief");
      }
      const entries = (await readdir(args.file)).filter((name) => name.endsWith('.json')).sort();
      if (!entries.length) {
        throw new CallFailure('not_found', `不存在：目录 ${args.file} 里没有 .json 文件。请核对计划目录路径或先写出计划文件后重试`, "请使用 --file 指向计划或两字段判断文件；核对判断时同时提供 --brief");
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
        const res = checkPlanObject(name, parsed, run);
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
            ...p,
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
          onlyDuplicate ? 'occupied' : 'invalid_parameters',
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
      throw new CallFailure('invalid_parameters', `${args.file} 不是常规文件或目录。请指定计划 JSON、.verdict.json 或计划目录后重试`, "请使用 --file 指向计划或两字段判断文件；核对判断时同时提供 --brief");
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
      process.stderr.write(formatClientCallError(error, { category: '参数无效' }) + '\n');
      return 1;
    }

    if (args.brief !== undefined || looksLikeVerdict(args.file, parsed)) {
      if (args.brief !== undefined) {
        const briefInfo = await stat(args.brief);
        if (!briefInfo.isFile()) {
          throw new CallFailure('invalid_parameters', `--brief 指定的 ${args.brief} 不是常规文件。请传入 fidelity-brief.ts 生成的 .brief.json 文件`, "请使用 --file 指向计划或两字段判断文件；核对判断时同时提供 --brief");
        }
        const briefObj = parsedPlanFile(basename(args.brief), await readFile(args.brief));
        if (!isBriefObject(briefObj)) {
          throw new CallFailure('invalid_parameters', `--brief 指定的 ${args.brief} 不是有效的场景保真核对简报。请使用 fidelity-brief.ts 生成的 .brief.json 文件`, "请使用 --file 指向计划或两字段判断文件；核对判断时同时提供 --brief");
        }
        const checked = fidelityJudgmentProblems(briefObj, parsed);
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
            'invalid_parameters',
            `${name} 对照 ${basename(args.brief)} 未通过检查`,
            checked.problems,
            '请按 stdout 中的 problems 修正判断文件或重跑 fidelity-brief.ts 后重检',
          );
          return 1;
        }
        return 0;
      }

      const checked = fidelityJudgmentProblems(null, parsed);
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
          'invalid_parameters',
          `${name} 结构检查未通过`,
          checked.problems,
          '请按 stdout 中的 problems 字段修正 .verdict.json 后重检',
        );
        return 1;
      }
      return 0;
    }

    const res = checkPlanObject(name, parsed, run);
    process.stdout.write(JSON.stringify({ mode: 'plan', ...res }) + '\n');
    if (!res.ok) {
      writeProblemStderr(
        'invalid_parameters',
        `${name} 结构检查未通过`,
        res.problems,
        '请按 stdout 中的 problems 字段对照 slots.schema.json 修改后重检',
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
