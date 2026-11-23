import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { policyOf, type BriefKnowledge, type BriefPolicy } from '../functions/authoring-brief.ts';
import {
  buildPlumbNode,
  lookupCommandDefinition,
  truncateCmdVerifyState,
} from '../functions/cmd-recall.ts';
import { commandTreeAnswer, commandTreeCheck, jevUnansweredStep, judgeStep, treeOnlyStep, type PlumbCall, type TreeAnswer } from '../functions/command-tree-verdict.ts';
import { expandValue } from '../functions/length-literals.ts';
import { parseManifest } from '../functions/manifest.ts';
import { confirmationSteps, deviceCommandLines } from '../functions/plan-commands.ts';
import {
  createCaseJudge,
  extractPlumbCliOptions,
  formatPlumbCliError,
  judgeOf,
  parseFlagMap,
  plumbFailure,
  SHARED_PLUMB_BOOL_FLAGS,
  SHARED_PLUMB_VALUE_FLAGS,
  type JudgeName,
  type PlumbToolIo,
} from '../functions/plumb-cli.ts';
import { JEV_COMMAND_PROMPT, type JevUnanswered } from '../functions/jev-judge.ts';
import { parseProfile, type RuntimeProfile } from '../functions/profile.ts';
import { parseRuntimeContract, type RuntimeContract } from '../functions/runtime-contract.ts';
import { readSlots, type PlanStep } from '../functions/slots.ts';
import { isRecord } from '../functions/text.ts';
import { readCommandPolicy, type CommandPolicy } from '../functions/generated/skills/command-tools/command-check/command-policy.ts';
import {
  formatPlumbCallError,
  normalizeJudgeAnswer,
  writePrivateFile,
  type PlumbBatchQuestion,
  type PlumbGate,
  type PlumbMindmapNode,
} from '../functions/generated/skills/plumb/plumb-client/index.ts';
import { loadRunStructuredContext, readKnowledge } from './authoring-brief.ts';
import { downloadedTree } from './check-plan.ts';
import { resolveRunDirectory } from './workspace-path.ts';
import type { LockedTree } from '../functions/catalog-selection.ts';

const USAGE =
  'node <技能目录>/tools/cmd-verify-plumb.ts (--file <plan.json> | --plans <plansDir>) (--run <runDir> | --knowledge <knowledgeDir>) [--item <item.json>] [--context-mode <state|node>] [--base-url <url>] [--model <id>] [--ca-file <pem>] [--ca-sha256 <hex>] [--cache-dir <dir>] [--no-cache] [--audit-out <jsonl>] [--strict-review] [--tree-only] [--judge <plumb|jev>] [--out <report.json>] [--key-stdin]';
const RULES = [
  'Plumb 的判断是未确认的模型判断，只作参考；命令对不对由命令树核对说了算（Hub 的 commands_catalog 检查，同 check-plan.ts，在 --run 目录的 run.json 与 knowledge/nodes.jsonl 上本地重算）。',
  '- 命令树核对通过而 Plumb 拒绝：标需人工复核（review_required），带 Plumb 的概率，不阻断，退出码 0；加 --strict-review 才阻断。',
  '- 命令树核对不通过：阻断（退出码 1），不论 Plumb 怎么说；先照 check-plan.ts 的同名问题改命令。',
  '- 命令树核对没有运行或没有结论（没有 --run 的冻结运行与命令树，或这一步缺事实）：只有 Plumb 的判断，它拒绝就阻断，并在这一步写明命令树核对为什么没有结论。',
  '- --tree-only：不问 Plumb，只做命令树核对（使用者选定判断方式为 model 时由流水线带上）。命令树核对不通过照样阻断；通过就过；没有结论的步骤标需人工复核、状态未知并写明原因，不阻断，加 --strict-review 才阻断。一步命令也没有核对（计划都标为跳过，或没有一步下发设备命令）时状态也是未知，写明缺什么和下一步。此时工具本身不需要 --base-url 和密钥；但命令行声明（cmd-verify-plumb.cli.json）仍要求它们，守卫会拒绝没带它们的直接调用，所以这个选项由 pipeline.ts 运行，不由主代理手敲。',
  '- --judge jev：由 Jev 判断，不问 Plumb（使用者选定判断方式为 jev 时由流水线带上，密钥只从标准输入第一行读入，不需要 --base-url）。Jev 的回答一律未确认、只作参考：每一步都标需人工复核并带 Jev 给的概率，不放行也不拒绝；命令树核对不通过的照样阻断。',
  '- 步骤意图取这一步（块或顺序步骤）自己写的 description；没写就用用例标题，并在这一步的 disclosure 里说明，不借脑图里同位置的步骤，也不用作者步骤的摘要。',
].join('\n');

