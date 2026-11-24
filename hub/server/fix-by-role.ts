import { PROTOCOL_CODES } from '../../contracts/generated/protocol.ts';
import type { PermissionRole } from '../../contracts/generated/vocabulary.ts';
import { COMMAND_METADATA } from './command-registry.ts';
import { COMMAND_PARAMETERS, commandParameterHelp, type CommandParameterId } from './command-parameters.ts';
import { connectionsPath, knowledgePath, settingsPath, teamPath } from './console/routes.ts';
import { packListHead, packListHeadForMember } from './pack-words.ts';

export type CallerRole = PermissionRole;

export function fillCallerAccountName(text: string, callerName: string | undefined): string {
  if (callerName === undefined || callerName.length === 0) return text;
  return text.replaceAll('<当前账户的名字>', callerName);
}

export function registeredCommandName(name: string): string {
  if (!COMMAND_METADATA.some((command) => command.name === name)) {
    throw new Error(`command not in COMMAND_METADATA: ${name}`);
  }
  return name;
}

export function circleHubFromParameters(id: CommandParameterId): string {
  const top = COMMAND_PARAMETERS[id].path[0];
  registeredCommandName(top);
  return `circle-hub ${commandParameterHelp(id)}`;
}

export function circleHubFromMetadata(name: string, options: { brief?: boolean } = {}): string {
  const meta = COMMAND_METADATA.find((command) => command.name === name);
  if (meta === undefined) throw new Error(`command not in COMMAND_METADATA: ${name}`);
  if (options.brief) return `circle-hub ${name}`;
  const summary = meta.summary.trim();
  return summary.length === 0 ? `circle-hub ${name}` : `circle-hub ${name} ${summary}`;
}

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
    case 'LEASE_UNAVAILABLE':
      return `请等待释放后重试，或改订其他测试环境；需要强制释放时执行 circle-hub lease release <键> --reason <理由>`;
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

export function fixByRole(code: string, role: CallerRole, memberFix?: string, callerName?: string): string | undefined {
  const member = memberDefault(code, memberFix);
  if (role !== 'admin') return member;
  const mapped = adminForCode(code);
  if (mapped !== undefined) {
    const filled = fillCallerAccountName(mapped, callerName);
    assertRegisteredNames(filled);
    return filled;
  }
  return member;
}

export function proseByRole(
  role: CallerRole,
  kind:
    | 'unassigned_packs'
    | 'context_unread'
    | 'contribution_unreadable'
    | 'content_unread'
    | 'missing_result_record'
    | 'fallback',
  detail?: { usable?: number; unassigned?: number; assigned?: number },
): string {
  if (role !== 'admin') {
    switch (kind) {
      case 'unassigned_packs':
        return packListHead(detail!.usable!, detail!.unassigned, detail!.assigned);
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
    case 'unassigned_packs': {
      const head = packListHeadForMember(detail!.usable!, detail!.unassigned!, detail!.assigned);
      return `${head}需要哪个时用 ${circleHubFromParameters('pack.assign')} 分配，或在控制台 ${teamPath()} 操作。`;
    }
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
