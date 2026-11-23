import {CallFailure} from '../functions/text.ts';
import { realpathSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFidelityVerdictDocument, fidelityPromptOf, mapPlumbSequenceToFidelityRow, type BoundStepDecision } from '../functions/fidelity-bind.ts';
import { FIDELITY_MAX_EST_TOKENS, partitionFidelityBlocks, renderFidelityStepState, type LiteralSubstitution, type PartitionedFidelityBlocks } from '../functions/fidelity-render.ts';
import { JEV_STATE_BUDGET_EST_TOKENS } from '../functions/jev-judge.ts';
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
import { writeNew } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import {
  formatPlumbCallError,
  normalizeJudgeAnswer,
  sha256Hex,
  stableStringify,
  writePrivateFile,
  type PlumbBatchQuestion,
} from '../functions/generated/skills/plumb/plumb-client/index.ts';
import { briefFile, planCases, verdictFile, type PlanCase } from './fidelity-brief.ts';

const USAGE =
  'node <技能目录>/tools/fidelity-plumb.ts --run <运行目录> --plans <plansDir> --briefs <briefsDir> --base-url <url> [--model <id>] [--ca-file <pem>] [--ca-sha256 <hex>] [--cache-dir <dir>] [--no-cache] [--audit-out <jsonl>] [--strict-review] [--judge <plumb|jev>] [--out <summary.json>] [--key-stdin]';

const VALUE_FLAGS = new Set(['--run', '--plans', '--briefs', '--out', '--judge', ...SHARED_PLUMB_VALUE_FLAGS]);
const BOOL_FLAGS = new Set(['--strict-review', ...SHARED_PLUMB_BOOL_FLAGS]);

interface PendingStepQuery {
  qid: string;
  caseIdx: number;
  stepIdx: number;
  state: string;
  requestSha256: string;
  substitutions: LiteralSubstitution[];
}

interface OverBudgetCase {
  file: string;
  item: string;
  brief: string;
  verdict: string;
  verdict_present: boolean;
  steps: Array<{ n: string; est_tokens: number; reduced_est_tokens: number | null; command_blocks: number; exemptions: number }>;
}

interface PendingCaseContext {
  planCase: PlanCase;
  briefPath: string;
  verdictPath: string;
  partitioned: PartitionedFidelityBlocks;
  steps: PendingStepQuery[];
}

const readTextOrNull = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
};

// What one step's state may weigh for the judge that is asked: the limit of Plumb's gateway, or the budget of ours for a Jev state. The rest of the
// rendering is ours and the same for both: the order in which earlier steps and repeated long literals are given up, and no cut inside a command block.
const stateBudgetOf = (judge: JudgeName): number => (judge === 'jev' ? JEV_STATE_BUDGET_EST_TOKENS : FIDELITY_MAX_EST_TOKENS);

function overBudgetStop(waiting: readonly OverBudgetCase[], judgedByPlumb: number, judge: JudgeName = 'plumb'): string {
  const name = judge === 'jev' ? 'Jev' : 'Plumb';
  const steps = (c: OverBudgetCase): string => {
    const shown = c.steps.slice(0, 6).map((st) => `${st.n} 约 ${st.est_tokens}`).join('、');
    return `${shown}${c.steps.length > 6 ? ` 等共 ${c.steps.length} 步` : ''}`;
  };
  const worst = (c: OverBudgetCase) => c.steps.reduce((a, b) => (b.est_tokens > a.est_tokens ? b : a));
  const describe = (c: OverBudgetCase): string => {
    const w = worst(c);
    const reduced = w.reduced_est_tokens === null ? '没有逐字重复的长字面量可换名' : `重复的长字面量换成名字后仍约 ${w.reduced_est_tokens}`;
    return `${c.file}（步骤 ${steps(c)} token；候选命令块约 ${w.command_blocks}、豁免依据约 ${w.exemptions}，${reduced}；简报 ${c.brief}）`;
  };
  const exceeded = judge === 'jev'
    ? `超过给 Jev 的题面预算（${JEV_STATE_BUDGET_EST_TOKENS} 个估算 token，取自 InfoTest 给 Jev 题面定的预算，不是实测的服务上限）`
    : `超过 Plumb 的 ${FIDELITY_MAX_EST_TOKENS} token 上限`;
  const fact = `${waiting.length} 条自动化用例的保真核对题面${exceeded}，工具不在命令块中间截断，这些用例没有交给 ${name}：${waiting.map(describe).join('；')}${judgedByPlumb > 0 ? `。其余 ${judgedByPlumb} 条已由 ${name} 核对并写入核对目录` : ''}`;
  const next = [
    '这些用例改走独立模型盲审：对上面每份简报运行 node \'<技能目录>/tools/task-brief.ts\' --role \'保真核对\' --case \'<用例文件名>\' --brief \'<简报>\' --out \'<同前缀的 .verdict.json>\' --task-file \'<任务文件>\'，派 compile-fidelity 写出判断（只用这种单条形式，不要对整个核对目录用 --batch，它会覆盖 NAME 已写的判断）'.replace('NAME', name),
    '写完运行 fidelity-apply.ts 并入自动化用例',
    '也可以缩短这些用例的命令块后重跑本工具',
  ].join('；');
  return formatPlumbCallError('参数无效', fact, next);
}

