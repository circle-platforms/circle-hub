// Shared V03 recovery rules. Intent binding never creates a request or performs an action.
import {labelOf,ReasonSchema,type Reason} from '../../../contracts/generated/vocabulary.ts';
import {UnknownExit,isUnknownTerminal,type LayerResult} from '../../../contracts/src/validation.ts';
import type {CheckOutcome} from '../../../contracts/src/tables.ts';

/** V03 R[11]-R[15]: after bounded check/read recovery, unresolved facts go to a named person. */
export const EXIT_BY_REASON = {
  no_check: { missing:"本层可执行的检查及其判定结果", recipient: 'owner', kind: 'repair', next_action: '包作者安装声明层的检查或观察，发布修复版本；运行者以原运行为 predecessor 用 start_run 重跑' },
  check_error: { missing:"可用的检查判定结果", recipient: 'owner', kind: 'repair', next_action: '具名维护人核对所指检查并修复实现或声明，发布修复版本；运行者以原运行为 predecessor 重跑' },
  timeout: { missing:"检查在上限内完成的判定", recipient: 'owner', kind: 'repair', next_action: '包作者在沙箱上限内调整单项检查上限或拆分输入，发布修复版本后以新修订重跑' },
  missing_input: { missing:"运行所需的已绑定输入事实", recipient: 'runner', kind: 'clarification', next_action: '运行者用 upload_file 补齐点名的运行输入，再以原运行为 predecessor 用 start_run 开新修订；缺在提交声明上的可用 submit_result 重交' },
  integrity_unproven: { missing:"完整的来源目录及其证据", recipient: 'administrator', kind: 'repair', next_action: '管理员补齐点名的完整性前提：字节摘要不符的从可信备份恢复，目录不全的重新生产，目标观察不全的核对原作业；不重交原效果。补齐后重评，仍不能补齐则重证基线并以新修订重跑' },
  budget_exhausted: { missing:"工作上限内完成的检查结果", recipient: 'owner', kind: 'repair', next_action: '包作者在沙箱最大值以内调高检查工作上限，或拆分检查工作；修好后以新修订重跑' },
  declared_skip: { missing:"被跳过条目的提交产物", recipient: 'runner', kind: 'repair', next_action: '运行者用 submit_result 交回完整的新提交，仍可取代本次结果' },
  not_covered: { missing:"未覆盖条目的提交产物", recipient: 'runner', kind: 'repair', next_action: '运行者用 submit_result 补齐未覆盖条目的完整提交，仍可取代本次结果' },
  awaiting_step: { missing:"所等步骤的完成事实", recipient: 'runner', kind: 'repair', next_action: '完成 missing 指向的前置修复或请求后，原样 submit_result 由 Hub 重评；改变输入时以本运行为 predecessor 开新修订' },
  output_failed: { missing:"能回读且与重算一致的产物", recipient: 'runner', kind: 'repair', next_action: '运行者修复所指产物的生成或回读不一致，补交可核验产物；更改输入时以本运行为 predecessor 重跑' },
  repair_exhausted: { missing:"修复后符合要求的产物", recipient: 'runner', kind: 'repair', next_action: '修复轮数用完；运行者仍可用 submit_result 重交完整的新提交取代结果，或以本运行为 predecessor 用 start_run 开新修订' },
} as const satisfies Record<Reason, { recipient: keyof Pick<NamedRecoveryContext, 'runner' | 'owner' | 'administrator'>; kind: NonNullable<UnknownExit['request_kind']>; next_action:string; missing:string }>;

export interface NamedRecoveryContext {
  runner: string;
  owner: string;
  administrator: string;
  due: string;
  location: string;
}

