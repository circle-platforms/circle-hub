import { registrationIncompletePresentation } from './env-bootstrap-capture.ts';
/**
 * D3 fact/next for call errors (Boss 13:05 / 14:12). Category words come from
 * error-reasons.callErrorCategoryOf. Next steps are table-driven by code × role × object kind.
 * Object words come from pack-words / source messages.
 */
import type { ProtocolError } from '../../contracts/src/common.ts';
import { SYNC_MODE_UI, type PermissionRole } from '../../contracts/generated/vocabulary.ts';
import { callErrorCategoryOf, type CallErrorCategory } from './error-reasons.ts';
import { circleHubFromMetadata, circleHubFromParameters, fillCallerAccountName } from './fix-by-role.ts';

export { fillCallerAccountName } from './fix-by-role.ts';
import { connectionsPath, knowledgePath, settingsPath, teamPath } from './console/routes.ts';
import { unassignedPackNext } from './pack-words.ts';

export { callErrorCategoryOf as callErrorCategory } from './error-reasons.ts';
export type { CallErrorCategory };
export { packObjectWord, unassignedPackFact, unassignedPackNext } from './pack-words.ts';

/** Closed five (hub-terms); mirrored here for tests that assert the set without importing D1 internals. */
export const CALL_ERROR_CATEGORIES = ['参数无效', '无权限', '不存在', '已被占用', '暂时不可用'] as const satisfies readonly CallErrorCategory[];

/** Knowledge-tree-root unauthorised: keep「绑定产品线」semantics (contributions / ROOT_FORBIDDEN). */
export function isKnowledgeRootDenial(message: string, fix: string | undefined): boolean {
  return /知识树根/.test(message) || /手册和命令树/.test(message) || /绑定这条产品线/.test(fix ?? '') || /绑定这条产品线/.test(message);
}

/** Object kind for SOURCE_NOT_PERMITTED next-step selection (Boss 16:34: structured clues only). */
export type NotPermittedKind = 'pack' | 'knowledge' | 'system' | 'root';

/**
 * Prefer path / registered fix clues over prose. Default `pack` when no clue — see
 * briefs/whitepaper-1113/requests-to-codex.md §16:34 for misclassification cases.
 */
export function notPermittedKindOf(message: string, fix: string | undefined, path?: string): NotPermittedKind {
  if (isKnowledgeRootDenial(message, fix)) return 'root';
  if (path === '/pack' || (typeof path === 'string' && path.startsWith('/pack'))) return 'pack';
  const fixText = fix ?? '';
  if (/分享读取权限/.test(fixText) || /\bshare\b/i.test(fixText)) return 'knowledge';
  if (/resource assign/.test(fixText) || /为所在团队分配此业务系统|分配此业务系统/.test(fixText)) return 'system';
  // Temporary path clues for knowledge reads (no prose match on 未获授权使用 / 存在，没有分配给).
  if (path === '/run' || path === '/reference' || (typeof path === 'string' && path.startsWith('/inputs'))) return 'knowledge';
  return 'pack';
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

/** Test-environment display name from a lease key; unregistered keys use the key itself (Boss 14:12). */
export function environmentNameFromLeaseKey(key: string): string {
  const bed = /^bed\/([^/]+)\//.exec(key);
  if (bed) return bed[1]!;
  return key;
}

/**
 * Fact for LEASE_UNAVAILABLE: which environment, who holds it, since when.
 * Parses engine messages that append（持有运行 …，取得于 …）.
 */
export function leaseUnavailableFact(message: string): string {
  const keyMatch = /键\s+(\S+)\s+上有/.exec(message) ?? /lease release\s+(\S+)/.exec(message);
  const key = keyMatch?.[1];
  const name = key !== undefined ? environmentNameFromLeaseKey(key) : /租约键/.test(message) ? '该键' : '该键';
  const sinceMatch = /取得于\s+(\S+)/.exec(message);
  const since = sinceMatch ? localClockOf(sinceMatch[1]!.replace(/[，,).].*$/, '')) : null;
  const sinceClause = since !== null ? `（自 ${since} 起）` : '';
  const own = /是你自己的运行|当前账户的另一次运行/.test(message);
  if (own) {
    return `测试环境「${name}」正由当前账户的另一次运行占用${sinceClause}`;
  }
  const named = /正由「([^」]+)」占用/.exec(message) ?? /持有者「([^」]+)」/.exec(message);
  if (named) return `测试环境「${name}」正由「${named[1]}」占用${sinceClause}`;
  if (/正被占用|已被预订|已占用|未到期的占用|由别的运行持有/.test(message)) {
    return `测试环境「${name}」正由「其他成员」占用${sinceClause}`;
  }
  return `测试环境「${name}」正由「其他成员」占用${sinceClause}`;
}

