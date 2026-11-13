import { teamId } from './cli-team.ts';
import { isAdmin } from '../records/api.ts';
import { uiLabelOf } from '../../contracts/generated/vocabulary.ts';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { labelOf } from '../../contracts/generated/vocabulary.ts';
import { packChanges, unruledShapes, parsePackRef, type PackProblem, type PublishCheck, type PublishReport } from '../runs/api.ts';
import { CliError, UsageError } from './errors.ts';
import { parse, decided } from './cli-arguments.ts';
import type { Session } from './cli-session.ts';
export const PACK_USAGE =
  'pack install <通用技能@版本> | uninstall <通用技能> | publish <目录> [--stage] [--dry-run] [--answer-request <请求摘要> ...] | grant-publish <用户> | revoke-publish <用户> | assign <用户> <工作流> | assign <工作流> --team=<团队ID> | unassign <用户> <工作流> | unassign <工作流> --team=<团队ID> | retire <发布版本> | activate <产品知识来源> | deactivate <产品知识来源> | list | shapes <工作流>';
function problemLine(problem: PackProblem): string {
  const where = [problem.file, problem.field ?? (problem.line === undefined ? '' : `第 ${problem.line} 行`)].filter((part) => part !== '').join(' ');
  return `- [${problem.rule}] ${where}：${problem.message}（处理：${problem.fix}）`;
}

/** At most this many changed files are named one by one in a check's comparison with the version in use. */
const MAX_CHANGE_LINES = 50;

/** A passed check's comparison with the version in use: the versions, then each file added, modified or removed. */
function changeLines(checked: PublishCheck & { ok: true }): string[] {
  const current = checked.current;
  if (current === null) return [`包 ${checked.manifest.id} 还没有已发布的版本，没有可比较的当前版本`];
  const from = `${current.id}@${current.version}`;
  if (current.digest === checked.digest) return [`与当前版本 ${from} 内容相同`];
  const changes = packChanges(current.manifest, checked.manifest);
  const count = (change: string): number => changes.filter((c) => c.change === change).length;
  const lines = [`当前版本 ${from}，本次 ${checked.manifest.id}@${checked.manifest.version}：${labelOf('change_kind', 'added')} ${count('added')} 个文件，${labelOf('change_kind', 'modified')} ${count('modified')} 个，${labelOf('change_kind', 'removed')} ${count('removed')} 个`];
  for (const change of changes.slice(0, MAX_CHANGE_LINES)) lines.push(`  ${labelOf('change_kind', change.change)} ${change.path}`);
  if (changes.length > MAX_CHANGE_LINES) lines.push(`  另有 ${changes.length - MAX_CHANGE_LINES} 个文件有变化`);
  return lines;
}

/**
 * A temporary directory holding pack.json and the files it lists, copied from `source` (which may hold more: tests, a README).
 * A listed path must be a plain file inside `source`; the publish check still verifies every digest and refuses anything
 * the copy lacks. Returns the directory to publish; its parent is the one to remove.
 */