const VALUE_FLAGS = new Set([
  '--file',
  '--plans',
  '--run',
  '--knowledge',
  '--item',
  '--context-mode',
  '--out',
  '--judge',
  ...SHARED_PLUMB_VALUE_FLAGS,
]);
const BOOL_FLAGS = new Set(['--strict-review', '--tree-only', ...SHARED_PLUMB_BOOL_FLAGS]);

interface RuntimeCheckers {
  contract: RuntimeContract;
  profile: RuntimeProfile;
  commandPolicy: CommandPolicy | null;
}

interface ExtractedCommandUnit {
  unitIndex: number;
  pointer: string;
  task: 'single_cmd_judge' | 'steplist_judge';
  lines: string[];
  commandText: string;
  definition: string;
  state?: string;
  node?: PlumbMindmapNode;
  intent: StepIntent;
  tree: TreeAnswer;
  cleanup: boolean;
  shorter?: () => string | null;
}

interface VerifiedCasePlan {
  file: string;
  item: string;
  title: string;
  units: ExtractedCommandUnit[];
}

async function readJsonSafe(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function loadOptionalRuntimeCheckers(runDir: string, rawPolicy: unknown): Promise<RuntimeCheckers | null> {
  try {
    const rawSources = await readJsonSafe(join(runDir, 'sources.json'));
    if (!Array.isArray(rawSources)) return null;
    const findFile = (slot: string): string | null => {
      const row = rawSources.find((r) => isRecord(r) && r.slot === slot && typeof r.file === 'string');
      return row && isRecord(row) ? String(row.file) : null;
    };
    const [contractFile, profileFile, invFile] = [findFile('contract'), findFile('profile'), findFile('inventory')];
    if (!contractFile || !profileFile) return null;
    const contractRes = parseRuntimeContract(await readJsonSafe(join(runDir, contractFile)));
    if (!contractRes.ok) return null;
    const beds = invFile
      ? (() => {
          return readJsonSafe(join(runDir, invFile)).then((v) => {
            const parsedInv = parseManifest(v);
            return parsedInv.ok ? parsedInv.beds : [];
          });
        })()
      : Promise.resolve([]);
    const profileRes = parseProfile(await readJsonSafe(join(runDir, profileFile)), contractRes.contract, await beds);
    if (!profileRes.ok) return null;
    return {
      contract: contractRes.contract,
      profile: profileRes.profile,
      commandPolicy: readCommandPolicy(rawPolicy),
    };
  } catch {
    return null;
  }
}

async function loadItemsById(runDir?: string, itemFile?: string): Promise<Map<string, Record<string, unknown>>> {
  const byId = new Map<string, Record<string, unknown>>();
  if (itemFile) {
    const parsed = await readJsonSafe(itemFile);
    if (isRecord(parsed) && typeof parsed.id === 'string') byId.set(parsed.id, parsed);
    return byId;
  }
  if (!runDir) return byId;
  try {
    const names = (await readdir(join(runDir, 'items'))).filter((n) => n.endsWith('.json')).sort();
    for (const name of names) {
      const raw = await readJsonSafe(join(runDir, 'items', name));
      if (isRecord(raw) && typeof raw.id === 'string') byId.set(raw.id, raw);
    }
  } catch {
  }
  return byId;
}

function splitCommandLines(raw: string): string[] {
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function stepCommandGroups(
  step: PlanStep,
  stepIdx: number,
  dialogueAnswers: ReadonlySet<number>,
  deviceLinePointers: Set<string> | null,
): string[] {
  if (dialogueAnswers.has(stepIdx)) return [];
  if (step.block_kind === 'SLEEP' || step.block_kind === 'SELECT_CELL') return [];
  if (deviceLinePointers !== null) {
    const prefix = `/steps/${stepIdx}/`;
    const matched = [...deviceLinePointers].filter((ptr) => ptr.startsWith(prefix));
    if (matched.length === 0) return [];
  }
  return step.args.filter((a): a is string => typeof a === 'string' && a.trim().length > 0);
}

type IntentSource = 'description' | 'case_title' | 'step_number';

interface StepIntent {
  text: string;
  source: IntentSource;
  disclosure?: string;
}

function stepIntentOf(fields: Record<string, unknown>, step: PlanStep, stepIdx: number): StepIntent {
  const own = typeof step.description === 'string' ? step.description.trim() : '';
  if (own) return { text: own, source: 'description' };
  const title = typeof fields.title === 'string' ? fields.title.trim() : '';
  const none = '这一步没有写 description';
  return title
    ? { text: title, source: 'case_title', disclosure: `${none}，步骤意图用的是用例标题；不按位置借脑图里的步骤，也不用作者步骤的摘要` }
    : { text: `步骤 ${stepIdx + 1}`, source: 'step_number', disclosure: `${none}，用例也没有标题，步骤意图只写了步骤序号；不按位置借脑图里的步骤，也不用作者步骤的摘要` };
}

function lookupMultiDefinition(knowledge: BriefKnowledge, lines: readonly string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const line of lines) {
    const info = lookupCommandDefinition(knowledge, line);
    if (!info.definition) continue;
    const key = info.path ?? info.definition;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(info.definition);
  }
  return parts.join('\n---\n');
}

function extractUnitsForPlan(params: {
  file: string;
  planObj: Record<string, unknown>;
  knowledge: BriefKnowledge;
  checkers: RuntimeCheckers | null;
  itemRecord?: Record<string, unknown>;
  contextMode: 'state' | 'node';
  productLine: string;
  frozenRun: Record<string, unknown> | null;
  commandTree: LockedTree | undefined;
  treeProblem?: string;
  judge?: JudgeName;
}): VerifiedCasePlan {
  const expanded = expandValue(params.planObj).value;
  if (!isRecord(expanded) || !isRecord(expanded.slots) || !Array.isArray(expanded.slots.plan) || expanded.slots.plan.length === 0) {
    throw plumbFailure('参数无效', `计划文件 ${params.file} 缺少 slots.plan[0]`, '请先用 check-plan.ts 修复计划格式');
  }
  const firstPlan = expanded.slots.plan[0];
  const planData = isRecord(firstPlan) ? firstPlan.data : null;
  const checked = readSlots(planData);
  if (!checked.ok) {
    throw plumbFailure(
      '参数无效',
      `计划文件 ${params.file} 结构校验未通过：${checked.problems.map((p) => p.message).join('；')}`,
      '请先用 check-plan.ts 修复计划格式',
    );
  }

  let dialogueAnswers: ReadonlySet<number> = new Set();
  let devicePointers: Set<string> | null = null;
  if (params.checkers) {
    const dlg = confirmationSteps(
      params.checkers.contract,
      params.checkers.profile,
      checked.slots,
      params.checkers.commandPolicy,
    );
    dialogueAnswers = dlg.answers;
    devicePointers = new Set(
      deviceCommandLines(params.checkers.contract, params.checkers.profile, checked.slots, dlg.answers).map((l) => l.pointer),
    );
  }

  const fields = params.itemRecord && isRecord(params.itemRecord.fields) ? params.itemRecord.fields : {};
  const caseTitle = typeof fields.title === 'string' ? fields.title : '';
  const itemId = String(params.planObj.item ?? '');
  const treeCheck = commandTreeCheck({ run: params.frozenRun, item: itemId, slots: expanded.slots, ...(params.commandTree !== undefined ? { catalog: params.commandTree } : {}), ...(params.treeProblem !== undefined ? { catalogProblem: params.treeProblem } : {}) });
  const executedSoFar: string[] = [];
  const units: ExtractedCommandUnit[] = [];
  const overBudgetList: string[] = [];

  for (const [stepIdx, step] of checked.slots.steps.entries()) {
    const groups = stepCommandGroups(step, stepIdx, dialogueAnswers, devicePointers);
    if (groups.length === 0) continue;

    for (const rawArg of groups) {
      const lines = splitCommandLines(rawArg);
      if (lines.length === 0) continue;
      const task: 'single_cmd_judge' | 'steplist_judge' = lines.length === 1 ? 'single_cmd_judge' : 'steplist_judge';
      const definition = lookupMultiDefinition(params.knowledge, lines);
      const intent = stepIntentOf(fields, step, stepIdx);
      const pointer = step.origin ?? `/steps/${stepIdx}`;
      const commandText = lines.join('\n');
      const tree = commandTreeAnswer(treeCheck, pointer);

      if (params.contextMode === 'node') {
        const node = buildPlumbNode(params.itemRecord ?? {}, intent.text, params.productLine);
        units.push({
          unitIndex: units.length,
          pointer,
          task,
          lines,
          commandText,
          definition,
          node,
          intent,
          tree,
          cleanup: step.cleanup === true,
        });
      } else {
        const currentStepSection = [
          '[当前步骤]',
          `步骤位置: ${pointer}${step.cleanup ? ' (cleanup)' : ''}`,
          `步骤意图: ${intent.text}`,
          `候选命令: ${lines.length === 1 ? lines[0] : `\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}`}`,
        ].join('\n');
        const rendered = truncateCmdVerifyState({
          caseTitle,
          executedSteps: executedSoFar,
          currentStepSection,
          overheadText: `${commandText}\n${definition}`,
        });
        if (rendered.overBudget) {
          overBudgetList.push(`${params.file}:${pointer}(${rendered.estTokensAfter} tokens)`);
        }
        const earlier = [...executedSoFar];
        const alone = currentStepSection.trim();
        let given = rendered.state;
        const shorter = (): string | null => {
          if (given === alone) return null;
          const next = truncateCmdVerifyState({ caseTitle, executedSteps: earlier, currentStepSection, overheadText: `${commandText}\n${definition}`, maxChars: Math.floor(given.length * 0.8) }).state;
          given = next === given ? alone : next;
          return given;
        };
        units.push({
          unitIndex: units.length,
          pointer,
          task,
          lines,
          commandText,
          definition,
          state: rendered.state,
          intent,
          tree,
          cleanup: step.cleanup === true,
          shorter,
        });
      }
      executedSoFar.push(lines.join(' ; '));
    }
  }

  if (overBudgetList.length > 0) {
    throw plumbFailure(
      '参数无效',
      `以下命令上下文超过 ${params.judge === 'jev' ? '给 Jev 的 @1800 token 题面（与给 Plumb 的相同）' : 'Plumb @1800 token'} 上限，拒绝截断并停用：${overBudgetList.join('；')}`,
      '请拆短单步命令列表或精简当前步骤描述',
    );
  }

  return { file: params.file, item: itemId, title: caseTitle, units };
}

