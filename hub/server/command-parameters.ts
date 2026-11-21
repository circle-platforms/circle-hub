import { parseArgs } from 'node:util';
import { z } from 'zod';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { PackId, TeamId, TokenId, UserId } from '../../contracts/src/common.ts';
import { VariableName } from '../../contracts/src/variables.ts';
import { ENVIRONMENT, PERMISSION_ROLE, labelOf } from '../../contracts/generated/vocabulary.ts';
import { UsageError } from './errors.ts';

type Schema = Record<string, unknown>;
export interface Parameter {
  name: string;
  label: string;
  description: string;
  required: boolean;
  schema: Schema;
  dynamicChoices?: true;
}
export interface Option {
  type: 'string' | 'boolean';
  label: string;
  description: string;
  multiple?: true;
  maxItems?: number;
  required?: true;
  hidden?: true;
  schema?: Schema;
  choices?: readonly { value: string; label: string }[];
  dynamicChoices?: true;
}
interface StdinParameter {
  description: string;
  sensitive: true;
  key?: string;
  keysFromOption?: string;
  enabledByOption?: string;
}
interface PositionalVariant {
  option: string;
  present: boolean;
  names: readonly string[];
}
interface Definition<O extends Record<string, Option> = Record<string, Option>> {
  path: readonly string[];
  description: string;
  source: { file: string; symbol: string };
  positionals: readonly Parameter[];
  minimum: number;
  maximum: number;
  options: O;
  rules: readonly Schema[];
  variants: readonly PositionalVariant[];
  stdin: readonly StdinParameter[];
  sensitiveOutput: boolean;
  validationNotes: readonly string[];
}
export type DynamicChoices = Readonly<Record<string, readonly { value: string; label: string }[]>>;

function contract(schema: z.ZodType): Schema {
  const { $schema: _dialect, ...shape } = z.toJSONSchema(schema, { io: 'input' });
  return shape;
}
const stringSchema = { type: 'string' };
const teamSchema = contract(TeamId), userSchema = contract(UserId), tokenSchema = contract(TokenId), packSchema = contract(PackId), secretNameSchema = contract(VariableName);
const text = (label: string, description: string, extra: Omit<Partial<Option>, 'type' | 'label' | 'description'> = {}) => ({ type: 'string' as const, label, description, ...extra });
const repeated = (label: string, description: string, extra: Omit<Partial<Option>, 'type' | 'label' | 'description' | 'multiple'> = {}) => ({ ...text(label, description, extra), multiple: true as const });
const flag = (label: string, description: string, hidden = false) => ({ type: 'boolean' as const, label, description, ...(hidden ? { hidden: true as const } : {}) });
const positional = (name: string, label: string, description: string, required = true, schema: Schema = stringSchema, dynamicChoices = false): Parameter => ({ name, label, description, required, schema, ...(dynamicChoices ? { dynamicChoices: true as const } : {}) });
const user = () => positional('user', '账户', '现有账户名或成员编号；原账户服务核对是否存在', true, stringSchema, true);
const team = () => positional('team', '团队', '团队编号；成员读取时只显示所属团队的名称', true, teamSchema, true);
const pack = () => positional('pack', '工作流', '已发布的工作流包号，不带版本；包准入仍由 registry 校验', true, packSchema, true);
const resource = () => positional('resource', '资源', '现有业务系统资源编号', true, stringSchema, true);
const as = text('读取账户', '现有 --as 参数；写操作仍由原处理函数拒绝此参数', { hidden: true });
const note = text('说明', '分配或撤回记录的说明');
const reason = text('理由', '必填、至多 500 字符；原服务检查凭据内容，不在表单中替代扫描', { required: true, schema: { type: 'string', minLength: 1, maxLength: 500 } });
const teamOption = text('团队', '与个人位置参数互斥的团队编号', { schema: teamSchema, dynamicChoices: true });
const resourceAudienceOptions = { team: teamOption, all: flag('全体成员', '与 --team 互斥；接入后显式分配给全体启用账户') };
const memberName = () => positional('name', '账户名', '由 records 校验：1–100 字符，无控制字符及首尾空白');
const product = text('产品', '产品包声明的名称或产品号，由知识服务解析', { required: true, dynamicChoices: true });
const line = text('版本线', '产品的版本线；存在性由知识服务检查', { dynamicChoices: true });
const sources = {
  user: { file: 'hub/server/cli.ts', symbol: 'userCommand' }, token: { file: 'hub/server/cli.ts', symbol: 'tokenCommand' },
  team: { file: 'hub/server/cli-team.ts', symbol: 'teamCommand' }, pack: { file: 'hub/server/cli-pack.ts', symbol: 'packCommand' },
  resource: { file: 'hub/server/cli-resource.ts', symbol: 'resourceCommand' }, secret: { file: 'hub/server/variables.ts', symbol: 'namedSecretCommand' },
  executor: { file: 'hub/server/cli-job.ts', symbol: 'executorCommand' }, knowledge: { file: 'hub/server/cli-knowledge.ts', symbol: 'knowledgeCommand' },
};
function define<const O extends Record<string, Option>>(path: readonly string[], description: string, source: Definition['source'], positionals: readonly Parameter[], options: O, extra: Partial<Pick<Definition, 'minimum' | 'maximum' | 'rules' | 'variants' | 'stdin' | 'sensitiveOutput' | 'validationNotes'>> = {}): Definition<O> {
  return { path, description, source, positionals, options, minimum: positionals.filter(p => p.required).length, maximum: positionals.length, rules: [], variants: [], stdin: [], sensitiveOutput: false, validationNotes: [], ...extra };
}
const assign = (action: 'assign' | 'unassign') => define(['pack', action], action === 'assign' ? '分配工作流' : '撤回工作流分配', sources.pack,
  [{ ...user(), required: false }, pack()], { team: teamOption, note }, {
    minimum: 1, maximum: 2,
    variants: [{ option: 'team', present: false, names: ['user', 'pack'] }, { option: 'team', present: true, names: ['pack'] }],
    rules: [{ oneOf: [{ required: ['user', 'pack'], not: { required: ['team'] } }, { required: ['team', 'pack'], not: { required: ['user'] } }] }],
  });
