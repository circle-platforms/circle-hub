/**
 * D3 fact/next for call errors (Boss 13:05 / 14:12). When ProtocolError.call_error_reason
 * is set, category and next come only from contracts/generated (reason × actual role);
 * facts come from structured fields when present, otherwise source.message unchanged.
 * No prose matching of category prefixes, knowledge-root wording, lease clauses, or noRead.
 */
import type { ProtocolError } from '../../contracts/src/common.ts';
import {
  formatCallError,
  formatCallErrorReason,
  resolveCallErrorReason,
} from '../../contracts/generated/protocol.ts';
import {
  CallErrorReasonSchema,
  SYNC_MODE_UI,
  type CallErrorObjectKind,
  type CallErrorReason,
  type EnvironmentRegistrationIssue,
  type PermissionRole,
} from '../../contracts/generated/vocabulary.ts';
import { callErrorCategoryOf, type CallErrorCategory } from './error-reasons.ts';
import { circleHubFromMetadata, circleHubFromParameters, fillCallerAccountName } from './fix-by-role.ts';

export { fillCallerAccountName } from './fix-by-role.ts';
import { connectionsPath, knowledgePath, settingsPath, teamPath } from './console/routes.ts';
import { unassignedPackNext } from './pack-words.ts';

export { callErrorCategoryOf as callErrorCategory } from './error-reasons.ts';
export type { CallErrorCategory };
export { packObjectWord, unassignedPackFact, unassignedPackNext } from './pack-words.ts';

/** Append 「还可以重交 N 次。」 onto a line that already ends with a sentence stop. */
function withRoundsLeft(line: string, roundsLeft: number | undefined): string {
  if (roundsLeft === undefined) return line;
  const trimmed = line.replace(/[。．]\s*$/u, '').trim();
  return `${trimmed}。还可以重交 ${roundsLeft} 次。`;
}

/**
 * Prefer the generated reason × role table when the throw site set call_error_reason.
 * Does not strip category prefixes, does not match prose, does not default object kind to pack.
 * Returns null when reason is absent or the (code, reason, role) tuple is not registered.
 */
export function formatStructuredCallError(
  error: ProtocolError,
  role: PermissionRole,
  options: { nextOverride?: string; factOverride?: string } = {},
): string | null {
  const parsed = CallErrorReasonSchema.safeParse(error.call_error_reason);
  if (!parsed.success) return null;
  const reason: CallErrorReason = parsed.data;
  const fact = options.factOverride ?? structuredCallErrorFact(error, role) ?? error.message;
  const resolved = resolveCallErrorReason(error.code, reason, role);
  if (resolved === null) return null;

  if ('category' in resolved.classification) {
    const next = options.nextOverride ?? resolved.nextAction;
    if (next === null || next === undefined) return null;
    if (options.nextOverride !== undefined) {
      return withRoundsLeft(formatCallError(resolved.classification.category, fact, next), error.rounds_left);
    }
    const formatted = formatCallErrorReason(error.code, reason, role, fact);
    return formatted === null ? null : withRoundsLeft(formatted, error.rounds_left);
  }

  if ('unknown' in resolved.classification) {
    const next = options.nextOverride ?? resolved.nextAction ?? '请联系管理员';
    const lead = fact.trim().replace(/[。．；;]\s*$/u, '');
    return withRoundsLeft(
      `${lead}；状态未知；原因缺资料；下一步${next}；决定者程序`,
      error.rounds_left,
    );
  }

  if ('conclusion' in resolved.classification) {
    const next = options.nextOverride ?? resolved.nextAction ?? '请联系管理员处理';
    const lead = fact.trim().replace(/[。．；;]\s*$/u, '');
    return withRoundsLeft(
      `${lead}；状态已确认；判断错误；下一步${next}；决定者程序`,
      error.rounds_left,
    );
  }

  return null;
}

/** Closed five (hub-terms); mirrored here for tests that assert the set without importing D1 internals. */
export const CALL_ERROR_CATEGORIES = ['参数无效', '无权限', '不存在', '已被占用', '暂时不可用'] as const satisfies readonly CallErrorCategory[];

