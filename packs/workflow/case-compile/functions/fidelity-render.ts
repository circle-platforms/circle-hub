// Complete exemption evidence, fact formatting, and 2400-token budgeting for Plumb scenario_fidelity.
import type { AuthorStep, FidelityBrief } from './fidelity.ts';
import { estimateTokens } from './generated/skills/plumb/plumb-client/index.ts';
import { isRecord } from './text.ts';

export const FIDELITY_MAX_EST_TOKENS = 2400;

export interface PartitionedFidelityBlocks {
  negativeCase: null;
  exemptedIndices: Set<number>;
  cleanupIndices: Set<number>;
  candidateBlocks: Array<Record<string, unknown>>;
  allBlocks: Array<Record<string, unknown>>;
  exemptSummaryLines: string[];
}

export interface RenderedFidelityState {
  state: string;
  truncated: boolean;
  overBudget: boolean;
  estTokensBefore: number;
  estTokensAfter: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Extracts executable command strings from either flat-step or block-mode brief entries. */
export function blockCommandLines(block: Record<string, unknown>): string[] {
  if (Array.isArray(block.cmds)) {
    return block.cmds.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
  }
  if (isRecord(block.call) && Array.isArray(block.call.args)) {
    return block.call.args.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
  }
  return [];
}

/** Extracts target host/object from either flat-step or block-mode brief entries. */
export function blockHost(block: Record<string, unknown>): string {
  if (typeof block.host === 'string' && block.host) return block.host;
  if (isRecord(block.call) && typeof block.call.object === 'string') return block.call.object;
  return '';
}

/** Extracts assertion texts from either flat-step or block-mode brief entries. */
export function blockAsserts(block: Record<string, unknown>): string[] {
  if (Array.isArray(block.asserts)) {
    return block.asserts.filter((a): a is string => typeof a === 'string' && a.trim().length > 0);
  }
  const out: string[] = [];
  if (typeof block.literal === 'string' && block.literal.trim()) out.push(block.literal.trim());
  if (Array.isArray(block.assertions)) {
    for (const a of block.assertions) {
      if (!isRecord(a)) continue;
      if (typeof a.literal === 'string' && a.literal.trim()) out.push(a.literal.trim());
      else if (isRecord(a.quote) && typeof a.quote.text === 'string' && a.quote.text.trim()) out.push(a.quote.text.trim());
    }
  }
  if (isRecord(block.quote) && typeof block.quote.text === 'string' && block.quote.text.trim()) {
    out.push(block.quote.text.trim());
  }
  return out;
}

/** Exemptions are evidence for model judgment, not a program-derived permission to erase candidate actions. */
export function partitionFidelityBlocks(brief: FidelityBrief): PartitionedFidelityBlocks {
 return {negativeCase:null,exemptedIndices:new Set(),cleanupIndices:new Set(),candidateBlocks:brief.blocks,allBlocks:brief.blocks,exemptSummaryLines:[]};
}

/** Renders one plan block deterministically without leaking worker prose (`description`/`desc`/`rationale`). */
export function formatBlockForFidelity(block: Record<string, unknown>): string {
  const index = typeof block.index === 'number' ? block.index : '?';
  const kind = str(block.kind) || 'STEP';
  const host = blockHost(block) || 'device';
  const tags = [kind, `host=${host}`];
  if (block.cleanup === true) tags.push('cleanup=true');
  if (typeof block.save_as === 'string' && block.save_as) tags.push(`save_as=${block.save_as}`);
  if (typeof block.input_register === 'string' && block.input_register) tags.push(`input=${block.input_register}`);

  const lines = [`block[${index}] (${tags.join(', ')})`];
  for (const cmd of blockCommandLines(block)) {
    lines.push(`  ${cmd}`);
  }
  const kw = isRecord(block.keywords)
    ? block.keywords
    : (isRecord(block.call) && isRecord(block.call.keywords) ? block.call.keywords : null);
  if (kw && Object.keys(kw).length > 0) {
    lines.push(`  keywords: ${JSON.stringify(kw)}`);
  }
  for (const assertion of blockAsserts(block)) {
    lines.push(`  assert: ${assertion}`);
  }
  return lines.join('\n');
}

function renderPriorSection(priorSteps: readonly AuthorStep[]): string {
  if (priorSteps.length === 0) return '';
  const body = priorSteps.map((s) => `${s.n}. ${s.text}`).join('\n');
  return `[前序步骤]\n${body}`;
}

function renderCurrentStepSection(step: AuthorStep, brief: FidelityBrief): string {
  const lines = [`[当前作者步骤 ${step.n}]`, step.text];
  if (step.author_text && step.author_text !== step.text) {
    lines.push(`作者原话: ${step.author_text}`);
  }
  if (step.adapted_commands && step.adapted_commands.length > 0) {
    lines.push(`适配命令: ${step.adapted_commands.join(' ; ')}`);
  }
  if (brief.expectations.length > 0) {
    lines.push(`期望参考: ${brief.expectations.map((e) => `${e.expectation_id}:${e.text}`).join(' | ')}`);
  }
  return lines.join('\n');
}

function joinSections(parts: readonly string[]): string {
  return parts.filter((p) => p.length > 0).join('\n\n');
}

/**
 * Renders the product-format `state` for one author step inside the Plumb `sequence` (@2400 est-token) budget.
 * Never truncates inside `[当前作者步骤 N]` or `[候选命令块]`; sets `overBudget=true` when even the core exceeds 2400.
 */
export function renderFidelityStepState(
  brief: FidelityBrief,
  stepIndex: number,
  partitioned: PartitionedFidelityBlocks,
  maxEstTokens: number = FIDELITY_MAX_EST_TOKENS,
): RenderedFidelityState {
  const current = brief.author_steps[stepIndex];
  const headerSec = brief.intent.trim() ? `[用例意图]\n${brief.intent.trim()}` : '';
  const priorSteps = brief.author_steps.slice(0, stepIndex);
  const currentSec = renderCurrentStepSection(current, brief);

  const blockLines = partitioned.candidateBlocks.map(formatBlockForFidelity);
  const exemptionSec = `[前置豁免规则]\n${brief.rules[2]}\n\n[mechanical.exemptions 原始依据，相关性及反向场景由模型核对]\n${JSON.stringify(brief.mechanical.exemptions)}`;
  const blockSec = `[候选命令块]\n${blockLines.join('\n')}\n\n${exemptionSec}`;

  const full = joinSections([headerSec, renderPriorSection(priorSteps), currentSec, blockSec]);
  const estTokensBefore = estimateTokens(full);
  if (estTokensBefore <= maxEstTokens) {
    return { state: full, truncated: false, overBudget: false, estTokensBefore, estTokensAfter: estTokensBefore };
  }

  for (let drop = 1; drop < priorSteps.length; drop += 1) {
    const remaining = priorSteps.slice(drop);
    const priorSec = `[前序步骤]\n（前面 ${drop} 步已省略）\n${remaining.map((s) => `${s.n}. ${s.text}`).join('\n')}`;
    const candidate = joinSections([headerSec, priorSec, currentSec, blockSec]);
    const est = estimateTokens(candidate);
    if (est <= maxEstTokens) {
      return { state: candidate, truncated: true, overBudget: false, estTokensBefore, estTokensAfter: est };
    }
  }

  const noPrior = joinSections([headerSec, currentSec, blockSec]);
  const noPriorEst = estimateTokens(noPrior);
  if (noPriorEst <= maxEstTokens) {
    return { state: noPrior, truncated: true, overBudget: false, estTokensBefore, estTokensAfter: noPriorEst };
  }

  const minimal = joinSections([currentSec, blockSec]);
  const minEst = estimateTokens(minimal);
  if (minEst <= maxEstTokens) {
    return { state: minimal, truncated: true, overBudget: false, estTokensBefore, estTokensAfter: minEst };
  }

  return {
    state: minimal,
    truncated: true,
    overBudget: true,
    estTokensBefore,
    estTokensAfter: minEst,
  };
}
