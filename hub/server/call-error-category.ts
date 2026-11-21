import type { ProtocolError } from '../../contracts/src/common.ts';
import { CALL_ERROR_CATEGORY, labelOf, type PermissionRole } from '../../contracts/generated/vocabulary.ts';
import { callErrorCategoryOf, type CallErrorCategory } from './error-reasons.ts';
import { circleHubFromMetadata, circleHubFromParameters, fillCallerAccountName } from './fix-by-role.ts';

export { fillCallerAccountName } from './fix-by-role.ts';
import { connectionsPath, knowledgePath, settingsPath, teamPath } from './console/routes.ts';
import { unassignedPackNext } from './pack-words.ts';

export { callErrorCategoryOf as callErrorCategory } from './error-reasons.ts';
export type { CallErrorCategory };
export { packObjectWord, unassignedPackFact, unassignedPackNext } from './pack-words.ts';

export const CALL_ERROR_CATEGORIES = CALL_ERROR_CATEGORY.map(code => labelOf('call_error_category', code)) as readonly CallErrorCategory[];

export type NotPermittedKind = 'pack' | 'system' | 'root' | 'unknown';
export function isKnowledgeRootDenial(_message: string, _fix: string | undefined, path?: string): boolean { return path === '/root'; }
export function notPermittedKindOf(_message: string, _fix: string | undefined, path?: string): NotPermittedKind {
  if (path === '/pack') return 'pack';
  if (path === '/resource') return 'system';
  if (path === '/root') return 'root';
  return 'unknown';
}

export function localClockOf(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms));
  const hour = parts.find((part) => part.type === 'hour')?.value;
  const minute = parts.find((part) => part.type === 'minute')?.value;
  if (hour === undefined || minute === undefined) return null;
  return `${hour}:${minute}`;
}

export function environmentNameFromLeaseKey(key: string): string {
  const bed = /^bed\/([^/]+)\//.exec(key);
  if (bed) return bed[1]!;
  return key;
}

export function leaseUnavailableFact(message: string): string { return message; }

export function callErrorFact(_code: string, message: string): string { return message; }

export function stripSentenceEnd(text: string): string {
  return text.trim().replace(/[。．.!！;；]+$/u, '');
}

type NextRow = { member: string; admin: (message: string) => string };

const PACK_NEXT: NextRow = {
  member: unassignedPackNext('workflow'),
  admin: () => '请在控制台「团队」页核对本次工作流的分配；未取得结构化工作流标识，不生成带猜测名称的分配命令',
};

const SYSTEM_NEXT: NextRow = {
  member: '请联系管理员为该账户或所在团队分配此业务系统',
  admin: () => `用 ${circleHubFromParameters('resource.assign')} 为所在团队分配，或在控制台「团队」页分配`,
};

const KNOWLEDGE_ROOT_NEXT: NextRow = {
  member: '请联系管理员为该账户分配绑定这条产品线的工作流；或改读这次运行锁定的构建的手册和命令树',
  admin: () =>
    `用 ${circleHubFromParameters('pack.assign')} 为该账户分配绑定这条产品线的工作流；或改读这次运行锁定的构建的手册和命令树`,
};

const NEXT_BY_CODE: Record<string, NextRow> = {
  SOURCE_NOT_PERMITTED: PACK_NEXT,
  LEASE_UNAVAILABLE: {
    member: '请等待释放后重试，或改订其他测试环境',
    admin: () => `请在控制台 ${connectionsPath()} 核对实际占用键与持有者，再按已登记的管理出口处置；未取得结构化租约键，不生成强制释放命令`,
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
    member: '请先完成对应的脚本合并，判断正确后再上机验证',
    admin: () => '请先完成对应的脚本合并，判断正确后再上机验证',
  },
  TEAM_PARSER_REQUIRED: {
    member: '请联系管理员为团队安装对应的解析器，或改用团队已支持的格式后重试',
    admin: () => '请为团队安装对应的解析器，或改用团队已支持的格式后重试',
  },
  SYNC_MODE_LOCAL: {
    member: '请在客户端读取；需要 Hub 读取时，先在客户端改同步方式再重试',
    admin: () => '请在客户端读取；需要 Hub 读取时，先在客户端改同步方式再重试',
  },
  SHARE_DUPLICATE: {
    member: '请使用已有的条目，或修改陈述后重新核对依据',
    admin: () => '请使用已有的条目，或修改陈述后重新核对依据',
  },
  RUN_SUPERSEDED: {
    member: '要修改已交的内容，请开始新的运行再提交；不修改时，在后续的运行里继续',
    admin: () => '要修改已交的内容，请开始新的运行再提交；不修改时，在后续的运行里继续',
  },
  RUN_ABANDONED: {
    member: '请用 start_run 以这次运行为前驱（predecessor）开始新的运行',
    admin: () => '请用 start_run 以这次运行为前驱（predecessor）开始新的运行',
  },
  SYNC_PURGE_CONFIRMATION_REQUIRED: {
    member: '请在 10 分钟内于 Hub 控制台的同步方式中确认这次清除，再用同一请求重试',
    admin: () => '请在 10 分钟内于 Hub 控制台的同步方式中确认这次清除，再用同一请求重试',
  },
  SOURCE_ABSENT: {
    member: '请从这次返回的 options 中选择可读名称；列表不完整时先核对 options_coverage',
    admin: () => '请从这次返回的 options 中选择可读名称；列表不完整时先核对 options_coverage',
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

export function callErrorNext(
  code: string,
  role: PermissionRole,
  fix: string | undefined,
  message = '',
  callerName?: string,
  path?: string,
): string {
  let next: string;
  if (code === 'SOURCE_ABSENT' && fix?.trim()) return fix;
  if (code === 'SOURCE_NOT_PERMITTED') {
    const kind = notPermittedKindOf(message, fix, path);
    if (kind === 'unknown') return fix && fix.trim() ? fix : '缺少这次对象的结构化类型与可执行下一步；请维护者补齐后按原请求核对';
    const row =
      kind === 'root' ? KNOWLEDGE_ROOT_NEXT : kind === 'system' ? SYSTEM_NEXT : PACK_NEXT;
    next = role === 'admin' ? row.admin(message) : row.member;
  } else {
    const row = NEXT_BY_CODE[code];
    if (row !== undefined) {
      next = role === 'admin' ? row.admin(message) : row.member;
    } else {
      const raw = fix === undefined ? '' : stripSentenceEnd(fix);
      if (role === 'admin') {
        next = raw.length > 0 ? raw : '缺少本次调用的具体下一步，请维护者补齐后重试';
      } else if (raw.length === 0) {
        next = '缺少本次调用的具体下一步，请维护者补齐后重试';
      } else {
        next = raw;
      }
    }
  }
  return role === 'admin' ? fillCallerAccountName(next, callerName) : next;
}

export function renderCallError(
  error: ProtocolError,
  role: PermissionRole,
  fix: string | undefined,
  callerName?: string,
): string | null {
  const category = callErrorCategoryOf(error.code);
  if (category === null) return null;
  const fact = callErrorFact(error.code, error.message);
  const next = callErrorNext(error.code, role, fix, error.message, callerName, error.path);
  return `${category}：${stripSentenceEnd(fact)}。${stripSentenceEnd(next)}。`;
}
