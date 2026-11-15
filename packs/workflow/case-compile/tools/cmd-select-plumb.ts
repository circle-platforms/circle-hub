// Pre-write command candidate selector using coarse recall (<=40) + Plumb choice tournament (<=25 per batch).
import { realpathSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCommandIndex,
  buildPlumbNode,
  CMD_RECALL_LIMIT,
  formatChoiceCandidates,
  normalizeMatchedCandidate,
  partitionChoiceChunks,
  recallCommandCandidates,
  type CommandCandidate,
} from '../functions/cmd-recall.ts';
import {
  formatPlumbCallError,
  normalizeJudgeAnswer,
  writePrivateFile,
  type PlumbBatchQuestion,
  type PlumbGate,
  type PlumbMindmapNode,
} from '../functions/generated/skills/plumb/plumb-client/index.ts';
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
import { isRecord } from '../functions/text.ts';
import { loadRunStructuredContext, readKnowledge } from './authoring-brief.ts';

const USAGE =
  'node <技能目录>/tools/cmd-select-plumb.ts --run <runDir> [--out-dir <dir>] [--item <id|index>] [--limit <1..40>] [--base-url <url>] [--model <id>] [--ca-file <pem>] [--ca-sha256 <hex>] [--cache-dir <dir>] [--no-cache] [--audit-out <jsonl>] [--strict-review] [--out <summary.json>] [--key-stdin]';

const OPTIONS: Record<string, boolean> = {
  run: true,
  'base-url': true,
  'out-dir': false,
  item: false,
  limit: false,
  model: false,
  'ca-file': false,
  'ca-sha256': false,
  'cache-dir': false,
  'audit-out': false,
  out: false,
};
const BOOLEAN_OPTIONS = ['strict-review', 'key-stdin', 'no-cache', 'allow-insecure-http'] as const;

const VALUE_FLAGS = new Set(['--run', '--out-dir', '--item', '--limit', '--out', ...SHARED_PLUMB_VALUE_FLAGS]);
const BOOL_FLAGS = new Set(['--strict-review', ...SHARED_PLUMB_BOOL_FLAGS]);

export const CMD_CANDIDATES_SCHEMA = 'plumb-cmd-candidates@1';

interface LoadedCaseItem {
  index: string;
  itemId: string;
  autoid: string;
  title: string;
  raw: Record<string, unknown>;
  steps: Array<{ stepIndex: number; stepText: string; query: string }>;
}

interface StageTrace {
  stage: number;
  chunk: number;
  candidates: string[];
  choice: string;
  confidence: number;
  gate: PlumbGate | null;
}

interface PendingStep {
  caseIdx: number;
  stepPos: number;
  stepIndex: number;
  stepText: string;
  node: PlumbMindmapNode;
  recalled: CommandCandidate[];
  chunks: CommandCandidate[][];
  stage1Traces: StageTrace[];
  stage1Winners: CommandCandidate[];
  stage1NoneSelected: boolean;
  lastRejectGate: PlumbGate | null;
  finalResult?: {
    matched: CommandCandidate | null;
    noneSelected: boolean;
    confidence: number | null;
    probabilities: Record<string, number> | null;
    gate: PlumbGate | null;
    rejected: boolean;
    reviewRequired: boolean;
    stages: StageTrace[];
  };
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return CMD_RECALL_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > CMD_RECALL_LIMIT) {
    throw plumbFailure('参数无效', `--limit 必须是 1..${CMD_RECALL_LIMIT} 的整数`, `用法：${USAGE}`);
  }
  return n;
}

function extractItemSteps(raw: Record<string, unknown>): Array<{ stepIndex: number; stepText: string; query: string }> {
  const fields = isRecord(raw.fields) ? raw.fields : {};
  const title = typeof fields.title === 'string' ? fields.title.trim() : '';
  const recomposition = isRecord(fields.recomposition) && isRecord(fields.recomposition.record)
    ? fields.recomposition.record
    : null;

  const adaptedCmds: string[] = [];
  if (recomposition && isRecord(recomposition.ledgers) && Array.isArray(recomposition.ledgers.adapted)) {
    for (const row of recomposition.ledgers.adapted) {
      if (isRecord(row) && Array.isArray(row.commands)) {
        for (const cmd of row.commands) {
          if (typeof cmd === 'string' && cmd.trim()) adaptedCmds.push(cmd.trim());
        }
      }
    }
  }

  const rawSteps = Array.isArray(fields.steps) ? fields.steps : [];
  const stepTexts = rawSteps
    .filter(isRecord)
    .map((s) => (typeof s.text === 'string' ? s.text.trim() : ''))
    .filter(Boolean);

  if (stepTexts.length > 0) {
    return stepTexts.map((stepText, idx) => ({
      stepIndex: idx + 1,
      stepText,
      query: [stepText, title, ...(stepTexts.length === 1 ? adaptedCmds : [])].filter(Boolean).join(' '),
    }));
  }

  if (recomposition && Array.isArray(recomposition.atoms)) {
    const actionAtoms = recomposition.atoms
      .filter(isRecord)
      .filter((a) => a.kind === 'action' && typeof a.text === 'string' && a.text.trim())
      .map((a) => String(a.text).trim());
    if (actionAtoms.length > 0) {
      return actionAtoms.map((stepText, idx) => ({
        stepIndex: idx + 1,
        stepText,
        query: [stepText, title, ...adaptedCmds].filter(Boolean).join(' '),
      }));
    }
  }

  if (title) {
    return [{
      stepIndex: 1,
      stepText: title,
      query: [title, ...adaptedCmds].filter(Boolean).join(' '),
    }];
  }

  return [];
}