/** Object kind for SOURCE_NOT_PERMITTED next-step selection; never inferred from message prose. */
export type NotPermittedKind = 'pack' | 'knowledge' | 'system' | 'root';

const READ_OBJECT_KINDS = new Set<CallErrorObjectKind>([
  'knowledge',
  'source_artifact',
  'record',
  'named_document',
]);

/** Map structured object_kind (or path-only clue) to the legacy next-step row key. No default pack. */
export function notPermittedKindOf(
  objectKind: CallErrorObjectKind | undefined,
  path?: string,
): NotPermittedKind | null {
  if (objectKind === 'knowledge_root') return 'root';
  if (objectKind === 'pack') return 'pack';
  if (objectKind === 'system') return 'system';
  if (objectKind !== undefined && READ_OBJECT_KINDS.has(objectKind)) return 'knowledge';
  if (path === '/pack' || (typeof path === 'string' && path.startsWith('/pack'))) return 'pack';
  if (path === '/run' || path === '/reference' || (typeof path === 'string' && path.startsWith('/inputs'))) {
    return 'knowledge';
  }
  return null;
}

function packNameFromMessage(message: string): string | undefined {
  return /「([^」]+)」/.exec(message)?.[1];
}

/** HH:MM in the process local zone from an ISO timestamp. */
export function localClockOf(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms));
  const hour = parts.find((part) => part.type === 'hour')?.value;
  const minute = parts.find((part) => part.type === 'minute')?.value;
  if (hour === undefined || minute === undefined) return null;
  return `${hour}:${minute}`;
}

function registrationIssueLabel(issue: EnvironmentRegistrationIssue): string {
  switch (issue) {
    case 'executor_identity':
      return '执行器';
    case 'target':
      return '目标';
    case 'resources':
      return '资源';
    case 'booking_scope':
      return '预订';
  }
}

/**
 * Fact built only from structured ProtocolError fields. Returns null when required fields are absent —
 * callers keep source.message and never invent from prose.
 */
export function structuredCallErrorFact(error: ProtocolError, role: PermissionRole = 'user'): string | null {
  const env = error.environment_display_name;
  const comparison = error.registration_comparison;
  if (env !== undefined && comparison !== undefined) {
    const issue = comparison.issue;
    if (role === 'admin') {
      if (issue === 'executor_identity' && comparison.left_display_name !== undefined && comparison.right_display_name !== undefined) {
        return `测试环境「${env}」关联的执行器登记的是「${comparison.left_display_name}」，它的定义里写的是「${comparison.right_display_name}」，两处不一致，这次上机验证没有执行`;
      }
      if (
        issue === 'target'
        && comparison.left_display_name !== undefined
        && comparison.right_display_name !== undefined
        && comparison.right_values?.[0] !== undefined
      ) {
        return `测试环境「${env}」登记的目标是「${comparison.left_display_name}」，执行器「${comparison.right_display_name}」的目标是「${comparison.right_values[0]}」，两处不一致，这次上机验证没有执行`;
      }
      if (
        issue === 'resources'
        && comparison.right_display_name !== undefined
        && (comparison.left_values?.[0] !== undefined || comparison.left_display_name !== undefined)
        && comparison.right_values?.[0] !== undefined
      ) {
        const left = comparison.left_values?.[0] ?? comparison.left_display_name!;
        return `测试环境「${env}」登记的预订前缀是「${left}」，执行器「${comparison.right_display_name}」的资源是「${comparison.right_values[0]}」，两处不一致，这次上机验证没有执行`;
      }
      if (issue === 'booking_scope' && comparison.right_display_name !== undefined) {
        return `测试环境「${env}」与「${comparison.right_display_name}」的预订前缀重叠，不能预订测试环境「${env}」，这次没有执行`;
      }
    }
    if (issue === 'booking_scope') {
      return `测试环境「${env}」的预订登记存在重叠，不能预订该测试环境，这次没有执行`;
    }
    return `测试环境「${env}」的${registrationIssueLabel(issue)}登记不一致，这次上机验证没有执行`;
  }

  if (env !== undefined && error.holder_relation !== undefined) {
    const since = error.acquired_at !== undefined ? localClockOf(error.acquired_at) : null;
    const sinceClause = since !== null ? `（自 ${since} 起）` : '';
    if (error.holder_relation === 'current_account') {
      return `测试环境「${env}」正由当前账户的另一次运行占用${sinceClause}`;
    }
    if (error.holder_relation === 'other_account') {
      const holder = error.holder_display_name ?? '其他成员';
      return `测试环境「${env}」正由「${holder}」占用${sinceClause}`;
    }
    return `测试环境「${env}」正被占用${sinceClause}`;
  }

  if (error.object_kind === 'knowledge_root') {
    return '当前账户未获授权读取这条产品线的手册和命令树';
  }

  if (
    error.object_display_name !== undefined
    && (
      error.call_error_reason === 'content_read_not_permitted'
      || (error.object_kind !== undefined && READ_OBJECT_KINDS.has(error.object_kind))
    )
  ) {
    return `当前账户未获授权读取「${error.object_display_name}」`;
  }

  return null;
}

