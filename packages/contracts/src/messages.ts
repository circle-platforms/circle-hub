import type {ApiError} from './index.ts';

const exact:Record<string,string>={
  'API route not found':'接口路由不存在',
  'JSON content type required':'需要 JSON 内容类型',
  'Invalid JSON':'JSON 无效',
  'Payload does not satisfy the contract':'请求内容不符合约定',
  'Bearer token required':'需要 Bearer 令牌',
  'Token is invalid or expired':'令牌无效或已过期',
  'Knowledge record is not available to this identity':'知识记录对当前身份不可用',
  'The author cannot approve their own knowledge':'作者不能批准自己的知识',
  'Approval rejected: self-approval':'不能批准自己提交的事项',
  'Approval rejected: eligibility-mismatch':'当前身份不能做这个决定',
  'Approval rejected: already-decided':'这个请求已经有决定',
  'Approval rejected: binding-mismatch':'批准绑定与当前请求不一致',
  'Approval rejected: expired':'批准请求已过期',
  'Scope policy no longer permits this decision':'范围策略已不允许这个决定',
  'Change set dependencies are blocked':'变更集依赖尚未批准',
  'Tools unavailable in caller catalog':'调用方目录中没有这些工具',
  'Timezone is not a recognized IANA name':'时区不是已识别的 IANA 名称',
  'OIDC is not configured':'尚未配置 OIDC',
  'OIDC subject is not provisioned':'这个 OIDC 主体还没有对应的人',
  'OIDC login could not be verified':'OIDC 登录未能通过校验',
  'Provide text or contentBase64':'提供 text 或 contentBase64 其中之一',
  'A governance approver cannot decide their own request':'提交人不能决定自己的审批请求',
  'Name one person or one team':'指定一个人或一个团队',
  'Judgement pin does not match the approved bytes':'判断结果的摘要与已批准字节不一致',
  'Only the skill owner installs the approved package':'只有技能所有者可以安装已批准的包',
  'Approve the skill before installing it':'安装前先批准技能',
  'Stable snapshot changed':'稳定快照已经变化',
};

const byCode:Record<string,string>={
  INVALID_PAYLOAD:'请求内容不符合约定',
  UNAUTHENTICATED:'未认证',
  FORBIDDEN_SCOPE:'范围不允许',
  FORBIDDEN_ACTION:'动作不允许',
  SELF_APPROVAL:'不能批准自己提交的事项',
  DECISION_CONFLICT:'该决定与已有决定冲突',
  DEPENDENCY_NOT_APPROVED:'依赖尚未批准',
  SOURCE_FORBIDDEN:'知识或来源对当前身份不可用',
  TARGET_NOT_FOUND:'目标不存在',
  SKILLPACK_CHECK_FAILED:'技能包检查未通过',
  APPROVAL_STALE:'批准绑定已过期或不匹配',
  INPUT_EXPIRED:'输入已过期',
  INPUT_REVISION_STALE:'输入修订已变化',
};

export function chineseMessage(code:string,english:string):string{
  if(exact[english])return exact[english];
  if(english.startsWith('Approved skill ')&&english.includes('is not installed'))return '已批准的技能尚未安装。先安装，再运行。';
  return byCode[code]??'请求被拒绝';
}

export function presentError(error:ApiError,acceptLanguage?:string|string[]):{message:string;messageZh:string;messageEn?:string}{
  const english=error.message;
  const messageZh=chineseMessage(error.code,english);
  const header=Array.isArray(acceptLanguage)?acceptLanguage.join(','):acceptLanguage??'';
  const wantsZh=/(^|[, ])\s*zh([_-]|;|,|$)/i.test(header);
  if(wantsZh)return {message:messageZh,messageZh,messageEn:english};
  return {message:english,messageZh};
}
