import {
  canonicalPath,
  commandPath,
  type BriefKnowledge,
  type BriefNode,
} from './authoring-brief.ts';
import {
  estimateTokens,
  type PlumbCandidate,
  type PlumbMindmapNode,
} from './generated/skills/plumb/plumb-client/index.ts';
import { isRecord } from './text.ts';

export const CMD_RECALL_LIMIT = 40;
export const CMD_CHOICE_CHUNK_SIZE = 24;
export const CMD_VERIFY_MAX_EST_TOKENS = 1800;
export const NONE_CANDIDATE_NAME = '都不是';
export const NONE_CANDIDATE: PlumbCandidate = {
  name: NONE_CANDIDATE_NAME,
  text: '以上候选均不符合',
};

const MAX_DEFINITION_CHARS = 600;
const MAX_SUMMARY_CHARS = 220;

const CUE_EXPANSIONS: ReadonlyArray<[RegExp, readonly string[]]> = [
  [/(?:删除|移除|取消|撤销|清除|关闭|停用|禁用)/u, ['no', 'off', 'delete', 'del', 'remove', 'reset', 'rollback', 'disable', 'undo']],
  [/(?:查看|显示|查询|检查|确认|列出|读取)/u, ['show', 'display', 'get', 'list', 'status']],
  [/(?:启用|开启|打开|激活)/u, ['on', 'enable', 'active', 'start']],
  [/(?:回退|回滚|恢复)/u, ['rollback', 'reset', 'restore']],
  [/(?:同步|复制)/u, ['sync', 'copy']],
];

export interface CommandCandidate {
  command: string;
  path: string;
  definition: string;
  summary: string;
  reference: string;
}

interface IndexedCommand {
  candidate: CommandCandidate;
  commandTokens: Set<string>;
  tf: Map<string, number>;
  length: number;
  normalizedCommand: string;
}

export interface CommandIndex {
  docs: IndexedCommand[];
  df: Map<string, number>;
  avgLen: number;
}

export interface RecalledCommand {
  candidate: CommandCandidate;
  score: number;
}

export interface RenderedCmdVerifyState {
  state: string;
  truncated: boolean;
  overBudget: boolean;
  estTokensBefore: number;
  estTokensAfter: number;
}

function cleanLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function clipChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function tokenizeCommandText(text: string, expandCues = false): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();

  for (const part of lower.split(/[^a-z0-9._-]+/u)) {
    if (!part) continue;
    tokens.push(part);
    if (/[._-]/u.test(part)) {
      for (const sub of part.split(/[._-]+/u)) {
        if (sub && sub !== part) tokens.push(sub);
      }
    }
  }

  for (const run of text.match(/[\u4e00-\u9fff]+/gu) ?? []) {
    if (run.length >= 2) tokens.push(run);
    if (run.length > 2) {
      for (let i = 0; i <= run.length - 2; i += 1) {
        tokens.push(run.slice(i, i + 2));
      }
    }
  }

  if (expandCues) {
    for (const [pattern, extras] of CUE_EXPANSIONS) {
      if (pattern.test(text)) {
        for (const extra of extras) tokens.push(extra);
      }
    }
  }

  return tokens;
}

export function commandWordsFromPath(path: string): string | null {
  const norm = canonicalPath(path);
  const parts = norm.split('/').filter(Boolean);
  if (parts[0] !== 'commands' || parts.length < 2) return null;
  return parts
    .slice(1)
    .map((seg) => decodeURIComponent(seg))
    .join(' ')
    .trim();
}

function extractNodeDefinitionAndSummary(node: BriefNode, command: string, knowledge: BriefKnowledge): {
  definition: string;
  summary: string;
  reference: string;
  indexText: string;
} {
  const defs = node.entries.filter((e) => e.kind === 'definition');
  const primary = defs.length > 0 ? defs : node.entries;
  const statements = [...new Set(primary.map((e) => e.statement.trim()).filter(Boolean))];
  const rawDefinition = statements.join('\n');
  const paramRows = knowledge.parameters?.get(command) ?? [];
  const paramSummary = paramRows.map((p) => `${p.name}: ${cleanLine(p.statement)}`).join('; ');
  const fullDefinition = clipChars(
    paramSummary ? `${rawDefinition}\n参数说明: ${paramSummary}` : rawDefinition,
    MAX_DEFINITION_CHARS,
  );

  const firstStmtLines = (primary[0]?.statement ?? command)
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter(Boolean);
  const syntaxLine = firstStmtLines[0] ?? command;
  const descLines = firstStmtLines.slice(1).join(' ');
  const appLine = primary[0]?.applicability ? `适用:${primary[0].applicability}` : '';
  const summaryBody = [descLines, appLine, paramSummary].filter(Boolean).join(' | ');
  const summary = clipChars(summaryBody ? `${syntaxLine} — ${summaryBody}` : syntaxLine, MAX_SUMMARY_CHARS);

  const indexText = [
    command,
    ...node.entries.map((e) => `${e.statement} ${e.applicability ?? ''}`),
    ...paramRows.map((p) => `${p.name} ${p.statement}`),
  ].join('\n');

  return {
    definition: fullDefinition || command,
    summary: summary || command,
    reference: primary[0]?.reference ?? `tree:${knowledge.root}${node.path}`,
    indexText,
  };
}