async function stagePackDirectory(source: string): Promise<string> {
  let manifest: { files?: Array<{ path?: unknown }> };
  try {
    manifest = JSON.parse(await readFile(join(source, 'pack.json'), 'utf8'));
  } catch {
    throw new CliError(`读不出 ${source} 里的 pack.json`, '目录要含 pack.json，它列出包的文件');
  }
  if (!Array.isArray(manifest.files)) throw new CliError('pack.json 没有 files 清单', '先按包的工具生成 pack.json');
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-stage-'));
  const target = join(root, 'pack');
  try {
    await mkdir(target);
    for (const path of ['pack.json', ...manifest.files.map((f) => f.path)]) {
      if (typeof path !== 'string' || path.startsWith('/') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
        throw new CliError(`pack.json 里有不合法的文件路径：${String(path).slice(0, 120)}`);
      }
      const from = join(source, path);
      const info = await lstat(from).catch(() => null);
      if (info === null || !info.isFile()) throw new CliError(`pack.json 列出的 ${path} 不是目录里的普通文件`, '补上这个文件，或重新生成 pack.json');
      await mkdir(dirname(join(target, path)), { recursive: true });
      await copyFile(from, join(target, path));
    }
    return target;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export function packIdOf(ref: string, what: string): string {
  const parsed = parsePackRef(ref);
  if (parsed === null || parsed.version !== null) throw new UsageError(`${what}按包号写，不带版本：${ref.slice(0, 120)}`);
  return parsed.id;
}

export async function packCommand(session: Session, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'install': {
      const {positionals}=parse(rest,{},1);const by=await session.admin();const hub=await session.hub();
      const decision=await decided(()=>hub.registry.install(by,positionals[0]));
      session.out(`通用技能已安装；决定 ${decision.digest}`);return 0;
    }
    case 'uninstall': {
      const {positionals}=parse(rest,{},1);const by=await session.admin();const hub=await session.hub();
      const decision=await decided(()=>hub.registry.uninstall(by,positionals[0]));
      session.out(`通用技能已卸载；旧运行仍按冻结摘要复核；决定 ${decision.digest}`);return 0;
    }
    case 'shapes': {
      const {positionals,values}=parse(rest,{as:{type:'string'}},1);
      const viewer=await session.viewer(values.as);
      const pack=packIdOf(positionals[0],'查看判定形状');
      const hub=await session.hub();
      const shapes=await unruledShapes(hub.records.store,viewer,pack);
      if(!shapes.length)session.out('没有未裁定的形状');
      for(const shape of shapes)session.out(`${shape.requirement}\t${shape.interpreter}\t${shape.count}\t${shape.latest_run}`);
      return 0;
    }
    case 'publish': {
      const { positionals, values } = parse(rest, { stage: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, 'answer-request':{type:'string',multiple:true} }, 1);
      const source = isAbsolute(positionals[0]) ? positionals[0] : resolve(session.ctx.io.cwd, positionals[0]);
      const admin = await session.admin();
      const hub = await session.hub();
      const refused = (outcome: { problems: PackProblem[]; report: PublishReport | null }, what: string): never => {
        for (const problem of outcome.problems) session.err(problemLine(problem));
        for (const problem of outcome.report?.warnings ?? []) session.err(`注意：${problemLine(problem).slice(2)}`);
        const fix = outcome.problems.some((p) => p.rule === 'publish.no_right') ? `管理员先授予发布权：circle-hub pack grant-publish ${admin.name}` : '按上面每条问题的处理改好后重新发布';
        throw new CliError(`${what}：${outcome.problems.length} 个问题`, fix);
      };
      // --stage publishes a copy of exactly the files pack.json lists, so a source directory may hold tests and a README.
      const staged = values.stage === true ? await stagePackDirectory(source) : null;
      const options = { answerRequests: values['answer-request'] ?? [] };
      if (values['dry-run'] === true) {
        // Every check and refusal of publish, nothing stored: what the console's 发布任务包 shows before its 发布 step.
        let checked;
        try {
          checked = await decided(() => hub.registry.check(admin, staged ?? source, options));
        } finally {
          if (staged !== null) await rm(dirname(staged), { recursive: true, force: true });
        }
        if (!checked.ok) return refused(checked, '发布内容未通过发布校验');
        const ref = `${checked.manifest.id}@${checked.manifest.version}`;
        const samples = checked.report.samples;
        session.out(
          checked.existing === null
            ? `发布校验通过：${ref}（${uiLabelOf('pack_kind', checked.manifest.kind)}，摘要 ${checked.digest}）：样例 ${samples.passed}/${samples.total} 通过`
            : `${ref} 已经以同样的内容发布过（摘要 ${checked.digest}），发布不会产生新的记录`,
        );
        for (const line of changeLines(checked)) session.out(line);
        for (const warning of checked.report.warnings) session.err(`注意：${problemLine(warning).slice(2)}`);
        session.out(checked.existing === null ? '试运行：没有发布，也没有写入任何内容；去掉 --dry-run 即发布这个版本' : '试运行：没有写入任何内容');
        return 0;
      }
      let outcome;
      try {
        outcome = await decided(() => hub.registry.publish(admin, staged ?? source, options));
      } finally {
        if (staged !== null) await rm(dirname(staged), { recursive: true, force: true });
      }
      if (!outcome.ok) return refused(outcome, '发布内容没有发布');
      const version = outcome.version;
      const ref = `${version.id}@${version.version}`;
      const samples = outcome.report.samples;
      session.out(
        outcome.created
          ? `已发布 ${ref}（${uiLabelOf('pack_kind', version.kind)}，摘要 ${version.digest}）：样例 ${samples.passed}/${samples.total} 通过`
          : `${ref} 已经以同样的内容发布过（摘要 ${version.digest}），包版本没有新的记录`,
      );
      if(values['answer-request']?.length)session.out(`请求作答：发布记录 rec:${version.record} 对应 ${new Set(values['answer-request']).size} 个指定请求（重复作答不增写）`);
      for (const warning of outcome.report.warnings) session.err(`注意：${problemLine(warning).slice(2)}`);
      if (version.kind === 'product' && !(await hub.registry.isActive(version.id))) session.out(`产品知识来源启用后才生效：circle-hub pack activate ${version.id}`);
      if (version.kind === 'workflow') session.out(`工作流分配给用户后才能用：circle-hub pack assign <用户> ${version.id}`);
      if (version.kind === 'system') session.out(`业务系统接入实例化为资源后才读取：circle-hub resource add ${version.id} --name <名字> --environment <环境> --origin <角色>=<地址>`);
      return 0;
    }
    case 'grant-publish':
    case 'revoke-publish': {
      const { positionals } = parse(rest, {}, 1);
      const admin = await session.admin();
      const user = await session.user(positionals[0]);
      const kit = await session.records();
      if (sub === 'grant-publish') await decided(() => kit.authorizations.grantPublishRight(admin, user.id));
      else await decided(() => kit.authorizations.revokePublishRight(admin, user.id));
      session.out(`${user.deleted_at?uiLabelOf('account_display_name','deleted_member'):user.name}（${user.id}）${sub === 'grant-publish' ? '有了发布权' : '的发布权已撤销'}`);
      return 0;
    }
    case 'assign':
    case 'unassign': {
      const { positionals, values } = parse(rest, { team: { type: 'string' }, note: { type: 'string' } }, 1, 2);
      if (values.team !== undefined) {
        if (positionals.length !== 1) throw new UsageError('团队分配只给一个包ID，不能同时指定个人');
        const team = teamId(values.team), pack = packIdOf(positionals[0], '分配');
        const by = await session.admin(), hub = await session.hub();
        if (sub === 'assign') await decided(() => hub.registry.assignTeam(by, team, pack, { note: values.note }));
        else await decided(() => hub.registry.unassignTeam(by, team, pack, values.note));
        session.out(sub === 'assign' ? `已把 ${pack} 分配给团队 ${team}` : `已撤回团队 ${team} 的 ${pack} 分配`);
        return 0;
      }
      if (positionals.length !== 2) throw new UsageError('个人分配须给出账户和工作流；团队分配使用 --team=<团队ID>');
      const packId = packIdOf(positionals[1], '分配');
      const admin = await session.admin();
      const user = await session.user(positionals[0]);
      const hub = await session.hub();
      if (sub === 'assign') await decided(() => hub.registry.assign(admin, user.id, packId, { note: values.note }));
      else await decided(() => hub.registry.unassign(admin, user.id, packId, values.note));
      const name=user.deleted_at?uiLabelOf('account_display_name','deleted_member'):user.name;
      session.out(sub === 'assign' ? `已把 ${packId} 分配给 ${name}（${user.id}）` : `${name}（${user.id}）不再能用 ${packId}`);
      return 0;
    }
    case 'retire': {
      const { positionals } = parse(rest, {}, 1);
      const ref = parsePackRef(positionals[0]);
      if (ref === null || ref.version === null) throw new UsageError(`退役要写 <包号>@<版本>：${positionals[0].slice(0, 120)}`);
      const admin = await session.admin();
      const hub = await session.hub();
      await decided(() => hub.registry.retire(admin, ref.id, ref.version as string));
      hub.connectors.refresh();
      session.out(`${ref.id}@${ref.version} 已退役：新的运行不再用它，已有的运行照常读取和完成`);
      return 0;
    }
    case 'activate':
    case 'deactivate': {
      const { positionals } = parse(rest, {}, 1);
      const packId = packIdOf(positionals[0], sub === 'activate' ? '启用' : '停用');
      const admin = await session.admin();
      const hub = await session.hub();
      if (sub === 'activate') await decided(() => hub.registry.activate(admin, packId));
      else await decided(() => hub.registry.deactivate(admin, packId));
      session.out(sub === 'activate' ? `产品知识来源 ${packId} 已对整个 Hub 启用` : `产品知识来源 ${packId} 已停用`);
      return 0;
    }
    case 'list': {
      const { values } = parse(rest, { as: { type: 'string' } }, 0);
      const viewer = await session.viewer(values.as);
      const hub = await session.hub();
      const listings = await hub.catalog.list(viewer);
      if (listings.length === 0) {
        session.out(isAdmin(viewer) ? '还没有发布任何内容' : '当前账户没有可用的工作流');
        return 0;
      }
      const names = await session.names();
      for (const pack of listings) {
        const state = uiLabelOf('pack_status', pack.withdrawn ? 'retired' : pack.kind === 'product' ? (pack.active ? 'enabled' : 'inactive') : 'published');
        const fields = [`${pack.id}@${pack.version}`, uiLabelOf('pack_kind', pack.kind), pack.title, state];
        if (isAdmin(viewer)) {
          fields.push(`所有者 ${names.get(pack.owner) ?? pack.owner}`, pack.published_at);
          if (pack.kind === 'workflow') fields.push(`分配给 ${(pack.assigned_to ?? []).map((id) => names.get(id) ?? id).join('、') || '无'}`);
        }
        session.out(fields.join('\t'));
      }
      return 0;
    }
    default:
      throw new UsageError(`pack 的子命令：${PACK_USAGE}`);
  }
}