/**
 * Fact clause for the category sentence. Structured fields win; otherwise pass source.message
 * (no category-prefix strip, no noRead / lease / knowledge-root prose rewrite).
 */
export function callErrorFact(code: string, message: string, error?: ProtocolError): string {
  if (error !== undefined) {
    const structured = structuredCallErrorFact(error);
    if (structured !== null) return structured;
  }
  let fact = message.split('；')[0]!.trim();

  if (code === 'SOURCE_INTEGRITY_UNPROVEN') {
    if (/缺少经摘要核验的知识原件/.test(fact)) return '缺少经摘要核验的知识原件';
  }

  if (code === 'LEASE_EXPIRED') {
    return fact.replace(/对你不可用/g, '对当前账户不可用');
  }

  if (code === 'SHARE_DUPLICATE') return '公共空间里已有这一条目';
  if (code === 'MEMORY_CURSOR_STALE') return '游标已失效';
  if (code === 'EFFECT_CONTENT_UNVERIFIED') {
    return '这次运行还没有判断为正确的脚本合并结果，不能上机验证';
  }
  if (code === 'EFFECT_RELEASE_UNMET') {
    const named = /「([^」]+)」/.exec(message);
    if (named) return `上机验证要求的核对结果还缺「${named[1]}」`;
    return '上机验证要求的核对结果还缺一项';
  }
  if (code === 'TEAM_PARSER_REQUIRED') {
    return '所在团队还没有能解析这种格式的解析器';
  }
  if (code === 'SYNC_MODE_LOCAL') {
    return `Hub 上没有这个来源的内容，它的同步方式是「${SYNC_MODE_UI.local}」`;
  }
  // RUN_SUPERSEDED: fact comes from the throw site (must name the successor run); do not hard-code without the id (Boss 14:32).
  if (code === 'RUN_ABANDONED') {
    return '这次运行已放弃，不再接受提交';
  }
  if (code === 'SOURCE_PENDING_REVIEW' && !/评审/.test(fact)) {
    return '该观察仍在评审中、尚未生效';
  }

  return fact.replace(/对你不可用/g, '对当前账户不可用');
}

/** Strip a trailing 。 so the renderer can add exactly one. */
export function stripSentenceEnd(text: string): string {
  return text.replace(/[。．]\s*$/u, '').trim();
}

type NextRow = { member: string; admin: (message: string, leaseKey?: string) => string };

const PACK_NEXT: NextRow = {
  member: unassignedPackNext('workflow'),
  admin: (message) => {
    const name = packNameFromMessage(message) ?? '<工作流>';
    return `请执行 circle-hub pack assign <当前账户的名字> ${name} 为该账户分配，或在控制台「团队」页为所在团队分配`;
  },
};

