// Only the upgrade handler loads this directory. The ordinary server does not load the predecessor reader.
import type { PlatformContext } from '../context.ts';
import type { PlatformIo } from '../cli.ts';
import { upgradeDatabase } from './host.ts';

export async function upgradeCommand(context: PlatformContext, io: PlatformIo): Promise<number> {
  const report = await upgradeDatabase(context);
  if (report.status === 'noop') { io.stdout('数据库已是当前基线，无需升级'); return 0; }
  io.stdout(`升级已完成；原数据库归档：${report.archive}；已核对备份：${report.backup}`);
  for (const table of report.tables) io.stdout(`${table.table}：转入 ${table.migrated} 行，归档保留 ${table.archived} 行`);
  return 0;
}