const resourceAssign = (action: 'assign' | 'unassign') => define(['resource', action], action === 'assign' ? '分配资源' : '撤回资源分配', sources.resource,
  [resource()], { team: teamOption, all: flag('全体成员', '与 --team 互斥；显式分配给全体启用账户'), note }, {
    rules: [{ oneOf: [{ required: ['team'], not: { required: ['all'], properties: { all: { const: true } } } }, { required: ['all'], properties: { all: { const: true } }, not: { required: ['team'] } }] }],
  });
const resourceOptions = {
  name: text('资源名', '资源的显示名称'), environment: text('运行环境', '生成词表中的运行环境', { schema: { type: 'string', enum: [...ENVIRONMENT] }, choices: ENVIRONMENT.map(value => ({ value, label: labelOf('environment', value) })) }),
  origin: repeated('角色地址', '每项写成角色=地址；角色由选定系统包声明'),
  'allow-plaintext': repeated('允许明文的角色', '只适用于已提供 http 地址的角色'),
  credential: repeated('凭据引用', '每项写成凭据项=命名密钥名字；这里不接收密钥值'),
  setting: repeated('文字设置', '每项写成设置键=文字；数组或对象使用 --setting-json'),
  'setting-json': repeated('JSON 设置', '每项写成设置键=JSON 值'),
  'setting-var': repeated('变量引用', '每项写成设置键=普通变量名字'),
  'unset-setting': repeated('移除设置', '仅 update 可用；add 的原处理函数拒绝此项'),
};
const secretOptions = {
  name: repeated('密钥名', '命名密钥，不是密钥值', { schema: secretNameSchema }),
  digest: repeated('摘要规则', '当前只接受 名字=sha512_base64；原服务校验对应名字及生成词表代码'),
  short: repeated('短值声明', '每项是 --name 中明确声明的名字'), reason,
  history: flag('版本记录', '显示已登记的版本记录，不显示密钥值'),
  'env-file': text('环境文件', 'Hub 所在机器上的显式输入文件；模块导入和形状导出不读取它'),
  key: repeated('环境键映射', '每项写成环境键=密钥名'), basic: repeated('Basic 映射', '每项写成用户键:密码键=密钥名'),
  'dry-run': flag('只检查', '核对输入但不写入'),
};
const executorOptions = { secret: flag('退役参数', '原命令保留明确拒绝 --secret；密钥值不得作为 argv', true) };
const uploadedReference = text('上传原件引用', '当前账户可读取的完整 src 引用，不接受片段；与本机文件互斥', { schema: { type: 'string', pattern: '^src:[0-9a-f]{64}$' } });
const sourceRules: Schema[] = [{ oneOf: [{ required: ['file'], not: { required: ['reference'] } }, { required: ['reference'], not: { required: ['file'] } }] }];
const sourceVariants = (names: readonly string[]): PositionalVariant[] => [{ option: 'reference', present: false, names: [...names, 'file'] }, { option: 'reference', present: true, names }];
const executorAssign = (action: 'assign' | 'unassign') => define(['executor', action], action === 'assign' ? '分配测试环境' : '撤回测试环境分配', sources.executor,
  [positional('executor', '执行器', '已登记的测试环境执行器编号', true, stringSchema, true)],
  { team: text('团队', '现有团队编号；与账户互斥', { schema: teamSchema, dynamicChoices: true }), user: text('账户', '现有账户名或成员编号；与团队互斥', { dynamicChoices: true }) },
  { rules: [{ oneOf: [{ required: ['team'], not: { required: ['user'] } }, { required: ['user'], not: { required: ['team'] } }] }] });