async function loadRunCaseItems(runDir: string, filter?: string): Promise<LoadedCaseItem[]> {
  const itemsDir = join(runDir, 'items');
  let entries: string[];
  try {
    entries = (await readdir(itemsDir)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    throw plumbFailure('不存在', `找不到运行用例目录 ${itemsDir}`, '请确认 --run 指向已下载的运行目录');
  }

  const loaded: LoadedCaseItem[] = [];
  for (const name of entries) {
    const stem = basename(name, '.json');
    const raw = JSON.parse(await readFile(join(itemsDir, name), 'utf8')) as unknown;
    if (!isRecord(raw) || typeof raw.id !== 'string') continue;
    const fields = isRecord(raw.fields) ? raw.fields : {};
    const autoid = typeof fields.autoid === 'string' ? fields.autoid : '';
    const title = typeof fields.title === 'string' ? fields.title : '';
    if (filter && filter !== stem && filter !== raw.id && filter !== autoid) {
      continue;
    }
    loaded.push({
      index: stem,
      itemId: raw.id,
      autoid,
      title,
      raw,
      steps: extractItemSteps(raw),
    });
  }
  if (filter && loaded.length === 0) {
    throw plumbFailure('不存在', `--run 目录中找不到匹配 --item ${filter} 的用例`, '请核对条目编号或序号后重试');
  }
  return loaded;
}

export async function runCmdSelectPlumb(
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
    const strOpt = (flag: string): string | undefined => {
      const val = parsed.flags.get(flag);
      return typeof val === 'string' && val.trim() ? val.trim() : undefined;
    };

    const runDir = resolve(getReq('--run'));
    const outDir = resolve(strOpt('--out-dir') ?? join(runDir, 'plumb', 'cmd_candidates'));
    const itemFilter = strOpt('--item');
    const limit = parseLimit(strOpt('--limit'));
    const strictReview = parsed.flags.get('--strict-review') === true;
    const outSummary = strOpt('--out');

    const ctx = await loadRunStructuredContext(runDir);
    const knowledge = ctx?.knowledge ?? await readKnowledge(runDir);
    if (!knowledge) {
      throw plumbFailure('不存在', `运行目录 ${runDir} 中缺少 knowledge/nodes.jsonl`, '请先完成运行下载后再执行命令预筛');
    }

    const items = await loadRunCaseItems(runDir, itemFilter);
    const productLine = ctx?.runMeta.product || '';
    const cmdIndex = buildCommandIndex(knowledge);

    const casePlans = items.map((item, caseIdx) => {
      const pendingSteps: PendingStep[] = item.steps.map((step, stepPos) => {
        const recalled = recallCommandCandidates(cmdIndex, step.query, { limit }).map((r) => r.candidate);
        const chunks = recalled.length > 0 ? partitionChoiceChunks(recalled) : [];
        return {
          caseIdx,
          stepPos,
          stepIndex: step.stepIndex,
          stepText: step.stepText,
          node: buildPlumbNode(item.raw, step.stepText, productLine),
          recalled,
          chunks,
          stage1Traces: [],
          stage1Winners: [],
          stage1NoneSelected: false,
          lastRejectGate: null,
        };
      });
      return { item, pendingSteps };
    });

    const stage1Questions: Record<string, PlumbBatchQuestion> = {};
    const stage1Meta = new Map<string, { step: PendingStep; chunkIdx: number; chunk: CommandCandidate[] }>();

    for (const plan of casePlans) {
      for (const step of plan.pendingSteps) {
        for (const [chunkIdx, chunk] of step.chunks.entries()) {
          const qid = `${step.caseIdx}:${step.stepIndex}:c${chunkIdx}`;
          stage1Questions[qid] = {
            task: 'choice',
            node: step.node,
            candidates: formatChoiceCandidates(chunk),
          };
          stage1Meta.set(qid, { step, chunkIdx, chunk });
        }
      }
    }

    let modelVersion: string | null = null;
    const needsPlumb = Object.keys(stage1Questions).length > 0;
    const client = needsPlumb ? await createCasePlumbClient(extractPlumbCliOptions(parsed.flags), io) : null;

    if (client && needsPlumb) {
      const s1Res = await client.judgeBatched({ task: 'choice', questions: stage1Questions });
      modelVersion = s1Res.model_version;

      const stage2Questions: Record<string, PlumbBatchQuestion> = {};
      const stage2Steps = new Map<string, PendingStep>();

      for (const [qid, meta] of stage1Meta.entries()) {
        const ans = s1Res.answers[qid];
        if (!ans) {
          throw plumbFailure('暂时不可用', `Plumb choice 批量返回缺少步骤 ${qid}`, '请重试命令选择预筛');
        }
        const norm = normalizeJudgeAnswer(ans);
        const { matched, noneSelected } = normalizeMatchedCandidate(norm.choice, meta.chunk);
        const gate = norm.gate ?? null;
        meta.step.stage1Traces.push({
          stage: 1,
          chunk: meta.chunkIdx,
          candidates: meta.chunk.map((c) => c.command),
          choice: norm.choice,
          confidence: norm.confidence,
          gate,
        });

        if (meta.step.chunks.length === 1) {
          const rejected = gate?.action === 'reject';
          const reviewRequired = !rejected && gate?.action === 'review';
          meta.step.finalResult = {
            matched: rejected ? null : matched,
            noneSelected,
            confidence: norm.confidence,
            probabilities: norm.probabilities ?? null,
            gate,
            rejected,
            reviewRequired,
            stages: meta.step.stage1Traces,
          };
          continue;
        }

        if (gate?.action === 'reject') {
          meta.step.lastRejectGate = gate;
        } else if (matched) {
          meta.step.stage1Winners.push(matched);
        } else if (noneSelected) {
          meta.step.stage1NoneSelected = true;
        }
      }

      for (const plan of casePlans) {
        for (const step of plan.pendingSteps) {
          if (step.finalResult || step.chunks.length <= 1) continue;
          const uniqueWinners: CommandCandidate[] = [];
          const seenCmds = new Set<string>();
          for (const w of step.stage1Winners) {
            if (!seenCmds.has(w.command)) {
              seenCmds.add(w.command);
              uniqueWinners.push(w);
            }
          }
          if (uniqueWinners.length === 0) {
            const rejected = step.lastRejectGate !== null && !step.stage1NoneSelected;
            step.finalResult = {
              matched: null,
              noneSelected: !rejected,
              confidence: step.stage1Traces[0]?.confidence ?? null,
              probabilities: null,
              gate: step.lastRejectGate ?? step.stage1Traces[0]?.gate ?? null,
              rejected,
              reviewRequired: false,
              stages: step.stage1Traces,
            };
          } else if (uniqueWinners.length === 1) {
            const winner = uniqueWinners[0]!;
            const trace = step.stage1Traces.find((t) => normalizeMatchedCandidate(t.choice, step.recalled).matched?.command === winner.command);
            const gate = trace?.gate ?? null;
            step.finalResult = {
              matched: winner,
              noneSelected: false,
              confidence: trace?.confidence ?? null,
              probabilities: null,
              gate,
              rejected: false,
              reviewRequired: gate?.action === 'review',
              stages: step.stage1Traces,
            };
          } else {
            const qid = `s2:${step.caseIdx}:${step.stepIndex}`;
            step.stage1Winners = uniqueWinners;
            stage2Questions[qid] = {
              task: 'choice',
              node: step.node,
              candidates: formatChoiceCandidates(uniqueWinners),
            };
            stage2Steps.set(qid, step);
          }
        }
      }

      if (Object.keys(stage2Questions).length > 0) {
        const s2Res = await client.judgeBatched({ task: 'choice', questions: stage2Questions });
        modelVersion = s2Res.model_version ?? modelVersion;
        for (const [qid, step] of stage2Steps.entries()) {
          const ans = s2Res.answers[qid];
          if (!ans) {
            throw plumbFailure('暂时不可用', `Plumb choice 二轮淘汰缺少结果 ${qid}`, '请重试命令选择预筛');
          }
          const norm = normalizeJudgeAnswer(ans);
          const { matched, noneSelected } = normalizeMatchedCandidate(norm.choice, step.stage1Winners);
          const gate = norm.gate ?? null;
          const allTraces: StageTrace[] = [
            ...step.stage1Traces,
            {
              stage: 2,
              chunk: 0,
              candidates: step.stage1Winners.map((c) => c.command),
              choice: norm.choice,
              confidence: norm.confidence,
              gate,
            },
          ];
          const rejected = gate?.action === 'reject';
          const reviewRequired = !rejected && gate?.action === 'review';
          step.finalResult = {
            matched: rejected ? null : matched,
            noneSelected,
            confidence: norm.confidence,
            probabilities: norm.probabilities ?? null,
            gate,
            rejected,
            reviewRequired,
            stages: allTraces,
          };
        }
      }
    }

    await mkdir(outDir, { recursive: true, mode: 0o700 });
    const written: Array<{
      index: string;
      item: string;
      file: string;
      selected_count: number;
      review_required: number[];
      rejected: number[];
    }> = [];
    const strictFailures: string[] = [];

    for (const plan of casePlans) {
      const stepRows = plan.pendingSteps.map((step) => {
        if (step.recalled.length === 0) {
          return {
            step_index: step.stepIndex,
            step_text: step.stepText,
            recalled_count: 0,
            candidates: [] as Array<{ command: string; path: string; definition: string; summary: string }>,
            selected: null,
            none_selected: true,
            note: '未召回相关候选命令',
            confidence: null,
            probabilities: null,
            gate: null,
            review_required: false,
            rejected: false,
            status: '未确认' as const,
            decided_by: '模型' as const,
            model_version: modelVersion,
            stages: [] as StageTrace[],
          };
        }
        const fr = step.finalResult!;
        const note = fr.rejected
          ? '[Plumb choice 落入 reject 区]'
          : fr.reviewRequired
            ? '[需人工复核：Plumb choice 落入 review 区]'
            : fr.noneSelected
              ? 'Plumb 选择“都不是”，请编写模型结合手册全文检索'
              : null;
        return {
          step_index: step.stepIndex,
          step_text: step.stepText,
          recalled_count: step.recalled.length,
          candidates: step.recalled.map((c) => ({
            command: c.command,
            path: c.path,
            definition: c.definition,
            summary: c.summary,
          })),
          selected: fr.matched
            ? { command: fr.matched.command, path: fr.matched.path, definition: fr.matched.definition }
            : null,
          none_selected: fr.noneSelected,
          ...(note ? { note } : {}),
          confidence: fr.confidence,
          probabilities: fr.probabilities,
          gate: fr.gate,
          review_required: fr.reviewRequired,
          rejected: fr.rejected,
          status: '未确认' as const,
          decided_by: '模型' as const,
          model_version: modelVersion,
          stages: fr.stages,
        };
      });

      const doc = {
        schema: CMD_CANDIDATES_SCHEMA,
        status: '未确认' as const,
        decided_by: '模型' as const,
        model_version: modelVersion,
        run: ctx?.runMeta.run ?? '',
        item: plan.item.itemId,
        index: plan.item.index,
        title: plan.item.title,
        steps: stepRows,
      };
      const filePath = join(outDir, `${plan.item.index}.json`);
      await writePrivateFile(filePath, JSON.stringify(doc, null, 2) + '\n');

      const reviewSteps = stepRows.filter((s) => s.review_required).map((s) => s.step_index);
      const rejectSteps = stepRows.filter((s) => s.rejected).map((s) => s.step_index);
      if (strictReview && (reviewSteps.length > 0 || rejectSteps.length > 0)) {
        strictFailures.push(`${plan.item.index}(${plan.item.itemId}): steps [${[...reviewSteps, ...rejectSteps].join(',')}]`);
      }

      written.push({
        index: plan.item.index,
        item: plan.item.itemId,
        file: filePath,
        selected_count: stepRows.filter((s) => s.selected !== null).length,
        review_required: reviewSteps,
        rejected: rejectSteps,
      });
    }

    const summary = {
      schema: 'plumb-cmd-select-summary@1',
      status: '未确认' as const,
      decided_by: '模型' as const,
      model_version: modelVersion,
      strict_review: strictReview,
      strict_review_failed: strictFailures.length > 0,
      cases: written.length,
      written,
    };
    const serialized = JSON.stringify(summary, null, 2) + '\n';
    if (outSummary) {
      await writePrivateFile(outSummary, serialized);
    }
    if (strictFailures.length > 0) {
      return {
        code: 1,
        stdout: serialized,
        stderr: formatPlumbCallError(
          '参数无效',
          `--strict-review 下发现落入 review/reject 区的命令选择：${strictFailures.join('；')}`,
          '请人工复核候选结果或改写用例步骤后重跑',
        ) + '\n',
      };
    }
    return { code: 0, stdout: serialized, stderr: '' };
  } catch (error) {
    return { code: 1, stdout: '', stderr: formatPlumbCliError(error) + '\n' };
  }
}

export async function main(argv: string[]): Promise<number> {
  const res = await runCmdSelectPlumb(argv);
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  return res.code;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
