/**
 * D3: next-step (fix) wording by caller role. Contract PROTOCOL_CODES.*.fix stays the member line;
 * administrators get registry-backed commands / console paths — never an imperative「请管理员…」to self.
 */
import { PROTOCOL_CODES } from '../../contracts/generated/protocol.ts';
import { COMMAND_METADATA } from './command-registry.ts';
import { COMMAND_PARAMETERS, commandParameterHelp, type CommandParameterId } from './command-parameters.ts';
import { connectionsPath, knowledgePath, recordsPath, settingsPath, teamPath } from './console/routes.ts';

export type CallerRole = 'admin' | 'user';

const ASK_ADMIN = /请管理员|由管理员|联系管理员|请对象的主人或管理员|或请主人、管理员|并由管理员|或由管理员|请内容的主人分享，或请管理员|仍失败时由资源管理员|由资源管理员|或 Hub 管理员|或系统包负责人|或联系管理员/;

/** Top-level `circle-hub <name>` must appear in COMMAND_METADATA. */
export function registeredCommandName(name: string): string {
  if (!COMMAND_METADATA.some((command) => command.name === name)) {
    throw new Error(`command not in COMMAND_METADATA: ${name}`);
  }
  return name;
}

/** Usage line from the parameter registry; top-level name checked against COMMAND_METADATA. */
export function circleHubFromParameters(id: CommandParameterId): string {
  const top = COMMAND_PARAMETERS[id].path[0];
  registeredCommandName(top);
  return `circle-hub ${commandParameterHelp(id)}`;
}

/** Top-level command with its registered summary (platform / admin commands without parameter ids). */
export function circleHubFromMetadata(name: string, options: { brief?: boolean } = {}): string {
  const meta = COMMAND_METADATA.find((command) => command.name === name);
  if (meta === undefined) throw new Error(`command not in COMMAND_METADATA: ${name}`);
  if (options.brief) return `circle-hub ${name}`;
  const summary = meta.summary.trim();
  return summary.length === 0 ? `circle-hub ${name}` : `circle-hub ${name} ${summary}`;
}

/** Every `circle-hub <cmd>` top-level name mentioned in text must be registered. */
export function circleHubNamesIn(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/\bcircle-hub\s+([a-z][a-z0-9-]*)/g)) names.push(match[1]);
  return names;
}

function assertRegisteredNames(text: string): void {
  for (const name of circleHubNamesIn(text)) registeredCommandName(name);
}

function memberDefault(code: string, memberFix: string | undefined): string | undefined {
  if (memberFix !== undefined && memberFix.length > 0) return memberFix;
  const row = (PROTOCOL_CODES as Record<string, { fix?: string }>)[code];
  return row?.fix;
}

