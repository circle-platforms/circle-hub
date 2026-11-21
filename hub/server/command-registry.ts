import { resetUsage } from './reset/cli.ts';
import { APPLY_USAGE, EXPORT_USAGE } from './cli-apply.ts';
import { teamCommand, TEAM_USAGE } from './cli-team.ts';
import type { CliContext } from './api.ts';
import type { CliOptions } from './cli.ts';
import type { Session } from './cli-session.ts';
import { PLATFORM_COMMAND_METADATA } from '../platform/api.ts';
import { PERMISSION_ROLE } from '../../contracts/generated/vocabulary.ts';
import { DEFAULT_ADMIN_NAME } from '../records/api.ts';
import { DEFAULT_EVENT_LIMIT } from '../health/api.ts';
import { SERVE_USAGE, SECRET_USAGE, ORIGINAL_USAGE, LEASE_USAGE, SHARE_USAGE, UNSHARE_USAGE, INIT_ADMIN_USAGE, OPERATOR_TOKEN_USAGE } from './cli-command-usage.ts';
import { packCommand, PACK_USAGE } from './cli-pack.ts';
import { resourceCommand, RESOURCE_USAGE } from './cli-resource.ts';
import { knowledgeCommand, KNOWLEDGE_USAGE } from './cli-knowledge.ts';
import { localToolsCommand, LOCAL_TOOLS_USAGE } from './cli-local-tools.ts';
import { RUN_BATCH_USAGE } from './cli-run-batch.ts';
import { variableCommand, namedSecretCommand, VAR_USAGE } from './variables.ts';
import { maskCommand, MASK_USAGE } from './cli-mask.ts';
import { executorCommand, jobCommand, EXECUTOR_USAGE, JOB_USAGE, bedCommand, BED_USAGE } from './cli-job.ts';
import { traceCommand, TRACE_USAGE } from './cli-trace.ts';
import { commandParameterHelp } from './command-parameters.ts';
type BuiltinHandler = (args: readonly string[], ctx: CliContext, options: CliOptions) => Promise<number>;
type AdminHandler = (session: Session, args: readonly string[]) => Promise<number>;
interface CommandMetadata { name: string; summary: string; bridge: boolean; step: `run-${string}`; reserved?: string }
const builtins: { name: string; help: string[]; handler: BuiltinHandler; bridge: boolean }[] = [
  { name: 'reset', help: [resetUsage()], handler: (args, _ctx, options) => import('./cli-reset.ts').then(module => module.dispatchReset(args, options)), bridge: false },
  { name: 'serve', help: [`  ${SERVE_USAGE}`], handler: (args, _ctx, options) => import('./main.ts').then(module => module.serve(args, options)), bridge: false },
  { name: 'user', help: [`  user create <名字> [--role ${PERMISSION_ROLE.join('|')}]   建用户；还没有管理员时先用 --role admin 建第一位管理员（省略名字时为 ${DEFAULT_ADMIN_NAME}），并只显示一次它的令牌`, '  user list [--json]                           列出用户（JSON 不含密码摘要或令牌）', '  user disable|enable <用户>                    停用或恢复一个账号（停用立即生效）', '  user rename <用户> <新名字>                    给账号改名；记录按成员编号引用账号，改名后登录和 --as 用新名字', '  user delete <成员编号> [--dry-run] [--json]    先检查清除范围；按显示的确认命令永久删除，失败后重试同一操作', '  user password-reset <用户>                   重置初始密码，只显示一次；首次登录须修改，控制台会话立即失效', '  user invite <用户>                            签发邀请码（24 小时内有效，仅可使用一次，只显示这一次）：成员的 Circle 经标准授权连接时，在授权页输入它'], handler: (args, ctx, options) => import('./cli.ts').then(module => module.userCommand(args, ctx, options)), bridge: true },
  { name: 'token', help: ['  token issue <用户> [--label <标签>] [--raw]    签发令牌，令牌只显示这一次；--raw 时标准输出上只有令牌和换行，确认写到标准错误', '  token revoke <令牌编号>                        撤销令牌（立即生效）', '  token list [<用户>]                           列出令牌（不显示令牌值）'], handler: (args, ctx, options) => import('./cli.ts').then(module => module.tokenCommand(args, ctx, options)), bridge: true },
  { name: 'logs', help: ['  logs export [--from <时间>] [--to <时间>] [--user <用户>] [--tool <工具>] [--run <运行>] [--out <文件>] [--as <管理员>]   导出调用日志（JSON Lines）'], handler: (args, ctx, options) => import('./cli.ts').then(module => module.logsCommand(args, ctx, options)), bridge: false },
  { name: 'local-tools', help: [`  ${LOCAL_TOOLS_USAGE}`], handler: (args, ctx) => localToolsCommand(args, ctx.io), bridge: false },
  { name: 'setup-code', help: ['  setup-code                                   还没有管理员时，给网页控制台发一个设置码（24 小时内有效，只显示一次），在 /console/setup 用它建第一位管理员'], handler: (args, ctx) => import('./cli.ts').then(module => module.setupCodeCommand(args, ctx)), bridge: false },
  { name: 'run', help: ['  run abandon <运行> --answer-request <摘要> --reason <理由>  管理放弃目标，原效果与冻结不改', `  ${RUN_BATCH_USAGE}  管理员为文件里每个外部对象各开始一次运行（只用于开始时由 Hub 直接算出结果的工作流）`, '  run list [--pack <包>] [--user <用户>] [--state 受理|未受理|进行中] [--since <ISO时间>] [--unknown] [--limit <N>] [--cursor <游标>] [--json] [--as <管理员>]  列出运行（仅管理员；默认 50 条，新到旧，超出给下一页游标）', '  run show <运行> [--json] [--as <管理员>]        显示一次运行'], handler: (args, ctx, options) => import('./cli.ts').then(module => module.runCommand(args, ctx, options)), bridge: false },
  { name: 'health', help: ['  health [--since <时长或时间>] [--json] [--as <管理员>]   资源的当前值和窗口内的最小、最大值（仅管理员；--since 写 30m、6h、7d 或 ISO 时间，默认 1 小时）'], handler: (args, ctx, options) => import('./cli.ts').then(module => module.healthCommand(args, ctx, options)), bridge: false },
  { name: 'crashes', help: [`  crashes [--limit <N>] [--json] [--as <管理员>]   进程的启动、停止和异常退出，异常退出带当时在处理的请求和崩溃报告摘要（仅管理员；默认 ${DEFAULT_EVENT_LIMIT} 条，新到旧）`], handler: (args, ctx, options) => import('./cli.ts').then(module => module.crashesCommand(args, ctx, options)), bridge: false },
 ];
