// Local ProtocolCode → reader reason map for D1 (Boss 12:10).
// Codex will land the same table in contracts/generated; this file mirrors requests-to-codex 10:50 + 12:10 until then.
import type { ProtocolCode } from '../../contracts/generated/protocol.ts';

/** Six vocabulary reasons, or judgment without a reason segment. */
export type ErrorReasonKind =
  | 'judgment_no_reason'
  | '缺资料'
  | '原始用例的问题'
  | '编写模型的问题'
  | '临时故障'
  | '设备的问题'
  | '还没查清';

/**
 * Only the non-default rows from the 10:50 table. Contested alternatives (编写模型的问题 vs
 * judgment_no_reason, SOURCE_READ_FAILED 临时故障 vs judgment_no_reason, …) follow Boss 12:10:
 * judgment_no_reason. SOURCE_UNAVAILABLE stays 缺资料 (neutral unknown for the caller).
 */
const REASON_BY_CODE = {
  SOURCE_UNAVAILABLE: '缺资料',
  SOURCE_RETRYABLE: '临时故障',
  SOURCE_INTEGRITY_UNPROVEN: '缺资料',
  SOURCE_PENDING_REVIEW: '缺资料',
  GROUNDS_WITHDRAWN: '缺资料',
  GROUNDS_PURGED: '缺资料',
} as const satisfies Partial<Record<ProtocolCode, Exclude<ErrorReasonKind, 'judgment_no_reason'>>>;

/** Neutral-unknown SOURCE_* still rendered as 状态未知；原因缺资料 (ABSENT / NOT_PERMITTED are out). */
export const SOURCE_UNKNOWN_CODES = {
  SOURCE_UNAVAILABLE: true,
} as const satisfies Partial<Record<ProtocolCode, true>>;

/** Look up the registered reason; unregistered codes are judgment_no_reason (no 「原因…」 segment). */
export function errorReasonOf(code: string): ErrorReasonKind {
  if (Object.hasOwn(REASON_BY_CODE, code)) return REASON_BY_CODE[code as keyof typeof REASON_BY_CODE];
  return 'judgment_no_reason';
}
