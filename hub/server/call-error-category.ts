/**
 * D3 fact/next for call errors (Boss 13:05 / afternoon 1114). Category words come from
 * error-reasons.callErrorCategoryOf. Next steps are table-driven by code × role — never
 * keyword-rewritten from「分配」. Object words come from pack-words / source messages.
 */
import type { ProtocolError } from '../../contracts/src/common.ts';
import { callErrorCategoryOf, type CallErrorCategory } from './error-reasons.ts';
import { circleHubFromMetadata, circleHubFromParameters } from './fix-by-role.ts';
import { connectionsPath, knowledgePath, settingsPath, teamPath } from './console/routes.ts';
import { unassignedPackFact } from './pack-words.ts';

export { callErrorCategoryOf as callErrorCategory } from './error-reasons.ts';
export type { CallErrorCategory };
export { packObjectWord, unassignedPackFact, unassignedPackNext } from './pack-words.ts';

/** Closed five (hub-terms); mirrored here for tests that assert the set without importing D1 internals. */
export const CALL_ERROR_CATEGORIES = ['参数无效', '无权限', '不存在', '已被占用', '暂时不可用'] as const satisfies readonly CallErrorCategory[];

/** Knowledge-tree-root unauthorised: keep「绑定产品线」semantics (contributions / ROOT_FORBIDDEN). */
function isKnowledgeRootDenial(message: string, fix: string | undefined): boolean {
  return /知识树根/.test(message) || /绑定这条产品线/.test(fix ?? '') || /绑定这条产品线/.test(message);
}

/**
 * Fact clause for the category sentence: no category prefix, no 任务包, no 「你」 as subject.
 * Prefers source messages that already use owner wording; only normalises legacy shapes.
 */
export function callErrorFact(code: string, message: string): string {
  let fact = message.split('；')[0]!.trim();
  fact = fact.replace(/^无权限：|^已被占用：|^暂时不可用：|^参数无效：|^不存在：/, '');

  // Legacy pack-denial shapes → owner form (kind unknown at rewrite time → 工作流, matching prior MCP default).
  const packDenied = /^(?:任务包|工作流|技能|产品知识来源|业务系统接入|工作流或技能) (.+) 存在，没有分配给(?:你|当前账户)$/.exec(fact);
  if (packDenied) return unassignedPackFact(packDenied[1]!, 'workflow');

  if (/^当前账户未获授权使用/.test(fact)) return fact;

  const noRead = /^(.+?)存在，你没有读取权限(?::|：)?(.*)$/.exec(fact);
  if (noRead) {
    const object = noRead[1]!.trimEnd();
    const detail = noRead[2]!.trim();
    return detail.length > 0
      ? `当前账户未获授权读取${object}（${detail}）`
      : `当前账户未获授权读取${object}`;
  }

  if (code === 'SOURCE_INTEGRITY_UNPROVEN') {
    if (/缺少经摘要核验的知识原件/.test(fact)) return '缺少经摘要核验的知识原件';
  }

  if (code === 'LEASE_UNAVAILABLE') {
    fact = fact.replace(/已被预订|已占用/, '正被占用');
  }

  if (code === 'LEASE_EXPIRED') {
    return fact
      .replace(/对你不可用/g, '对当前账户不可用')
      .replace(/没有分配给你/g, '未获授权给当前账户');
  }

  if (code === 'SHARE_DUPLICATE') return '公共空间里已有这一条目';
  if (code === 'MEMORY_CURSOR_STALE') return '游标已失效';
  if (code === 'EFFECT_CONTENT_UNVERIFIED') {
    return '这次运行还没有判断为正确的脚本合并结果，不能上机验证';
  }
  if (code === 'SOURCE_PENDING_REVIEW' && !/评审/.test(fact)) {
    return '该观察仍在评审中、尚未生效';
  }

  return fact
    .replace(/没有分配给你/g, '未获授权给当前账户')
    .replace(/对你不可用/g, '对当前账户不可用');
}

/** Strip a trailing 。 so the renderer can add exactly one. */
export function stripSentenceEnd(text: string): string {
  return text.replace(/[。．]\s*$/u, '').trim();
}

type NextRow = { member: string; admin: () => string };

/**
 * Next-step table: error code × admin|member. Knowledge-tree-root denial is a separate row
 * keyed off the message/fix, not a keyword rewrite of「分配」.
 */
