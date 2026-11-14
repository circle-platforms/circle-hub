// Administrator-owned environment preservation. Preview has no persistence side effects.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { canonicalBytes, isAdmin, isSha256, sha256Hex, AccessError, IntegrityError, RecordsError, EnvironmentUpgradeRequiredError, type EnvironmentUpgradePreview, type EnvironmentUpgradeReceipt, type Principal, type RecordsSchemaCompatibility } from '../records/api.ts';
import type { HubConfig } from '../config/index.ts';
import { CliError, UsageError } from './errors.ts';

export const UPGRADE_USAGE = 'upgrade preview [--owner-role <数据库拥有者>] [--json] | upgrade apply --preview <预检JSON文件> --expected-snapshot <摘要> [--owner-role <数据库拥有者>]';
export interface UpgradeCommandSession {
  ctx: { io: { cwd: string } };
  config(): HubConfig;
  operatorToken(): Promise<string | null>;
  out(line: string): void;
}
export interface UpgradeCommandPorts {
  /** Known-schema, read-only token verification; never Session.admin/openRecords or a first-admin fallback. */
  authenticate(config: HubConfig, authorization: string): Promise<Principal | null>;
  preview(config: HubConfig, actor: Principal): Promise<EnvironmentUpgradePreview>;
  apply(config: HubConfig, actor: Principal, preview: EnvironmentUpgradePreview, runtimeRole: string): Promise<EnvironmentUpgradeReceipt>;
  compatibility(config: HubConfig): Promise<RecordsSchemaCompatibility>;
  readPreview(file: string): Promise<unknown>;
}

export async function upgradeCommand(session: UpgradeCommandSession, args: readonly string[], ports: UpgradeCommandPorts): Promise<number> {
  const [action, ...rest] = args;
  if (action !== 'preview' && action !== 'apply') throw new UsageError(UPGRADE_USAGE);
  let parsed;
  try { parsed = parseArgs({ args: [...rest], allowPositionals: false, strict: true, options: { json: { type: 'boolean' }, 'owner-role': { type: 'string' }, preview: { type: 'string' }, 'expected-snapshot': { type: 'string' } } }); }
  catch { throw new UsageError(UPGRADE_USAGE); }
  const values = parsed.values;
  if (action === 'preview' && (values.preview !== undefined || values['expected-snapshot'] !== undefined) || action === 'apply' && (values.json !== undefined || !values.preview || !values['expected-snapshot'] || !isSha256(values['expected-snapshot']))) throw new UsageError(UPGRADE_USAGE);
  const config = session.config(), token = await session.operatorToken();
  if (token === null) throw new CliError('升级需要已有操作令牌对应的启用管理员；未读取或写入升级状态');
  let actor: Principal | null;
  try { actor = await ports.authenticate(config, `Bearer ${token}`); }
  catch (error) {
    if (error instanceof AccessError) throw new CliError('操作令牌无效或不属于当前启用的管理员；升级未执行');
    if (error instanceof IntegrityError) throw new CliError('迁移身份或摘要不能核对；保留现库并使用兼容发布，升级未执行');
    throw new CliError('无法只读核验操作令牌；检查连接、已知迁移身份及读取权限后重试，升级未执行');
  }
  if (!actor || !isAdmin(actor)) throw new CliError('操作令牌无效或不属于当前启用的管理员；升级未执行');
  const owner = values['owner-role'];
  const ownerConfig = owner === undefined ? config : { ...config, database: { ...config.database, user: owner } };
  if (action === 'preview') {
    const preview = await ports.preview(ownerConfig, actor);
    if (values.json) session.out(JSON.stringify(preview));
    else {
      session.out(`保权预检：${preview.alreadyCompleted ? '已完成，无需再次保权' : preview.canApply ? '可应用' : '未满足应用条件'}；计划授权 ${preview.payload?.plan.grants.length ?? 0} 条`);
      session.out(`预检快照摘要：${preview.sha256 ?? '无'}；最低安全级别：${preview.minimumReaderLevel}`);
      session.out(preview.downgradeNotice);
      if (preview.problems.length) session.out(`缺少可应用的保权事实 ${preview.problems.length} 项；请核对受权预检详情后重新预检`);
      if (preview.canApply && !preview.alreadyCompleted && preview.sha256 !== null) session.out('下一步：另执行 upgrade preview --json 并保存输出；upgrade apply --preview <预检JSON文件> --expected-snapshot <该JSON的sha256>；不要沿用之前预检的摘要，应用前不启用新守卫');
    }
    return preview.alreadyCompleted || preview.canApply ? 0 : 1;
  }
  let candidate: unknown;
  try { candidate = await ports.readPreview(resolve(session.ctx.io.cwd, values.preview!)); }
  catch { throw new UsageError('预检文件不可读取或不是严格JSON；请重新保存受权的只读预检'); }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) throw new UsageError('预检文件不合格式');
  const preview = candidate as EnvironmentUpgradePreview;
  let digest: string;
  try { digest = sha256Hex(canonicalBytes(preview.payload)); } catch { throw new UsageError('预检快照不是可核对的JSON'); }
  if (preview.sha256 !== values['expected-snapshot'] || digest !== values['expected-snapshot'] || preview.canApply !== true || preview.freshDatabase !== false || preview.payload === null) throw new CliError('预检快照摘要或可应用状态不匹配；未应用升级，请重新预检');
  let receipt: EnvironmentUpgradeReceipt;
  try { receipt = await ports.apply(ownerConfig, actor, preview, config.database.user); }
  catch (error) {
    if (error instanceof RecordsError || error instanceof EnvironmentUpgradeRequiredError) throw error;
    throw new CliError('升级事务结果尚未确认；不要假定未执行，也不要重新补授', '恢复连接后先执行 upgrade preview --json 核对完成回执；保留现库，不自动重试写入');
  }
  let compatibility: RecordsSchemaCompatibility | null;
  try { compatibility = await ports.compatibility(config); } catch { compatibility = null; }
  if (compatibility?.compatible !== true) throw new CliError('保权事务已有完成回执，但当前运行角色可读性尚未确认；保留现库，不重授、不重建', '检查兼容发布及运行角色读取权限后重新启动；不要使用 reset');
  session.out(`保权升级已完成；${receipt.alreadyCompleted ? '沿用已有完成回执' : `本次授权 ${receipt.grants} 条`}；当前运行角色可读性已核对`);
  session.out('下一步：重新启动本版本；启动须独立核验保权完成后才启用环境权限守卫');
  return 0;
}