export function buildCommandIndex(knowledge: BriefKnowledge): CommandIndex {
  const seenCommands = new Set<string>();
  const docs: IndexedCommand[] = [];
  const df = new Map<string, number>();

  for (const [, node] of knowledge.nodes) {
    if (!node.entries.length) continue;
    const canon = canonicalPath(node.path);
    const command = commandWordsFromPath(canon);
    if (!command || seenCommands.has(command)) continue;
    seenCommands.add(command);

    const { definition, summary, reference, indexText } = extractNodeDefinitionAndSummary(node, command, knowledge);
    const cmdTokens = new Set(tokenizeCommandText(command, false));
    const allTokens = [
      ...tokenizeCommandText(command, false),
      ...tokenizeCommandText(command, false),
      ...tokenizeCommandText(indexText, false),
    ];
    const tf = new Map<string, number>();
    for (const tok of allTokens) {
      tf.set(tok, (tf.get(tok) ?? 0) + 1);
    }
    for (const uniq of tf.keys()) {
      df.set(uniq, (df.get(uniq) ?? 0) + 1);
    }

    docs.push({
      candidate: { command, path: canon, definition, summary, reference },
      commandTokens: cmdTokens,
      tf,
      length: allTokens.length || 1,
      normalizedCommand: command.toLowerCase(),
    });
  }

  const totalLen = docs.reduce((sum, d) => sum + d.length, 0);
  return {
    docs,
    df,
    avgLen: docs.length > 0 ? totalLen / docs.length : 1,
  };
}

export function recallCommandCandidates(
  index: CommandIndex,
  query: string,
  options: { limit?: number; includeZeroScore?: boolean } = {},
): RecalledCommand[] {
  const limit = Math.max(1, Math.min(CMD_RECALL_LIMIT, options.limit ?? CMD_RECALL_LIMIT));
  const N = index.docs.length;
  if (N === 0) return [];

  const qTokens = [...new Set(tokenizeCommandText(query, true))];
  const qLower = cleanLine(query).toLowerCase();
  const k1 = 1.2;
  const b = 0.5;
  const scored: RecalledCommand[] = [];

  for (const doc of index.docs) {
    let score = 0;
    for (const tok of qTokens) {
      const freq = doc.tf.get(tok) ?? 0;
      if (freq === 0) continue;
      const docFreq = index.df.get(tok) ?? 0;
      const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);
      const normTf = (freq * (k1 + 1)) / (freq + k1 * (1 - b + (b * doc.length) / index.avgLen));
      const cmdBoost = doc.commandTokens.has(tok) ? 1.5 : 1.0;
      score += idf * normTf * cmdBoost;
    }

    if (doc.normalizedCommand && qLower.includes(doc.normalizedCommand)) {
      score += 8.0 + doc.commandTokens.size * 0.5;
    } else if (doc.commandTokens.size > 0) {
      let matchedWords = 0;
      for (const word of doc.commandTokens) {
        if (qTokens.includes(word)) matchedWords += 1;
      }
      if (matchedWords === doc.commandTokens.size) {
        score += 4.0;
      }
    }

    if (score > 0 || options.includeZeroScore) {
      scored.push({ candidate: doc.candidate, score });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.candidate.command.localeCompare(b.candidate.command);
  });
  return scored.slice(0, limit);
}

export function partitionChoiceChunks<T>(items: readonly T[], chunkSize: number = CMD_CHOICE_CHUNK_SIZE): T[][] {
  const safeSize = Math.max(1, Math.min(CMD_CHOICE_CHUNK_SIZE, chunkSize));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += safeSize) {
    out.push(items.slice(i, i + safeSize));
  }
  return out;
}

export function formatChoiceCandidates(candidates: readonly CommandCandidate[]): PlumbCandidate[] {
  return [
    ...candidates.map((c) => ({ name: c.command, text: c.summary })),
    NONE_CANDIDATE,
  ];
}