function leaseKeyFromMessage(message: string): string {
  const keyMatch = /键\s+(\S+)\s+上有/.exec(message);
  if (keyMatch) return keyMatch[1]!;
  return '<键>';
}

/**
 * Fact clause for the category sentence: no category prefix, no 任务包, no 「你」 as subject.
 * Prefers source messages that already use owner wording; only normalises prior shapes.
 */
export function callErrorFact(code: string, message: string): string {
  let fact = message.split('；')[0]!.trim();
  fact = fact.replace(/^无权限：|^已被占用：|^暂时不可用：|^参数无效：|^不存在：/, '');

  if (code === 'SOURCE_NOT_PERMITTED' && isKnowledgeRootDenial(message, undefined)) {
    return '当前账户未获授权读取这条产品线的手册和命令树';
  }

  if (/^当前账户未获授权使用/.test(fact)) return fact;

  const noRead = /^(.+?)存在，你没有读取权限(?::|：)?(.*)$/.exec(fact);
  if (noRead) {
    const object = noRead[1]!.trimEnd();
    return `当前账户未获授权读取「${object}」`;
  }
  if (/^当前账户未获授权读取/.test(fact) && !/「/.test(fact)) {
    const rest = fact.slice('当前账户未获授权读取'.length).replace(/（.*$/, '').trim();
    return `当前账户未获授权读取「${rest}」`;
  }

  if (code === 'SOURCE_INTEGRITY_UNPROVEN') {
    if (/缺少经摘要核验的知识原件/.test(fact)) return '缺少经摘要核验的知识原件';
  }

  if (code === 'LEASE_UNAVAILABLE') {
    return leaseUnavailableFact(message);
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

type NextRow = { member: string; admin: (message: string) => string };

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

/**
 * Next-step table: error code × admin|member. Knowledge-tree-root denial is a separate row
 * keyed off the message/fix, not a keyword rewrite of「分配」.
 */
const NEXT_BY_CODE: Record<string, NextRow> = {
  SOURCE_NOT_PERMITTED: PACK_NEXT,
  LEASE_UNAVAILABLE: {
    member: '请等待释放后重试，或改订其他测试环境',
    admin: (message) => {
      const key = leaseKeyFromMessage(message);
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
 * Table-driven; knowledge-tree-root / knowledge-read / system denial are dedicated rows.
 */
export function callErrorNext(
  code: string,
  role: PermissionRole,
  fix: string | undefined,
  message = '',
  callerName?: string,
  path?: string,
): string {
  let next: string;
  if (code === 'SOURCE_NOT_PERMITTED') {
    const kind = notPermittedKindOf(message, fix, path);
    const row =
      kind === 'root' ? KNOWLEDGE_ROOT_NEXT : kind === 'knowledge' ? KNOWLEDGE_NEXT : kind === 'system' ? SYSTEM_NEXT : PACK_NEXT;
    next = role === 'admin' ? row.admin(message) : row.member;
  } else {
    const row = NEXT_BY_CODE[code];
    if (row !== undefined) {
      next = role === 'admin' ? row.admin(message) : row.member;
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
  const incomplete = registrationIncompletePresentation(error, role);
  if (incomplete) return `${incomplete.category}：${incomplete.fact}。${incomplete.next}。`;
  const category = callErrorCategoryOf(error.code);
  if (category === null) return null;
  const fact = callErrorFact(error.code, error.message);
  const next = callErrorNext(error.code, role, fix, error.message, callerName, error.path);
  return `${category}：${fact}。${next}。`;
}
