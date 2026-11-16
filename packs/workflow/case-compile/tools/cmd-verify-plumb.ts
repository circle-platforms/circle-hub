// Post-write authored command verifier using Plumb single_cmd_judge / steplist_judge (@1800) with fail-closed gates.
import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { policyOf, type BriefKnowledge, type BriefPolicy } from '../functions/authoring-brief.ts';
import {
  buildPlumbNode,
  lookupCommandDefinition,
  truncateCmdVerifyState,
} from '../functions/cmd-recall.ts';
import { authorStepsOf, type AuthorStep } from '../functions/fidelity.ts';
import { expandValue } from '../functions/length-literals.ts';
import { parseManifest } from '../functions/manifest.ts';
import { confirmationSteps, deviceCommandLines } from '../functions/plan-commands.ts';
import {
  createCasePlumbClient,
  extractPlumbCliOptions,
  formatPlumbCliError,
  parseFlagMap,
  plumbFailure,
  SHARED_PLUMB_BOOL_FLAGS,
  SHARED_PLUMB_VALUE_FLAGS,
  type PlumbToolIo,
} from '../functions/plumb-cli.ts';
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

const USAGE =
  'node <技能目录>/tools/cmd-verify-plumb.ts (--file <plan.json> | --plans <plansDir>) (--run <runDir> | --knowledge <knowledgeDir>) [--item <item.json>] [--context-mode <state|node>] [--base-url <url>] [--model <id>] [--ca-file <pem>] [--ca-sha256 <hex>] [--cache-dir <dir>] [--no-cache] [--audit-out <jsonl>] [--strict-review] [--out <report.json>] [--key-stdin]';

const OPTIONS: Record<string, boolean> = {
  file: false,
  plans: false,
  run: false,
  knowledge: false,
  item: false,
  'context-mode': false,
  'base-url': true,
  model: false,
  'ca-file': false,
  'ca-sha256': false,
  'cache-dir': false,
  'audit-out': false,
  out: false,
};
const BOOLEAN_OPTIONS = ['strict-review', 'key-stdin', 'no-cache', 'allow-insecure-http'] as const;

const VALUE_FLAGS = new Set([
  '--file',
  '--plans',
  '--run',
  '--knowledge',
  '--item',
  '--context-mode',
  '--out',
  ...SHARED_PLUMB_VALUE_FLAGS,
]);
const BOOL_FLAGS = new Set(['--strict-review', ...SHARED_PLUMB_BOOL_FLAGS]);

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
  cleanup: boolean;
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
    // Optional when validating standalone plans against --knowledge.
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

/** Where the intent line of a step comes from; a closed set, written into the report. */
type IntentSource = 'author_steps' | 'description' | 'mindmap_position' | 'case_title' | 'step_number';

interface StepIntent {
  text: string;
  source: IntentSource;
  /** One sentence for the reader of the report: where the text came from and what was passed over. */
  disclosure: string;
}

const oneLine = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/**
 * The intent line of one step: what the case author meant the step to do, which is what Plumb is asked the command to serve.
 * A step names the author steps it realizes in author_step_refs, the ids of the action atoms of the frozen recomposition record
 * (the author steps of the fidelity brief); its intent is their text, the adapted text where the recomposition adapted the atom,
 * in the order of the references. A reference that is no author step of this case contributes nothing. A sequential step
 * without such a reference keeps its own description, then the mind-map step at the same position, then the case title. A
 * block plan has no such position (the n-th block says nothing about which mind-map step it serves), so a block without one
 * gets the case title, and the disclosure says so.
 */