function adminForCode(code: string): string | undefined {
  switch (code) {
    case 'SOURCE_NOT_PERMITTED':
      return `用 ${circleHubFromParameters('pack.assign')} 为该账户或所在团队分配工作流或通用技能；或在控制台 ${teamPath()} 分配。分享读取权限用 ${circleHubFromMetadata('share', { brief: true })}（用法见该命令登记）；也可以换一个当前账户能读的引用`;
    case 'LEASE_UNAVAILABLE':
      return `有确定空闲时刻的可等候后重试；无期限预订可改用别的键，或用 ${circleHubFromParameters('lease.release')} 按既有带理由规则强制释放；也可在控制台 ${connectionsPath()} 处理。不补造到期时刻`;
    case 'SOURCE_INTEGRITY_UNPROVEN':
      return `用 ${circleHubFromMetadata('restore', { brief: true })} 从备份恢复原件，再用 ${circleHubFromMetadata('records', { brief: true })} 核验摘要，恢复后按原引用重读`;
    case 'SOURCE_UNAVAILABLE':
      return `核对引用；需要时请内容的主人分享，或按管理员记录恢复读取后按原引用重读；原因只记在管理员记录里。调用记录可用 ${circleHubFromMetadata('logs', { brief: true })}`;
    case 'IDENTITY_UNMAPPED':
      return `在控制台 ${teamPath()} 核对账户与外部身份对应后补齐映射`;
    case 'SOURCE_RETRYABLE':
      return `按给出的下次时刻重读同一来源；仍失败时在控制台 ${connectionsPath()} 核对资源并恢复读取`;
    case 'SOURCE_READ_FAILED':
      return `按所报确定故障，在控制台 ${connectionsPath()} 修复应答或修订，或用 ${circleHubFromMetadata('resource', { brief: true })} 调整接入后重读`;
    case 'SOURCE_READ_LIMIT':
      return `在控制台 ${connectionsPath()} 调整资源声明或缩小读取范围后重新完整读取`;
    case 'SOURCE_REDIRECT_REFUSED':
      return `在控制台 ${connectionsPath()} 核对来源给出的 Location 与路由声明，修复配置后按原对象重读`;
    case 'AUDIENCE_VISIBILITY_EXCEEDED':
      return `收窄受众，或在控制台 ${teamPath()} 补身份映射，并用 ${circleHubFromMetadata('share', { brief: true })} 覆盖确切内容的分享许可`;
    case 'SPACE_CAPACITY_EXCEEDED':
      return `在控制台 ${teamPath()} 调整容量后重试；撤回或停用内容不会释放版本记录占用`;
    case 'SPACE_INDEX_LIMIT':
      return `缩短或拆分单条内容；当前版本超限时撤回或替换条目，或在控制台 ${settingsPath()} 调整索引限额；历史引用仍保留`;
    case 'PACK_PERSONAL_CAPABILITY_DENIED':
      return `个人空间只使用上传、个人或团队知识及 Hub 生成的文件；需要其他能力时先发布到团队，再用 ${circleHubFromParameters('pack.assign')} 分配`;
    case 'MEMORY_DOCUMENT_LIMIT':
      return `缩短正文，或在控制台 ${settingsPath()} 调整单篇限额`;
    case 'MEMORY_SPACE_LIMIT':
      return `停用旧记忆、缩短标题目录正文，或在控制台 ${settingsPath()} 调整空间字节与篇数限额`;
    case 'MEMORY_TEAM_DISABLED':
      return `在控制台 ${knowledgePath()} 核对并重新启用原团队记忆后，再提交共享`;
    default:
      return undefined;
  }
}

/** Rewrite a member-oriented fix that still says「请管理员…」when the caller is an administrator. */
function rewriteAskAdmin(fix: string): string {
  return fix
    .replaceAll('请对象的主人或管理员分享读取权限，工作流和通用技能请管理员分配', '由对象的主人分享读取权限，或你分配工作流和通用技能')
    .replaceAll('或请主人、管理员按既有带理由释放规则处理', '或你按既有带理由释放规则处理')
    .replaceAll('请内容的主人分享，或请管理员按管理员记录恢复读取', '请内容的主人分享，或你按管理员记录恢复读取')
    .replaceAll('仍失败时由资源管理员恢复读取', '仍失败时由你恢复读取')
    .replaceAll('由资源管理员调整声明或缩小读取范围', '由你调整声明或缩小读取范围')
    .replaceAll('由资源管理员核对来源给出的 Location 与路由声明', '由你核对来源给出的 Location 与路由声明')
    .replaceAll('由资源管理员修复应答／修订、系统包负责人修复规划／投影或 Hub 管理员恢复存储', '由你修复应答／修订、规划／投影或恢复存储')
    .replaceAll('或由管理员补身份映射与覆盖确切内容的分享许可', '或你补身份映射与覆盖确切内容的分享许可')
    .replaceAll('或由管理员调整单篇限额', '或你调整单篇限额')
    .replaceAll('或请管理员调整空间字节与篇数限额', '或你调整空间字节与篇数限额')
    .replaceAll('或联系管理员调整索引限额', '或你调整索引限额')
    .replaceAll('并由管理员分配', '并由你分配')
    .replaceAll('由管理员补身份映射', '由你补身份映射')
    .replaceAll('由管理员核对并重新启用原团队记忆后', '由你核对并重新启用原团队记忆后')
    .replaceAll('请管理员调整容量后重试', '由你调整容量后重试')
    .replaceAll('请管理员从备份恢复原件并重验摘要，恢复后按原引用重读', '由你从备份恢复原件并重验摘要，恢复后按原引用重读')
    .replaceAll('请管理员把它分配给你', '由你把它分配给该成员')
    .replaceAll('请管理员给你分配', '由你分配')
    .replaceAll('需要哪个请管理员分配', '需要哪个由你分配')
    .replaceAll('请管理员分配', '由你分配')
    .replaceAll('请管理员核对读取权限', '由你核对读取权限')
    .replaceAll('请管理员核对保存的结果后重新读取', '由你核对保存的结果后重新读取')
    .replaceAll('或请管理员检查', '或由你检查')
    .replaceAll('请联系管理员', '由你处理')
    .replaceAll('请管理员', '由你');
}

