import {CallFailure} from './text.ts';
// Deterministic step_indices binding and Option A1 Plumb sequence gate-to-verdict mapping.
import type { AuthorStep, FidelityBrief, FidelityRow, FidelityVerdict, ModelDisclosure, ModelJudgment } from './fidelity.ts';
import {
  blockCommandLines,
  type PartitionedFidelityBlocks,
} from './fidelity-render.ts';
import type { LiteralSubstitution } from './fidelity-render.ts';
import type { PlumbGate, PlumbNormalizedAnswer } from './generated/skills/plumb/plumb-client/index.ts';

export interface BoundStepDecision {
  row: FidelityRow;
  reviewRequired: boolean;
}

const CHOICE_MAP: Readonly<Record<string, '保持' | '改变' | '未实现'>> = {
  保持: '保持',
  preserved: '保持',
  改变: '改变',
  changed: '改变',
  未实现: '未实现',
  unrealized: '未实现',
};

function normalizePlumbSequenceChoice(choice: string): '保持' | '改变' | '未实现' {
  const mapped = CHOICE_MAP[choice.trim()];
  if (!mapped) {
    throw new Error(`Plumb sequence 返回了未知选项 "${choice}"`);
  }
  return mapped;
}

function validBriefIndices(brief: FidelityBrief): Set<number> {
  return new Set(
    brief.blocks
      .map((b) => b.index)
      .filter((n): n is number => typeof n === 'number' && Number.isSafeInteger(n)),
  );
}

/** Binds only explicit author references or whole adapted command literals; missing evidence stays unbound. */
export function mapStepIndices(
  brief: FidelityBrief,
  authorStep: AuthorStep,
  authorStepIndex: number,
  partitioned: PartitionedFidelityBlocks,
): { indices: number[]; tier: 'author_step_refs' | 'command_or_rebinding' | 'none' } {
  const validIndices = validBriefIndices(brief);

  // Tier 1: explicit author_step_refs on plan blocks/steps.
  const tier1: number[] = [];
  for (const blk of brief.blocks) {
    const idx = typeof blk.index === 'number' ? blk.index : -1;
    if (!validIndices.has(idx)) continue;
    if (Array.isArray(blk.author_step_refs) && blk.author_step_refs.includes(authorStep.n)) {
      tier1.push(idx);
    }
  }
  if (tier1.length > 0) {
    return { indices: [...new Set(tier1)].sort((a, b) => a - b), tier: 'author_step_refs' };
  }

  const commands=authorStep.adapted_commands??[];
  const exact=partitioned.candidateBlocks.filter(block=>validIndices.has(block.index as number)&&blockCommandLines(block).some(line=>commands.includes(line))).map(block=>block.index as number);
  if(exact.length)return {indices:[...new Set(exact)].sort((a,b)=>a-b),tier:'command_or_rebinding'};

  return { indices: [], tier: 'none' };
}

function toJudgmentGate(gate: PlumbGate | undefined): ModelJudgment['gate'] | undefined {
  if (!gate) return undefined;
  return {
    action: gate.action,
    ...(gate.calibration_source ? { reason: `source=${gate.calibration_source}` } : {}),
  };
}

/**
 * Applies Option A1 verdict mapping + unbound fail-closed guard for one Plumb `sequence` result.
 */