function stepIntentOf(params: {
  fields: Record<string, unknown>;
  authorSteps: readonly AuthorStep[];
  blockPlan: boolean;
  step: PlanStep;
  stepIdx: number;
}): StepIntent {
  const { fields, authorSteps, blockPlan, step, stepIdx } = params;
  const authored = new Map(authorSteps.map((author) => [author.n, { text: oneLine(author.text), adapted: author.author_text !== undefined && author.author_text !== author.text }] as const));
  const used: string[] = [];
  const passedOver: string[] = [];
  for (const ref of new Set(step.author_step_refs ?? [])) (authored.get(ref)?.text ? used : passedOver).push(ref);
  const known = authorSteps.length ? `本用例的作者步骤编号：${authorSteps.map((author) => author.n).join('、')}` : '本用例没有可对照的作者步骤';
  const skipped = passedOver.length ? `author_step_refs 里的 ${passedOver.join('、')} 不是本用例的作者步骤编号（${known}）` : '';
  if (used.length > 0) {
    return {
      text: used.map((ref) => authored.get(ref)!.text).join('；'),
      source: 'author_steps',
      disclosure: `步骤意图取自作者步骤 ${used.map((ref) => (authored.get(ref)!.adapted ? `${ref}（取适配后的写法）` : ref)).join('、')}${skipped ? `；${skipped}，没有采用` : ''}`,
    };
  }
  const why = skipped || '这一步没有写 author_step_refs';
  if (!blockPlan) {
    if (typeof step.description === 'string' && step.description.trim()) {
      return { text: step.description.trim(), source: 'description', disclosure: `步骤意图取自这一步写的描述（description）：${why}` };
    }
    const rawSteps = Array.isArray(fields.steps) ? fields.steps : [];
    const positional = rawSteps[stepIdx];
    if (isRecord(positional) && typeof positional.text === 'string' && positional.text.trim()) {
      return {
        text: positional.text.trim(),
        source: 'mindmap_position',
        disclosure: `步骤意图取自脑图里同一序号的步骤：${why}；按序号对应只是近似，不能保证它就是这一步实现的那一步`,
      };
    }
  }
  const title = typeof fields.title === 'string' ? fields.title.trim() : '';
  const none = blockPlan ? '块计划不按位置借用脑图步骤' : '脑图里也没有同一序号的步骤';
  return title
    ? { text: title, source: 'case_title', disclosure: `步骤意图取自用例标题：${why}；${none}` }
    : { text: `步骤 ${stepIdx + 1}`, source: 'step_number', disclosure: `没有可用的文字，步骤意图只写了步骤序号：${why}；${none}；用例也没有标题` };
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
  // The frozen recomposition record of the plan run item: the same author steps the fidelity brief lists (tools/fidelity-brief.ts).
  const authorSteps = authorStepsOf(isRecord(fields.recomposition) ? fields.recomposition.record : undefined);
  const blockPlan = checked.slots.blocks.length > 0;
  const itemId = String(params.planObj.item ?? '');
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
      const intent = stepIntentOf({ fields, authorSteps, blockPlan, step, stepIdx });
      const pointer = step.origin ?? `/steps/${stepIdx}`;
      const commandText = lines.join('\n');

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
        units.push({
          unitIndex: units.length,
          pointer,
          task,
          lines,
          commandText,
          definition,
          state: rendered.state,
          intent,
          cleanup: step.cleanup === true,
        });
      }
      executedSoFar.push(lines.join(' ; '));
    }
  }

  if (overBudgetList.length > 0) {
    throw plumbFailure(
      '参数无效',
      `以下命令上下文超过 Plumb @1800 token 上限，拒绝截断并停用：${overBudgetList.join('；')}`,
      '请拆短单步命令列表、精简当前步骤描述，或少引用几条作者步骤（author_step_refs）',
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
    if (parsed.help) return { code: 0, stdout: `${USAGE}\n`, stderr: '' };

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
    const outPath = strOpt('--out');

    const runDir = runArg ? resolve(runArg) : undefined;
    const ctx = runDir ? await loadRunStructuredContext(runDir) : null;
    const knowledge = ctx?.knowledge ?? await readKnowledge(resolve(knowledgeArg ?? runArg!));
    if (!knowledge) {
      throw plumbFailure('不存在', '找不到有效的锁定命令树（knowledge/nodes.jsonl）', '请核对 --run 或 --knowledge 目录后重试');
    }

    let rawPolicy: BriefPolicy | null = ctx?.policy ?? null;
    let rawPolicyObj: unknown = null;
    if (runDir) {
      try {
        const runObj = await readJsonSafe(join(runDir, 'run.json'));
        if (isRecord(runObj) && runObj.command_policy !== undefined) {
          rawPolicyObj = runObj.command_policy;
          rawPolicy = rawPolicy ?? policyOf(runObj.command_policy);
        }
      } catch {
        // Standalone tests may omit run.json when using --knowledge.
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
    let modelVersion: string | null = null;
    const totalQ = Object.keys(singleQuestions).length + Object.keys(listQuestions).length;
    if (totalQ > 0) {
      const client = await createCasePlumbClient(extractPlumbCliOptions(parsed.flags), io);
      if (Object.keys(singleQuestions).length > 0) {
        const sRes = await client.judgeBatched({ task: 'single_cmd_judge', questions: singleQuestions });
        modelVersion = sRes.model_version;
        for (const qid of Object.keys(singleQuestions)) {
          const rawAns = sRes.answers[qid];
          if (!rawAns) {
            throw plumbFailure('暂时不可用', `Plumb single_cmd_judge 缺少结果 ${qid}`, '请重试命令核验');
          }
          answers.set(qid, normalizeJudgeAnswer(rawAns));
        }
      }
      if (Object.keys(listQuestions).length > 0) {
        const lRes = await client.judgeBatched({ task: 'steplist_judge', questions: listQuestions });
        modelVersion = lRes.model_version ?? modelVersion;
        for (const qid of Object.keys(listQuestions)) {
          const rawAns = lRes.answers[qid];
          if (!rawAns) {
            throw plumbFailure('暂时不可用', `Plumb steplist_judge 缺少结果 ${qid}`, '请重试命令核验');
          }
          answers.set(qid, normalizeJudgeAnswer(rawAns));
        }
      }
    }

    const blockedItems: string[] = [];
    let reviewRequiredCount = 0;
    const results = activeCases.map((c, caseIdx) => {
      const steps = c.units.map((unit) => {
        const qid = `${caseIdx}:${unit.unitIndex}`;
        const norm = answers.get(qid)!;
        const action: PlumbGate['action'] | undefined = norm.gate?.action;
        const lowerChoice = norm.choice.trim().toLowerCase();
        const isMismatch = norm.match === 0 || lowerChoice === 'no' || lowerChoice === '否';

        let verdict: 'pass' | 'review' | 'reject';
        let blocked = false;
        let reviewRequired = false;
        let note: string | null = null;

        if (action === 'reject') {
          verdict = 'reject';
          blocked = true;
          note = 'Plumb match 落入 reject 区';
        } else if (action === 'review') {
          verdict = 'review';
          reviewRequired = true;
          reviewRequiredCount += 1;
          blocked = strictReview;
          note = '[需人工复核：Plumb match 落入 review 区]';
        } else if (isMismatch) {
          verdict = 'reject';
          blocked = true;
          note = 'Plumb match 判断命令不匹配';
        } else {
          verdict = 'pass';
        }

        if (blocked) {
          blockedItems.push(`${basename(c.file)}:${unit.pointer} (${unit.lines[0]} -> ${verdict})`);
        }

        return {
          pointer: unit.pointer,
          task: unit.task,
          command: unit.commandText,
          intent: unit.intent.text,
          intent_source: unit.intent.source,
          disclosure: unit.intent.disclosure,
          definition_attached: unit.definition.length > 0,
          verdict,
          blocked,
          review_required: reviewRequired,
          ...(note ? { note } : {}),
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

    const report = {
      schema: 'plumb-cmd-verify-report@1',
      status: '未确认' as const,
      decided_by: '模型' as const,
      model_version: modelVersion,
      context_mode: contextMode,
      strict_review: strictReview,
      checked: results.length,
      skipped,
      blocked_count: blockedItems.length,
      review_required_count: reviewRequiredCount,
      results,
    };
    const serialized = JSON.stringify(report, null, 2) + '\n';
    if (outPath) {
      await writePrivateFile(outPath, serialized);
    }
    if (blockedItems.length > 0) {
      return {
        code: 1,
        stdout: serialized,
        stderr: formatPlumbCallError(
          '参数无效',
          `Plumb 命令核验未通过（阻断 ${blockedItems.length} 处）：${blockedItems.join('；')}`,
          '请修正错误命令或参数后重跑 cmd-verify-plumb.ts',
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