export async function runCmdVerifyPlumb(
  argv: readonly string[],
  io: PlumbToolIo = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const parsed = parseFlagMap(argv, { booleanFlags: BOOL_FLAGS, valueFlags: VALUE_FLAGS, usage: USAGE });
    if (parsed.help) return { code: 0, stdout: `${USAGE}\n${RULES}\n`, stderr: '' };

    const strOpt = (flag: string): string | undefined => {
      const val = parsed.flags.get(flag);
      return typeof val === 'string' && val.trim() ? val.trim() : undefined;
    };

    const fileArg = strOpt('--file');
    const plansArg = strOpt('--plans');
    if (Boolean(fileArg) === Boolean(plansArg)) {
      throw plumbFailure('参数无效', '必须二选一指定 --file <plan.json> 或 --plans <plansDir>', `用法：${USAGE}`);
    }
    const runArg = strOpt('--run');
    const knowledgeArg = strOpt('--knowledge');
    if (!runArg && !knowledgeArg) {
      throw plumbFailure('参数无效', '缺少知识树来源：请指定 --run <runDir> 或 --knowledge <knowledgeDir>', `用法：${USAGE}`);
    }
    const modeArg = strOpt('--context-mode') ?? 'state';
    if (modeArg !== 'state' && modeArg !== 'node') {
      throw plumbFailure('参数无效', `--context-mode 仅支持 state 或 node（收到 ${modeArg}）`, `用法：${USAGE}`);
    }
    const contextMode: 'state' | 'node' = modeArg;
    const itemArg = strOpt('--item');
    const strictReview = parsed.flags.get('--strict-review') === true;
    const treeOnly = parsed.flags.get('--tree-only') === true;
    const plumbOptions = extractPlumbCliOptions(parsed.flags);
    const judge: JudgeName = judgeOf(plumbOptions);
    if (treeOnly && plumbOptions.judge !== undefined) throw plumbFailure('参数无效', '--tree-only 不问任何判断服务，不能同时写 --judge', '去掉其中一个');
    const outPath = strOpt('--out');

    const runDir = runArg ? resolveRunDirectory(runArg).lexical : undefined;
    const ctx = runDir ? await loadRunStructuredContext(runDir) : null;
    const knowledge = ctx?.knowledge ?? await readKnowledge(resolve(knowledgeArg ?? runArg!));
    if (!knowledge) {
      throw plumbFailure('不存在', '找不到有效的锁定命令树（knowledge/nodes.jsonl）', '请核对 --run 或 --knowledge 目录后重试');
    }

    let rawPolicy: BriefPolicy | null = ctx?.policy ?? null;
    let rawPolicyObj: unknown = null;
    let frozenRun: Record<string, unknown> | null = null;
    let commandTree: LockedTree | undefined;
    let treeProblem: string | undefined;
    if (runDir) {
      try {
        const runObj = await readJsonSafe(join(runDir, 'run.json'));
        if (isRecord(runObj)) frozenRun = runObj;
        if (isRecord(runObj) && runObj.command_policy !== undefined) {
          rawPolicyObj = runObj.command_policy;
          rawPolicy = rawPolicy ?? policyOf(runObj.command_policy);
        }
      } catch {
      }
      if (frozenRun) {
        try {
          commandTree = await downloadedTree(runDir, frozenRun);
        } catch (error) {
          treeProblem = `这次运行下载的命令树读不出来：${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
    void rawPolicy;
    const checkers = runDir ? await loadOptionalRuntimeCheckers(runDir, rawPolicyObj) : null;
    const itemsById = await loadItemsById(runDir, itemArg ? resolve(itemArg) : undefined);
    const productLine = ctx?.runMeta.product ?? '';

    const targetFiles: string[] = [];
    if (fileArg) {
      targetFiles.push(resolve(fileArg));
    } else {
      const dir = resolve(plansArg!);
      const entries = (await readdir(dir)).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
      if (entries.length === 0) {
        throw plumbFailure('参数无效', `目录 ${dir} 下没有计划文件 (.json)`, '请先编写自动化计划后重试');
      }
      for (const name of entries) targetFiles.push(join(dir, name));
    }

    const skipped: Array<{ file: string; item: string; reason: string }> = [];
    const activeCases: VerifiedCasePlan[] = [];

    for (const fPath of targetFiles) {
      const raw = await readJsonSafe(fPath);
      if (!isRecord(raw)) {
        throw plumbFailure('参数无效', `计划文件 ${fPath} 顶层必须是 JSON 对象`, '请修正计划文件后重试');
      }
      if (raw.handling === 'skipped') {
        skipped.push({
          file: fPath,
          item: String(raw.item ?? ''),
          reason: typeof raw.reason === 'string' ? raw.reason : '',
        });
        continue;
      }
      const itemRecord = itemsById.get(String(raw.item ?? ''));
      activeCases.push(
        extractUnitsForPlan({
          file: fPath,
          planObj: raw,
          knowledge,
          checkers,
          itemRecord,
          contextMode,
          productLine,
          frozenRun,
          commandTree,
          judge,
          ...(treeProblem !== undefined ? { treeProblem } : {}),
        }),
      );
    }

    const singleQuestions: Record<string, PlumbBatchQuestion> = {};
    const listQuestions: Record<string, PlumbBatchQuestion> = {};
    const qLookup = new Map<string, { caseIdx: number; unit: ExtractedCommandUnit }>();

    for (const [caseIdx, c] of activeCases.entries()) {
      for (const unit of c.units) {
        const qid = `${caseIdx}:${unit.unitIndex}`;
        const q: PlumbBatchQuestion = {
          task: unit.task,
          ...(unit.task === 'single_cmd_judge' ? { command: unit.lines[0] } : { commands: unit.lines }),
          ...(unit.definition ? { definition: unit.definition } : {}),
          ...(contextMode === 'node' ? { node: unit.node } : { state: unit.state }),
        };
        if (unit.task === 'single_cmd_judge') singleQuestions[qid] = q;
        else listQuestions[qid] = q;
        qLookup.set(qid, { caseIdx, unit });
      }
    }

    const answers = new Map<string, ReturnType<typeof normalizeJudgeAnswer>>();
    // Units whose question Jev's service turned down: no Jev opinion for them, and the step says so and why.
    const noAnswer = new Map<string, JevUnanswered>();
    const tooLongAlone: string[] = [];
    const shortened = new Set<string>();
    let modelVersion: string | null = null;
    const totalQ = Object.keys(singleQuestions).length + Object.keys(listQuestions).length;
    let jevRequests: number | null = null;
    if (totalQ > 0 && !treeOnly) {
      // The request log of a Jev call lands where the caller names it; when it names none, beside the report, if one is written. The answers of
      // the passes before this one are kept in a file next to it, so that a pass asks only what has no answer yet.
      const auditOut = plumbOptions.auditOut ?? (judge === 'jev' && outPath ? join(dirname(resolve(outPath)), 'jev-audit.jsonl') : undefined);
      const { client, jev } = await createCaseJudge({ ...plumbOptions, ...(judge === 'jev' && auditOut ? { auditOut, jevAnswers: `${auditOut.replace(/\.jsonl$/u, '')}.answers.jsonl` } : {}) }, io);
      // A request the service refuses for its size (the body too large, or the model's context too short for it) is asked again with fewer earlier steps.
      const refusedForLength = (error: unknown): boolean => isRecord(error) && (error.status === 413 || error.code === 'request_too_large' || error.code === 'context_too_long');
      const ask = async (task: 'single_cmd_judge' | 'steplist_judge', questions: Record<string, PlumbBatchQuestion>) => {
        try { return await client.judgeBatched({ task, questions }); } catch (error) { if (!refusedForLength(error)) throw error; }
        const answered: Record<string, unknown> = {};
        let model: string | null = null;
        for (const [qid, question] of Object.entries(questions)) {
          const { caseIdx, unit } = qLookup.get(qid)!;
          let current = question;
          for (;;) {
            try {
              const one = await client.judgeBatched({ task, questions: { [qid]: current } });
              answered[qid] = one.answers[qid];
              model = one.model_version ?? model;
              break;
            } catch (error) {
              if (!refusedForLength(error)) throw error;
              const state = current.state === undefined ? null : unit.shorter?.() ?? null;
              if (state === null) { tooLongAlone.push(`${basename(activeCases[caseIdx].file)}:${unit.pointer}（${unit.lines[0].length > 60 ? unit.lines[0].slice(0, 60) + '…' : unit.lines[0]}）`); break; }
              current = { ...current, state };
              shortened.add(qid);
            }
          }
        }
        return { answers: answered as Awaited<ReturnType<typeof client.judgeBatched>>['answers'], model_version: model };
      };
      // Jev: a question the service turns down for its size is asked again with fewer earlier steps, as for Plumb; what is turned down alone, or for
      // another reason, has no Jev opinion and the batch goes on.
      const tooLong = (why: JevUnanswered | undefined): boolean => why !== undefined && (why.code === 'request_too_large' || why.code === 'context_too_long');
      const askJev = async (task: 'single_cmd_judge' | 'steplist_judge', questions: Record<string, PlumbBatchQuestion>) => {
        const first = await client.judgeBatched({ task, questions });
        const answered = { ...first.answers }, gone: Record<string, JevUnanswered> = { ...(first.unanswered ?? {}) };
        let model = first.model_version;
        for (const [qid, why] of Object.entries(first.unanswered ?? {})) {
          const { unit } = qLookup.get(qid)!;
          let current = questions[qid]!, reason: JevUnanswered | undefined = why;
          while (tooLong(reason)) {
            const state = current.state === undefined ? null : unit.shorter?.() ?? null;
            if (state === null) break;
            current = { ...current, state };
            shortened.add(qid);
            const one = await client.judgeBatched({ task, questions: { [qid]: current } });
            model = one.model_version ?? model;
            if (one.answers[qid]) { answered[qid] = one.answers[qid]!; delete gone[qid]; break; }
            reason = one.unanswered?.[qid];
            if (reason) gone[qid] = reason;
          }
        }
        return { answers: answered, unanswered: gone, model_version: model };
      };
      const askAll = (task: 'single_cmd_judge' | 'steplist_judge', questions: Record<string, PlumbBatchQuestion>) => (judge === 'jev' ? askJev(task, questions) : ask(task, questions));
      if (Object.keys(singleQuestions).length > 0) {
        const sRes = await askAll('single_cmd_judge', singleQuestions);
        modelVersion = sRes.model_version;
        for (const qid of Object.keys(singleQuestions)) {
          const rawAns = sRes.answers[qid];
          if (!rawAns) {
            const why = 'unanswered' in sRes ? sRes.unanswered?.[qid] : undefined;
            if (why) { noAnswer.set(qid, why); continue; }
            if (tooLongAlone.length > 0) continue;
            throw plumbFailure('暂时不可用', `${judge === 'jev' ? 'Jev' : 'Plumb'} single_cmd_judge 缺少结果 ${qid}`, '请重试命令核验');
          }
          answers.set(qid, normalizeJudgeAnswer(rawAns));
        }
      }
      if (Object.keys(listQuestions).length > 0) {
        const lRes = await askAll('steplist_judge', listQuestions);
        modelVersion = lRes.model_version ?? modelVersion;
        for (const qid of Object.keys(listQuestions)) {
          const rawAns = lRes.answers[qid];
          if (!rawAns) {
            const why = 'unanswered' in lRes ? lRes.unanswered?.[qid] : undefined;
            if (why) { noAnswer.set(qid, why); continue; }
            if (tooLongAlone.length > 0) continue;
            throw plumbFailure('暂时不可用', `${judge === 'jev' ? 'Jev' : 'Plumb'} steplist_judge 缺少结果 ${qid}`, '请重试命令核验');
          }
          answers.set(qid, normalizeJudgeAnswer(rawAns));
        }
      }
      if (jev) jevRequests = jev.requests;
    }

    if (tooLongAlone.length > 0) {
      throw plumbFailure(
        '参数无效',
        `以下步骤不带前面的步骤、只它自己，判断服务仍因输入过长拒收：${tooLongAlone.join('；')}`,
        '请把这一步拆成几条更短的命令，或把这一步的描述写短，再重跑 cmd-verify-plumb.ts',
      );
    }
    const blockedItems: string[] = [];
    const causes = { tree: 0, plumb: 0, strict: 0 };
    let reviewRequiredCount = 0;
    const results = activeCases.map((c, caseIdx) => {
      const steps = c.units.map((unit) => {
        const qid = `${caseIdx}:${unit.unitIndex}`;
        if (treeOnly) {
          const judged = treeOnlyStep(unit.tree, strictReview);
          if (judged.review_required) reviewRequiredCount += 1;
          if (judged.blocked) {
            const cause = unit.tree.status === 'refused' ? 'tree' : 'strict';
            causes[cause] += 1;
            const where = `${basename(c.file)}:${unit.pointer}`;
            blockedItems.push(
              cause === 'tree'
                ? `${where} 命令树核对未通过（${unit.lines[0]}；${unit.tree.problems?.[0]?.message ?? '没有说明'}）`
                : `${where} (${unit.lines[0]} -> 命令树核对没有结论，--strict-review)`,
            );
          }
          const disclosure = [unit.intent.disclosure, judged.disclosure].filter((part): part is string => part !== undefined).join('；');
          return {
            pointer: unit.pointer,
            task: unit.task,
            command: unit.commandText,
            intent: unit.intent.text,
            intent_source: unit.intent.source,
            definition_attached: unit.definition.length > 0,
            plumb_verdict: null,
            tree_check: unit.tree,
            verdict: judged.verdict,
            blocked: judged.blocked,
            review_required: judged.review_required,
            ...(judged.note ? { note: judged.note } : {}),
            ...(disclosure ? { disclosure } : {}),
            answer: null,
            match: null,
            confidence: null,
            probabilities: null,
            gate: null,
          };
        }
        const missing = noAnswer.get(qid);
        if (missing) {
          // No Jev opinion for this unit: the command tree check alone settles it, and the step says that Jev did not answer and why.
          const judged = jevUnansweredStep(unit.tree, strictReview, missing.reason);
          if (judged.review_required) reviewRequiredCount += 1;
          if (judged.blocked) {
            const cause = unit.tree.status === 'refused' ? 'tree' : 'strict';
            causes[cause] += 1;
            const where = `${basename(c.file)}:${unit.pointer}`;
            blockedItems.push(cause === 'tree' ? `${where} 命令树核对未通过（${unit.lines[0]}；${unit.tree.problems?.[0]?.message ?? '没有说明'}）` : `${where} (${unit.lines[0]} -> 命令树核对没有结论，--strict-review)`);
          }
          const disclosure = [unit.intent.disclosure, judged.disclosure].filter((part): part is string => part !== undefined).join('；');
          return {
            pointer: unit.pointer,
            task: unit.task,
            command: unit.commandText,
            intent: unit.intent.text,
            intent_source: unit.intent.source,
            definition_attached: unit.definition.length > 0,
            ...(shortened.has(qid) ? { earlier_steps_shortened: true } : {}),
            plumb_verdict: null,
            tree_check: unit.tree,
            verdict: judged.verdict,
            blocked: judged.blocked,
            review_required: judged.review_required,
            ...(judged.note ? { note: judged.note } : {}),
            ...(disclosure ? { disclosure } : {}),
            jev_no_opinion: { code: missing.code, reason: missing.reason },
            answer: null,
            match: null,
            confidence: null,
            probabilities: null,
            gate: null,
          };
        }
        const norm = answers.get(qid)!;
        const action: PlumbGate['action'] | undefined = norm.gate?.action;
        const lowerChoice = norm.choice.trim().toLowerCase();
        const isMismatch = norm.match === 0 || lowerChoice === 'no' || lowerChoice === '否';

        const yes = norm.probabilities?.yes ?? norm.probabilities?.['是'];
        const said = typeof yes === 'number' ? { yes } : {};
        const plumb: PlumbCall =
          action === 'reject'
            ? { call: 'reject', note: 'Plumb match 落入 reject 区', ...said }
            : action === 'review'
              ? { call: 'review', note: judge === 'jev' ? `[需人工复核：Jev 的回答未经确认，只作参考${typeof yes === 'number' ? `（p(是)=${yes.toFixed(3)}）` : ''}]` : '[需人工复核：Plumb match 落入 review 区]', ...said }
              : isMismatch
                ? { call: 'reject', note: 'Plumb match 判断命令不匹配', ...said }
                : { call: 'pass', note: null, ...said };
        const judged = judgeStep(plumb, unit.tree, strictReview);
        if (judged.review_required) reviewRequiredCount += 1;
        if (judged.blocked) {
          const cause = unit.tree.status === 'refused' ? 'tree' : judged.verdict === 'review' ? 'strict' : 'plumb';
          causes[cause] += 1;
          const where = `${basename(c.file)}:${unit.pointer}`;
          blockedItems.push(
            cause === 'tree'
              ? `${where} 命令树核对未通过（${unit.lines[0]}；${unit.tree.problems?.[0]?.message ?? '没有说明'}）`
              : cause === 'strict'
                ? `${where} (${unit.lines[0]} -> 需人工复核，--strict-review)`
                : `${where} (${unit.lines[0]} -> reject，命令树核对没有结论)`,
          );
        }
        // Jev never settles a step: where the tree has no conclusion either, nothing releases or refuses it, and the step says so.
        const jevAlone = judge === 'jev' && unit.tree.status !== 'accepted' && unit.tree.status !== 'refused' ? `命令树核对没有给出结论（${unit.tree.reason ?? '没有说明'}）；这一步只有 Jev 的判断（未确认，只作参考），既没有放行也没有拒绝，状态未知` : undefined;
        const disclosure = [unit.intent.disclosure, judged.disclosure, jevAlone].filter((part): part is string => part !== undefined).join('；');

        return {
          pointer: unit.pointer,
          task: unit.task,
          command: unit.commandText,
          intent: unit.intent.text,
          intent_source: unit.intent.source,
          definition_attached: unit.definition.length > 0,
          ...(shortened.has(qid) ? { earlier_steps_shortened: true } : {}),
          plumb_verdict: plumb.call,
          tree_check: unit.tree,
          verdict: judged.verdict,
          blocked: judged.blocked,
          review_required: judged.review_required,
          ...(judged.note ? { note: judged.note } : {}),
          ...(disclosure ? { disclosure } : {}),
          answer: norm.choice,
          match: norm.match ?? null,
          confidence: norm.confidence,
          probabilities: norm.probabilities ?? null,
          gate: norm.gate ?? null,
        };
      });

      return {
        file: c.file,
        item: c.item,
        title: c.title,
        ok: steps.every((s) => !s.blocked),
        steps,
      };
    });

    // The program has said nothing about a command it never looked at: with no command checked, "confirmed" would be false.
    const stepsChecked = results.reduce((sum, row) => sum + row.steps.length, 0);
    const nothingChecked = treeOnly && stepsChecked === 0;
    const report = {
      schema: 'plumb-cmd-verify-report@1',
      judge: treeOnly ? ('tree-only' as const) : judge,
      status: treeOnly ? (reviewRequiredCount > 0 || nothingChecked ? ('未知' as const) : ('已确认' as const)) : ('未确认' as const),
      decided_by: treeOnly ? ('程序' as const) : ('模型' as const),
      model_version: modelVersion,
      ...(judge === 'jev' ? { prompt_version: JEV_COMMAND_PROMPT } : {}),
      ...(jevRequests !== null ? { jev_requests: jevRequests } : {}),
      ...(noAnswer.size > 0 ? { jev_no_opinion_count: noAnswer.size } : {}),
      context_mode: contextMode,
      strict_review: strictReview,
      checked: results.length,
      steps_checked: stepsChecked,
      skipped,
      blocked_count: blockedItems.length,
      review_required_count: reviewRequiredCount,
      ...(nothingChecked ? {
        missing_fact: `没有核对任何命令：${results.length === 0 ? `这次给的计划都标为跳过（${skipped.length} 份）` : '计划里没有一步下发设备命令'}，命令树核对一步也没有做`,
        next_action: '确认这些计划本来就不下发设备命令（跳过的用例看它写的理由）；本该有命令的先写进计划，再重跑 cmd-verify-plumb.ts',
      } : {}),
      results,
    };
    const serialized = JSON.stringify(report, null, 2) + '\n';
    if (outPath) {
      await writePrivateFile(outPath, serialized);
    }
    if (blockedItems.length > 0) {
      const next = [
        causes.tree > 0 ? '命令树核对未通过的命令按所列问题修正（check-plan.ts 的 commands_catalog 报同样的问题）' : '',
        causes.plumb > 0 ? '只有 Plumb 判断的命令要么修正，要么带上 --run 的冻结运行目录（run.json 与 knowledge/nodes.jsonl）让命令树核对能跑：命令树核对通过的命令，Plumb 拒绝也只标需人工复核' : '',
        causes.strict > 0 ? '--strict-review 把需人工复核也当阻断，去掉它则由人复核这些步骤' : '',
      ].filter(Boolean);
      return {
        code: 1,
        stdout: serialized,
        stderr: formatPlumbCallError(
          '参数无效',
          `${treeOnly ? '' : judge === 'jev' ? 'Jev ' : 'Plumb '}命令核验未通过（阻断 ${blockedItems.length} 处）：${blockedItems.join('；')}`,
          `请${next.join('；')}，再重跑 cmd-verify-plumb.ts`,
        ) + '\n',
      };
    }
    return { code: 0, stdout: serialized, stderr: '' };
  } catch (error) {
    return { code: 1, stdout: '', stderr: formatPlumbCliError(error) + '\n' };
  }
}

export async function main(argv: string[]): Promise<number> {
  const res = await runCmdVerifyPlumb(argv);
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  return res.code;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
