import { CALL_ERROR_CATEGORY_LABEL, isCallErrorCategory, labelOf, type CallErrorCategory as CallErrorCode } from './generated/vocabulary.ts';
import type { Verdict, CheckTier, Reason as UnknownReason } from '../../../../../contracts/generated/vocabulary.ts';
// Shared helpers of the case-compile pack functions (pure TypeScript, no imports outside the pack).

export const PACK = 'case-compile';

export function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A check subject can hold data full of references that nothing quotes, such as catalog entries. The evaluator reads every
 * reference-like string it finds in a subject, against one budget for all items of a submission, so a whole mind map ran out of
 * it and verification stopped. Such data crosses the subject as text; its content does not change, so a recipe digest stays.
 */
export function sealed(value: unknown): unknown {
  return value === undefined || value === null ? value : { sealed: JSON.stringify(value) };
}
export function opened(value: unknown): unknown {
  return isRecord(value) && typeof value.sealed === 'string' && Object.keys(value).length === 1 ? JSON.parse(value.sealed) : value;
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/** Max length per wrapped explanatory prose line (safely below Circle `read_file` 2,000-char line cap). */
export const PROSE_WRAP_MAX_CHARS = 1_600;

/**
 * Wraps an explanatory Markdown prose bullet (`prefix + body`) so no emitted line exceeds `maxChars`.
 * Never apply to verbatim content blocks (device output, scope quotes, author/manual quotes, fenced blocks).
 */
export function wrapProseLine(prefix: string, body: string, maxChars: number = PROSE_WRAP_MAX_CHARS): string[] {
  const width = Math.max(40, Math.floor(maxChars));
  const normalized = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.includes('\n') && prefix.length + normalized.length <= width) {
    return [`${prefix}${normalized}`];
  }
  const paragraphs = normalized.split('\n');
  const out: string[] = [];
  for (let pIndex = 0; pIndex < paragraphs.length; pIndex++) {
    let curPrefix = pIndex === 0 ? prefix : '  ';
    let rest = paragraphs[pIndex]!;
    if (rest.length === 0) {
      out.push(pIndex === 0 ? prefix : '');
      continue;
    }
    while (curPrefix.length + rest.length > width) {
      const budget = Math.max(1, width - curPrefix.length);
      let cut = Math.min(budget, rest.length);
      if (cut < rest.length && cut > 1) {
        const prev = rest.charCodeAt(cut - 1);
        if (prev >= 0xd800 && prev <= 0xdbff) cut--;
      }
      const spaceIdx = rest.slice(0, cut).search(/[ \t][^ \t]*$/);
      let trimmedSpace = false;
      if (spaceIdx >= Math.floor(cut * 0.6) && spaceIdx > 0) {
        cut = spaceIdx;
        trimmedSpace = true;
      }
      out.push(`${curPrefix}${rest.slice(0, cut)}`);
      rest = trimmedSpace ? rest.slice(cut).replace(/^[ \t]+/, '') : rest.slice(cut);
      curPrefix = '  ';
      if (rest.length === 0) break;
    }
    if (rest.length > 0) out.push(`${curPrefix}${rest}`);
  }
  return out;
}

export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export interface PackWarning {
  code: string;
  message: string;
}

export function refusal(code: string, message: string, fix: string, warnings: PackWarning[] = [], pointer?: string): { error: { code: string; message: string; fix: string; pointer?: string }; warnings: PackWarning[] } {
  return { error: { code: `${PACK}.${code}`, message, fix, ...(pointer !== undefined ? { pointer } : {}) }, warnings };
}

