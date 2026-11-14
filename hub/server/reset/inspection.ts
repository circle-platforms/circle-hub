import { diagnoseRecordsSchemaForMaintenance, type RecordsSchemaCompatibility } from '../../records/api.ts';
import { settingsOf, postgresFor, type PlatformContext } from '../../platform/api.ts';
import { RESET_DATA_SCOPE, parseResetRequest, type ResetInspection, type ResetPorts, type ResetProblem, type ResetRequest } from './types.ts';

export function resetInspection(diagnostic: RecordsSchemaCompatibility): ResetInspection {
  const available = diagnostic.status !== 'unavailable';
  const compatible = diagnostic.status === 'compatible';
  return {
    available, compatible, needsRebuild: diagnostic.status === 'incompatible', canKeepConfig: compatible,
    diagnostics: diagnostic.problems.map(reason => ({ reason, nextAction: available ? '归档并初始化后完成首次设置，再用定义文件恢复' : '先检查数据库进程、连接和读取权限后重试；当前不能重建' })),
    choices: !available ? [] : compatible ? [
      ...RESET_DATA_SCOPE.map(scope => ({ scopes: [scope], keepConfig: false, definitionAllowed: scope !== 'config' })),
      { scopes: 'all', keepConfig: false, definitionAllowed: false },
      { scopes: 'all', keepConfig: true, definitionAllowed: true },
    ] : [{ scopes: 'all', keepConfig: false, definitionAllowed: false }],
  };
}
export async function inspectReset(context: PlatformContext): Promise<ResetInspection> {
  await settingsOf(context);
  const postgres = postgresFor(context);
  return resetInspection(await diagnoseRecordsSchemaForMaintenance({ database: { host: postgres.target.socketDir, port: postgres.target.port, database: postgres.target.database, user: postgres.target.user } }, postgres.application.user));
}

/** Quote one literal path for POSIX shells; command substitutions remain inert inside single quotes. */
export function quoteResetDefinitionPath(path: string): string { return "'" + path.replaceAll("'", "'\"'\"'") + "'"; }
export function resetClearsAccounts(request: ResetRequest): boolean {
  return !request.keepConfig && (request.scopes === 'all' || request.scopes.includes('config'));
}
export function freshDefinitionNextAction(path: string): string {
  return ['circle-hub reset --scope all', 'circle-hub init-admin', 'circle-hub apply ' + quoteResetDefinitionPath(path)].join('\n');
}
/** All missing capabilities are checked before backup, stopping a service or archiving any database. */
export function resetRequestProblems(inspection: ResetInspection | undefined, input: ResetRequest, ports: ResetPorts = {}, definitionPath?: string): ResetProblem[] {
  const request = parseResetRequest(input), blocked: ResetProblem[] = [];
  if (request.definitionFile && resetClearsAccounts(request)) return [{ scope: 'config',
    reason: '这次重置会清掉全部账户，重置后没有管理员可以应用定义文件；现在未改变任何东西',
    nextAction: freshDefinitionNextAction(definitionPath ?? request.definitionFile) }];
  if (!inspection) return blocked;
  if (!inspection.available) blocked.push({ reason: '尚未确认数据库是否兼容，不能执行重建', nextAction: '检查连接和读取权限后重试；不要以连接错误为由初始化数据库' });
  if (inspection.needsRebuild && request.scopes !== 'all') blocked.push({ reason: '不兼容的库不能按当前范围读取或部分重建', nextAction: '选择全部归档并初始化，完成首次设置后再应用定义文件' });
  if (request.keepConfig && !inspection.compatible) blocked.push({ scope: 'config', reason: '当前库结构不能由本版本导出配置', nextAction: '归档并初始化后用定义文件恢复；程序不读取旧业务格式' });
  if (request.keepConfig && (!ports.exportConfiguration || !ports.restoreConfiguration)) blocked.push({ scope: 'config', reason: '受保护配置导出或恢复能力未装配，未开始重建', nextAction: '安装包含完整配置导出和恢复能力的版本后重试' });
  if (request.definitionFile && !ports.applyDefinition) blocked.push({ scope: 'config', reason: '定义文件恢复能力未装配，未开始重建', nextAction: '安装具备配置apply能力的版本后重试，或单独归档初始化后使用circle-hub apply' });
  return blocked;
}