const NEXT_BY_CODE: Record<string, NextRow> = {
  SOURCE_NOT_PERMITTED: {
    member: '请联系管理员为该账户或所在团队分配此工作流；当前账户可用的工作流和技能用 list_task_packs 查看',
    admin: () =>
      `用 ${circleHubFromParameters('pack.assign')} 为该账户或所在团队分配工作流或通用技能；或在控制台 ${teamPath()} 分配。分享读取权限用 ${circleHubFromMetadata('share', { brief: true })}（用法见该命令登记）；也可以换一个当前账户能读的引用`,
  },
  LEASE_UNAVAILABLE: {
    member: '请等待释放后重试，或改订其他键；无期限预订可请主人按既有带理由规则处理',
    admin: () =>
      `有确定空闲时刻的可等候后重试；无期限预订可改用别的键，或用 ${circleHubFromParameters('lease.release')} 按既有带理由规则强制释放；也可在控制台 ${connectionsPath()} 处理。不补造到期时刻`,
  },
  LEASE_EXPIRED: {
    member: '请重新预订',
    admin: () =>
      `用 ${circleHubFromParameters('lease.release')} 核对后，再为该账户重新预订；也可在控制台 ${connectionsPath()} 处理`,
  },
  SOURCE_INTEGRITY_UNPROVEN: {
    member: '请联系管理员从备份恢复原件并重验摘要，恢复后按原引用重读',
    admin: () =>
      `用 ${circleHubFromMetadata('restore', { brief: true })} 从备份恢复原件，再用 ${circleHubFromMetadata('records', { brief: true })} 核验摘要，恢复后按原引用重读`,
  },
  SOURCE_PENDING_REVIEW: {
    member: '请等待评审完成后重试',
    admin: () => '请完成或推进评审后，再按原对象重试',
  },
  MEMORY_CURSOR_STALE: {
    member: '请重新取得游标后再调用',
    admin: () => '请重新取得游标后再调用',
  },
  EFFECT_CONTENT_UNVERIFIED: {
    member: '请先完成脚本合并',
    admin: () => '请先完成脚本合并后再上机验证',
  },
  EFFECT_RELEASE_UNMET: {
    member: '请先完成声明的核验要求项，再派发其已核验产物；缺的项请联系管理员核对发布条件',
    admin: () => '请先完成声明的核验要求项，再派发其已核验产物',
  },
  TEAM_PARSER_REQUIRED: {
    member: '请联系管理员先将解析器发布并安装到团队，或改用团队已支持的格式后重新核对引文',
    admin: () => '请先将解析器发布并安装到团队，或改用团队已支持的格式后重新核对引文',
  },
  SYNC_MODE_LOCAL: {
    member: 'Hub 上没有这个来源的内容，因为同步方式是仅保存在客户端设备；请在客户端设置同步方式后重试',
    admin: () => 'Hub 上没有这个来源的内容，因为同步方式是仅保存在客户端设备；请在客户端设置同步方式后重试',
  },
  SHARE_DUPLICATE: {
    member: '请使用已有公共空间条目，或修改陈述后重新核对依据',
    admin: () => '请使用已有公共空间条目，或修改陈述后重新核对依据',
  },
  SYNC_PURGE_CONFIRMATION_REQUIRED: {
    member: '请在 10 分钟内于 Hub 控制台的同步方式中确认这次清除，再用同一请求重试',
    admin: () => '请在 10 分钟内于 Hub 控制台的同步方式中确认这次清除，再用同一请求重试',
  },
  SOURCE_ABSENT: {
    member: '请核对名称',
    admin: () => '请核对名称',
  },
  IDENTITY_UNMAPPED: {
    member: '请联系管理员在控制台核对账户与外部身份对应后补齐映射',
    admin: () => `在控制台 ${teamPath()} 核对账户与外部身份对应后补齐映射`,
  },
  SOURCE_RETRYABLE: {
    member: '请按给出的下次时刻重读同一来源；仍失败时请联系管理员核对资源并恢复读取',
    admin: () => `按给出的下次时刻重读同一来源；仍失败时在控制台 ${connectionsPath()} 核对资源并恢复读取`,
  },
  SOURCE_READ_FAILED: {
    member: '请联系管理员按所报确定故障修复应答或修订后重读',
    admin: () =>
      `按所报确定故障，在控制台 ${connectionsPath()} 修复应答或修订，或用 ${circleHubFromMetadata('resource', { brief: true })} 调整接入后重读`,
  },
  SOURCE_READ_LIMIT: {
    member: '请联系管理员调整资源声明或缩小读取范围后重新完整读取',
    admin: () => `在控制台 ${connectionsPath()} 调整资源声明或缩小读取范围后重新完整读取`,
  },
  SOURCE_REDIRECT_REFUSED: {
    member: '请联系管理员核对来源给出的 Location 与路由声明，修复配置后按原对象重读',
    admin: () => `在控制台 ${connectionsPath()} 核对来源给出的 Location 与路由声明，修复配置后按原对象重读`,
  },
  AUDIENCE_VISIBILITY_EXCEEDED: {
    member: '请收窄受众，或请联系管理员补身份映射并用分享覆盖确切内容的许可',
    admin: () =>
      `收窄受众，或在控制台 ${teamPath()} 补身份映射，并用 ${circleHubFromMetadata('share', { brief: true })} 覆盖确切内容的分享许可`,
  },
  SPACE_CAPACITY_EXCEEDED: {
    member: '请联系管理员调整容量后重试；撤回或停用内容不会释放版本记录占用',
    admin: () => `在控制台 ${teamPath()} 调整容量后重试；撤回或停用内容不会释放版本记录占用`,
  },
  SPACE_INDEX_LIMIT: {
    member: '请缩短或拆分单条内容；或请联系管理员调整索引限额',
    admin: () =>
      `缩短或拆分单条内容；当前版本超限时撤回或替换条目，或在控制台 ${settingsPath()} 调整索引限额；历史引用仍保留`,
  },
  PACK_PERSONAL_CAPABILITY_DENIED: {
    member: '个人空间只使用上传、个人或团队知识及 Hub 生成的文件；需要其他能力时请联系管理员先发布到团队再分配',
    admin: () =>
      `个人空间只使用上传、个人或团队知识及 Hub 生成的文件；需要其他能力时先发布到团队，再用 ${circleHubFromParameters('pack.assign')} 分配`,
  },
  MEMORY_DOCUMENT_LIMIT: {
    member: '请缩短正文，或请联系管理员调整单篇限额',
    admin: () => `缩短正文，或在控制台 ${settingsPath()} 调整单篇限额`,
  },
  MEMORY_SPACE_LIMIT: {
    member: '请停用旧记忆、缩短标题目录正文，或请联系管理员调整空间字节与篇数限额',
    admin: () => `停用旧记忆、缩短标题目录正文，或在控制台 ${settingsPath()} 调整空间字节与篇数限额`,
  },
  MEMORY_TEAM_DISABLED: {
    member: '请联系管理员核对并重新启用原团队记忆后，再提交共享',
    admin: () => `在控制台 ${knowledgePath()} 核对并重新启用原团队记忆后，再提交共享`,
  },
};