/** A check outcome, statement always closed by the two markers (the synthetic one only when the contract is synthetic). */
export interface Outcome {
  judgment_sources?:string[];
  missing?: string;
  verdict: Extract<Verdict, 'support' | 'refute' | 'unknown'>;
  code?: string;
  statement: string;
  grounds: string[];
  tier: CheckTier;
  reason?: Extract<UnknownReason, 'missing_input' | 'integrity_unproven' | 'check_error' | 'output_failed'>;
  item?: string;
  /** Where the judged content sits in the subject (the /data/... forms of this pack, or the interpreter's own). */
  pointer?: string;
  data?: { [key: string]: unknown };
}

/** The two markers every conclusion of this pack carries (task page A.5): never "可以运行". */
export function markers(synthetic: boolean, identity?: { runtimeVersion: string; digest: string }): string {
  const basis = synthetic ? '按合成合约核对' : '按发布的运行器合约核对';
  const who = identity ? `；运行时 ${identity.runtimeVersion}；身份 ${(identity as { pinned?: { identity: string } }).pinned?.identity.slice(0, 12) ?? identity.digest.slice(0, 12)}` : '';
  return `（${basis}${who}；不证明在真实设备上跑得通）`;
}

/** Parse only this module's complete provenance-tail grammar for display, never the meaning of a fact. */
export function reportStatement(text: string): string {
  return text.replace(/（(按合成合约核对|按发布的运行器合约核对)；运行时 [^；\r\n]+；身份 [a-f0-9]{12}；不证明在真实设备上跑得通）/gu, '（$1；不证明在真实设备上跑得通）');
}

