import { isAdmin } from '../records/api.ts';
import { open, lstat, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createKnowledgeReader, formatKnowledgeRetract, formatReprojectReport, formatSeedReport, formatSyncReport, knowledgeReproject, knowledgeRetract, knowledgeSeed, knowledgeSync, parseKnowledgeReprojectArgs, parseKnowledgeSeedArgs, parseKnowledgeSyncArgs, type KnowledgeReprojectArgs, type KnowledgeSeedArgs, type KnowledgeSyncArgs } from '../knowledge/api.ts';
import type { ProductHandle, RunsService } from '../ports.ts';
import { isSha256, type Principal, type RecordStore } from '../records/api.ts';
import { messageOf } from './assemble/errors.ts';
import { type AssembledHub } from './assemble/hub.ts';
import { CliError, UsageError } from './errors.ts';
import { parse, decided } from './cli-arguments.ts';
import type { Session } from './cli-session.ts';
export const KNOWLEDGE_USAGE = 'knowledge sync --product <产品> [--line <版本线>] [--dry-run] [--recheck] [--include-unreleased] | seed --product <产品> --line <版本线> [--build <构建>] --basis <一句理由> [--dry-run] | reproject <产品> <版本线> | retract (--entry <记录摘要> | --run <运行> | --object <对象摘要>)… --reason <一行原因> | roots <产品> | diff <根A> <根B> | view <knowledge外部标识> [--only <取值列表>] [--as <管理员>] --out <文件>';
async function productOf(hub: AssembledHub, viewer: Principal, name: string): Promise<ProductHandle> {
  const product = (await hub.packs.productByName(name)) ?? (await hub.packs.productById(name));
  if (product === null || !(await hub.packs.readableProducts(viewer)).has(product.product.id)) {
    throw new CliError(`没有叫 ${name.slice(0, 80)} 的启用中的产品知识来源，或当前账户无权读取相关知识`, '用 circle-hub pack list 查看产品知识来源，用 pack activate 启用');
  }
  return product;
}

/** Own the newly created file before writing, so cleanup never removes a competing writer's file. */
export async function writeKnowledgeViewFile(target: string, bytes: Uint8Array, openTarget = async () => open(target, 'wx', 0o600)): Promise<Record<string, unknown>> {
  let file: Awaited<ReturnType<typeof openTarget>>;
  try { file = await openTarget(); }
  catch { throw new CliError('无法创建知识视图文件', '检查目录权限并换一个不存在的文件名后重试'); }
  try { await file.writeFile(bytes); await file.close(); }
  catch {
    await file.close().catch(() => {});
    const removed = await rm(target).then(() => true, () => false);
    throw new CliError('知识视图文件写入失败', removed ? '半截文件已删除；检查磁盘空间和目录权限后重试' : '检查并删除本次创建的半截文件，恢复磁盘空间和目录权限后重试');
  }
  try {
    const view: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (view === null || typeof view !== 'object' || Array.isArray(view)) throw new Error('not a view object');
    return view as Record<string, unknown>;
  } catch {
    const removed = await rm(target).then(() => true, () => false);
    throw new CliError('知识视图字节不是有效的 JSON 对象', removed ? '文件已删除；修复知识视图字节后重新导出' : '检查并删除本次创建的文件，修复知识视图字节后重新导出');
  }
}

const objectOf = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/**
 * `knowledge retract --run`: the contribution records a run stored, in receipt order, as its accepted validation results
 * list them (`contributions.stored`); a contribution record names no run. The run is read through the runs service, as
 * `run show` and `share run` read it. Every accepted result the run's detail names is read, not only the latest: a later
 * accepted submission's receipt lists only its own items, and an abandoned run's latest result is the management projection,
 * which has no receipt. Stored results are read as stored, so older result shapes still give their receipts. Null when the
 * run is absent; the retraction screen then refuses it.
 */
export async function runContributionEntries(runs: Pick<RunsService, 'getRun'>, store: Pick<RecordStore, 'get'>, by: Principal, run: string): Promise<string[] | null> {
  const detail = await runs.getRun(by, run);
  if (detail === null) return null;
  const results = new Map<string, unknown>();
  for (const submission of detail.submissions) if (submission.result !== null) results.set(submission.result, null);
  if (detail.latest !== null) results.set(detail.latest.record, detail.latest.result);
  const entries: string[] = [];
  for (const [digest, known] of results) {
    const stored = known === null ? await store.get(digest) : null;
    const result = objectOf(known ?? (stored?.kind === 'validation_result' ? stored.body : null));
    if (result === null || result.run !== run || result.acceptance !== 'accepted') continue;
    const rows = objectOf(result.contributions)?.stored;
    for (const row of Array.isArray(rows) ? rows : []) {
      const record = objectOf(row)?.record;
      if (typeof record === 'string' && isSha256(record) && !entries.includes(record)) entries.push(record);
    }
  }
  return entries;
}