const KNOWLEDGE_ROOT_NEXT: NextRow = {
  member: '请联系管理员为该账户分配一个绑定这条产品线的工作流或技能后重交；或改读当前账户运行锁定的根',
  admin: () =>
    `用 ${circleHubFromParameters('pack.assign')} 为该账户分配一个绑定这条产品线的工作流或技能；或改读该账户运行锁定的根`,
};

/**
 * Next-step clause for the category sentence (no leading「下一步」).
 * Table-driven; knowledge-tree-root denial is a dedicated row.
 */
export function callErrorNext(
  code: string,
  role: 'admin' | 'user',
  fix: string | undefined,
  message = '',
): string {
  if (code === 'SOURCE_NOT_PERMITTED' && isKnowledgeRootDenial(message, fix)) {
    return role === 'admin' ? KNOWLEDGE_ROOT_NEXT.admin() : KNOWLEDGE_ROOT_NEXT.member;
  }
  const row = NEXT_BY_CODE[code];
  if (row !== undefined) {
    return role === 'admin' ? row.admin() : row.member;
  }
  const raw = fix === undefined ? '' : stripSentenceEnd(fix);
  if (role === 'admin') {
    if (raw.length > 0) return raw;
    return '核对后重试';
  }
  if (raw.length === 0) return '请联系管理员处理';
  if (!/^请/.test(raw)) return `请${raw}`;
  return raw;
}

/** Full reader line when the code is a mapped call refusal; otherwise null. */
export function renderCallError(error: ProtocolError, role: 'admin' | 'user', fix: string | undefined): string | null {
  const category = callErrorCategoryOf(error.code);
  if (category === null) return null;
  const fact = callErrorFact(error.code, error.message);
  const next = callErrorNext(error.code, role, fix, error.message);
  return `${category}：${fact}。${next}。`;
}
