import { teamId } from './cli-team.ts';
import { isAdmin } from '../records/api.ts';
import {referencesIn} from '../../contracts/src/variables.ts';
import { join } from 'node:path';
import { ENVIRONMENT, isEnvironment, labelOf, type Environment } from '../../contracts/generated/vocabulary.ts';
import { type AddResourceInput, type LoginStatus, type UpdateResourceInput } from '../connectors/api.ts';
import { WHOLE_HUB, parseStrictJson } from '../records/api.ts';
import { messageOf } from './assemble/errors.ts';
import { vaultKeyProblem } from './assemble/vault.ts';
import { CliError, UsageError } from './errors.ts';
import { parse, decided } from './cli-arguments.ts';
import type { Session } from './cli-session.ts';
import { RUNNING_HUB_LOGIN } from './cli-session.ts';
export const RESOURCE_USAGE = 'resource assign|unassign <资源ID> (--team=<团队ID> | --all) | add <业务系统接入> --name <名字> --environment <环境> --origin <角色>=<地址> [--allow-plaintext <角色>] [--credential <凭据项>=<密钥名>…（包声明项必填）] [--setting <键>=<文字> | --setting-json <键>=<JSON> | --setting-var <键>=<变量名>] | update <资源> [--system-pack <业务系统接入>] [--name <名字>] [--environment <环境>] [--origin <角色>=<地址>…] [--allow-plaintext <角色>… | --clear-plaintext] [--credential <凭据项>=<密钥名>] [--setting <键>=<文字> | --setting-json <键>=<JSON> | --setting-var <键>=<变量名>] [--unset-setting <键>]（地址整项替换，设置逐键修改） | show <资源> [--values] | read <资源> <读取名> <键> [--events] | list | disable <资源> | enable <资源> | reset-login <资源>';
function pairs(values: readonly string[] | undefined, flag: string): [string, string][] {
  return (values ?? []).map((value) => {
    const at = value.indexOf('=');
    if (at <= 0) throw new UsageError(`${flag} 写成 <名字>=<值>，请核对这个参数`);
    return [value.slice(0, at), value.slice(at + 1)];
  });
}

