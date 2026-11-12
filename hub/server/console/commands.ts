// The operations the console does not run (proposal decision 6 of 2026-10-31: the console keeps adding members, connecting
// business systems, publishing task packs and importing knowledge): each button opens a dialog with the `circle-hub` command
// for the administrator's Circle to run on the Hub's host, so the checks and records are those of the command line. A word
// that is not a plain identifier is single-quoted; a value the administrator must supply (a reason) is a quoted placeholder.
import type { CommandDialog } from './ui.ts';

/** A shell word: identifiers as they are, anything else in single quotes. */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9_.@:=/+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function command(...words: readonly string[]): string {
  return ['circle-hub', ...words.map(shellWord)].join(' ');
}

const REASON = '--reason=请填写理由';

/** An HTML id for a dialog: the operation and its object, reduced to safe characters. */
function dialogId(operation: string, object: string): string {
  return `cmd-${operation}-${object.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

export const commands = {
  memberPack: (user: string, pack: string, assigned: boolean): CommandDialog => ({
    id: dialogId(`member-pack-${user}`, pack), title: '调整工作流使用范围',
    text: '调整后对该成员的新任务生效；已有任务的记录保留。', command: command('pack', assigned ? 'unassign' : 'assign', user, pack),
  }),
  memberPublish: (user: string, granted: boolean): CommandDialog => ({
    id: dialogId('member-publish', user), title: '调整发布权',
    text: '发布权只允许发布本人拥有的内容。', command: command('pack', granted ? 'revoke-publish' : 'grant-publish', user),
  }),
  userDisable: (user: { id: string; name: string }): CommandDialog => ({
    id: dialogId('user-disable', user.id), title: `停用成员 ${user.name}`,
    text: '停用后，该成员无法访问 Hub，私人空间冻结，已分享的私人内容暂停访问。团队已取得的内容保留。重新启用后恢复仍有效的分享；不会清除内容或停止远程客户端。', command: command('user', 'disable', user.id),
  }),
  userEnable: (user: { id: string; name: string }): CommandDialog => ({
    id: dialogId('user-enable', user.id), title: `启用成员 ${user.name}`,
    text: '启用后，私人空间和仍有效的分享恢复可用，已收回的分享不会恢复。未吊销且未过期的客户端访问令牌恢复可用；已关闭的控制台会话需要重新登录。', command: command('user', 'enable', user.id),
  }),
  tokenRevoke: (token: { id: string; label: string }, owner: string): CommandDialog => ({
    id: dialogId('token-revoke', token.id), title: `断开 ${owner} 的客户端`,
    text: `吊销令牌 ${token.id}${token.label ? `（${token.label}）` : ''}：使用该令牌的客户端与控制台会话立即断开，其他令牌不受影响。`, command: command('token', 'revoke', token.id),
  }),
  userInvite: (user: { id: string; name: string }): CommandDialog => ({
    id: dialogId('user-invite', user.id), title: `签发邀请码：${user.name}`,
    text: '邀请码 24 小时内有效，仅可使用一次，只在签发时显示；该成员的客户端打开连接确认页时输入，即以该成员的身份完成连接。', command: command('user', 'invite', user.id),
  }),
  tokenIssue: (user: { id: string; name: string }): CommandDialog => ({
    id: dialogId('token-issue', user.id), title: `签发客户端访问令牌：${user.name}`,
    text: '新令牌仅在签发时显示一次，只用于连接客户端，不能登录控制台；所有账户都用用户名和密码登录控制台。', command: command('token', 'issue', user.id, '--label=客户端'),
  }),
  // The masking dictionary (B02 R[11]): rules are set, tried and removed on the server; the page lists them.
  maskSet: (): CommandDialog => ({
    id: dialogId('mask-set', 'rule'), title: '添加或更新遮盖规则',
    text: '规则名相同即更新。模式是正则表达式；写了名为 secret 的分组时只替换该分组，周围的文字保留。先用第一条命令在一份样本上试，确认替换结果后再用第二条命令保存。之后读到的业务系统应答按新规则替换，已经保存的内容不改写。',
    command: `${command('mask', 'test', '--pattern=password=(?<secret>\\S+)', '--label=密码', '--file=样本文件')}\n${command('mask', 'set', '规则名', '--label=密码', '--pattern=password=(?<secret>\\S+)', REASON)}`,
  }),
  maskRemove: (name: string): CommandDialog => ({
    id: dialogId('mask-remove', name), title: `删除遮盖规则 ${name}`,
    text: '删除后读到的业务系统应答不再按这条规则替换；已经按它替换过的内容不恢复，被替换的值 Hub 没有保存。', command: command('mask', 'remove', name, REASON),
  }),
  secretSet: (name: string): CommandDialog => ({
    id: dialogId('secret-set', name), title: `更新凭据 ${name}`,
    text: '新内容从标准输入读取，不出现在命令、记录和页面中；引用该凭据的业务系统与运行环境下次使用新版本。', command: command('secret', 'set', `--name=${name}`, REASON),
  }),
  secretUnset: (name: string): CommandDialog => ({
    id: dialogId('secret-unset', name), title: `吊销凭据 ${name}`,
    text: '吊销后引用该凭据的读取与派发不再可用；版本记录保留。', command: command('secret', 'unset', `--name=${name}`, REASON),
  }),
  resourceToggle: (resource: { id: string; name: string; enabled: boolean }): CommandDialog => ({
    id: dialogId(resource.enabled ? 'resource-disable' : 'resource-enable', resource.id), title: `${resource.enabled ? '停用' : '启用'}业务系统 ${resource.name}`,
    text: resource.enabled ? '停用后 Hub 不再读取该系统；已读取的内容与记录保留。' : '启用后 Hub 恢复以只读方式读取该系统。', command: command('resource', resource.enabled ? 'disable' : 'enable', resource.id),
  }),
  resourceResetLogin: (resource: { id: string; name: string }): CommandDialog => ({
    id: dialogId('resource-reset-login', resource.id), title: `重新认证业务系统 ${resource.name}`,
    text: '清除该系统已保存的登录状态，下次读取时重新登录。', command: command('resource', 'reset-login', resource.id),
  }),
  packAssign: (pack: string): CommandDialog => ({
    id: dialogId('pack-assign', pack), title: `调整 ${pack} 的使用范围`,
    text: '把成员加入使用范围用 assign，移出用 unassign；成员以编号或名称指定。', command: `${command('pack', 'assign', '成员编号', pack)}\n${command('pack', 'unassign', '成员编号', pack)}`,
  }),
  packMaintainer: (pack: string): CommandDialog => ({
    id: dialogId('pack-maintainer', pack), title: '调整维护人',
    text: `维护人可发布新版本；${pack} 的新版本只能由其所有者发布。`, command: `${command('pack', 'grant-publish', '成员编号')}\n${command('pack', 'revoke-publish', '成员编号')}`,
  }),
  packRetire: (ref: string): CommandDialog => ({
    id: dialogId('pack-retire', ref), title: `退役版本 ${ref}`,
    text: '退役后该版本不再可用于新任务；已有任务照旧可读、可完成。', command: command('pack', 'retire', ref),
  }),
  packActivate: (pack: string, active: boolean): CommandDialog => ({
    id: dialogId(active ? 'pack-deactivate' : 'pack-activate', pack), title: `${active ? '停用' : '启用'}产品知识来源 ${pack}`,
    text: active ? '停用后该产品线的知识不再对全 Hub 生效。' : '启用后该产品线的知识对全 Hub 生效。', command: command('pack', active ? 'deactivate' : 'activate', pack),
  }),
  executorDisable: (executor: { id: string; target: string }): CommandDialog => ({
    id: dialogId('executor-disable', executor.id), title: `停用运行环境 ${executor.target}`,
    text: '停用后不再向该运行环境派发作业；已派发的作业照旧查询与处置。', command: command('executor', 'disable', executor.id),
  }),
  bedHoldClear: (executor: { id: string; target: string }): CommandDialog => ({
    id: dialogId('bed-hold-clear', executor.id), title: `确认运行环境 ${executor.target} 已恢复`,
    text: '核实运行环境已恢复原状（例如设备已重启、作业留下的配置已清除）后再执行；执行后该运行环境恢复接受派发，原记录保留。', command: command('bed', 'hold', 'clear', executor.id, REASON),
  }),
  jobDispose: (job: string): CommandDialog => ({
    id: dialogId('job-dispose', job), title: `处置作业 ${job.slice(0, 12)} 的派发结果`,
    text: '先查看作业状态与处置请求，再按核对结论执行 circle-hub job dispose（核对、保持未知、标记失败三选一）；处置前该运行环境不接受新的派发。', command: command('job', 'status', job),
  }),
  tlsIssue: (): CommandDialog => ({
    id: 'cmd-tls-issue', title: '重新签发服务器证书',
    text: '由本 Hub 的证书颁发机构重新签发服务器证书；重启 Hub 后生效。颁发机构不变，已信任的浏览器与客户端无需重新配置。', command: command('tls', 'issue'),
  }),
  backup: (): CommandDialog => ({
    id: 'cmd-backup', title: '备份',
    text: '备份数据库、对象、密钥库与设置文件，并清理旧备份；需在运行 Hub 的服务器上执行。', command: command('backup'),
  }),
  restore: (): CommandDialog => ({
    id: 'cmd-restore', title: '恢复',
    text: '校验备份后恢复到空的数据根；恢复后的记录以备份为准，需停止 Hub 后执行。', command: command('restore', '备份文件夹'),
  }),
};
