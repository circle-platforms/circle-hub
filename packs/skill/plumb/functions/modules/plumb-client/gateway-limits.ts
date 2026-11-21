import { formatPlumbCallError, type PlumbBatchQuestion } from './types.ts';

export interface PlumbGatewayLimits {
  readonly maxQuestions: number;
  readonly maxPairs: number;
  readonly maxBodyBytes: number;
  readonly stateEstTokens: number;
  readonly fidelityStateEstTokens: number;
  readonly maxConcurrentPerKey: number;
}

export const PLUMB_GATEWAY_LIMITS: PlumbGatewayLimits = Object.freeze({
  maxQuestions: 32,
  maxPairs: 256,
  maxBodyBytes: 1_048_576,
  stateEstTokens: 1_400,
  fidelityStateEstTokens: 2_400,
  maxConcurrentPerKey: 2,
});

export const PLUMB_TASK_FAMILIES: Readonly<Record<string, string>> = Object.freeze({
  match: 'match',
  single_cmd_judge: 'match',
  steplist_judge: 'match',
  choice: 'choice',
  cmd_select: 'choice',
  manual_choice: 'choice',
  sequence: 'sequence',
  scenario_fidelity: 'sequence',
  placement: 'placement',
  rerank: 'rerank',
  expectation: 'expectation',
  criterion_coverage: 'criterion_coverage',
});

const ONE_PAIR_FAMILIES: ReadonlySet<string> = new Set(['match', 'rerank', 'criterion_coverage']);

export const PLUMB_DEFAULT_OPTION_COUNTS: Readonly<{ sequence: number; expectation: number }> = Object.freeze({ sequence: 3, expectation: 3 });

function listedOptions(question: PlumbBatchQuestion): number {
  const raw = question.candidates ?? question.criteria;
  if (Array.isArray(raw)) return raw.length;
  if (typeof raw === 'object' && raw !== null) return Object.keys(raw).length;
  return 0;
}

export function estimateExpandedPairs(question: PlumbBatchQuestion, fallbackTask?: string): number {
  const task = (question.task ?? fallbackTask ?? '').trim().toLowerCase();
  const family = Object.hasOwn(PLUMB_TASK_FAMILIES, task) ? PLUMB_TASK_FAMILIES[task]! : '';
  if (ONE_PAIR_FAMILIES.has(family)) return 1;
  const listed = listedOptions(question);
  if (listed > 0) return listed;
  if (family === 'sequence') return PLUMB_DEFAULT_OPTION_COUNTS.sequence;
  if (family === 'expectation') return PLUMB_DEFAULT_OPTION_COUNTS.expectation;
  return 1;
}

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');
const entryBytes = (qid: string, question: PlumbBatchQuestion): number => bytesOf(JSON.stringify(qid)) + 1 + bytesOf(JSON.stringify(question));

export function requestBodyBytes(frame: Readonly<Record<string, unknown>>, entries: ReadonlyArray<readonly [string, PlumbBatchQuestion]>): number {
  let bytes = bytesOf(JSON.stringify({ ...frame, questions: {} }));
  entries.forEach(([qid, question], i) => {
    bytes += entryBytes(qid, question) + (i > 0 ? 1 : 0);
  });
  return bytes;
}

export interface PlumbBatchPlanOptions {
  frame: Readonly<Record<string, unknown>>;
  fallbackTask?: string;
  maxQuestions?: number;
  limits?: Partial<PlumbGatewayLimits>;
}

export function planPlumbBatches(
  entries: ReadonlyArray<readonly [string, PlumbBatchQuestion]>,
  options: PlumbBatchPlanOptions,
): Array<Array<[string, PlumbBatchQuestion]>> {
  const limits = { ...PLUMB_GATEWAY_LIMITS, ...options.limits };
  const maxQuestions = Math.max(1, Math.min(limits.maxQuestions, options.maxQuestions ?? limits.maxQuestions));
  const frameBytes = bytesOf(JSON.stringify({ ...options.frame, questions: {} }));
  const chunks: Array<Array<[string, PlumbBatchQuestion]>> = [];
  let chunk: Array<[string, PlumbBatchQuestion]> = [];
  let pairs = 0;
  let bytes = frameBytes;
  for (const [qid, question] of entries) {
    const cost = estimateExpandedPairs(question, options.fallbackTask);
    const own = entryBytes(qid, question);
    if (cost > limits.maxPairs) {
      throw new Error(formatPlumbCallError('参数无效', `题目 ${qid} 估算展开 ${cost} 个打分对，超过单次请求上限 ${limits.maxPairs} 个`, '请减少这道题的候选数后重试'));
    }
    if (frameBytes + own > limits.maxBodyBytes) {
      throw new Error(formatPlumbCallError('参数无效', `题目 ${qid} 连同请求框架共 ${frameBytes + own} 字节，超过单次请求上限 ${limits.maxBodyBytes} 字节`, '请缩短这道题的上下文后重试'));
    }
    const next = bytes + (chunk.length > 0 ? 1 : 0) + own;
    if (chunk.length > 0 && (chunk.length >= maxQuestions || pairs + cost > limits.maxPairs || next > limits.maxBodyBytes)) {
      chunks.push(chunk);
      chunk = [];
      pairs = 0;
      bytes = frameBytes;
    }
    bytes += (chunk.length > 0 ? 1 : 0) + own;
    pairs += cost;
    chunk.push([qid, question]);
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

export function describePlumbRequestLimits(limits: Pick<PlumbGatewayLimits, 'maxQuestions' | 'maxPairs' | 'maxBodyBytes'> = PLUMB_GATEWAY_LIMITS): string {
  const mib = limits.maxBodyBytes / 1_048_576;
  const body = Number.isInteger(mib) ? `${mib} MiB` : `${limits.maxBodyBytes} 字节`;
  return `单次请求不超过 ${limits.maxQuestions} 题、展开后不超过 ${limits.maxPairs} 个打分对（选择题每个候选算一个）、请求体不超过 ${body}`;
}