export async function runFidelityPlumb(
  argv: readonly string[],
  io: PlumbToolIo = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const parsed = parseFlagMap(argv, { booleanFlags: BOOL_FLAGS, valueFlags: VALUE_FLAGS, usage: USAGE });
    if (parsed.help) return { code: 0, stdout: `${USAGE}\n`, stderr: '' };

    const getReq = (flag: string): string => {
      const val = parsed.flags.get(flag);
      if (typeof val !== 'string' || !val.trim()) {
        throw plumbFailure('参数无效', `缺少必填参数 ${flag}`, `用法：${USAGE}`);
      }
      return val.trim();
    };
    const runDirectory = getReq('--run');
    const plansDir = getReq('--plans');
    const briefsDir = getReq('--briefs');
    const outSummary = typeof parsed.flags.get('--out') === 'string' ? (parsed.flags.get('--out') as string).trim() : '';
    const plumbOptions = extractPlumbCliOptions(parsed.flags);
    const judge: JudgeName = judgeOf(plumbOptions);
    // Jev answers only advise: the review gate of one never releases a step, so every step of a Jev audit goes to the blind audit.
    const strictReview = parsed.flags.get('--strict-review') === true || judge === 'jev';
    const promptVersion = fidelityPromptOf(judge);
    const stateBudget = stateBudgetOf(judge);

    const { cases, skipped } = await planCases(runDirectory, plansDir);
    await mkdir(briefsDir, { recursive: true, mode: 0o700 });

    const reused: Array<{ file: string; item: string; verdict: string }> = [];
    const pendingCases: PendingCaseContext[] = [];
    const overBudget: OverBudgetCase[] = [];

    for (const [caseIdx, planCase] of cases.entries()) {
      const bPath = briefFile(briefsDir, planCase.base, planCase.brief.brief_sha256);
      const vPath = verdictFile(briefsDir, planCase.base, planCase.brief.brief_sha256);
      if ((await readTextOrNull(bPath)) === null) {
        await writeNew(bPath, Buffer.from(JSON.stringify(planCase.brief, null, 2) + '\n'));
      }
      const partitioned = partitionFidelityBlocks(planCase.brief);
      const stepQueries: PendingStepQuery[] = [];
      const tooBig: OverBudgetCase['steps'] = [];
      for (const [stepIdx, authorStep] of planCase.brief.author_steps.entries()) {
        const rendered = renderFidelityStepState(planCase.brief, stepIdx, partitioned, stateBudget);
        if (rendered.overBudget) {
          tooBig.push({
            n: authorStep.n,
            est_tokens: rendered.estTokensPlain,
            reduced_est_tokens: rendered.reducedEstTokens,
            command_blocks: rendered.parts?.commandBlocks ?? 0,
            exemptions: rendered.parts?.exemptions ?? 0,
          });
          continue;
        }
        const qid = `${caseIdx}:${authorStep.n}`;
        const requestSha256 = sha256Hex(stableStringify({ task: 'sequence', state: rendered.state }));
        stepQueries.push({ qid, caseIdx, stepIdx, state: rendered.state, requestSha256, substitutions: rendered.substitutions });
      }
      const saved=await readTextOrNull(vPath);
      if (tooBig.length > 0) {
        overBudget.push({ file: planCase.file, item: planCase.item, brief: resolve(bPath), verdict: resolve(vPath), verdict_present: saved !== null, steps: tooBig });
        continue;
      }
      if(saved!==null){
        const doc=JSON.parse(saved);
        const digest=sha256Hex(stepQueries.map(step=>step.requestSha256).join(','));
        if(doc.model_disclosure?.prompt_version!==promptVersion||doc.model_disclosure?.request_sha256!==digest)
          throw new CallFailure('invalid_parameters',judge==='jev'?'已有判断不是 Jev 按本版题目写的（判断方式或题目版本不同）；不能复用另一种判断方式或旧题目的判断':'已有判断没有绑定本版完整豁免题目；不能复用旧题目的判断','保留旧文件，改用新的 --briefs 目录重新核对');
        reused.push({file:planCase.file,item:planCase.item,verdict:resolve(vPath)});continue;
      }
      pendingCases.push({
        planCase,
        briefPath: resolve(bPath),
        verdictPath: resolve(vPath),
        partitioned,
        steps: stepQueries,
      });
    }

    const written: Array<{ file: string; item: string; verdict: string; preserved: number; changed: number; unrealized: number; review_required: string[]; literal_substitutions: Array<{ step: string } & LiteralSubstitution> }> = [];
    let modelVersion: string | undefined;
    let jevRequests: number | null = null;
    const noOpinion: Array<{ file: string; item: string; steps: Array<{ n: string; code: string; reason: string }> }> = [];

    if (pendingCases.length > 0) {
      // Where the audit's request log lands for Jev when the caller names none: next to the briefs, and the answers of the passes before this one
      // are kept in a file beside it, so that a pass asks only the questions that have no answer yet.
      const auditOut = plumbOptions.auditOut ?? (judge === 'jev' ? join(briefsDir, 'jev-audit.jsonl') : undefined);
      const { client, jev } = await createCaseJudge({ ...plumbOptions, ...(judge === 'jev' && auditOut ? { auditOut, jevAnswers: `${auditOut.replace(/\.jsonl$/u, '')}.answers.jsonl` } : {}) }, io);
      const questions: Record<string, PlumbBatchQuestion> = {};
      for (const ctx of pendingCases) {
        for (const sq of ctx.steps) {
          questions[sq.qid] = {
            task: 'sequence',
            state: sq.state,
            step_n: sq.stepIdx + 1,
            // Jev names the author step in its question; the step's label is the one the state text shows.
            ...(judge === 'jev' ? { metadata: { author_step: ctx.planCase.brief.author_steps[sq.stepIdx]!.n } } : {}),
          };
        }
      }
      const batchRes = await client.judgeBatched({ task: 'sequence', questions });
      modelVersion = batchRes.model_version ?? undefined;
      jevRequests = jev ? jev.requests : null;

      for (const ctx of pendingCases) {
        // A step whose question Jev's service turned down has no Jev opinion. A case with such a step gets no verdict file from this tool: its brief
        // stays where it is, and the blind audit judges the case, as for a case too large to ask; the summary says which steps had no answer and why.
        const lacking = ctx.steps.filter((sq) => batchRes.unanswered?.[sq.qid] !== undefined);
        if (lacking.length > 0) {
          noOpinion.push({ file: ctx.planCase.file, item: ctx.planCase.item, steps: lacking.map((sq) => ({ n: ctx.planCase.brief.author_steps[sq.stepIdx]!.n, code: batchRes.unanswered![sq.qid]!.code, reason: batchRes.unanswered![sq.qid]!.reason })) });
          continue;
        }
        const decisions: BoundStepDecision[] = [];
        for (const sq of ctx.steps) {
          const itemAns = batchRes.answers[sq.qid];
          if (!itemAns) {
            throw plumbFailure('暂时不可用', `${judge === 'jev' ? 'Jev' : 'Plumb'} 批量结果缺少步骤 ${sq.qid}`, `请重试 ${judge === 'jev' ? 'Jev' : 'Plumb'} 保真核对`);
          }
          const normalized = normalizeJudgeAnswer(itemAns);
          decisions.push(
            mapPlumbSequenceToFidelityRow({
              brief: ctx.planCase.brief,
              authorStep: ctx.planCase.brief.author_steps[sq.stepIdx]!,
              partitioned: ctx.partitioned,
              plumb: normalized,
              modelVersion: itemAns.model_version ?? batchRes.model_version ?? '',
              requestSha256: sq.requestSha256,
              strictReview,
              judge,
            }),
          );
        }
        const batchDigest = sha256Hex(ctx.steps.map((s) => s.requestSha256).join(','));
        const substitutions = ctx.steps.flatMap((sq) => sq.substitutions.map((sub) => ({ step: ctx.planCase.brief.author_steps[sq.stepIdx]!.n, ...sub })));
        const doc = buildFidelityVerdictDocument({
          brief: ctx.planCase.brief,
          decisions,
          partitioned: ctx.partitioned,
          modelVersion: batchRes.model_version ?? '',
          requestSha256: batchDigest,
          literalSubstitutions: substitutions,
          judge,
        });
        await writeNew(ctx.verdictPath, Buffer.from(JSON.stringify(doc, null, 2) + '\n'));
        const countVerdict = (v: string) => decisions.filter((d) => d.row.verdict === v).length;
        written.push({
          file: ctx.planCase.file,
          item: ctx.planCase.item,
          verdict: ctx.verdictPath,
          preserved: countVerdict('preserved'),
          changed: countVerdict('changed'),
          unrealized: countVerdict('unrealized'),
          review_required: decisions.filter((d) => d.reviewRequired).map((d) => d.row.n),
          literal_substitutions: substitutions,
        });
      }
    }

    const summary = {
      status: '未确认',
      decided_by: '模型',
      judge,
      model_version: modelVersion ?? null,
      ...(jevRequests !== null ? { jev_requests: jevRequests } : {}),
      strict_review: strictReview,
      checked: cases.length,
      reused,
      written,
      ...(noOpinion.length > 0 ? { jev_no_opinion: noOpinion } : {}),
      over_budget: overBudget,
      skipped,
    };
    const serialized = JSON.stringify(summary, null, 2) + '\n';
    if (outSummary) {
      await writePrivateFile(outSummary, serialized);
    }
    const waiting = overBudget.filter((c) => !c.verdict_present);
    if (waiting.length > 0) return { code: 1, stdout: serialized, stderr: overBudgetStop(waiting, written.length + reused.length, judge) + '\n' };
    return { code: 0, stdout: serialized, stderr: '' };
  } catch (error) {
    return { code: 1, stdout: '', stderr: formatPlumbCliError(error) + '\n' };
  }
}

export async function main(argv: string[]): Promise<number> {
  const res = await runFidelityPlumb(argv);
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  return res.code;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