export function normalizeMatchedCandidate(
  choiceValue: string,
  candidates: readonly CommandCandidate[],
): { matched: CommandCandidate | null; noneSelected: boolean } {
  const cleaned = cleanLine(choiceValue.replace(/^`|`$/gu, ''));
  if (!cleaned) return { matched: null, noneSelected: false };
  if (cleaned === NONE_CANDIDATE_NAME || /^都不是(?:$|[（(:：\s])/u.test(cleaned) || cleaned.toLowerCase() === 'none') {
    return { matched: null, noneSelected: true };
  }

  const lower = cleaned.toLowerCase();
  const exact = candidates.find((c) => cleanLine(c.command).toLowerCase() === lower);
  if (exact) return { matched: exact, noneSelected: false };

  const head = cleanLine(cleaned.split(/(?:\s+[<\[{]|—|[:：])/u, 1)[0] ?? '');
  const headLower = head.toLowerCase();
  if (headLower) {
    const byHead = candidates.find((c) => cleanLine(c.command).toLowerCase() === headLower);
    if (byHead) return { matched: byHead, noneSelected: false };
  }

  const sorted = [...candidates].sort((a, b) => b.command.length - a.command.length);
  for (const cand of sorted) {
    const cmdLower = cleanLine(cand.command).toLowerCase();
    if (lower === cmdLower || lower.startsWith(`${cmdLower} `)) {
      return { matched: cand, noneSelected: false };
    }
  }

  return { matched: null, noneSelected: false };
}

export function buildPlumbNode(
  item: unknown,
  stepText: string,
  line?: string | null,
): PlumbMindmapNode {
  const rec = isRecord(item) ? item : {};
  const fields = isRecord(rec.fields) ? rec.fields : {};
  const rawPath = Array.isArray(fields.path)
    ? fields.path.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim())
    : [];
  const rawTitle = typeof fields.title === 'string' && fields.title.trim() ? fields.title.trim() : '';
  const explicitLine = typeof line === 'string' && line.trim() ? line.trim() : '';
  const resolvedLine = explicitLine || rawPath[0] || rawTitle || 'general';
  const node: PlumbMindmapNode = {
    line: resolvedLine,
    title: cleanLine(stepText) || rawTitle || resolvedLine,
  };
  if (rawPath.length > 0) {
    node.path = rawPath;
  }
  const moduleName = rawPath.length >= 2 ? rawPath[1] : rawPath[0];
  if (moduleName) {
    node.module = moduleName;
  }
  return node;
}

export function lookupCommandDefinition(
  knowledge: BriefKnowledge,
  line: string,
): { path: string | null; command: string | null; definition: string } {
  let path = commandPath(knowledge, line);
  if (!path) {
    const tokens = line.trim().split(/\s+/u).filter(Boolean);
    for (let len = tokens.length; len >= 1; len -= 1) {
      const candidate = canonicalPath(`/commands/${tokens.slice(0, len).join('/')}`);
      const node = knowledge.nodes.get(candidate);
      if (node && node.entries.length > 0) {
        path = candidate;
        break;
      }
    }
  }
  if (!path) return { path: null, command: null, definition: '' };
  const node = knowledge.nodes.get(path);
  const command = commandWordsFromPath(path);
  if (!node || !command) return { path, command, definition: '' };
  const { definition } = extractNodeDefinitionAndSummary(node, command, knowledge);
  return { path, command, definition };
}

export function truncateCmdVerifyState(input: {
  caseTitle?: string;
  executedSteps: readonly string[];
  currentStepSection: string;
  overheadText?: string;
  maxEstTokens?: number;
  maxChars?: number;
}): RenderedCmdVerifyState {
  const maxEstTokens = input.maxEstTokens ?? CMD_VERIFY_MAX_EST_TOKENS;
  const overheadTokens = input.overheadText ? estimateTokens(input.overheadText) : 0;
  const headerSec = input.caseTitle && cleanLine(input.caseTitle) ? `[用例]\n${cleanLine(input.caseTitle)}` : '';
  const currentSec = input.currentStepSection.trim();
  const prior = input.executedSteps.map((s, idx) => `${idx + 1}. ${cleanLine(s)}`).filter(Boolean);

  const joinParts = (parts: readonly string[]) => parts.filter(Boolean).join('\n\n');
  const priorBlock = (lines: readonly string[], dropped: number): string => {
    if (lines.length === 0) return '';
    const prefix = dropped > 0 ? `（前面 ${dropped} 步已省略）\n` : '';
    return `[已执行的步骤]\n${prefix}${lines.join('\n')}`;
  };

  const fits = (state: string, est: number): boolean => est <= maxEstTokens && (input.maxChars === undefined || state.length <= input.maxChars);
  const fullState = joinParts([headerSec, priorBlock(prior, 0), currentSec]);
  const estTokensBefore = estimateTokens(fullState) + overheadTokens;
  if (fits(fullState, estTokensBefore)) {
    return { state: fullState, truncated: false, overBudget: false, estTokensBefore, estTokensAfter: estTokensBefore };
  }

  for (let drop = 1; drop < prior.length; drop += 1) {
    const candidate = joinParts([headerSec, priorBlock(prior.slice(drop), drop), currentSec]);
    const est = estimateTokens(candidate) + overheadTokens;
    if (fits(candidate, est)) {
      return { state: candidate, truncated: true, overBudget: false, estTokensBefore, estTokensAfter: est };
    }
  }

  const noPrior = joinParts([headerSec, currentSec]);
  const noPriorEst = estimateTokens(noPrior) + overheadTokens;
  if (fits(noPrior, noPriorEst)) {
    return { state: noPrior, truncated: true, overBudget: false, estTokensBefore, estTokensAfter: noPriorEst };
  }

  const minimal = currentSec;
  const minEst = estimateTokens(minimal) + overheadTokens;
  return {
    state: minimal,
    truncated: true,
    overBudget: minEst > maxEstTokens,
    estTokensBefore,
    estTokensAfter: minEst,
  };
}
