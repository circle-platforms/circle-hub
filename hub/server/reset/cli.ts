import { parseArgs } from 'node:util';
import type { PlatformIo } from '../../platform/api.ts';
import type { PlatformContext } from '../../platform/api.ts';
import { RESET_SCOPE, RESET_SCOPE_LABEL, RESET_ALL_LABEL, parseResetRequest, type ResetPorts, type ResetRequest } from './types.ts';
import { resetData, ResetBlocked } from './host.ts';
import { ResetFailure } from './operation.ts';
import { runResetWorker } from './worker.ts';

export function resetUsage(): string {
  return `用法：circle-hub reset --scope <${[...RESET_SCOPE, 'all'].join('|')}> [--scope <范围>] [--keep-config] [--definition src:<已授权对象摘要>]\n${RESET_SCOPE.map(scope => `${scope}：${RESET_SCOPE_LABEL[scope]}`).join('；')}；all：${RESET_ALL_LABEL}\n本机定义文件请使用独立的 circle-hub apply <文件>；reset 不接受任意服务器文件路径。`;
}
export function parseResetArguments(args: readonly string[]): { worker?: string; request?: ResetRequest; help?: boolean } {
  try {
    const parsed = parseArgs({ args: [...args], allowPositionals: false, strict: true, options: {
      scope: { type: 'string', multiple: true }, 'keep-config': { type: 'boolean' }, definition: { type: 'string' }, worker: { type: 'string' }, help: { type: 'boolean' },
    } });
    const value = parsed.values;
    if (value.worker !== undefined) {
      if (args.length !== 2 || args[0] !== '--worker' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.worker)) throw new Error();
      return { worker: value.worker };
    }
    if (value.help) return { help: true };
    if (!value.scope?.length || value.scope.includes('all') && value.scope.length !== 1) throw new Error();
    return { request: parseResetRequest({ scopes: value.scope.length === 1 && value.scope[0] === 'all' ? 'all' : value.scope, keepConfig: value['keep-config'] === true, ...(value.definition ? { definitionFile: value.definition } : {}) }) };
  } catch { throw new Error('reset 参数不合格式；范围必须明确，定义只接受已授权的src对象引用'); }
}

export async function resetCommand(args: readonly string[], context: PlatformContext, io: PlatformIo, ports: ResetPorts = {}): Promise<number> {
  let parsed: ReturnType<typeof parseResetArguments>;
  try { parsed = parseResetArguments(args); } catch { io.stderr(resetUsage()); return 2; }
  if (parsed.help) { io.stdout(resetUsage()); return 0; }
  if (parsed.worker) return runResetWorker(context, parsed.worker, request => resetData(context, request, ports));
  try {
    const report = await resetData(context, parsed.request!, ports);
    io.stdout(`重建已完成；原数据库归档：${report.archive}；已核对备份：${report.backup}`);
    for (const count of report.counts) io.stdout(`${RESET_SCOPE_LABEL[count.scope]}：保留 ${count.retained}；${count.cleared === null ? '未按业务形状分类，数量见归档表计数' : `清除 ${count.cleared}`}`);
    for (const table of report.archivedTables ?? []) io.stdout(`归档表 ${table.schema}.${table.table}：${table.rows} 行`);
    for (const notice of report.notices) io.stdout(`${notice.name ? notice.name + '：' : ''}${notice.reason}；下一步：${notice.nextAction}`);
    return 0;
  } catch (error) {
    if (error instanceof ResetBlocked) for (const problem of error.problems) io.stderr(`${problem.reason}；下一步：${problem.nextAction}`);
    else if (error instanceof ResetFailure) io.stderr(error.message);
    else io.stderr('重建未完成：执行条件未能核对；检查私有备份和恢复状态后重试，未输出原始异常');
    return 1;
  }
}