const leaseSource = { file: 'hub/server/cli-admin.ts', symbol: 'leaseCommand' };
const bedSource = { file: 'hub/server/cli-job.ts', symbol: 'bedCommand' };
const maintenanceReason = text('理由', '必填；由原命令与服务核验并写入动作记录', { required: true });
const leasePrefix = () => positional('prefix', '租约前缀', '已发布工作流声明下的登记前缀，原命令核对归属', true, stringSchema, true);
const bedExecutor = () => positional('executor', '执行器', '已登记的测试环境执行器编号', true, stringSchema, true);

export const COMMAND_PARAMETERS = {
  'init-admin': define(['init-admin'], '建立第一位管理员', { file: 'hub/server/cli-admin.ts', symbol: 'initAdminCommand' }, [{ ...memberName(), required: false }], { 'password-stdin': flag('从标准输入读密码', '不设置时由现有命令生成初始密码') }, { stdin: [{ key: '管理员密码', enabledByOption: 'password-stdin', sensitive: true, description: '12–256 字符，无控制字符；仅通过 readSecret/stdin 传递' }], sensitiveOutput: true }),
  'user.create': define(['user', 'create'], '建立账户', sources.user, [{ ...memberName(), required: false }], { role: text('角色', '缺省为普通成员；首次建管理员可省略名称', { schema: { type: 'string', enum: [...PERMISSION_ROLE] }, choices: PERMISSION_ROLE.map(value => ({ value, label: labelOf('permission_role', value) })) }), as }, { sensitiveOutput: true, validationNotes: ['已有管理员时账户名必填；仅首次管理员可由原处理函数补默认名称'] }),
  'user.list': define(['user', 'list'], '列出账户', sources.user, [], { json: flag('JSON 输出', '不含密码材料或令牌值') }),
  'user.disable': define(['user', 'disable'], '停用账户', sources.user, [user()], { as }),
  'user.enable': define(['user', 'enable'], '启用账户', sources.user, [user()], { as }),
  'user.rename': define(['user', 'rename'], '修改账户名', sources.user, [user(), positional('name', '新名称', '由原账户服务核对名称和重名')], { as }),
  'user.password-reset': define(['user', 'password-reset'], '重置初始密码', sources.user, [user()], { as }, { sensitiveOutput: true }),
  'user.invite': define(['user', 'invite'], '签发邀请码', sources.user, [user()], { as }, { sensitiveOutput: true }),
  'user.delete': define(['user', 'delete'], '检查并确认删除账户', sources.user, [positional('user', '成员编号', '永久删除只接受成员编号', true, userSchema, true)], { 'dry-run': flag('只检查', '不能和 --confirm 同时使用'), json: flag('JSON 输出', '输出检查或回执'), confirm: flag('确认删除', '确认须带原检查的 operation-id'), 'operation-id': text('操作编号', '照抄检查返回的编号'), 'expected-state': text('检查状态', '照抄检查返回值'), epoch: text('检查代数', '照抄检查返回值'), as }, { rules: [{ not: { required: ['confirm', 'dry-run'], properties: { confirm: { const: true }, 'dry-run': { const: true } } } }], validationNotes: ['永久删除的预览、确认、operation-id 校验仍全部由原处理函数执行'] }),
  'team.create': define(['team', 'create'], '建立团队', sources.team, [positional('name', '团队名', '由 records 校验名称，团队不嵌套')], {}),
  'team.list': define(['team', 'list'], '列出团队', sources.team, [], {}),
  'team.show': define(['team', 'show'], '查看团队', sources.team, [team()], {}),
  'team.delete': define(['team', 'delete'], '删除团队并撤回其分配', sources.team, [team()], {}),
  'team.add': define(['team', 'add'], '加入团队成员', sources.team, [team(), user()], {}),
  'team.remove': define(['team', 'remove'], '移出团队成员', sources.team, [team(), user()], {}),
  'token.issue': define(['token', 'issue'], '签发令牌', sources.token, [user()], { label: text('标签', '至多 100 字符，无控制字符'), raw: flag('原始输出', '只在 stdout 一次性输出令牌'), as }, { sensitiveOutput: true }),
  'token.revoke': define(['token', 'revoke'], '撤销令牌', sources.token, [positional('token', '令牌编号', '令牌编号，不是令牌值', true, tokenSchema)], { as }),
  'token.list': define(['token', 'list'], '列出令牌', sources.token, [{ ...user(), required: false }], {}),
  'pack.publish': define(['pack', 'publish'], '发布包目录', sources.pack, [positional('directory', '目录', 'Hub 所在机器上的包目录')], { stage: flag('按清单暂存', '只复制 pack.json 列出的文件'), 'dry-run': flag('只检查', '执行发布检查但不保存发布记录'), 'answer-request': repeated('作答请求', '可重复，值为待作答的请求摘要') }),
  'pack.assign': assign('assign'), 'pack.unassign': assign('unassign'),
  'pack.install': define(['pack', 'install'], '安装通用技能', sources.pack, [positional('pack', '通用技能版本', '已发布的技能包号@精确版本，安装后沿现有全员规则可用', true, stringSchema, true)], {}),
  'pack.uninstall': define(['pack', 'uninstall'], '卸载通用技能', sources.pack, [positional('pack', '通用技能', '包号，不带版本；旧运行仍按冻结摘要复核', true, packSchema, true)], {}),
  'pack.activate': define(['pack', 'activate'], '启用产品知识来源', sources.pack, [positional('pack', '产品知识来源', '已发布的产品包号，不带版本；由原 registry 核验', true, packSchema, true)], {}),
  'pack.deactivate': define(['pack', 'deactivate'], '停用产品知识来源', sources.pack, [positional('pack', '产品知识来源', '已启用的产品包号，不带版本', true, packSchema, true)], {}),
  'pack.retire': define(['pack', 'retire'], '退役包版本', sources.pack, [positional('pack', '包版本', '已发布的包号@精确版本；已有运行仍可读取和完成，由原 registry 核验', true, stringSchema, true)], {}),
  'pack.grant-publish': define(['pack', 'grant-publish'], '授予发布权', sources.pack, [user()], {}),
  'pack.revoke-publish': define(['pack', 'revoke-publish'], '撤回发布权', sources.pack, [user()], {}),
  'resource.add': define(['resource', 'add'], '接入业务系统资源', sources.resource, [positional('system-pack', '业务系统接入包', '已发布的系统包号或号@版本', true, stringSchema, true)], { ...resourceOptions, ...resourceAudienceOptions, name: { ...resourceOptions.name, required: true }, environment: { ...resourceOptions.environment, required: true }, origin: { ...resourceOptions.origin, required: true } }, { rules: [{ not: { required: Object.keys(resourceAudienceOptions), properties: { all: { const: true } } } }], validationNotes: ['所需角色、凭据项和设置来自选定系统包；不预设产品字段', '未指定 --all 或 --team 时不分配；接入和分配分步执行，分配未确认时资源仍已添加'] }),
  'resource.update': define(['resource', 'update'], '更新资源接入配置', sources.resource, [resource()], { 'system-pack': text('业务系统接入包', '新的已发布系统包引用', { dynamicChoices: true }), ...resourceOptions, 'clear-plaintext': flag('清除明文许可', '不能与 --allow-plaintext 同时提供') }, { rules: [{ not: { required: ['clear-plaintext', 'allow-plaintext'], properties: { 'clear-plaintext': { const: true } } } }] }),
  'resource.assign': resourceAssign('assign'), 'resource.unassign': resourceAssign('unassign'),
  'secret.set': define(['secret', 'set'], '设置命名密钥', sources.secret, [], { name: { ...secretOptions.name, required: true }, digest: secretOptions.digest, short: secretOptions.short, reason }, { stdin: [{ keysFromOption: 'name', sensitive: true, description: '每个命名密钥对应一个 readSecret(name) 输入；绝不进入 argv 或公开形状' }] }),
  'secret.unset': define(['secret', 'unset'], '撤回命名密钥', sources.secret, [], { name: { ...secretOptions.name, required: true, maxItems: 1 }, reason }, { validationNotes: ['只允许一个 --name；数量及不可逆操作仍由原服务检查'] }),
  'secret.show': define(['secret', 'show'], '查看密钥登记', sources.secret, [], { name: { ...secretOptions.name, required: true, maxItems: 1 }, history: secretOptions.history }, { validationNotes: ['只允许一个 --name；不显示密钥值'] }),
  'secret.list': define(['secret', 'list'], '列出密钥登记', sources.secret, [], {}),
  'secret.import': define(['secret', 'import'], '从显式环境文件导入密钥', sources.secret, [], { 'env-file': { ...secretOptions['env-file'], required: true }, key: secretOptions.key, basic: secretOptions.basic, digest: secretOptions.digest, short: secretOptions.short, reason, 'dry-run': secretOptions['dry-run'] }, { rules: [{ anyOf: [{ required: ['key'] }, { required: ['basic'] }] }], validationNotes: ['环境文件只由原导入命令显式读取；不会导出文件内容'] }),
  'executor.add': define(['executor', 'add'], '登记执行器', sources.executor, [positional('file', '定义文件', '本机 CLI 的 JSON 文件；网页使用上传原件引用，credential 为命名密钥引用', false)], { ...executorOptions, name: { ...text('执行器名字','管理员明确指定的稳定名字，不是目标或内部编号'), required:true }, reference: uploadedReference }, { rules: sourceRules, variants: sourceVariants([]) }),
  'executor.update': define(['executor', 'update'], '更新执行器定义', sources.executor, [positional('executor', '执行器', '现有执行器编号', true, stringSchema, true), positional('file', '定义文件', '本机 CLI 的 JSON 文件；网页使用上传原件引用', false)], { ...executorOptions, reference: uploadedReference }, { rules: sourceRules, variants: sourceVariants(['executor']) }),
  'executor.name': define(['executor','name'],'给现有执行器命名',sources.executor,[positional('executor','现有执行器编号','仅用于定位待命名对象'),positional('name','明确名字','不从目标或编号自动生成')],executorOptions),
  'executor.list': define(['executor', 'list'], '列出执行器', sources.executor, [], executorOptions),
  'executor.disable': define(['executor', 'disable'], '停用执行器', sources.executor, [positional('executor', '执行器', '现有执行器编号', true, stringSchema, true)], executorOptions),
  'executor.assign': executorAssign('assign'), 'executor.unassign': executorAssign('unassign'),
  'doc.put': define(['doc', 'put'], '登记命名文档', { file: 'hub/server/cli-admin.ts', symbol: 'docCommand' }, [positional('name', '文档名', '命名文档的固定名称，由既有文档服务校验'), positional('file', '文档文件', '本机 CLI 的文件；网页使用上传原件引用', false)], { reference: uploadedReference }, { rules: sourceRules, variants: sourceVariants(['name']) }),
  'lease.register': define(['lease', 'register'], '登记租约前缀归属', leaseSource, [leasePrefix()], { owner: text('登记所有者', '启用的账户名或编号；由原命令核对', { required: true, dynamicChoices: true }), reason: maintenanceReason, as }),
  'lease.unregister': define(['lease', 'unregister'], '注销租约前缀登记', leaseSource, [leasePrefix()], { reason: maintenanceReason, as }),
  'lease.release': define(['lease', 'release'], '强制释放租约键', leaseSource, [positional('key', '租约键', '原命令在释放前及事务守卫内核对未终态作业；本地释放不证明远端停止', true, stringSchema, true)], { reason: maintenanceReason, as }),
  'bed.baseline.record': define(['bed', 'baseline', 'record'], '登记干净基线', bedSource, [bedExecutor()], { probe: text('探针', '执行器声明的探针编号，由原服务核验', { required: true, dynamicChoices: true }), reason: text('说明', '可选的登记说明') }),
  'bed.hold.clear': define(['bed', 'hold', 'clear'], '结清运行环境占用', bedSource, [bedExecutor()], { reason: maintenanceReason }),
  'knowledge.sync': define(['knowledge', 'sync'], '同步知识来源', { file: 'hub/knowledge/cli.ts', symbol: 'parseKnowledgeSyncArgs' }, [], { product, line, 'dry-run': flag('只检查', '不保存同步产物'), recheck: flag('重新检查', '重新核对已知来源'), 'include-unreleased': flag('包含未发布构建', '同步未标为已发布的构建'), 'max-age': text('来源缓存秒数', '原解析允许 0 或至多 10 位十进制非负整数秒；0 强制重新读取', { schema: { type: 'string', pattern: '^(0|[1-9][0-9]{0,9})$' } }) }),
  'knowledge.seed': define(['knowledge', 'seed'], '建立版本线知识树', { file: 'hub/knowledge/seed.ts', symbol: 'parseKnowledgeSeedArgs' }, [], { product, line: { ...line, required: true }, build: text('构建', '可选的实际构建名', { dynamicChoices: true }), basis: text('理由', '去除首尾空白后 1–500 字，单行；原知识解析器执行此校验', { required: true }), 'dry-run': flag('只检查', '不保存产物') }),
  'knowledge.reproject': define(['knowledge', 'reproject'], '重做已有知识投影', { file: 'hub/knowledge/reproject.ts', symbol: 'parseKnowledgeReprojectArgs' }, [positional('product', '产品', '产品名或产品号', true, stringSchema, true), positional('line', '版本线', '已有版本线', true, stringSchema, true)], {}),
  'knowledge.retract': define(['knowledge', 'retract'], '撤回已有知识依据', sources.knowledge, [], { entry: repeated('条目记录', '条目记录摘要'), run: repeated('运行', '运行编号'), object: repeated('对象', '对象摘要'), reason }, { rules: [{ anyOf: [{ required: ['entry'] }, { required: ['run'] }, { required: ['object'] }] }] }),
} as const;
export type CommandParameterId = keyof typeof COMMAND_PARAMETERS;

