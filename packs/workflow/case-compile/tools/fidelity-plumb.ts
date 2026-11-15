// Client-side Plumb scenario-fidelity verifier: builds briefs, evaluates steps via Plumb sequence (@2400), and writes .verdict.json.
import { realpathSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFidelityVerdictDocument, mapPlumbSequenceToFidelityRow, type BoundStepDecision } from '../functions/fidelity-bind.ts';
import { partitionFidelityBlocks, renderFidelityStepState, type PartitionedFidelityBlocks } from '../functions/fidelity-render.ts';
import {
  createCasePlumbClient,
  extractPlumbCliOptions,
  parseFlagMap,
  SHARED_PLUMB_BOOL_FLAGS,
  SHARED_PLUMB_VALUE_FLAGS,
  type PlumbToolIo,
} from '../functions/plumb-cli.ts';
import { formatCallError } from '../functions/text.ts';
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
  'node <技能目录>/tools/fidelity-plumb.ts --run <run.json> --plans <plansDir> --briefs <briefsDir> --base-url <url> [--model <id>] [--ca-file <pem>] [--ca-sha256 <hex>] [--cache-dir <dir>] [--no-cache] [--audit-out <jsonl>] [--strict-review] [--out <summary.json>] [--key-stdin]';

const OPTIONS: Record<string, boolean> = {
  run: true,
  plans: true,
  briefs: true,
  'base-url': true,
  model: false,
  'ca-file': false,
  'ca-sha256': false,
  'cache-dir': false,
  'audit-out': false,
  out: false,
};
const BOOLEAN_OPTIONS = ['strict-review', 'key-stdin', 'no-cache', 'allow-insecure-http'] as const;

const VALUE_FLAGS = new Set(['--run', '--plans', '--briefs', '--out', ...SHARED_PLUMB_VALUE_FLAGS]);
const BOOL_FLAGS = new Set(['--strict-review', ...SHARED_PLUMB_BOOL_FLAGS]);

interface PendingStepQuery {
  qid: string;
  caseIdx: number;
  stepIdx: number;
  state: string;
  requestSha256: string;
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
        throw new Error(formatPlumbCallError('参数无效', `缺少必填参数 ${flag}`, `用法：${USAGE}`));
      }
      return val.trim();
    };
    const runPath = getReq('--run');
    const plansDir = getReq('--plans');
    const briefsDir = getReq('--briefs');
    const outSummary = typeof parsed.flags.get('--out') === 'string' ? (parsed.flags.get('--out') as string).trim() : '';
    const strictReview = parsed.flags.get('--strict-review') === true;

    const { cases, skipped } = await planCases(runPath, plansDir);
    await mkdir(briefsDir, { recursive: true, mode: 0o700 });

    const reused: Array<{ file: string; item: string; verdict: string }> = [];
    const pendingCases: PendingCaseContext[] = [];
    const overBudget: Array<{ file: string; item: string; step: string; est_tokens: number }> = [];

    for (const [caseIdx, planCase] of cases.entries()) {
      const bPath = briefFile(briefsDir, planCase.base, planCase.brief.brief_sha256);
      const vPath = verdictFile(briefsDir, planCase.base, planCase.brief.brief_sha256);
      if ((await readTextOrNull(bPath)) === null) {
        await writeNew(bPath, Buffer.from(JSON.stringify(planCase.brief, null, 2) + '\n'));
      }
      if ((await readTextOrNull(vPath)) !== null) {
        reused.push({ file: planCase.file, item: planCase.item, verdict: resolve(vPath) });
        continue;
      }

      const partitioned = partitionFidelityBlocks(planCase.brief);
      const stepQueries: PendingStepQuery[] = [];
      for (const [stepIdx, authorStep] of planCase.brief.author_steps.entries()) {
        const rendered = renderFidelityStepState(planCase.brief, stepIdx, partitioned);
        if (rendered.overBudget) {
          overBudget.push({
            file: planCase.file,
            item: planCase.item,
            step: authorStep.n,
            est_tokens: rendered.estTokensAfter,
          });
        }
        const qid = `${caseIdx}:${authorStep.n}`;
        const requestSha256 = sha256Hex(stableStringify({ task: 'sequence', state: rendered.state }));
        stepQueries.push({ qid, caseIdx, stepIdx, state: rendered.state, requestSha256 });
      }
      pendingCases.push({
        planCase,
        briefPath: resolve(bPath),
        verdictPath: resolve(vPath),
        partitioned,
        steps: stepQueries,
      });
    }

    if (overBudget.length > 0) {
      const detail = overBudget.map((o) => `${o.file}(step ${o.step}: ${o.est_tokens} tokens)`).join('；');
      throw new Error(
        formatPlumbCallError(
          '参数无效',
          `以下用例的核心步骤+候选命令块超过 Plumb 2400 token 上限，拒绝截断并停用：${detail}`,
          '请拆短单步命令块或缩减无关冗余后重新运行',
        ),
      );
    }

    const written: Array<{ file: string; item: string; verdict: string; preserved: number; changed: number; unrealized: number; review_required: string[] }> = [];
    let modelVersion: string | undefined;

    if (pendingCases.length > 0) {
      const client = await createCasePlumbClient(extractPlumbCliOptions(parsed.flags), io);
      const questions: Record<string, PlumbBatchQuestion> = {};
      for (const ctx of pendingCases) {
        for (const sq of ctx.steps) {
          questions[sq.qid] = {
            task: 'sequence',
            state: sq.state,
            step_n: sq.stepIdx + 1,
          };
        }
      }
      const batchRes = await client.judgeBatched({ task: 'sequence', questions });
      modelVersion = batchRes.model_version;

      for (const ctx of pendingCases) {
        const decisions: BoundStepDecision[] = [];
        for (const sq of ctx.steps) {
          const itemAns = batchRes.answers[sq.qid];
          if (!itemAns) {
            throw new Error(formatPlumbCallError('暂时不可用', `Plumb 批量结果缺少步骤 ${sq.qid}`, '请重试 Plumb 保真核对'));
          }
          const normalized = normalizeJudgeAnswer(itemAns);
          decisions.push(
            mapPlumbSequenceToFidelityRow({
              brief: ctx.planCase.brief,
              authorStep: ctx.planCase.brief.author_steps[sq.stepIdx]!,
              authorStepIndex: sq.stepIdx,
              partitioned: ctx.partitioned,
              plumb: normalized,
              modelVersion: itemAns.model_version ?? batchRes.model_version,
              requestSha256: sq.requestSha256,
              strictReview,
            }),
          );
        }
        const batchDigest = sha256Hex(ctx.steps.map((s) => s.requestSha256).join(','));
        const doc = buildFidelityVerdictDocument({
          brief: ctx.planCase.brief,
          decisions,
          partitioned: ctx.partitioned,
          modelVersion: batchRes.model_version,
          requestSha256: batchDigest,
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
        });
      }
    }

    const summary = {
      status: '未确认',
      decided_by: '模型',
      model_version: modelVersion ?? null,
      strict_review: strictReview,
      checked: cases.length,
      reused,
      written,
      skipped,
    };
    const serialized = JSON.stringify(summary, null, 2) + '\n';
    if (outSummary) {
      await writePrivateFile(outSummary, serialized);
    }
    return { code: 0, stdout: serialized, stderr: '' };
  } catch (error) {
    return { code: 1, stdout: '', stderr: formatCallError(error) + '\n' };
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
