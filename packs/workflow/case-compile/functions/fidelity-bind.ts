// Deterministic step_indices binding and Option A1 Plumb sequence gate-to-verdict mapping.
import type { AuthorStep, FidelityBrief, FidelityRow, FidelityVerdict, ModelDisclosure, ModelJudgment } from './fidelity.ts';
import {
  blockAsserts,
  blockCommandLines,
  commandHeadTokens,
  type PartitionedFidelityBlocks,
} from './fidelity-render.ts';
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

function semanticTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of commandHeadTokens(text)) {
    out.add(tok);
  }
  const cjkRuns = text.match(/[\u4e00-\u9fff]{2,}/gu) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i <= run.length - 2; i += 1) {
      out.add(run.slice(i, i + 2));
    }
  }
  return out;
}

function validBriefIndices(brief: FidelityBrief): Set<number> {
  return new Set(
    brief.blocks
      .map((b) => b.index)
      .filter((n): n is number => typeof n === 'number' && Number.isSafeInteger(n)),
  );
}

/**
 * Maps an authored step deterministically onto `brief.blocks` indices across three fallback tiers:
 * 1) explicit `author_step_refs` annotations
 * 2) exact `adapted_commands` / `rebindings` literal matches
 * 3) token overlap & single-step/1-to-1 candidate correspondence (excluding folded exempted/cleanup steps).
 */
export function mapStepIndices(
  brief: FidelityBrief,
  authorStep: AuthorStep,
  authorStepIndex: number,
  partitioned: PartitionedFidelityBlocks,
): { indices: number[]; tier: 'author_step_refs' | 'command_or_rebinding' | 'token_overlap' | 'none' } {
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

  // Tier 2: adapted_commands head matching against non-exempt candidate blocks.
  const candidates = partitioned.candidateBlocks.filter((blk) => {
    const idx = typeof blk.index === 'number' ? blk.index : -1;
    return validIndices.has(idx);
  });
  if (candidates.length === 0) return { indices: [], tier: 'none' };

  if (authorStep.adapted_commands && authorStep.adapted_commands.length > 0) {
    const adaptedHeads = authorStep.adapted_commands
      .map((cmd) => commandHeadTokens(cmd).slice(0, 3).join(' '))
      .filter((h) => h.length > 0);
    const tier2: number[] = [];
    for (const blk of candidates) {
      const cmdStr = commandHeadTokens(blockCommandLines(blk).join(' ')).join(' ');
      if (adaptedHeads.some((head) => cmdStr.includes(head))) {
        tier2.push(blk.index as number);
      }
    }
    if (tier2.length > 0) {
      return { indices: [...new Set(tier2)].sort((a, b) => a - b), tier: 'command_or_rebinding' };
    }
  }

  // Single author step cleanly owns all non-exempt, non-cleanup candidate blocks when present.
  if (brief.author_steps.length === 1) {
    return {
      indices: [...new Set(candidates.map((c) => c.index as number))].sort((a, b) => a - b),
      tier: 'token_overlap',
    };
  }

  // Tier 3: overlap scoring between author step + expectations and candidate blocks.
  const queryText = [authorStep.text, authorStep.author_text ?? '', ...(authorStep.adapted_commands ?? [])].join(' ');
  const qTokens = semanticTokens(queryText);
  const scored: Array<{ index: number; score: number }> = [];
  for (const blk of candidates) {
    const blkText = [
      ...blockCommandLines(blk),
      ...blockAsserts(blk),
      typeof blk.kind === 'string' ? blk.kind : '',
    ].join(' ');
    const bTokens = semanticTokens(blkText);
    let score = 0;
    for (const tok of qTokens) {
      if (bTokens.has(tok)) score += 1;
    }
    if (score >= 2) scored.push({ index: blk.index as number, score });
  }
  if (scored.length > 0) {
    const maxScore = Math.max(...scored.map((s) => s.score));
    const winners = scored.filter((s) => s.score >= Math.max(2, maxScore - 1)).map((s) => s.index);
    return { indices: [...new Set(winners)].sort((a, b) => a - b), tier: 'token_overlap' };
  }

  // 1-to-1 structural fallback when candidate blocks match author steps count exactly.
  if (candidates.length === brief.author_steps.length && candidates[authorStepIndex]) {
    const positional = candidates[authorStepIndex].index;
    if (typeof positional === 'number' && validIndices.has(positional)) {
      return { indices: [positional], tier: 'token_overlap' };
    }
  }

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
    verdict = 'unrealized';
    notes.push('未能确定对应计划步骤 index，按 fail-closed 降级为 unrealized');
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

/** Assembles a complete schema-valid `.verdict.json` payload with model disclosure metadata. */
export function buildFidelityVerdictDocument(params: {
  brief: FidelityBrief;
  decisions: readonly BoundStepDecision[];
  partitioned: PartitionedFidelityBlocks;
  modelVersion: string;
  requestSha256?: string;
}): {
  brief_sha256: string;
  steps: FidelityRow[];
  disclosure: string;
  model_disclosure: ModelDisclosure;
} {
  const { brief, decisions, partitioned, modelVersion, requestSha256 } = params;
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
  segments.push(`依据 Plumb(${modelVersion}) 判断（状态未确认，决定者模型）。`);

  return {
    brief_sha256: brief.brief_sha256,
    steps: rows,
    disclosure: segments.join('；').slice(0, 8192),
    model_disclosure: {
      status: '未确认',
      decided_by: '模型',
      model_version: modelVersion,
      ...(requestSha256 ? { request_sha256: requestSha256 } : {}),
      prompt_version: 'sequence@product-2400',
      review_required_steps: reviewSteps,
    },
  };
}