const KNOWLEDGE_NEXT: NextRow = {
  member: '请联系管理员或条目的所有者分享读取权限，或改用当前账户能读的引用',
  admin: () =>
    `请执行 circle-hub share run <运行编号> --users <当前账户的名字> 分享读取权限，或改用当前账户能读的引用`,
};

const SYSTEM_NEXT: NextRow = {
  member: '请联系管理员为该账户或所在团队分配此业务系统',
  admin: () =>
    `请执行 circle-hub resource assign <业务系统> --team=<团队> 为所在团队分配，或在控制台「团队」页分配`,
};

const KNOWLEDGE_ROOT_NEXT: NextRow = {
  member: '请联系管理员为该账户分配绑定这条产品线的工作流；或改读这次运行锁定的构建的手册和命令树',
  admin: () =>
    `用 ${circleHubFromParameters('pack.assign')} 为该账户分配绑定这条产品线的工作流；或改读这次运行锁定的构建的手册和命令树`,
};

const GENERIC_NOT_PERMITTED_NEXT: NextRow = {
  member: '请联系管理员处理',
  admin: () => '请核对后重试',
};

/**
 * Next-step table: error code × admin|member. Knowledge-tree-root denial is a separate row
 * keyed off structured object_kind (or path clue), never message prose.
 */
const NEXT_BY_CODE: Record<string, NextRow> = {
  SOURCE_NOT_PERMITTED: PACK_NEXT,
  LEASE_UNAVAILABLE: {
    member: '请等待释放后重试，或改订其他测试环境',
    admin: (_message, leaseKey) => {
      const key = leaseKey !== undefined && leaseKey.length > 0 ? leaseKey : '<键>';
      return `请等待释放后重试，或改订其他测试环境；需要强制释放时执行 circle-hub lease release ${key} --reason <理由>，或在控制台「连接」页操作`;
    },
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

/**
 * Next-step clause for the category sentence (no leading「下一步」).
 * Table-driven; object kind comes from structured fields or path, never message prose.
 */
export function callErrorNext(
  code: string,
  role: PermissionRole,
  fix: string | undefined,
  message = '',
  callerName?: string,
  path?: string,
  error?: ProtocolError,
): string {
  let next: string;
  if (code === 'SOURCE_NOT_PERMITTED') {
    const kind = notPermittedKindOf(error?.object_kind, path ?? error?.path);
    const row =
      kind === 'root' ? KNOWLEDGE_ROOT_NEXT
        : kind === 'knowledge' ? KNOWLEDGE_NEXT
          : kind === 'system' ? SYSTEM_NEXT
            : kind === 'pack' ? PACK_NEXT
              : GENERIC_NOT_PERMITTED_NEXT;
    next = role === 'admin' ? row.admin(message) : row.member;
  } else {
    const row = NEXT_BY_CODE[code];
    if (row !== undefined) {
      next = role === 'admin' ? row.admin(message, error?.lease_key) : row.member;
    } else {
      const raw = fix === undefined ? '' : stripSentenceEnd(fix);
      if (role === 'admin') {
        next = raw.length > 0 ? raw : '核对后重试';
      } else if (raw.length === 0) {
        next = '请联系管理员处理';
      } else if (!/^请/.test(raw)) {
        next = `请${raw}`;
      } else {
        next = raw;
      }
    }
  }
  return role === 'admin' ? fillCallerAccountName(next, callerName) : next;
}

/** Full reader line when the code is a mapped call refusal; otherwise null. */
export function renderCallError(
  error: ProtocolError,
  role: PermissionRole,
  fix: string | undefined,
  callerName?: string,
): string | null {
  const structured = formatStructuredCallError(error, role);
  if (structured !== null) return structured;
  const category = callErrorCategoryOf(error.code);
  if (category === null) return null;
  const fact = callErrorFact(error.code, error.message, error);
  const next = callErrorNext(error.code, role, fix, error.message, callerName, error.path, error);
  return `${category}：${fact}。${next}。`;
}
