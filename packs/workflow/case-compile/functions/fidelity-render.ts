// Deterministic exemption folding, fact formatting, and 2400-token budgeting for Plumb scenario_fidelity.
import type { AuthorStep, FidelityBrief } from './fidelity.ts';
import { estimateTokens } from './generated/skills/plumb/plumb-client/index.ts';
import { isRecord } from './text.ts';

export const FIDELITY_MAX_EST_TOKENS = 2400;

const NEGATIVE_MISSING_PRECOND_RE =
  /(?:(?:前置|前提|对端|全局开关|监听|依赖对象|配置).{0,10}(?:未配置|未创建|不存在|未开启|未启用|缺失)|(?:未配置|未创建|不存在|未开启|未启用|缺少).{0,12}(?:前置|前提|对端|peer|监听|开关|场景|条件))/iu;

export interface PartitionedFidelityBlocks {
  negativeCase: boolean;
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

/** Extracts normalized lowercase alphanumeric/word tokens for deterministic command/prerequisite matching. */
export function commandHeadTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9._-]+/u)
    .filter((tok) => tok.length >= 2 && tok !== 'no' && tok !== 'del' && tok !== 'delete');
}

/** Detects explicit negative cases verifying missing/absent prerequisites so they never fold away preconditions. */
export function isNegativeMissingPreconditionCase(brief: FidelityBrief): boolean {
  const texts: string[] = [brief.intent];
  for (const step of brief.author_steps) {
    texts.push(step.text);
    if (step.author_text) texts.push(step.author_text);
  }
  for (const exp of brief.expectations) {
    texts.push(exp.text);
  }
  return texts.some((t) => NEGATIVE_MISSING_PRECOND_RE.test(t));
}

function cmdMatchesPrerequisite(block: Record<string, unknown>, prerequisiteText: string): boolean {
  const prereqTokens = commandHeadTokens(prerequisiteText);
  if (prereqTokens.length === 0) return false;
  const cmdText = blockCommandLines(block).join(' ');
  const cmdTokens = new Set(commandHeadTokens(cmdText));
  let hits = 0;
  for (const tok of prereqTokens) {
    if (cmdTokens.has(tok)) hits += 1;
  }
  return hits >= Math.min(2, prereqTokens.length);
}

function cleanupMatchesPartner(cleanupBlock: Record<string, unknown>, partnerBlock: Record<string, unknown>): boolean {
  const cleanHost = blockHost(cleanupBlock);
  const partnerHost = blockHost(partnerBlock);
  if (cleanHost && partnerHost && cleanHost !== partnerHost) return false;
  if (typeof cleanupBlock.for === 'string' && cleanupBlock.for === partnerBlock.id) return true;
  const cleanTokens = new Set(commandHeadTokens(blockCommandLines(cleanupBlock).join(' ')));
  const partnerTokens = commandHeadTokens(blockCommandLines(partnerBlock).join(' '));
  let hits = 0;
  for (const tok of partnerTokens) {
    if (cleanTokens.has(tok)) hits += 1;
  }
  return hits >= Math.min(2, Math.max(1, partnerTokens.length));
}

/**
 * Separates Hub-verified added_precondition steps and paired cleanup:true steps out of the candidate
 * action list when safe (never in negative missing-precondition cases, and never when author_step_refs binds a block).
 */
export function partitionFidelityBlocks(brief: FidelityBrief): PartitionedFidelityBlocks {
  const allBlocks = brief.blocks;
  const negativeCase = isNegativeMissingPreconditionCase(brief);
  const exemptedIndices = new Set<number>();
  const cleanupIndices = new Set<number>();
  const exemptSummaryLines: string[] = [];

  if (!negativeCase) {
    const explicitRefs = new Set<number>();
    for (const blk of allBlocks) {
      if (Array.isArray(blk.author_step_refs) && blk.author_step_refs.length > 0 && typeof blk.index === 'number') {
        explicitRefs.add(blk.index);
      }
    }

    const statePrereqs: string[] = [];
    for (const ex of brief.mechanical.exemptions) {
      if (ex.kind !== 'added_precondition') continue;
      if (Array.isArray(ex.step_indices)) {
        for (const idx of ex.step_indices) {
          if (typeof idx === 'number' && !explicitRefs.has(idx)) exemptedIndices.add(idx);
        }
      }
      if (ex.origin === 'record.sources.states' && Array.isArray(ex.prerequisites)) {
        for (const p of ex.prerequisites) {
          if (typeof p === 'string' && p.trim()) statePrereqs.push(p.trim());
        }
      }
    }

    if (statePrereqs.length > 0) {
      const authoredText = brief.author_steps.map((s) => `${s.text} ${s.author_text ?? ''} ${(s.adapted_commands ?? []).join(' ')}`).join(' ').toLowerCase();
      for (const blk of allBlocks) {
        const idx = typeof blk.index === 'number' ? blk.index : -1;
        if (idx <= 0 || explicitRefs.has(idx) || exemptedIndices.has(idx)) continue;
        const cmds = blockCommandLines(blk).join(' ').toLowerCase();
        const matchesAuthorLiterally = cmds.length > 0 && authoredText.includes(cmds);
        if (!matchesAuthorLiterally && statePrereqs.some((p) => cmdMatchesPrerequisite(blk, p))) {
          exemptedIndices.add(idx);
        }
      }
    }

    const nonCleanupBlocks = allBlocks.filter((b) => b.cleanup !== true && b.kind !== 'RESTORE_FROM');
    for (const blk of allBlocks) {
      const idx = typeof blk.index === 'number' ? blk.index : -1;
      if (idx <= 0 || explicitRefs.has(idx) || exemptedIndices.has(idx)) continue;
      const isCleanup = blk.cleanup === true || blk.kind === 'RESTORE_FROM';
      if (!isCleanup) continue;
      if (nonCleanupBlocks.some((partner) => cleanupMatchesPartner(blk, partner))) {
        cleanupIndices.add(idx);
      }
    }

    if (exemptedIndices.size > 0) {
      exemptSummaryLines.push(`已核验前置步骤（index=${[...exemptedIndices].sort((a, b) => a - b).join(',')}）依 added_precondition 豁免`);
    }
    if (cleanupIndices.size > 0) {
      exemptSummaryLines.push(`已配对清理步骤（index=${[...cleanupIndices].sort((a, b) => a - b).join(',')}）随主配置清理豁免`);
    }
  }

  let candidateBlocks = allBlocks.filter((blk) => {
    const idx = typeof blk.index === 'number' ? blk.index : -1;
    return !exemptedIndices.has(idx) && !cleanupIndices.has(idx);
  });
  if (candidateBlocks.length === 0 && allBlocks.length > 0) {
    candidateBlocks = allBlocks;
  }

  return {
    negativeCase,
    exemptedIndices,
    cleanupIndices,
    candidateBlocks,
    allBlocks,
    exemptSummaryLines,
  };
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
  const exemptNote = partitioned.exemptSummaryLines.length > 0
    ? `\n\n[已核验豁免说明]\n${partitioned.exemptSummaryLines.join('\n')}`
    : '';
  const blockSec = `[候选命令块]\n${blockLines.join('\n')}${exemptNote}`;

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
