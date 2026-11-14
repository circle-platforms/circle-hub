import type { Verdict, CheckTier, Reason as UnknownReason } from '../../../../contracts/generated/vocabulary.ts';
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

export type CallErrorCategory = '参数无效' | '无权限' | '不存在' | '已被占用' | '暂时不可用';

const CALL_ERROR_CATEGORIES: readonly CallErrorCategory[] = [
  '参数无效',
  '无权限',
  '不存在',
  '已被占用',
  '暂时不可用',
];

const DEFAULT_NEXT_STEP: Record<CallErrorCategory, string> = {
  参数无效: '请核对命令参数、选项格式或输入文件内容后重试',
  无权限: '请检查标准输入令牌、访问权限或文件权限后重试',
  不存在: '请核对文件路径、运行编号或目标条目是否存在后重试',
  已被占用: '请更换名称或确认当前运行及目标状态后重试',
  暂时不可用: '请确认 Hub 地址与网络连接或稍后重试',
};

function sanitizeCallErrorSegment(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/任务包/g, '工作流')
    .replace(/你[们]?的?/g, '')
    .replace(/\bundefined\b/g, '未填写')
    .trim()
    .replace(/^[：:\s]+/, '')
    .replace(/[。.!！;；\s]+$/, '');
}

function classifyCallError(error: unknown, message: string): CallErrorCategory {
  for (const cat of CALL_ERROR_CATEGORIES) {
    if (message.startsWith(cat + '：') || message.startsWith(cat + ':')) return cat;
  }
  if (typeof error === 'object' && error !== null) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') {
      if (status === 401 || status === 403) return '无权限';
      if (status === 404 || status === 410) return '不存在';
      if (status === 409 || status === 423) return '已被占用';
      if (status === 408 || status === 429 || status >= 500) return '暂时不可用';
      if (status === 400 || status === 422) return '参数无效';
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (code === 'ENOENT' || code === 'ENOTDIR') return '不存在';
      if (code === 'EACCES' || code === 'EPERM') return '无权限';
      if (code === 'EEXIST' || code === 'EBUSY') return '已被占用';
      if (
        code === 'ECONNREFUSED' ||
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        code === 'EAI_AGAIN' ||
        code === 'ENOTFOUND' ||
        code === 'EHOSTUNREACH' ||
        code === 'ENETUNREACH' ||
        code.startsWith('UND_ERR_')
      ) {
        return '暂时不可用';
      }
    }
  }
  const lower = message.toLowerCase();
  if (/hub 答复 (401|403)\b|没有存密钥|标准输入里没有令牌|(^|[^a-z])(401|403|unauthorized|forbidden)([^a-z]|$)|无权限|权限不足|未授权|鉴权|令牌/.test(lower)) {
    return '无权限';
  }
  if (/输出文件无法新建|目录.*已有|同一个条目|对应同一条原始用例|已被占用|已存在|重复|冲突|occupied|conflict|already exists|duplicate/.test(lower)) {
    return '已被占用';
  }
  if (/hub 答复 (408|429|5\d\d)\b|没有答复|hub 不可达|尚未开始上机验证|还没有结束|尚未返回|暂时不可用|超时|timed out|timeout|fetch failed|econn|network|502|503|504|服务不可用/.test(lower)) {
    return '暂时不可用';
  }
  if (/hub 答复 (404|410)\b|读不到 |没有 \.json 文件|里没有 |中没有|无法读取|enoent|not found|找不到|未找到|不存在/.test(lower)) {
    return '不存在';
  }
  return '参数无效';
}

/**
 * Formats CLI/extension invocation failures into `<类别词>：<这一次的事实>。<下一步>。`
 * using the closed five categories and removing disallowed phrasing.
 */
export function formatCallError(
  error: unknown,
  options?: { category?: CallErrorCategory; fallbackNextStep?: string },
): string {
  const raw = error instanceof Error ? error.message : String(error);
  const trimmed = raw.trim();
  const category = options?.category ?? classifyCallError(error, trimmed);
  let body = trimmed;
  for (const cat of CALL_ERROR_CATEGORIES) {
    if (body.startsWith(cat + '：') || body.startsWith(cat + ':')) {
      body = body.slice(cat.length + 1);
      break;
    }
  }
  const parts = body.split('。').map(sanitizeCallErrorSegment).filter(Boolean);
  if (parts.length === 0) {
    const nextStep = sanitizeCallErrorSegment(options?.fallbackNextStep ?? DEFAULT_NEXT_STEP[category]);
    return `${category}：调用失败。${nextStep}。`;
  }
  if (parts.length === 1) {
    const nextStep = sanitizeCallErrorSegment(options?.fallbackNextStep ?? DEFAULT_NEXT_STEP[category]);
    return `${category}：${parts[0]}。${nextStep}。`;
  }
  const fact = parts.slice(0, -1).join('。');
  const nextStep = parts[parts.length - 1];
  return `${category}：${fact}。${nextStep}。`;
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
      throw new Error(`参数写法不对，不支持单独的参数 ${token ?? ''}`.trim() + `。请使用 ${usage}`);
    }
    const eq = token.indexOf('=');
    if (eq >= 0) {
      throw new Error(`选项 ${token.slice(0, eq)} 不能用 = 连接参数值。请改为 ${token.slice(0, eq)} <值> 后重试`);
    }
    const key = token.slice(2) as K;
    if (!Object.hasOwn(options, key)) {
      throw new Error(`未知选项 --${key}。只允许 ${optionList}，请按 ${usage} 重试`);
    }
    const val = argv[i + 1];
    if (!val || val.startsWith('--') || Object.hasOwn(values, key)) {
      throw new Error(`选项 --${key} 必须只写一次且紧跟一个值。请按 ${usage} 重试`);
    }
    values[key] = val;
  }
  for (const key of allowedKeys) {
    if (options[key] && !values[key]) {
      throw new Error(`缺少必填参数 --${key}。请按 ${usage} 重试`);
    }
  }
  return values;
}