type ParseOptions<O extends Record<string, Option>> = { [K in keyof O]: Pick<O[K], 'type'> & (O[K] extends { multiple: true } ? { multiple: true } : {}) };
export function commandParseOptions<K extends CommandParameterId>(id: K): ParseOptions<(typeof COMMAND_PARAMETERS)[K]['options']> {
  const definition: Definition = COMMAND_PARAMETERS[id];
  return Object.fromEntries(Object.entries(definition.options).map(([name, option]) => [name, { type: option.type, ...(option.multiple ? { multiple: true } : {}) }])) as ParseOptions<(typeof COMMAND_PARAMETERS)[K]['options']>;
}

export function parseCommandParameters<K extends CommandParameterId>(id: K, argv: readonly string[]) {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: commandParseOptions(id) as Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) { throw new UsageError(error instanceof Error ? error.message : String(error)); }
  const definition = COMMAND_PARAMETERS[id], count = parsed.positionals.length;
  if (count < definition.minimum || count > definition.maximum) throw new UsageError(`需要 ${definition.minimum === definition.maximum ? definition.minimum : `${definition.minimum} 至 ${definition.maximum}`} 个参数，给了 ${count} 个`);
  return parsed;
}

function fieldSchema(field: Parameter | Option): Schema {
  const scalar = { ...('type' in field && field.type === 'boolean' ? { type: 'boolean' } : stringSchema), ...field.schema, title: field.label, description: field.description };
  return 'multiple' in field && field.multiple ? { type: 'array', minItems: 1, ...('maxItems' in field && field.maxItems !== undefined ? { maxItems: field.maxItems } : {}), items: scalar } : scalar;
}
export function commandParameterShape(id: CommandParameterId, choices: DynamicChoices = {}) {
  const definition: Definition = COMMAND_PARAMETERS[id], properties: Record<string, Schema> = {}, fields: Array<Parameter & { location: 'positional' | 'option'; multiple?: true; choices?: readonly { value: string; label: string }[] }> = [];
  for (const parameter of definition.positionals) {
    const selected = parameter.dynamicChoices ? choices[parameter.name] : undefined;
    properties[parameter.name] = { ...fieldSchema(parameter), ...(selected ? { enum: selected.map(item => item.value) } : {}) };
    fields.push({ ...parameter, location: 'positional', ...(selected ? { choices: selected } : {}) });
  }
  for (const [name, option] of Object.entries(definition.options)) {
    if (option.hidden) continue;
    const selected = option.choices ?? (option.dynamicChoices ? choices[name] : undefined), schema = fieldSchema(option);
    if (selected) {
      if (option.multiple) schema.items = { ...(schema.items as Schema), enum: selected.map(item => item.value) };
      else schema.enum = selected.map(item => item.value);
    }
    properties[name] = schema;
    fields.push({ name, label: option.label, description: option.description, required: option.required === true, schema, location: 'option', ...(option.multiple ? { multiple: true } : {}), ...(selected ? { choices: selected } : {}) });
  }
  const required = [...definition.positionals.filter(parameter => parameter.required).map(parameter => parameter.name), ...Object.entries(definition.options).filter(([, option]) => option.required && !option.hidden).map(([name]) => name)];
  return { id, path: [...definition.path], description: definition.description, source: definition.source, fields, argumentSchema: { type: 'object', properties, required, additionalProperties: false, ...(definition.rules.length ? { allOf: definition.rules } : {}) }, stdin: definition.stdin, sensitiveOutput: definition.sensitiveOutput, validationNotes: definition.validationNotes };
}

