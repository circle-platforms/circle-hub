// Local ProtocolCode → call-error category map for D1 (Boss 13:05 / afternoon 1114).
// Codex will land the same table in contracts/generated; this file mirrors requests-to-codex until then.
import type { ProtocolCode } from '../../contracts/generated/protocol.ts';

/** Closed set of call-refusal category words (owner 2026-11-14). */
export type CallErrorCategory =
  | '参数无效'
  | '无权限'
  | '不存在'
  | '已被占用'
  | '暂时不可用';

/**
 * How a protocol error is presented to the reader:
 * - category: `<类别词>：<事实>。<下一步>。` (no 状态/判断/原因/决定者)
 * - unavailable: SOURCE_UNAVAILABLE keeps 「状态未知；原因缺资料」
 * - conclusion: keep the 状态/判断/原因/决定者 string (item/layer conclusions; not used for mapped call codes)
 */
export type ErrorPresentation =
  | { kind: 'category'; category: CallErrorCategory }
  | { kind: 'unavailable' }
  | { kind: 'conclusion' };

/** Pack-scoped codes look like `<pack-id>.<local>` (not bare PROTOCOL_CODES). */
export function isPackScopedCode(code: string): boolean {
  return /^[a-z][a-z0-9-]{0,40}\.[A-Za-z0-9_.:-]+$/.test(code);
}

/** requests-to-codex table (Boss afternoon reassignments applied). */
const CATEGORY_BY_CODE = {
  // 参数无效
  SUBMISSION_SCHEMA_VIOLATION: '参数无效',
  REFERENCE_UNRESOLVED: '参数无效',
  REFERENCE_AMBIGUOUS: '参数无效',
  QUOTE_MISMATCH: '参数无效',
  SOURCE_UNPARSEABLE: '参数无效',
  EFFECT_PARAMETER_OUT_OF_RANGE: '参数无效',
  SPACE_ENTRY_INVALID: '参数无效',
  SYNC_OBJECT_INVALID: '参数无效',
  SYNC_OBJECT_HASH_MISMATCH: '参数无效',
  CREDENTIAL_IN_UPLOAD: '参数无效',
  SPACE_CREDENTIALS_DETECTED: '参数无效',
  SHARE_CREDENTIALS: '参数无效',
  MEMORY_CREDENTIALS_DETECTED: '参数无效',
  SHARE_QUOTE_MISMATCH: '参数无效',
  SHARE_UPLOAD_UNSIGNED: '参数无效',
  SYNC_PURGE_CONFIRMATION_REQUIRED: '参数无效',
  MEMORY_CURSOR_STALE: '参数无效',
  // 无权限
  SOURCE_NOT_PERMITTED: '无权限',
  IDENTITY_UNMAPPED: '无权限',
  AUDIENCE_VISIBILITY_EXCEEDED: '无权限',
  PACK_SPACE_DENIED: '无权限',
  PACK_PERSONAL_PUBLICATION_DENIED: '无权限',
  PACK_PERSONAL_CAPABILITY_DENIED: '无权限',
  EFFECT_NOT_ALLOWED: '无权限',
  BOUNDARY_POLICY_DENIED: '无权限',
  PACK_POLICY_DENIED: '无权限',
  SPACE_SEARCH_IN_RUN: '无权限',
  SPACE_RESULT_GROUNDS_PRIVATE: '无权限',
  SPACE_CONTENT_UNINSPECTABLE: '无权限',
  SHARE_UNVERIFIED: '无权限',
  SHARE_PERSONAL_SOURCE: '无权限',
  SHARE_GROUND_UNREADABLE: '无权限',
  RESULT_GROUNDS_UNREADABLE: '无权限',
  MEMORY_RUN_FORBIDDEN: '无权限',
  MEMORY_TEAM_DISABLED: '无权限',
  // 不存在
  SOURCE_ABSENT: '不存在',
  RUN_SUPERSEDED: '不存在',
  RUN_ABANDONED: '不存在',
  GROUNDS_WITHDRAWN: '不存在',
  GROUNDS_PURGED: '不存在',
  SYNC_OBJECT_MISSING: '不存在',
  SHARE_GROUND_UNRESOLVED: '不存在',
  EFFECT_CONTENT_UNVERIFIED: '不存在',
  EFFECT_RELEASE_UNMET: '不存在',
  TEAM_PARSER_REQUIRED: '不存在',
  SYNC_MODE_LOCAL: '不存在',
  LEASE_EXPIRED: '不存在',
  // 已被占用
  LEASE_UNAVAILABLE: '已被占用',
  FENCING_STALE: '已被占用',
  IDEMPOTENCY_MISMATCH: '已被占用',
  SPACE_VERSION_CONFLICT: '已被占用',
  MEMORY_VERSION_CONFLICT: '已被占用',
  SYNC_VERSION_CONFLICT: '已被占用',
  SYNC_EPOCH_CHANGED: '已被占用',
  SHARE_DUPLICATE: '已被占用',
  // 暂时不可用
  SOURCE_RETRYABLE: '暂时不可用',
  SOURCE_INTEGRITY_UNPROVEN: '暂时不可用',
  SOURCE_READ_FAILED: '暂时不可用',
  SOURCE_READ_LIMIT: '暂时不可用',
  SOURCE_REDIRECT_REFUSED: '暂时不可用',
  EFFECT_BUDGET_EXHAUSTED: '暂时不可用',
  EFFECT_UNKNOWN_DISPOSED: '暂时不可用',
  SPACE_CAPACITY_EXCEEDED: '暂时不可用',
  SPACE_INDEX_LIMIT: '暂时不可用',
  MEMORY_DOCUMENT_LIMIT: '暂时不可用',
  MEMORY_SPACE_LIMIT: '暂时不可用',
  SYNC_BATCH_LIMIT: '暂时不可用',
  SYNC_SESSION_EXPIRED: '暂时不可用',
  SYNC_RATE_LIMITED: '暂时不可用',
  SOURCE_PENDING_REVIEW: '暂时不可用',
} as const satisfies Partial<Record<ProtocolCode, CallErrorCategory>>;

/** Neutral-unknown SOURCE_UNAVAILABLE still rendered as 状态未知；原因缺资料. */
export const SOURCE_UNKNOWN_CODES = {
  SOURCE_UNAVAILABLE: true,
} as const satisfies Partial<Record<ProtocolCode, true>>;

/** Look up presentation; pack-scoped codes default to 参数无效 (whole-call pack refusal). */
export function errorPresentationOf(code: string): ErrorPresentation {
  if (Object.hasOwn(SOURCE_UNKNOWN_CODES, code)) return { kind: 'unavailable' };
  if (Object.hasOwn(CATEGORY_BY_CODE, code)) {
    return { kind: 'category', category: CATEGORY_BY_CODE[code as keyof typeof CATEGORY_BY_CODE] };
  }
  // Pack function refused the whole call (no item accepted): 参数无效, never the conclusion string.
  if (isPackScopedCode(code)) return { kind: 'category', category: '参数无效' };
  return { kind: 'conclusion' };
}

/** Category word when the code is a mapped call refusal; otherwise null. */
export function callErrorCategoryOf(code: string): CallErrorCategory | null {
  const presentation = errorPresentationOf(code);
  return presentation.kind === 'category' ? presentation.category : null;
}

/** Full code→category table for Codex / briefs (protocol codes only; pack codes default separately). */
export function categoryTableEntries(): ReadonlyArray<readonly [string, CallErrorCategory]> {
  return Object.entries(CATEGORY_BY_CODE) as Array<[string, CallErrorCategory]>;
}