export async function knowledgeCommand(session: Session, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'sync-worker') {
    const { positionals } = parse(rest, {}, 1);
    return (await import('./deployment-sync.ts')).runDeploymentSyncWorker(session.config(), positionals[0], session.ctx.io.env);
  }
  if (sub === 'sync-status') {
    const { positionals } = parse(rest, {}, 1);
    const status = await (await import('./deployment-sync.ts')).deploymentSyncStatus(session, positionals[0]);
    session.out(JSON.stringify(status));
    return status.error ? 1 : 0;
  }
  if (sub === 'view') {
    const { values, positionals } = parse(rest, { out: { type: 'string' }, only: { type: 'string' }, as: { type: 'string' } }, 1);
    if (!values.out) throw new UsageError('knowledge view 要用 --out 指定新文件');
    const viewer = await session.viewer(values.as, true).catch(error => {
      if (error instanceof CliError || error instanceof UsageError) throw error;
      throw new CliError('无法核对知识视图读取账号', '检查管理员身份及记录库连接后重试；原始异常不输出到终端');
    });
    if (!isAdmin(viewer)) throw new CliError('只有管理员能导出知识视图');
    const target = resolve(values.out);
    if (await lstat(target).then(() => true, () => false)) throw new CliError('输出文件已存在', '换一个新文件');
    let external = positionals[0];
    if (values.only !== undefined) {
      if (!values.only || /[&?#]/.test(values.only) || /[?&]only=/.test(external)) throw new UsageError('--only 要给非空取值列表，不能同时写在引用里；特殊字符按 URI 百分号编码');
      external += `${external.includes('?') ? '&' : '?'}only=${values.only.replaceAll(' ', '%20')}`;
    }
    const result = await (async () => {
      try {
        const hub = await session.hub(false, true);
        return await createKnowledgeReader(hub.knowledge).read(external, { principal: viewer, run: null, purpose: 'administrator view export' });
      } catch { throw new CliError('知识视图计算未完成', '检查装配、来源和视图计算后重试；原始异常不输出到终端'); }
    })();
    if (!result.ok) throw new CliError('未能读取指定知识视图', '核对产品、构建、权限和视图参数后重试；原始读取说明不输出到终端');
    const artifact = result.artifacts.find(a => a.name === 'original');
    const kit = await session.records();
    const bytes = artifact ? await kit.artifacts.trustedBytes(artifact.artifact.body.sha256).catch(() => { throw new CliError('知识视图字节读取失败', '修复原件存储后重新导出；原始异常不输出到终端'); }) : null;
    if (bytes === null) throw new CliError('知识视图字节缺失', '修复原件存储后重新导出');
    const view = await writeKnowledgeViewFile(target, bytes);
    const counts = (value: unknown): unknown => {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
      return Object.fromEntries(Object.entries(value).filter(([key]) => /^[a-z][a-z0-9_]*$/.test(key)).map(([key, entry]) => [key, counts(entry)]).filter(([, entry]) => entry !== undefined));
    };
    session.out(`已导出 ${artifact!.artifact.body.sha256}：${bytes.length} 字节，权限 0600`);
    session.out(`totals：${view.totals == null ? '未提供' : JSON.stringify(counts(view.totals))}；截断：${typeof view.truncated === 'boolean' ? (view.truncated ? '是' : '否') : '未提供'}；跳过：${typeof view.skipped === 'number' ? view.skipped : '未提供'}`);
    return 0;
  }
  if (sub === 'sync') {
    let parsed: KnowledgeSyncArgs;
    try {
      parsed = parseKnowledgeSyncArgs(rest);
    } catch (error) {
      throw new UsageError(messageOf(error));
    }
    const admin = await session.admin();
    const hub = await session.hub(true);
    const report = await decided(() => knowledgeSync(hub.knowledge, hub.packs, admin, parsed));
    for (const line of formatSyncReport(report).trimEnd().split('\n')) session.out(line);
    return report.error === null && report.counts.failed === 0 ? 0 : 1;
  }
  if (sub === 'seed') {
    let parsed: KnowledgeSeedArgs;
    try {
      parsed = parseKnowledgeSeedArgs(rest);
    } catch (error) {
      throw new UsageError(messageOf(error));
    }
    const admin = await session.admin();
    const hub = await session.hub(true);
    const report = await decided(() => knowledgeSeed(hub.knowledge, hub.packs, admin, parsed, hub.resources));
    for (const line of formatSeedReport(report).trimEnd().split('\n')) session.out(line);
    return report.ok ? 0 : 1;
  }
  if (sub === 'reproject') {
    // Re-projects a line's existing fed cases onto its current seedling root, as seed does before it moves the pointer.
    let parsed: KnowledgeReprojectArgs;
    try {
      parsed = parseKnowledgeReprojectArgs(rest);
    } catch (error) {
      throw new UsageError(messageOf(error));
    }
    const admin = await session.admin();
    const hub = await session.hub(true);
    const report = await decided(() => knowledgeReproject(hub.knowledge, hub.packs, admin, parsed));
    for (const line of formatReprojectReport(report).trimEnd().split('\n')) session.out(line);
    return report.ok ? 0 : 1;
  }
  if (sub === 'retract') {
    const { values } = parse(rest, { entry: { type: 'string', multiple: true }, run: { type: 'string', multiple: true }, object: { type: 'string', multiple: true }, reason: { type: 'string' } }, 0);
    const entries = values.entry ?? [];
    const runs = values.run ?? [];
    const objects = values.object ?? [];
    const reason = values.reason;
    if (reason === undefined || reason.trim() === '') throw new UsageError('knowledge retract 要用 --reason 给一行原因');
    if (reason.includes('\n') || reason.includes('\r')) throw new UsageError('knowledge retract 的 --reason 必须是一行');
    if (entries.length + runs.length + objects.length === 0) throw new UsageError('knowledge retract 至少要一个 --entry、--run 或 --object');
    if ([...entries, ...runs, ...objects].some(id => id.trim() === '')) throw new UsageError('knowledge retract 的目标不能为空');
    if ([...entries, ...objects].some(id => !isSha256(id))) throw new UsageError('knowledge retract 的 --entry 和 --object 是记录摘要（64 位十六进制）');
    const admin = await session.admin();
    const hub = await session.hub(true);
    const feeding = hub.knowledge.feeding;
    if (!feeding) throw new CliError('喂入层没有装上', '用当前 Hub 装配后重试');
    // A run's contributions join the entries of the same command, so the entry record lists them and the read side marks
    // each one; entries an earlier record already lists are skipped as covered, as any other target is.
    const included: Array<{ run: string; count: number }> = [];
    const targets = [...entries];
    for (const run of new Set(runs)) {
      const stored = await decided(() => runContributionEntries(hub.deps.runs, hub.records.store, admin, run));
      if (stored === null) continue;
      included.push({ run, count: stored.length });
      targets.push(...stored);
    }
    const report = await decided(() => knowledgeRetract(feeding, admin, { entries: targets, runs, objects, reason: reason.trim(), at: hub.knowledge.__context.now().toISOString() }));
    for (const row of included) session.out(`运行 ${row.run} 存下的回注条目 ${row.count} 个一并列为撤回目标`);
    for (const line of formatKnowledgeRetract(report)) session.out(line);
    return 0;
  }
  if (sub === 'roots') {
    const { values, positionals } = parse(rest, { as: { type: 'string' } }, 1);
    const viewer = await session.viewer(values.as);
    const hub = await session.hub();
    const product = await productOf(hub, viewer, positionals[0]);
    const id = product.product.id;
    const builds = await hub.knowledge.builds(id);
    const lines: string[] = [];
    for (const build of builds) if (!lines.includes(build.line)) lines.push(build.line);
    session.out(`产品线 ${id}（${product.product.names.join('、')}）：${builds.length} 个构建，${lines.length} 条版本线`);
    for (const line of lines) {
      const current = await hub.knowledge.currentRoot(id, line);
      session.out(`版本线 ${line}：${current === null ? '还没有当前根' : `当前根 ${current.root}（构建 ${current.build.name}，产出于 ${current.produced_at}）`}`);
      // Builds that have a root first, one line each; a line with many name-only builds stays readable: they
      // close the line as one count instead of one row per build.
      const ofLine = builds.filter((b) => b.line === line);
      const rooted = ofLine.filter((b) => b.root !== null || b.base !== b.name);
      const nameOnly = ofLine.filter((b) => b.root === null && b.base === b.name);
      for (const build of rooted) {
        session.out(
          [
            `  ${build.name}`,
            build.family,
            build.base === build.name ? '自身为基础构建' : `基于 ${build.base}`,
            build.released_at === null ? '未发布' : `发布于 ${build.released_at}`,
            build.root === null ? '还没有根' : `根 ${build.root}`,
          ].join('\t'),
        );
      }
      if (nameOnly.length > 0) session.out(`  另有 ${nameOnly.length} 个构建只有名字，还没有根`);
    }
    return 0;
  }
  if (sub === 'diff') {
    const { values, positionals } = parse(rest, { as: { type: 'string' } }, 2);
    const [from, to] = positionals;
    if (!isSha256(from) || !isSha256(to)) throw new UsageError('knowledge diff 的两个参数都是知识根的摘要（64 位十六进制）');
    const viewer = await session.viewer(values.as);
    const hub = await session.hub();
    const neutral = new CliError('没有这两个知识根，或者你不能读它们');
    if (!isAdmin(viewer)) {
      const readable = await hub.packs.readableProducts(viewer);
      for (const root of [from, to]) {
        const infos = await hub.knowledge.rootInfo(root);
        if (infos.length === 0 || !infos.some((info) => readable.has(info.product))) throw neutral;
      }
    }
    const diff = await hub.knowledge.diffRoots(from, to);
    if (diff === null) throw neutral;
    session.out(`从 ${diff.from} 到 ${diff.to}：增加 ${diff.added.length}，删除 ${diff.removed.length}，改动 ${diff.modified.length}`);
    for (const path of diff.added) session.out(`+ ${path}`);
    for (const path of diff.removed) session.out(`- ${path}`);
    for (const path of diff.modified) session.out(`~ ${path}`);
    return 0;
  }
  throw new UsageError(`knowledge 的子命令：${KNOWLEDGE_USAGE}`);
}

