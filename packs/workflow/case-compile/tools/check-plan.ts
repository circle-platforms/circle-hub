import {frozenRunProblem,planBoundary,type HubCheckCoverage} from '../functions/plan-boundary.ts';
import {lockedTree,type LockedTree} from '../functions/catalog-selection.ts';
import {parseRuntimeContract} from '../functions/runtime-contract.ts';
import {parseProfile} from '../functions/profile.ts';
import {parseManifest} from '../functions/manifest.ts';
import { formatClientCallError } from '../functions/client-cli.ts';
import { CallFailure } from '../functions/text.ts';
import { planStateOf } from '../functions/plan-state.ts';
import { blockPositions, type BlockPosition } from '../functions/cmd-lookup.ts';
// Read-only plan/verdict checks. A plan is judged by the Hub's own boundary (functions/plan-boundary.ts): the slot record against
// the schema the run froze, then every pack check that judges a plan, with the Hub's functions and the run's frozen inputs; the
// quotation check of the core (quote@1) runs over the locked tree of the download (functions/quote-sources.ts).
//   node <技能目录>/tools/check-plan.ts --file <计划或判断JSON> [--brief <核对文件>] [--run <运行目录>]
// `--run` is the run directory (the folder that holds run.json and knowledge/), as for every tool that reads a run (tools/workspace-path.ts).
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
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
import { readSlots, type PlanSlots } from '../functions/slots.ts';
import { planDataOf } from '../functions/subject.ts';
import { isRecord, parseCliOptions, type CallErrorCategory } from '../functions/text.ts';
import { parsedPlanFile } from './submit-plans.ts';
import { resolveRun } from './workspace-path.ts';
import type {Verdict} from '../../../../contracts/generated/vocabulary.ts';

const OPTIONS: Record<string, boolean> = { file: true, brief: false, run: false };
const USAGE = 'node <技能目录>/tools/check-plan.ts --file <计划或判断JSON> [--brief <核对文件>] [--run <运行目录>]';

export interface CheckProblem {
  code?: string;
  verdict?: Extract<Verdict, 'refute' | 'unknown'>;
  requested?:import('../functions/call-boundaries.ts').CallBoundaryGap['requested'];
  allowed_calls?:import('../functions/call-boundaries.ts').CallBoundaryGap['allowed_calls'];
  allowed_seats?:string[];
  requested_output?:string;
  allowed_output_ids?:string[];
  expected_output?:string;
  step_pointer?:string;
  pointer: string;
  message: string;
}