/** Local operator time, to the minute; raw timestamps stay in machine records. */
export function localMinute(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

export function outcome(kind: Outcome['verdict'], statement: string, tier: Outcome['tier'], item: string, extras: Partial<Outcome> = {}): Outcome {
  return { verdict: kind, statement, grounds: [], tier, item, ...extras };
}

/** Wraps a check so a defect of the pack itself is a check_error, never an exception across the boundary. */
export function guarded(run: () => unknown, failure: (message: string) => unknown): unknown {
  try {
    return run();
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

export type CallErrorCategory = (typeof CALL_ERROR_CATEGORY_LABEL)[keyof typeof CALL_ERROR_CATEGORY_LABEL];
export interface CallFailureFields { path?: string; legal_form?: string }
/** Explicit refusal data. No category or next action is inferred from prose. */
export class CallFailure extends Error {
  readonly category: CallErrorCode;
  readonly fact: string;
  readonly next_action: string;
  readonly path?: string;
  readonly legal_form?: string;
  constructor(category: CallErrorCode, fact: string, next_action: string, fields: CallFailureFields = {}) {
    if (!isCallErrorCategory(category) || typeof fact !== 'string' || typeof next_action !== 'string' || !fact.trim() || !next_action.trim()) throw new TypeError('CallFailure requires a fact and next action');
    super(fact);
    this.name = 'CallFailure'; this.category = category; this.fact = fact; this.next_action = next_action;
    this.path = fields.path; this.legal_form = fields.legal_form;
  }
}
export function failCall(category: CallErrorCode, fact: string, next_action: string, fields: CallFailureFields = {}): never {
  throw new CallFailure(category, fact, next_action, fields);
}
const sentence = (text: string): string => text.trim().replace(/[。．.!！;；]+$/u, '') + '。';
/** Only native structured filesystem and connection codes select a recovery action. */
function nativeFailure(error: unknown): CallFailure | null {
  if (!(error instanceof Error)) return null;
  const fields = error as Error & { code?: unknown; path?: unknown };
  const path = typeof fields.path === 'string' ? fields.path : undefined;
  const code = fields.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return new CallFailure('not_found', `文件位置不存在或不是目录${path ? '：' + path : ''}`, '按本次文件参数核对位置，提供存在的普通文件或目录后重试', { path });
  if (code === 'EACCES' || code === 'EPERM') return new CallFailure('permission_denied', `本机文件操作被系统权限拒绝${path ? '：' + path : ''}`, '由运行者核对该位置的系统权限，再按同一参数重试', { path });
  if (code === 'EEXIST' || code === 'EBUSY') return new CallFailure('occupied', `本机目标位置已存在或被占用${path ? '：' + path : ''}`, '另选未占用位置，或由运行者核对原位置后重试', { path });
  if (typeof code === 'string' && ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','EAI_AGAIN','ENOTFOUND','EHOSTUNREACH','ENETUNREACH','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET'].includes(code)) return new CallFailure('temporarily_unavailable', `连接操作失败（${String(code)}）`, '由运行者检查当前连接目标与服务状态后重试同一请求');
  return null;
}
/** A null category means no structured refusal classification was established. */
export interface CallFailureData extends CallFailureFields {
  category: CallErrorCode | null;
  fact: string;
  next_action: string;
}
export interface CallFailureOptions { category?: CallErrorCategory; fallbackNextStep?: string }
export function callFailureData(error: unknown, options?: CallFailureOptions): CallFailureData {
  let failure = error instanceof CallFailure ? error : nativeFailure(error);
  if (!failure && options?.category) {
    const entry = Object.entries(CALL_ERROR_CATEGORY_LABEL).find(([,label]) => label === options.category);
    if (entry && options.fallbackNextStep) failure = new CallFailure(entry[0] as CallErrorCode, error instanceof Error ? error.message : '调用失败', options.fallbackNextStep);
  }
  return failure ?? { category: null, fact: '调用未完成，缺少结构化错误原因', next_action: '请维护者定位本次拒绝点并补齐错误类别、事实和下一步；不据此改写输入内容或判断业务结论' };
}
/** Adapts structured refusal data to the existing CLI wire text. */
export function formatCallError(error: unknown, options?: CallFailureOptions): string {
  const failure = callFailureData(error, options);
  // The legacy CLI label means the caller cannot proceed; null is never a network or transient attribution.
  const category = failure.category ?? 'temporarily_unavailable';
  return labelOf('call_error_category', category) + '：' + sentence(failure.fact) + sentence(failure.next_action) + (failure.path ? `位置：${failure.path}。` : '') + (failure.legal_form ? `合法写法：${failure.legal_form}。` : '');
}

/**
 * Parses `--name value` CLI pairs against a declared boolean `required` table.
 * Rejects `=` assignments, repeated keys, bare positional arguments, and unknown flags.
 */
export function parseCliOptions<K extends string>(
  argv: readonly string[],
  options: Record<K, boolean>,
  usage: string,
): Partial<Record<K, string>> {
  const values: Partial<Record<K, string>> = {};
  const allowedKeys = Object.keys(options) as K[];
  const optionList = allowedKeys.map((key) => `${options[key] ? '' : '可选 '}--${key}`).join('、');
  for (let i = 0; i < argv.length; i += 2) {
    const token = argv[i];
    if (!token?.startsWith('--')) {
      failCall('invalid_parameters', '参数写法不对，不支持单独的参数', `请使用 ${usage}`);
    }
    const eq = token.indexOf('=');
    if (eq >= 0) {
      failCall('invalid_parameters', `选项 ${token.slice(0, eq)} 不能用 = 连接参数值`, `请改为 ${token.slice(0, eq)} <值> 后重试`);
    }
    const key = token.slice(2) as K;
    if (!Object.hasOwn(options, key)) {
      failCall('invalid_parameters', `未知选项 --${key}`, `只允许 ${optionList}，请按 ${usage} 重试`);
    }
    const val = argv[i + 1];
    if (!val || val.startsWith('--') || Object.hasOwn(values, key)) {
      failCall('invalid_parameters', `选项 --${key} 必须只写一次且紧跟一个值`, `请按 ${usage} 重试`);
    }
    values[key] = val;
  }
  for (const key of allowedKeys) {
    if (options[key] && !values[key]) {
      failCall('invalid_parameters', `缺少必填参数 --${key}`, `请按 ${usage} 重试`);
    }
  }
  return values;
}