export const BUILTIN_COMMANDS = builtins.map(command => ({ ...command, summary: command.help[0].trim(), step: `run-${command.name}` as const }));
const administrative: { name: string; summary: string; handler: AdminHandler; bridge?: boolean; reserved?: string }[] = [
{ name: 'apply', summary: APPLY_USAGE.slice('apply '.length), handler: (session, args) => import('./cli-apply.ts').then(module => module.applyCommand(session, args)) },
  { name: 'export', summary: EXPORT_USAGE, handler: (session, args) => import('./cli-apply.ts').then(module => module.exportCommand(session, args)) },
{name:'share',summary:SHARE_USAGE.slice('share '.length),handler: (session,args) => import('./cli-admin.ts').then(module => module.sharingCommand(session,args))},
  {name:'unshare',summary:UNSHARE_USAGE.slice('unshare '.length),handler:(session,args)=>import('./cli-admin.ts').then(module=>module.sharingCommand(session,args,true))},
  {name:'records',summary:'verify [--kind <记录类型>] [--vault]（核存储摘要，可选核验密钥库解密，不输出正文）',handler: (session,args) => import('./cli-admin.ts').then(module => module.recordsCommand(session,args))},
  { name: 'executor', summary: EXECUTOR_USAGE, bridge: true, handler: executorCommand },
  { name: 'job', summary: JOB_USAGE, handler: jobCommand },
  { name: 'bed', summary: BED_USAGE, bridge: true, handler: bedCommand },
  { name: 'pack', reserved: '管理工作流', bridge: true, summary: PACK_USAGE.slice('pack '.length), handler: packCommand },
  { name: 'resource', reserved: '管理资源声明', bridge: true, summary: RESOURCE_USAGE.slice('resource '.length), handler: resourceCommand },
  { name: 'var', summary: VAR_USAGE.slice('var '.length), handler: variableCommand },
  { name: 'mask', summary: MASK_USAGE.slice('mask '.length), handler: maskCommand },
  { name: 'secret', reserved: '管理密钥库条目', bridge: true, summary: SECRET_USAGE.slice('secret '.length), handler: namedSecretCommand },
  { name: 'original', summary: ORIGINAL_USAGE.slice('original '.length), handler: (session,args) => import('./cli-admin.ts').then(module => module.originalCommand(session,args)) },
  { name: 'lease', summary: LEASE_USAGE.slice('lease '.length), bridge: true, handler: (session,args) => import('./cli-admin.ts').then(module => module.leaseCommand(session,args)) },
  { name: 'knowledge', reserved: '读取和管理知识树', bridge: true, summary: KNOWLEDGE_USAGE.slice('knowledge '.length), handler: knowledgeCommand },
  { name: 'team', reserved: '管理团队', bridge: true, summary: TEAM_USAGE.slice('team '.length), handler: teamCommand },
  { name: 'trace', summary: TRACE_USAGE.slice('trace '.length), handler: traceCommand },
  { name: 'doc', summary: commandParameterHelp('doc.put').slice('doc '.length) + ' | list | show <名字>', bridge: true, handler: (session,args) => import('./cli-admin.ts').then(module => module.docCommand(session,args)) },
  { name: 'init-admin', reserved: '初始化管理员', summary: INIT_ADMIN_USAGE.slice('init-admin '.length), handler: (session,args) => import('./cli-admin.ts').then(module => module.initAdminCommand(session,args)) },
  { name: 'operator-token', reserved: '管理操作令牌', summary: OPERATOR_TOKEN_USAGE.slice('operator-token '.length), handler: (session,args) => import('./cli-admin.ts').then(module => module.operatorTokenCommand(session,args)) },
];
export const ADMIN_COMMANDS = administrative.map(command => ({ ...command, bridge: command.bridge ?? false, step: `run-${command.name}` as const }));
export const COMMAND_METADATA: readonly CommandMetadata[] = [...BUILTIN_COMMANDS, ...ADMIN_COMMANDS, ...PLATFORM_COMMAND_METADATA];
export const RESERVED_DESCRIPTIONS = Object.fromEntries(ADMIN_COMMANDS.filter(command => command.reserved !== undefined).map(command => [command.name, command.reserved!]));
export const BRIDGED_COMMANDS: ReadonlySet<string> = new Set(COMMAND_METADATA.filter(command => command.bridge).map(command => command.name));