/**
 * Fix string for this caller. Member (default): contract / provided fix. Admin: registry-backed next steps;
 * never imperative「请管理员…」pointing at self.
 */
export function fixByRole(code: string, role: CallerRole, memberFix?: string): string | undefined {
  const member = memberDefault(code, memberFix);
  if (role !== 'admin') return member;
  const mapped = adminForCode(code);
  if (mapped !== undefined) {
    assertRegisteredNames(mapped);
    return mapped;
  }
  if (member === undefined) return undefined;
  if (!ASK_ADMIN.test(member)) return member;
  const rewritten = rewriteAskAdmin(member);
  assertRegisteredNames(rewritten);
  return rewritten;
}

/** Hardcoded reader lines in text.ts that still say「请管理员…」when the caller is a member. */
export function proseByRole(
  role: CallerRole,
  kind:
    | 'unassigned_packs'
    | 'context_unread'
    | 'contribution_unreadable'
    | 'content_unread'
    | 'missing_result_record'
    | 'fallback',
  detail?: { usable?: number; unassigned?: number },
): string {
  if (role !== 'admin') {
    switch (kind) {
      case 'unassigned_packs':
        return `你能用的 ${detail!.usable} 个；Hub 上另有 ${detail!.unassigned} 个没有分配给你（名字不列出），需要哪个请管理员分配。`;
      case 'context_unread':
        return '测试环境的资料尚未读出；状态未知；原因缺资料；下一步由使用者请管理员核对读取权限。';
      case 'contribution_unreadable':
        return '原文不可读取；状态未知；原因缺资料；下一步由使用者请管理员核对读取权限。';
      case 'content_unread':
        return '原文尚未读出；状态未知；原因缺资料；下一步由使用者请管理员核对读取权限。';
      case 'missing_result_record':
        return '由使用者请管理员核对保存的结果后重新读取';
      case 'fallback':
        return '答复正文未能显示；状态未知；原因临时故障；下一步由使用者查看机器可读答复，或请管理员检查。';
    }
  }
  switch (kind) {
    case 'unassigned_packs':
      return `该成员能用的 ${detail!.usable} 个；Hub 上另有 ${detail!.unassigned} 个没有分配给该成员（名字不列出）。需要哪个时用 ${circleHubFromParameters('pack.assign')} 分配，或在控制台 ${teamPath()} 操作。`;
    case 'context_unread':
      return `测试环境的资料尚未读出；状态未知；原因缺资料；下一步由你在控制台 ${connectionsPath()} 核对读取权限。`;
    case 'contribution_unreadable':
      return `原文不可读取；状态未知；原因缺资料；下一步由你核对读取权限；需要分配时用 ${circleHubFromParameters('pack.assign')}。`;
    case 'content_unread':
      return `原文尚未读出；状态未知；原因缺资料；下一步由你核对读取权限。`;
    case 'missing_result_record':
      return `由你核对保存的结果后重新读取；调用记录可用 ${circleHubFromMetadata('logs', { brief: true })}`;
    case 'fallback':
      return `答复正文未能显示；状态未知；原因临时故障；下一步由使用者查看机器可读答复，或由你用 ${circleHubFromMetadata('logs', { brief: true })} 检查。`;
  }
}