export interface PlanCheckResult {
  /** Every check the Hub runs on a plan submission, whether it ran here and, if not, why. */
  hub_checks?:HubCheckCoverage[];
  cleanup_checked?:boolean;
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

export function checkPlanObject(file: string, parsed: unknown, run?:unknown,catalog?:LockedTree): PlanCheckResult {
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

  // The claim's own quotes (slots.plan[0].quotes) are resolved and checked verbatim by the Hub when it takes the submission, a step before
  // its checks (hub/runs/engine/exact.ts resolveStatement); a mismatch there refuses the whole submission. This tool does not run that step.
  const claim = Array.isArray(slots.plan) ? slots.plan[0] : slots.plan;
  const claimQuotes = isRecord(claim) && Array.isArray(claim.quotes) ? claim.quotes.length : 0;
  const planData = planDataOf(expandedRecord);
  const checked = readSlots(planData);
  if (run === undefined) {
    if (!checked.ok) {
      for (const p of checked.problems) problems.push({ pointer: p.pointer, message: p.message });
      return { ok: false, file, item, handling, kind: null, expansions: describeExpansions(file, expanded.expansions), counts: null, problems };
    }
    problems.push({ code: 'missing_input', pointer: '/run', message: '缺冻结权限输入；用 --run <本次运行下载的运行目录> 重检。结构通过不等于允许调用' });
    return result(checked.slots, { structureOk: true, authorityChecked: false, cleanupChecked: false, coverage: undefined });
  }

  // With the frozen run the plan goes through the Hub's own boundary. An item whose slot record has a structure problem gets
  // no check there, as at the Hub; the checks that need an upload or a later audit are listed with the reason they did not run.
  const groups = isRecord(run) && Array.isArray(run.groups) ? run.groups : [];
  const groupsForPack = groups.filter(group => isRecord(group) && group.kind === 'case-compile');
  const group = groupsForPack.length === 1 ? groupsForPack[0] : null;
  const items = isRecord(run) && Array.isArray(run.items) ? run.items : [];
  let coverage: HubCheckCoverage[] | undefined, structureOk = checked.ok, authorityChecked = false, cleanupChecked = false;
  if (!isRecord(run) || !isRecord(group) || !items.some(row => isRecord(row) && row.id === item)) {
    problems.push(frozenRunProblem(run, item));
  } else {
    const contract = parseRuntimeContract(group.contract), manifest = parseManifest(group.manifest);
    const profile = contract.ok && manifest.ok ? parseProfile(group.profile, contract.contract, manifest.beds) : null;
    const frozenValid = contract.ok && manifest.ok && profile?.ok === true;
    if (!frozenValid) problems.push({ pointer: '/run/groups', message: '冻结合约、清单或运行环境配置无效；重新下载本次运行完整 run.json，不手写冻结输入' });
    if (frozenValid && catalog === undefined) problems.push({ code: 'missing_input', pointer: '/run/knowledge', message: '缺本次冻结根的命令树；保留下载目录 knowledge/nodes.jsonl 与 run.json 一起重检，没有它命令身份、逆操作和运行器清理都核对不了' });
    const boundary = planBoundary({ run, item: item!, slots: expandedRecord.slots, catalog });
    problems.push(...boundary.problems);
    coverage = boundary.coverage;
    structureOk = checked.ok && boundary.structure_ok;
    authorityChecked = frozenValid && coverage.some(row => row.check === 'contract_shape' && row.ran);
    // The runner's cleanup rule is judged inside the Hub's check (the product's declared inverses need the locked command tree of this run).
    cleanupChecked = frozenValid && contract.ok && contract.contract.cleanup !== undefined && catalog !== undefined && catalog.root === run.root && run.command_policy !== undefined && structureOk && authorityChecked;
  }
  return result(checked.ok ? checked.slots : null, { structureOk, authorityChecked, cleanupChecked, coverage });

  function result(slots: PlanSlots | null, state: { structureOk: boolean; authorityChecked: boolean; cleanupChecked: boolean; coverage: HubCheckCoverage[] | undefined }): PlanCheckResult {
    const cleanupSteps = slots === null ? 0 : slots.steps.filter((step) => step.cleanup === true).length + slots.blocks.filter((b) => isRecord(b) && b.kind === 'CLEANUP').length;
    const notRun = (state.coverage ?? []).filter(row => !row.ran);
    return {
      ok: problems.length === 0,
      file,
      item,
      handling,
      kind: slots === null ? null : slots.blocks.length > 0 ? 'blocks' : 'flat',
      expansions: describeExpansions(file, expanded.expansions),
      ...(state.coverage !== undefined ? { hub_checks: state.coverage } : {}),
      cleanup_checked: state.cleanupChecked,
      structure_ok: state.structureOk,
      authority_checked: state.authorityChecked,
      disclosure: state.coverage !== undefined
        ? `已按冻结运行核对：槽位记录结构，以及 Hub 同名检查 ${state.coverage.filter(row => row.ran).map(row => `${row.check}${row.why !== undefined ? `（${row.why}）` : ''}`).join('、') || '（本次没有一项能跑）'}，用同一个函数（引文检查 expected_quotes 是核心 quote@1 的同一条规则）和同一份冻结输入。本地没有跑的 Hub 检查：${notRun.map(row => `${row.check}（${row.why}）`).join('；') || '无'}；这些以提交回执为准${claimQuotes > 0 ? `。计划记录自己写的 quotes（${claimQuotes} 条）由 Hub 受理提交时另外逐条核对，原文不在所引片段里会整份不受理；这里没有核这一步，以提交回执为准` : ''}`
        : '只核对结构；未核对冻结权限，提供 --run <本次运行下载的运行目录> 后核对 Hub 对计划的全部本地可跑检查',
      counts: slots === null ? null : { blocks: slots.blocks.length, steps: slots.steps.length, expects: slots.expects.length, cleanup_steps: cleanupSteps, replacements: slots.replacements.length },
      problems,
    };
  }
}

/**
 * Read only the standard download beside the explicitly supplied frozen run; never infer catalog authority from prose. What comes
 * back is the locked tree of the run, not a catalog: the checks are given the part of it the Hub gives them (functions/plan-boundary.ts),
 * and the quotation check reads the statements of its entries, which are the texts the Hub reads for a tree: reference.
 */
export async function downloadedTree(runDirectory:string,run:unknown):Promise<LockedTree|undefined>{
 if(!isRecord(run)||typeof run.root!=='string')return undefined;
 let bytes:string;try{bytes=await readFile(join(runDirectory,'knowledge','nodes.jsonl'),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
 const tree=lockedTree(bytes.split('\n').filter(Boolean).map(line=>JSON.parse(line) as unknown),{run:run.run,root:run.root});
 if(typeof tree==='string')throw new CallFailure('invalid_parameters',tree,'重新下载本次运行完整 knowledge/nodes.jsonl，不拼接其他运行的命令树');
 let positions:ReadonlyMap<string,BlockPosition>|undefined;
 return {...tree,blocks:()=>positions??=textFilePositions(join(runDirectory,'knowledge'))};
}
/**
 * Where each node's block starts in the text files beside nodes.jsonl (knowledge/manual.txt, commands.txt, ...): what a refusal that
 * names an entry of the manual needs to say which line of the file it stands on. Read when asked, once; a file that is not there is
 * not looked for again, and the refusal then names the entry without a line.
 */
function textFilePositions(knowledge:string):ReadonlyMap<string,BlockPosition>{
 const found=new Map<string,BlockPosition>();
 let names:string[];try{names=readdirSync(knowledge).filter(name=>name.endsWith('.txt')).sort();}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return found;throw error;}
 for(const name of names)for(const [path,at] of blockPositions(name,readFileSync(join(knowledge,name),'utf8')))if(!found.has(path))found.set(path,at);
 return found;
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

/** A problem is about --run itself when its pointer is /run or under it: no usable frozen run, or one without its command tree. */
const concernsRun = (problem: CheckProblem): boolean => problem.pointer === '/run' || problem.pointer.startsWith('/run/');
const PLAN_NEXT_STEP = '按 problems 的位置与允许集合修改计划；结构问题对照 slots.schema.json，不改冻结配置绕过';
/**
 * What the stderr line of a failed plan check tells to do next. The sentence about --run is for the problems that are about it;
 * a plan problem found with a right --run (a recomposition declaration, a field the schema does not have) is not told to look at it.
 */
export function planNextStep(problems: readonly CheckProblem[]): string {
  return (problems.some(concernsRun) ? '先提供正确的 --run 冻结输入，再' : '') + PLAN_NEXT_STEP;
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
    const frozen=args.run!==undefined?resolveRun(args.run):undefined;
    const run=frozen!==undefined?parsedPlanFile('run.json',await readFile(frozen.file.lexical)):undefined;
    const catalog=frozen!==undefined?await downloadedTree(frozen.directory.lexical,run):undefined;

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
        const res = checkPlanObject(name, parsed, run, catalog);
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

    const res = checkPlanObject(name, parsed, run, catalog);
    process.stdout.write(JSON.stringify({ mode: 'plan', ...res }) + '\n');
    if (!res.ok) {
      writeProblemStderr('invalid_parameters', `${name} 本地核对未通过`, res.problems, planNextStep(res.problems));
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