export function mapPlumbSequenceToFidelityRow(params: {
  brief: FidelityBrief;
  authorStep: AuthorStep;
  authorStepIndex: number;
  partitioned: PartitionedFidelityBlocks;
  plumb: PlumbNormalizedAnswer;
  modelVersion: string;
  requestSha256?: string;
  strictReview?: boolean;
}): BoundStepDecision {
  const { brief, authorStep, authorStepIndex, partitioned, plumb, modelVersion, requestSha256, strictReview = false } = params;
  const normalizedChoice = normalizePlumbSequenceChoice(plumb.choice);
  const gateAction = plumb.gate?.action ?? 'pass';
  const mapped = mapStepIndices(brief, authorStep, authorStepIndex, partitioned);
  let stepIndices = mapped.indices;
  let reviewRequired = false;
  let verdict: FidelityVerdict;
  const notes: string[] = [];

  if (gateAction === 'pass') {
    verdict = normalizedChoice === '保持' ? 'preserved' : normalizedChoice === '改变' ? 'changed' : 'unrealized';
  } else if (gateAction === 'review') {
    if (normalizedChoice === '改变') {
      verdict = 'changed';
    } else if (normalizedChoice === '未实现') {
      verdict = 'unrealized';
    } else if (strictReview) {
      verdict = 'changed';
      reviewRequired = true;
      notes.push('--strict-review 已启用，review 区不自动放行');
    } else {
      verdict = 'preserved';
      reviewRequired = true;
      notes.push('[需人工复核：Plumb sequence 落入 review 区]');
    }
  } else {
    // gateAction === 'reject' always fails closed against preserving unverified deviations.
    verdict = normalizedChoice === '未实现' ? 'unrealized' : 'changed';
    notes.push('Plumb gate=reject，拒绝自动放行');
  }

  if (verdict === 'preserved' && stepIndices.length === 0) {
    throw new CallFailure('invalid_parameters',`作者步骤 ${authorStep.n} 缺确定的计划步骤对应，不能把缺对应依据判成未实现`,'在计划中补 author_step_refs 或完整 adapted_commands 对应后重跑');
  }

  if (partitioned.exemptSummaryLines.length > 0 && verdict === 'preserved') {
    notes.push(partitioned.exemptSummaryLines.join('；'));
  }

  const confText = Number.isFinite(plumb.confidence) ? plumb.confidence.toFixed(3) : 'n/a';
  const rationaleParts = [
    `Plumb(${modelVersion}) sequence=${normalizedChoice}（conf=${confText}, gate=${gateAction}, 映射方式=${mapped.tier}）`,
    ...notes,
  ];
  const rationale = rationaleParts.join('；').slice(0, 4096);

  const gateMeta = toJudgmentGate(plumb.gate);
  const modelJudgment: ModelJudgment = {
    status: '未确认',
    decided_by: '模型',
    model_version: modelVersion,
    task: 'sequence',
    choice: normalizedChoice,
    confidence: Number.isFinite(plumb.confidence) ? Math.min(1, Math.max(0, plumb.confidence)) : null,
    ...(gateMeta ? { gate: gateMeta } : {}),
    ...(requestSha256 ? { request_sha256: requestSha256 } : {}),
  };

  return {
    row: {
      n: authorStep.n,
      verdict,
      step_indices: stepIndices,
      rationale,
      model_judgment: modelJudgment,
    },
    reviewRequired,
  };
}

/** Assembles a standalone `.verdict.json` payload with model disclosure metadata (brief digest bound by `embedFidelity`). */
export function buildFidelityVerdictDocument(params: {
  brief: FidelityBrief;
  decisions: readonly BoundStepDecision[];
  partitioned: PartitionedFidelityBlocks;
  modelVersion: string;
  requestSha256?: string;
  /** Long literals that stood in the state sent to Plumb as names, step by step (see shortenRepeatedLiterals). */
  literalSubstitutions?: ReadonlyArray<{ step: string } & LiteralSubstitution>;
}): {
  steps: FidelityRow[];
  disclosure: string;
  model_disclosure: ModelDisclosure;
} {
  const { decisions, partitioned, modelVersion, requestSha256, literalSubstitutions = [] } = params;
  const rows = decisions.map((d) => d.row);
  const kept = rows.filter((r) => r.verdict === 'preserved').map((r) => r.n);
  const changed = rows.filter((r) => r.verdict === 'changed').map((r) => r.n);
  const unrealized = rows.filter((r) => r.verdict === 'unrealized').map((r) => r.n);
  const reviewSteps = decisions.filter((d) => d.reviewRequired).map((d) => d.row.n);

  const segments: string[] = [];
  if (reviewSteps.length > 0) {
    segments.push(`[需人工复核：Plumb sequence 落入 review 区] 步骤 ${reviewSteps.join('、')}`);
  }
  if (kept.length > 0) segments.push(`保持步骤：${kept.join('、')}`);
  if (changed.length > 0) segments.push(`改变步骤：${changed.join('、')}`);
  if (unrealized.length > 0) segments.push(`未实现步骤：${unrealized.join('、')}`);
  if (partitioned.exemptSummaryLines.length > 0) {
    segments.push(partitioned.exemptSummaryLines.join('；'));
  }
  if (literalSubstitutions.length > 0) {
    const perStep = new Map<string, string[]>();
    for (const sub of literalSubstitutions) {
      const row = `${sub.name}（${sub.length} 个字符，出现 ${sub.occurrences} 次，SHA-256 前 12 位 ${sub.sha256_12}）`;
      perStep.set(sub.step, [...(perStep.get(sub.step) ?? []), row]);
    }
    segments.push(`长字面量换名：${[...perStep].map(([step, rows]) => `步骤 ${step} 的 ${rows.join('、')}`).join('；')}，送 Plumb 的题面里逐字相同的长字面量写成了名字，原文只在题面的对照表里列一次，自动化用例和简报里的原文没有改`);
  }
  segments.push(`依据 Plumb(${modelVersion}) 判断（状态未确认，决定者模型）。`);

  return {
    steps: rows,
    disclosure: segments.join('；').slice(0, 8192),
    model_disclosure: {
      status: '未确认',
      decided_by: '模型',
      model_version: modelVersion,
      ...(requestSha256 ? { request_sha256: requestSha256 } : {}),
      prompt_version: 'sequence@product-2400-exemptions-v2',
      review_required_steps: reviewSteps,
    },
  };
}