export function commandParameterHelp(id: CommandParameterId): string {
  const definition: Definition = COMMAND_PARAMETERS[id];
  const args = definition.variants.length
    ? ['(' + definition.variants.map(variant => [...variant.names.map(name => `<${definition.positionals.find(parameter => parameter.name === name)!.label}>`), ...(variant.present ? [`--${variant.option}=<${definition.options[variant.option].label}>`] : [])].join(' ')).join(' | ') + ')']
    : definition.positionals.map(parameter => parameter.required ? `<${parameter.label}>` : `[<${parameter.label}>]`);
  const variantOptions = new Set(definition.variants.map(variant => variant.option));
  for (const [name, option] of Object.entries(definition.options)) if (!option.hidden && !variantOptions.has(name)) {
    const argument = `--${name}${option.type === 'boolean' ? '' : ` <${option.label}>${option.multiple ? '…' : ''}`}`;
    args.push(option.required ? argument : `[${argument}]`);
  }
  return [...definition.path, ...args].join(' ');
}

const validator = new AjvJsonSchemaValidator();
export function buildCommandArgv(id: CommandParameterId, values: Record<string, unknown>): string[] {
  const definition: Definition = COMMAND_PARAMETERS[id], shape = commandParameterShape(id);
  if (!validator.getValidator(shape.argumentSchema)(values).valid) throw new UsageError('参数不符合命令登记；请核对必填项、范围和互斥选项');
  const variant = definition.variants.find(candidate => Object.hasOwn(values, candidate.option) === candidate.present), names = variant?.names ?? definition.positionals.map(parameter => parameter.name);
  const argv = [...definition.path];
  for (const name of names) if (values[name] !== undefined) argv.push(String(values[name]));
  for (const [name, option] of Object.entries(definition.options)) {
    if (option.hidden || values[name] === undefined || values[name] === false) continue;
    if (option.type === 'boolean') argv.push('--' + name);
    else for (const value of option.multiple ? values[name] as string[] : [values[name]]) argv.push(`--${name}=${String(value)}`);
  }
  return argv;
}
