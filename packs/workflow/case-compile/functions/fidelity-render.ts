import { createHash } from 'node:crypto';
import { literalLengths, type AuthorStep, type FidelityBrief } from './fidelity.ts';
import { PLUMB_GATEWAY_LIMITS, estimateTokens } from './generated/skills/plumb/plumb-client/index.ts';
import { isRecord } from './text.ts';

/** What the Plumb gateway reads of one fidelity state, and the default of renderFidelityStepState: a caller whose judge is another one passes that judge's budget. */
export const FIDELITY_MAX_EST_TOKENS = PLUMB_GATEWAY_LIMITS.fidelityStateEstTokens;

export interface PartitionedFidelityBlocks {
  negativeCase: null;
  exemptedIndices: Set<number>;
  cleanupIndices: Set<number>;
  candidateBlocks: Array<Record<string, unknown>>;
  allBlocks: Array<Record<string, unknown>>;
  exemptSummaryLines: string[];
}

export interface LiteralSubstitution {
  name: string;
  length: number;
  labels?: number[];
  occurrences: number;
  sha256_12: string;
}

export interface RenderedFidelityState {
  state: string;
  truncated: boolean;
  overBudget: boolean;
  estTokensBefore: number;
  estTokensAfter: number;
  estTokensPlain: number;
  substitutions: LiteralSubstitution[];
  reducedEstTokens: number | null;
  parts: { currentStep: number; commandBlocks: number; exemptions: number } | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function blockCommandLines(block: Record<string, unknown>): string[] {
  if (Array.isArray(block.cmds)) {
    return block.cmds.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
  }
  if (isRecord(block.call) && Array.isArray(block.call.args)) {
    return block.call.args.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
  }
  return [];
}

export function blockHost(block: Record<string, unknown>): string {
  if (typeof block.host === 'string' && block.host) return block.host;
  if (isRecord(block.call) && typeof block.call.object === 'string') return block.call.object;
  return '';
}

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

export function partitionFidelityBlocks(brief: FidelityBrief): PartitionedFidelityBlocks {
 return {negativeCase:null,exemptedIndices:new Set(),cleanupIndices:new Set(),candidateBlocks:brief.blocks,allBlocks:brief.blocks,exemptSummaryLines:[]};
}

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

const LONG_LITERAL_CHARS = 32;
const LITERAL_TABLE_TAG = '[长字面量对照]';
const LITERAL_TABLE_NOTE = '下面每个名字，在上文和命令块里都代表一个逐字相同的长字面量，原文只在这里写一次：';

export function shortenRepeatedLiterals(segments: readonly string[]): { segments: string[]; legend: string; substitutions: LiteralSubstitution[] } {
  const piece = /^(["']*)([^]*?)(["']*)$/u;
  const split = segments.map((segment) => segment.split(/(\s+)/u));
  const seen = new Map<string, number>();
  const order: string[] = [];
  for (const parts of split) {
    for (const part of parts) {
      const core = piece.exec(part)![2]!;
      if (/^\s*$/u.test(part) || [...core].length < LONG_LITERAL_CHARS) continue;
      if (!seen.has(core)) order.push(core);
      seen.set(core, (seen.get(core) ?? 0) + 1);
    }
  }
  const taken = (name: string): boolean => segments.some((segment) => segment.includes(name));
  const chosen = new Map<string, { name: string; line: string; count: number }>();
  let next = 1;
  for (const literal of order) {
    const count = seen.get(literal)!;
    if (count < 2) continue;
    while (taken(`«L${next}»`)) next += 1;
    const name = `«L${next}»`;
    const [facts] = literalLengths([literal]);
    const line = `${name} = ${literal}（共 ${facts!.length} 个字符${facts!.labels ? `；各段 ${facts!.labels.join('、')}` : ''}）`;
    if (estimateTokens(literal) * count <= estimateTokens(name) * count + estimateTokens(line)) continue;
    chosen.set(literal, { name, line, count });
    next += 1;
  }
  if (chosen.size === 0) return { segments: [...segments], legend: '', substitutions: [] };
  const replaced = split.map((parts) => parts.map((part) => {
    const [, open, core, close] = piece.exec(part)!;
    const hit = chosen.get(core!);
    return hit ? `${open}${hit.name}${close}` : part;
  }).join(''));
  return {
    segments: replaced,
    legend: [LITERAL_TABLE_TAG, LITERAL_TABLE_NOTE, ...[...chosen.values()].map((c) => c.line)].join('\n'),
    substitutions: [...chosen.entries()].map(([literal, c]) => {
      const [facts] = literalLengths([literal]);
      return {
        name: c.name,
        length: facts!.length,
        ...(facts!.labels ? { labels: facts!.labels } : {}),
        occurrences: c.count,
        sha256_12: createHash('sha256').update(literal).digest('hex').slice(0, 12),
      };
    }),
  };
}

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
  const blockHead = `[候选命令块]\n${blockLines.join('\n')}`;

  const rungs: Array<{ header: string; prior: string }> = [{ header: headerSec, prior: renderPriorSection(priorSteps) }];
  for (let drop = 1; drop < priorSteps.length; drop += 1) {
    rungs.push({ header: headerSec, prior: `[前序步骤]\n（前面 ${drop} 步已省略）\n${priorSteps.slice(drop).map((s) => `${s.n}. ${s.text}`).join('\n')}` });
  }
  rungs.push({ header: headerSec, prior: '' }, { header: '', prior: '' });

  const plainText = (rung: { header: string; prior: string }): string => joinSections([rung.header, rung.prior, currentSec, `${blockHead}\n\n${exemptionSec}`]);
  const reducedText = (rung: { header: string; prior: string }): { text: string; substitutions: LiteralSubstitution[] } => {
    const out = shortenRepeatedLiterals([rung.header, rung.prior, currentSec, blockHead]);
    const [header, prior, cur, blocks] = out.segments as [string, string, string, string];
    return { text: joinSections([header, prior, cur, out.legend, `${blocks}\n\n${exemptionSec}`]), substitutions: out.substitutions };
  };

  const estTokensBefore = estimateTokens(plainText(rungs[0]!));
  for (const [i, rung] of rungs.entries()) {
    const state = plainText(rung);
    const est = estimateTokens(state);
    if (est <= maxEstTokens) {
      return { state, truncated: i > 0, overBudget: false, estTokensBefore, estTokensAfter: est, estTokensPlain: est, substitutions: [], reducedEstTokens: null, parts: null };
    }
  }

  const minimalPlain = plainText(rungs.at(-1)!);
  const estTokensPlain = estimateTokens(minimalPlain);
  for (const [i, rung] of rungs.entries()) {
    const { text, substitutions } = reducedText(rung);
    if (substitutions.length === 0) break;
    const est = estimateTokens(text);
    if (est <= maxEstTokens) {
      return { state: text, truncated: i > 0, overBudget: false, estTokensBefore, estTokensAfter: est, estTokensPlain, substitutions, reducedEstTokens: null, parts: null };
    }
  }

  const reduced = reducedText(rungs.at(-1)!);
  return {
    state: minimalPlain,
    truncated: true,
    overBudget: true,
    estTokensBefore,
    estTokensAfter: estTokensPlain,
    estTokensPlain,
    substitutions: [],
    reducedEstTokens: reduced.substitutions.length > 0 ? estimateTokens(reduced.text) : null,
    parts: { currentStep: estimateTokens(currentSec), commandBlocks: estimateTokens(blockHead), exemptions: estimateTokens(exemptionSec) },
  };
}