/** Bind new results only. Stored results are read through readStoredValidationResult, never passed here. */
function bindNamedRecovery(layer: LayerResult, context: NamedRecoveryContext, outcomes: readonly CheckOutcome[] = []): LayerResult {
  const reason = layer.reason ?? 'check_error';
  const gap = (cause: Reason, missing: string) => {
    const policy = EXIT_BY_REASON[cause];
    return { reason: cause, missing, exit: UnknownExit.parse({ action: 'request', request_kind: policy.kind,
      audience: { user: context[policy.recipient] }, due: context.due }) };
  };
  const distinct = new Map<string, ReturnType<typeof gap>>();
  for (const outcome of outcomes) {
    if (outcome.verdict !== 'unknown') continue;
    const cause = outcome.reason ?? 'check_error';
    const missing = outcome.missing ?? outcome.statement;
    distinct.set(JSON.stringify([cause, missing]), gap(cause, missing));
  }
  if (layer.terminal!=='incomplete'&&!isUnknownTerminal(layer)) return distinct.size ? {...layer,gaps:[...distinct.values()]} : layer;
  const selected = [...distinct.values()].find(g => g.reason === reason)
    ?? gap(reason, `${context.location}：缺少${EXIT_BY_REASON[reason].missing}（${labelOf('reason',reason)}）`);
  const rest = [...distinct.values()].filter(g => g !== selected);
  return { ...layer, ...selected, ...(rest.length ? { gaps: rest } : {}) };
}

/** Compatibility input for the earlier pure-intent helper, not an execution context. */
export interface RecoveryContext {now:Date;runner:string;owner:string|null;admin:string|null;trustedCore?:boolean}
const heldInputReasons=ReasonSchema.extract(['awaiting_step','missing_input']);
export function bindRecovery(layer:LayerResult,context:NamedRecoveryContext,outcomes?:readonly CheckOutcome[]):LayerResult;
export function bindRecovery(layer:LayerResult,outcomes:readonly CheckOutcome[],context:RecoveryContext):LayerResult;
export function bindRecovery(layer:LayerResult,second:NamedRecoveryContext|readonly CheckOutcome[],third?:RecoveryContext|readonly CheckOutcome[]):LayerResult{
  if(!Array.isArray(second))return bindNamedRecovery(layer,second as NamedRecoveryContext,Array.isArray(third)?third:[]);
  const context=third as RecoveryContext;
  if(!context.owner||!context.admin)throw new Error('无法绑定未知出口：缺少 owner 或具名管理员身份读取接线');
  const due=new Date(context.now.getTime()+72*60*60*1000).toISOString();
  const bound=bindNamedRecovery(layer,{runner:context.runner,owner:context.owner,administrator:context.admin,due,location:'判定'},second);
  const decorate=(gap:{reason:Reason;missing:string;exit:unknown})=>{
    const outcome=second.find(o=>o.verdict==='unknown'&&o.reason===gap.reason&&o.missing===gap.missing);
    let procedure:string=EXIT_BY_REASON[gap.reason].next_action;
    // Only parent-observed evidence can propose automatic recovery. Pack data and authored exits grant no authority.
    if(context.trustedCore&&outcome){
      const held=Array.isArray(outcome.data?.unread_sources)&&outcome.data.unread_sources.some((row:unknown)=>row!==null&&typeof row==='object'&&'reason'in row&&row.reason==='credential_unreadable');
      if(outcome.data?.sandbox==='SANDBOX_UNAVAILABLE'){gap.exit={action:'reevaluate',audience:{hub:true},due};procedure='Hub 在沙箱恢复后自动重评';}
      else if(outcome.reason==='missing_input'&&outcome.data?.why==='unavailable'){gap.exit={action:'reread',audience:{hub:true},due};procedure='Hub 重读已绑定的来源片段后自动重评';}
      else if(heldInputReasons.safeParse(outcome.reason).success&&held){gap.exit={action:'request',request_kind:'disposition',audience:{user:context.admin},due};procedure='具名管理员接受这份普通来源后 Hub 自动重评';}
      else if(outcome.reason==='integrity_unproven'&&outcome.data?.why==='integrity_unproven'){gap.exit={action:'request',request_kind:'repair',audience:{user:context.admin},due};procedure='具名管理员从可信备份恢复与摘要一致的字节后重新核验，不重读损坏的原件';}
    }
    gap.missing+='；下一步：'+procedure;
  };
  if(bound.missing&&bound.exit&&bound.reason)decorate(bound as LayerResult&{reason:Reason;missing:string;exit:unknown});
  for(const gap of bound.gaps??[])decorate(gap);
  return bound;
}
