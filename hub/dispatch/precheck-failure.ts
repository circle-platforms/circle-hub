// Only fixed boundary descriptions belong in public diagnostics, never target error bodies.
export class PrecheckFactError extends Error {
  readonly missing_fact:string;
  readonly next_action:string;
  constructor(missing_fact:string,next_action:string){super(missing_fact);this.missing_fact=missing_fact;this.next_action=next_action;}
}
export function precheckFailure(error:unknown,stage:string):{missing_fact:string;next_action:string} {
  if(error instanceof PrecheckFactError)return {missing_fact:error.missing_fact,next_action:error.next_action};
  if(stage==='connect')return {missing_fact:'缺少通过认证、协议和工具目录校验的目标连接或会话',next_action:'管理员核对受限连接原件、证书、认证及允许/拒绝工具目录；恢复符合声明的会话后再采证'};
  if(stage==='acquire')return {missing_fact:'未取得具有有效身份、确认标记和期限的目标租约',next_action:'管理员核对租约调用原件、占用状态及租约字段声明，恢复本次租约确认后再采证'};
  if(stage==='precheck')return {missing_fact:'主只读核对未取得完整且可保存的应答',next_action:'管理员核对受限主读取原件、权限、调用声明和本地存储，恢复读取后再采证'};
  return {missing_fact:'逐座位核对的清单、构建或读取前提未完整取得',next_action:'管理员读取受限探测原件，核对清单完整性、预订的构建和产品身份，以及探测字段声明，恢复缺少的前提后再采证'};
}