function settingValue(text: string): string {
  if (/^\s*[\[{]/.test(text)) throw new UsageError('数组或对象请用 --setting-json');
  return text;
}
function resourceSettings(values: {setting?:string[];'setting-json'?:string[];'setting-var'?:string[]}) {
  const out:Record<string,unknown>={};
  const add=(key:string,value:unknown)=>{if(Object.hasOwn(out,key))throw new UsageError('设置键重复；逐项核对');out[key]=value;};
  for(const [key,value] of pairs(values.setting,'--setting'))add(key,settingValue(value));
  for(const [key,value] of pairs(values['setting-json'],'--setting-json')) {try {add(key,JSON.parse(value));}catch(error){if(error instanceof UsageError)throw error;throw new UsageError('设置 JSON 无效；核对 --setting-json，不回显原文');}}
  for(const [key,value] of pairs(values['setting-var'],'--setting-var')) {if(!/^[A-Z][A-Z0-9_]{0,63}$/.test(value))throw new UsageError('设置的变量名字不合规则');add(key,'${var:'+value+'}');}
  return out;
}
async function resourceWarnings(session:Session, record:import('../../contracts/src/resources.ts').ResourceRecord) {
  const hub=await session.hub(false); const by=await session.admin();
  const described=await hub.connectors.admin.describe(by,record.id);
  for(const item of described?.credentials??[]) {
    const match=/^\$\{secret:([^}]+)\}$/.exec(item.entry);if(!match)continue;
    if(!item.set)session.out(`密钥 ${match[1]} 还没有设置：用 circle-hub secret set --name ${match[1]} 设置`);
    else if(!item.registered)session.out(`密钥 ${match[1]} 的这一版未登记此使用者和地址：要重新输入一次值才会发往这里`);
  }
}

/**
 * The login column of `resource list`: the state stored in the vault, read fresh by this command (a running server reads it
 * again at its next read that needs the credential, RUNNING_HUB_LOGIN).
 */
function loginText(status: LoginStatus | null): string {
  if (status === null) return '不用登录';
  let state: string;
  if (status.stopped) state = `登录已停止${status.failure ? `（${status.failure}）` : ''}：用 secret set 重设凭据或 resource reset-login 解除（正在运行的 Hub 不用重启）`;
  else if (status.cooldownUntil !== null) state = `登录冷却到 ${status.cooldownUntil}`;
  else if (status.token) state = `已登录${status.expiresAt ? `（到期 ${status.expiresAt}）` : ''}`;
  else state = '还没有登录';
  return `密钥库里的登录状态：${state}`;
}

export async function resourceCommand(session: Session, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'assign':
    case 'unassign': {
      const { positionals, values } = parse(rest, { team: { type: 'string' }, all: { type: 'boolean' }, note: { type: 'string' } }, 1);
      if ((values.team !== undefined) === (values.all === true)) throw new UsageError('资源分配须且只能指定 --team=<团队ID> 或 --all');
      const subject = values.team !== undefined ? teamId(values.team) : WHOLE_HUB;
      const by = await session.admin(), hub = await session.hub();
      const resource = (await hub.resources.list(by)).find(row => row.id === positionals[0]);
      if (!resource) throw new CliError('资源不可用');
      if (sub === 'assign') await decided(() => hub.records.authorizations.assignResource(by, resource.id, subject, { note: values.note }));
      else await decided(() => hub.records.authorizations.unassignResource(by, resource.id, subject, values.note));
      session.out(sub === 'assign' ? `资源 ${resource.name} 已分配给${values.all ? '全体成员' : '团队 ' + subject}` : `已撤回资源 ${resource.name} 给${values.all ? '全体成员' : '团队 ' + subject}的分配`);
      return 0;
    }
    case 'add': {
      const { values, positionals } = parse(
        rest,
        {
          name: { type: 'string' },
          environment: { type: 'string' },
          origin: { type: 'string', multiple: true },
          'allow-plaintext': { type: 'string', multiple: true },
          setting: { type: 'string', multiple: true },
          'setting-json': {type:'string',multiple:true},
          'setting-var': {type:'string',multiple:true},
          'unset-setting': {type:'string',multiple:true},
          credential: {type:'string',multiple:true},
        },
        1,
      );
      if (values.name === undefined || values.name.trim() === '') throw new UsageError('要用 --name 给资源起名字');
      const environment = values.environment;
      if (environment === undefined || !isEnvironment(environment)) {
        throw new UsageError(`--environment 是 ${ENVIRONMENT.map((code) => `${code}（${labelOf('environment', code)}）`).join('、')} 之一`);
      }
      const origins: Record<string, string> = {};
      for (const [role, url] of pairs(values.origin, '--origin')) {
        if (Object.hasOwn(origins, role)) throw new UsageError(`角色 ${role} 的地址给了两次`);
        origins[role] = url;
      }
      if (Object.keys(origins).length === 0) throw new UsageError('至少用一个 --origin <角色>=<地址> 给出业务系统接入每个角色的地址');
      const plaintext = new Set<string>();
      for (const role of values['allow-plaintext'] ?? []) {
        if (!Object.hasOwn(origins, role)) throw new UsageError(`--allow-plaintext ${role}：这个角色没有用 --origin 给地址`);
        let origin: URL;
        try {
          origin = new URL(origins[role]);
        } catch {
          throw new UsageError(`角色 ${role} 的地址不是 URL`);
        }
        if (origin.protocol !== 'http:') throw new UsageError(`--allow-plaintext ${role}：只有 http 地址才需要允许明文`);
        plaintext.add(origin.origin);
      }
      const settings = resourceSettings(values);
      if(values['unset-setting']?.length)throw new UsageError('--unset-setting 只用于 update');
      const admin = await session.admin();
      const hub = await session.hub();
      const input: AddResourceInput = {
        credentials:Object.fromEntries(pairs(values.credential,'--credential')),
        system_pack: positionals[0],
        name: values.name,
        environment: environment as Environment,
        origins,
        ...(plaintext.size > 0 ? { allow_plaintext: [...plaintext] } : {}),
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
      };
      const record = await decided(() => hub.connectors.admin.addResource(admin, input));
      session.out(`已添加资源 ${record.id}：${record.name}（业务系统接入 ${record.system_pack}，环境 ${labelOf('environment', record.environment)}）`);
      await resourceWarnings(session,record);
      return 0;
    }
    case 'update': {
      const { values, positionals } = parse(
        rest,
        {
          'system-pack': { type: 'string' },
          name: { type: 'string' },
          environment: { type: 'string' },
          origin: { type: 'string', multiple: true },
          'allow-plaintext': { type: 'string', multiple: true },
          'clear-plaintext': { type: 'boolean' },
          setting: { type: 'string', multiple: true },
          'setting-json': {type:'string',multiple:true},
          'setting-var': {type:'string',multiple:true},
          'unset-setting': {type:'string',multiple:true},
          credential: {type:'string',multiple:true},
        },
        1,
      );
      if (values['clear-plaintext'] && values['allow-plaintext'] !== undefined) {
        throw new UsageError('--clear-plaintext 与 --allow-plaintext 不能同时给');
      }
      const changes: UpdateResourceInput = {};
      if (values['system-pack'] !== undefined) changes.system_pack = values['system-pack'];
      if (values.name !== undefined) {
        if (values.name.trim() === '') throw new UsageError('--name 不能是空的');
        changes.name = values.name;
      }
      if (values.environment !== undefined) {
        if (!isEnvironment(values.environment)) throw new UsageError(`--environment 是 ${ENVIRONMENT.map((code) => `${code}（${labelOf('environment', code)}）`).join('、')} 之一`);
        changes.environment = values.environment as Environment;
      }
      if (values.origin !== undefined) {
        const origins: Record<string, string> = {};
        for (const [role, url] of pairs(values.origin, '--origin')) {
          if (Object.hasOwn(origins, role)) throw new UsageError(`角色 ${role} 的地址给了两次`);
          origins[role] = url;
        }
        changes.origins = origins;
      }
      if (values['clear-plaintext']) {
        changes.allow_plaintext = [];
      } else if (values['allow-plaintext'] !== undefined) {
        const plaintext = new Set<string>();
        for (const role of values['allow-plaintext']) {
          const url = changes.origins?.[role];
          if (url === undefined) throw new UsageError(`--allow-plaintext ${role}：同一条命令里要用 --origin 给出这个角色的地址（地址整项替换）`);
          let origin: URL;
          try {
            origin = new URL(url);
          } catch {
            throw new UsageError(`角色 ${role} 的地址不是 URL`);
          }
          if (origin.protocol !== 'http:') throw new UsageError(`--allow-plaintext ${role}：只有 http 地址才需要允许明文`);
          plaintext.add(origin.origin);
        }
        changes.allow_plaintext = [...plaintext];
      }
      const settings=resourceSettings(values);
      if(Object.keys(settings).length)changes.settings=settings;
      if(values['unset-setting'])changes.unset_settings=values['unset-setting'];
      if(values.credential)changes.credentials=Object.fromEntries(pairs(values.credential,'--credential'));
      if (Object.keys(changes).length === 0) throw new UsageError('没有要改的项：给 --system-pack、--name、--environment、--origin、--allow-plaintext、--clear-plaintext 或 --setting');
      const admin = await session.admin();
      const hub = await session.hub();
      const previous=await hub.connectors.admin.describe(admin,positionals[0]);
      const clearedRoles: string[] = [];
      if (changes.origins !== undefined && values['allow-plaintext'] === undefined && !values['clear-plaintext'] && previous) {
        const prevOrigins = previous.origins ?? {};
        const prevPlaintext = new Set(previous.allow_plaintext ?? []);
        const kept = new Set<string>();
        for (const [role, oldUrl] of Object.entries(prevOrigins)) {
          try {
            const oldOrigin = new URL(oldUrl).origin;
            if (prevPlaintext.has(oldOrigin)) {
              if (changes.origins[role] === oldUrl) {
                kept.add(oldOrigin);
              } else {
                clearedRoles.push(role);
              }
            }
          } catch {}
        }
        changes.allow_plaintext = [...kept];
      }
      const missingLegacy=(previous?.credentials??[]).filter(c=>!c.entry.startsWith('${secret:')&&!c.set&&changes.credentials?.[c.name]);
      const record = await decided(() => hub.connectors.admin.updateResource(admin, positionals[0], changes));
      for(const item of missingLegacy)session.out(`原值不在密钥库里：接着用 circle-hub secret set --name ${changes.credentials![item.name]} 设置`);
      session.out(`已更新资源 ${record.id}：${record.name}（业务系统接入 ${record.system_pack}，环境 ${labelOf('environment', record.environment)}）`);
      if (values['clear-plaintext']) session.out('已清空所有明文放行');
      else if (clearedRoles.length > 0) session.out(`已清掉角色 ${clearedRoles.sort().join('、')} 的明文放行`);
      await resourceWarnings(session,record);
      return 0;
    }
    case 'show': {
      const {positionals,values}=parse(rest,{values:{type:'boolean'}},1);
      const by=await session.admin(), hub=await session.hub(false), kit=await session.records();
      const d=await hub.connectors.admin.describe(by,positionals[0]);if(!d)throw new CliError('资源不可用');
      session.out(`${d.id} ${d.name} ${d.system_pack}`);
      const config=await kit.authorizations.resourceConfig(d.id);let bound=config?.body.bound??null;
      let cursor:string|null=null;
      while(!bound){const page=await kit.authorizations.history({permission:'resource_config',subject:WHOLE_HUB,object:d.id,newestFirst:true,limit:500,cursor});bound=page.items.find(row=>!row.body.revoked&&row.body.bound)?.body.bound??null;if(bound||!page.next)break;cursor=page.next;}
      const bytes=bound?await kit.objects.get(bound):null;if(!bytes)throw new CliError('资源定义原件缺失；请管理员从可信备份恢复后重做 resource show');
      const source=parseStrictJson(Buffer.from(bytes).toString()) as {settings?:Record<string,unknown>};const versions=await kit.variables.list(by);
      for(const [key,value] of Object.entries(source.settings??{})){
        const refs=referencesIn(value).filter(ref=>ref.kind==='var');
        const names=refs.map(ref=>{const version=versions.find(v=>v.kind==='var'&&v.name===ref.name);return '${var:'+ref.name+'} '+(!version?'还没有设置':version.decision.body.revoked?`已撤回（最后第 ${version.version} 版）`:`第 ${version.version} 版`);});
        session.out(`设置 ${key}：${names.length?names.join('；'):values.values?JSON.stringify(value):'长度 '+Buffer.byteLength(JSON.stringify(value))}`);
      }
      for(const c of d.credentials){const version=c.revoked?`已撤回（最后第 ${c.version} 版）`:c.version?`第 ${c.version} 版`:'尚未登记命名版本';const stored=c.stored_digest?labelOf('digest_rule',c.stored_digest):'无当前登记';session.out(`凭据项 ${c.name} ${c.entry} ${version} 长度 ${c.length??'不适用'} 发送规则 ${labelOf('digest_rule',c.digest)} 存储规则 ${stored} ${c.set?'有条目':'无条目'} ${c.registered?'已登记使用者':'无当前使用者登记'}`);}
      return 0;
    }
    case 'read': {
      const { positionals, values } = parse(rest, { events: { type: 'boolean' } }, 3);
      const admin = await session.admin();
      // Default output is metadata only; --events sends redacted connector diagnostics to stderr for smoke capture.
      const hub = await session.hub(true, values.events !== true);
      const [resource, readName, key] = positionals;
      const described = await decided(() => hub.connectors.admin.describe(admin, resource));
      if (described === null) throw new CliError('资源不可用');
      const result = await hub.connectors.executeRead(resource, readName, { id: key }, { principal: admin, purpose: '管理员冒烟读取' });
      session.out(`${described.system_pack}/${readName}：${result.ok ? '读取完成' : `失败（${result.code}）`}`);
      if (result.ok) for (const artifact of result.artifacts) session.out(`产物 ${artifact.name} ${artifact.artifact.body.sha256} ${artifact.artifact.body.size} 字节`);
      if (result.manifest !== null) session.out(`读清单 ${result.manifest}`);
      return result.ok ? 0 : 1;
    }
    case 'list': {
      const { values } = parse(rest, { as: { type: 'string' } }, 0);
      const viewer = await session.viewer(values.as);
      if (!isAdmin(viewer)) throw new CliError('只有管理员能列出资源');
      const hub = await session.hub();
      // The console's listing (ResourceCatalogPort): admins only, with addresses and plaintext declarations.
      const listings = await hub.resources.list(viewer);
      if (listings.length === 0) {
        session.out('还没有资源');
        return 0;
      }
      // The login column is read from the vault, which needs the master key: asked once for the whole listing, so an
      // unreadable key costs one refusal, not one per resource.
      const keyProblem = listings.some((resource) => resource.enabled) ? await vaultKeyProblem(hub.records) : null;
      for (const resource of listings) {
        const fields = [resource.id, resource.name, resource.system_pack, labelOf('environment', resource.environment as Environment), resource.enabled ? '启用' : '停用'];
        fields.push(Object.entries(resource.origins ?? {}).map(([role, url]) => `${role}=${url}`).join(' '));
        if ((resource.allow_plaintext ?? []).length > 0) fields.push(`允许明文 ${(resource.allow_plaintext ?? []).join(' ')}`);
        if (resource.enabled) {
          let login: string;
          if (keyProblem !== null) login = `登录状态读不出：${keyProblem}`;
          else {
            try {
              login = loginText(await hub.connectors.admin.loginStatus(viewer, resource.id));
            } catch (error) {
              login = `登录状态读不出：${messageOf(error)}`;
            }
          }
          fields.push(login);
        }
        session.out(fields.join('\t'));
      }
      return 0;
    }
    case 'disable':
    case 'enable':
    case 'reset-login': {
      const { positionals } = parse(rest, {}, 1);
      const admin = await session.admin();
      // A reset only removes the vault's session entry, which needs no master key.
      const hub = await session.hub();
      const id = positionals[0];
      if (sub === 'disable') await decided(() => hub.connectors.admin.disable(admin, id));
      else if (sub === 'enable') await decided(() => hub.connectors.admin.enable(admin, id));
      else await decided(() => hub.connectors.admin.resetLogin(admin, id));
      if (sub === 'reset-login') {
        session.out(`资源 ${id} 在密钥库里的登录状态已清除：Hub 下一次要用这个资源的凭据时用已存的凭据登录一次`);
        session.err(`注意：${RUNNING_HUB_LOGIN}`);
      } else session.out(sub === 'disable' ? `资源 ${id} 已停用：不再读取` : `资源 ${id} 已启用`);
      return 0;
    }
    default:
      throw new UsageError(`resource 的子命令：${RESOURCE_USAGE}`);
  }
}

