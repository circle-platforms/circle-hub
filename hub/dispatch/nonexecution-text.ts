// Shared wording for confirmed nonexecution; recovery does not change the ready-submission retry rule.
export const NOT_EXECUTED_NEXT = '原样重交，Hub 会再试一次';
export const TARGET_REJECTED_NEXT = '按拒绝的原因修正后原样重交，Hub 会再试一次';
export const TARGET_REJECTED_REASON = '原请求被目标明确拒收，本次上机验证没有执行';
export const NOT_EXECUTED_REASON = '原请求记录证明目标没有执行';
export const RECOVERED_NOT_EXECUTED_REASON = '服务重启后核对到原请求尚未开始，本次上机验证没有执行';
export const RECOVERED_NOT_SENT_REASON = '服务重启后核对到这次上机验证的请求还没有发出，本次上机验证没有执行';
