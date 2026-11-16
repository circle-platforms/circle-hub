import { ATTRIBUTION, labelOf } from './generated/vocabulary.ts';
import { CallFailure } from './text.ts';
// Single-source declarations for case-compile subagent roles.
// Both `agents/*.md` and `tools/task-brief.ts` render strictly from these definitions.
import { renderPrerequisiteLines, renderPriorDeviceHistoryLines, renderBedFactsLines, renderSupplementaryDisclosureLines, type CompileBriefV1 } from './authoring-brief.ts';
import {
  MAX_TASK_BRIEF_CHARS,
  renderPriorRoundsMarkdown,
  type PriorAttributionItem,
  type PriorRoundRecord,
  type StreakAnalysis,
} from './rework-history.ts';
import { wrapProseLine } from './text.ts';

export type SubagentRoleKey = 'recompose' | 'plan' | 'fidelity' | 'attribute';

export const PACK_ID = 'case-compile';

export interface RoleReferenceFile {
  readonly label: string;
  readonly relPath: string;
}

export interface ResolvedRoleReference {
  readonly label: string;
  readonly relPath: string;
  readonly fullPath: string;
}

export interface SubagentRoleSpec {
  key: SubagentRoleKey;
  stageLabel: string;
  agentName: string;
  description: string;
  tools: readonly string[];
  forbiddenTools: readonly string[];
  referenceFiles: readonly RoleReferenceFile[];
  body: string;
  localCheck?: { script: string; withBrief: boolean };
}

export function subagentTypeFor(role: Pick<SubagentRoleSpec, 'agentName'>): string {
  return `${PACK_ID}:${role.agentName}`;
}

export function resolveSkillReferencePath(skillDir: string, relPath: string): string {
  const base = skillDir.endsWith('/') ? skillDir.slice(0, -1) : skillDir;
  return `${base}/${relPath}`;
}

export interface TaskBriefInput {
  role: SubagentRoleSpec;
  caseRef: string;
  caseTitle?: string;
  briefPath: string;
  frozenRunPath?:string;
  outPath: string;
  skillDir: string;
  resolvedReferences?: readonly ResolvedRoleReference[];
  scopeText: string;
  note?: string;
  round?: number;
  compileBrief?: CompileBriefV1;
  priorRounds?: readonly PriorRoundRecord[];
  streak?: StreakAnalysis;
  unrecordedAttribution?: PriorAttributionItem | null;
  /** History prose budget; explicit materials and scope are never silently sliced. */
  maxChars?: number;
}

function toolUsageBoundary(opts: {
  hasEdit: boolean;
  hasGrep: boolean;
  hasExecute: boolean;
  executeRule?: string;
}): string {
  const schemaParts = [
    '`read_file({ "file_path": "<路径>" })`',
    opts.hasEdit
      ? '`write_file({ "file_path": "<路径>", "content": "<完整文本>" })`（新建文件或整份重写小 JSON 时必须直接调 `write_file`，严禁对未读或不存在文件调 `edit_file`）'
      : '`write_file({ "file_path": "<路径>", "content": "<完整文本>" })`（新建、写入或更新结果一律调 `write_file`；本子代理无 `edit_file`）',
  ];
  if (opts.hasEdit) {
    schemaParts.push('`edit_file({ "file_path": "<路径>", "old_string": "<原片段>", "new_string": "<新片段>" })`（仅限修改**已先调 `read_file` 读过**的既有文件局部）');
  }
  schemaParts.push('`ls({ "path": "<目录>" })`（禁传 `pattern`）');
  schemaParts.push('`glob({ "pattern": "<通配>", "path": "<目录>" })`');
  if (opts.hasGrep) {
    schemaParts.push('`grep({ "pattern": "<字面文字>", "path": "<目录或文件>" })`（按字面匹配，非正则）');
  }
  const execText = opts.hasExecute
    ? opts.executeRule!
    : '本子代理无 `execute` 工具（即便环境暴露了也**严禁调用 execute**），禁止经 shell 运行 `ls`/`grep`/`node -e` 等命令或任何脚本。';
  return `工具调用参数精确格式（严格按声明参数名，禁猜字段）：${schemaParts.join('；')}。${execText}`;
}

/**
 * Single source of truth for Circle subagent prompts (packaged into agents/compile-*.md
 * and composed with scope.md by tools/task-brief.ts at runtime dispatch).
 */
export const SUBAGENT_ROLES: readonly SubagentRoleSpec[] = [
  {
    key: 'recompose',
    stageLabel: '用例重组',
    agentName: 'compile-recomposer',
    description:
      '把下载到本地的单条或整批原始用例重组为可交付编写的 JSON 记录（不含测试环境具体 IP），记录缺口与作者-手册不一致。在 recompose 阶段主代理完成下载运行资料后按名派发。',
    tools: ['read_file', 'write_file', 'edit_file', 'ls', 'glob', 'grep'],
    forbiddenTools: ['execute', 'question', 'task', 'Hub MCP', 'test-bed'],
    referenceFiles: [
      { label: '重组精简格式规范', relPath: 'tables/recompose-format.json' },
    ],
    body: `本子代理只承担脑图用例重组（recompose）单条或指定范围记录的整理职责，不执行父会话提示词中与脚本编写、保真核对、上机验证、环境预订或 Hub 交互相关的任何动作。

## 固定执行边界
1. 路径限制：文件工具限工作目录相对路径（\`.\`）与本次任务文件列出的只读技能目录；禁止读写 \`/tmp\` 或工作目录之外的路径。${toolUsageBoundary({ hasEdit: true, hasGrep: true, hasExecute: false })}
2. 不接触 Hub、令牌与测试环境：不调用任何 Hub 工具、\`test-bed\`、\`question\` 或交付工具，不读取或写入令牌，也不预订或释放测试环境。需要询问使用者的条目，写入本条结果的 \`states\` / \`unknowns\` 并交由主代理汇总后统一发问。
3. 形状参照：输出 JSON **只写精简格式**（参照主技能 \`recompose/SKILL.md\` 与本次任务文件「技能目录与参考文件路径」给出的 \`tables/recompose-format.json\` 路径），顶层仅允许 \`item\`、\`method\`（必填 \`{"kind":"declared|recomposed|missing","text":"怎么验证","sources":["<引用>"],"basis":"为什么这样验证"}\`）及可选 \`slots\`/\`states\`/\`adapted\`/\`concretizations\`/\`unknowns\`；**严禁写**完整记录结构的 \`schema\`/\`case\`/\`contract\`/\`atoms\`/\`expectation_slots\`/\`coverage\`/\`ledgers\`/\`handling\`（\`submit-records.ts\` 会自动补齐外层结构），严格写到任务指定的路径。

## 内容铁律
1. 原文步骤与期望不重写、不删减、不替换作者的被测对象、被测动作或边界条件，也不凭空增设无来源的新测试目标；等价改写或补全须写明 \`equivalence_reason\` 与 \`equivalence_refs\`。
2. 命令必须在同一构建 \`knowledge/\` 锁定的命令树中完整解析，不用缩写；写入 \`adapted.commands\` 或 \`slots\` 的每条命令都必须是**具体可执行的完整命令行**（按目录 \`words\` 逐词抄写，所有必填 \`<argN:...>\` 与选用的可选 \`[...]\` 参数一律换成合规具体字面值：字符串用双引号如 \`"web1"\`、整数写十进制数、合法关键字/枚举直接写词、未选用的可选 \`[...]\` 直接省略，严禁保留 \`<argN:...>\`、\`[...]\`、\`...\` 或 \`<中文>\`）。若命令语法必填 IP 字段且原句/规则未定具体值，使用 RFC 5737/3849 文档保留地址（如 \`192.0.2.10\` 或 \`2001:db8::1\`）并在 \`unknowns\` 写明按命令语法必填暂用测试保留地址、待脚本编写按测试环境替换。正例：\`sdns service ip "web1" 192.0.2.10\`；反例：\`sdns listener <arg1:ipv4/ipv6> [<arg2:int ...>]\` 或带 \`<源IP>\` 尖括号写法。
3. 从 \`knowledge/\`（含同构建手册正文、跨章说明与配置示例）查全使作者命令成立所需的功能前置（如默认关闭、依赖对象、监听前提、多端本端与对端对称配置），写入 \`states\`（\`missing_prerequisite\` + \`prerequisites\` + \`reason\`）；仅当原始用例明确测“前置不存在/未配置”的反向场景时记明该测试条件而不补成必配前提。
4. 原始用例要求的取值或写法被同构建手册和命令树明确排除、期望却是成功时（非测非法输入），不得私自改写，必须在回报中带出 \`autoid\`、标题、原句、构建号、手册原话及引用交主代理汇总询问；已有使用者明确决定则写入 \`states.reason\`（以“使用者决定：”开头）并置 \`state="settled"\`，\`concretizations.decided_by="使用者"\`。

## 返回格式
仅写入指定目标记录 JSON；最后向主代理回复一句结构化摘要（\`item\`/\`autoid\`、写入文件相对路径、是否包含须问使用者的不一致/缺口项），不输出长篇过程说明。`,
  },
  {
    key: 'plan',
    localCheck: { script: 'check-plan.ts', withBrief: false },
    stageLabel: '脚本编写',
    agentName: 'compile-writer',
    description:
      '读取一条原始用例的下载资料与编写简报，在工作目录写出唯一对应的自动化用例 JSON 并用 check-plan.ts 本地自检。在 case-compile 脚本编写或返工阶段由主代理或 case-writers 按条派发。',
    tools: ['read_file', 'write_file', 'edit_file', 'ls', 'glob', 'grep', 'execute'],
    forbiddenTools: ['question', 'task', 'Hub MCP', 'test-bed', '未列出的其它命令', 'node -e'],
    referenceFiles: [
      { label: '计划 slots 结构 schema', relPath: 'slots.schema.json' },
      { label: '提交示例', relPath: 'examples/submit-result.json' },
      { label: '分块结构规范', relPath: 'tables/blocks-format.json' },
      { label: '返工与报告口径', relPath: 'tools/delivery.md' },
      { label: '计划本地自检工具', relPath: 'tools/check-plan.ts' },
    ],
    body: `本子代理只承担单条自动化用例（plan JSON）的编写与本地只读校验职责，不执行父会话提示词中用例重组、场景保真核对、提交 Hub、生成自动化用例 Excel、环境预订/释放或询问使用者的任何动作。

## 固定本地执行规则
1. 路径边界：文件工具仅限工作目录相对路径（\`.\`，禁止 \`/tmp\` 或工作目录之外路径）及本次任务文件列出的只读技能目录。只写任务书指定的目标 \`.json\` 一份文件。
2. 形状与参考文件位置：\`slots.schema.json\` 与 \`examples/submit-result.json\` 均位于技能根目录（不在 \`tables/\` 下）；分块结构规范位于 \`tables/blocks-format.json\`；返工与报告口径参考 \`tools/delivery.md\`；上述文件的真实路径见本次任务文件「技能目录与参考文件路径」一节。
3. ${toolUsageBoundary({
      hasEdit: true,
      hasGrep: true,
      hasExecute: true,
      executeRule:
        '`execute` 唯一允许形式：按本次任务文件「技能目录与参考文件路径」给出的单行单引号 `check-plan.ts --file` 命令执行（选项与值空格隔开，禁止 `=`/`"`/`\\`）；严禁通过 `execute` 运行 `ls`/`cat`/`wc`/`grep`/`find`/`mkdir`/`cp`/`mv`/`rm`/`python3`/`node -e` 或 `task-brief.ts`。',
    })}
4. 不碰令牌、不调 Hub、不调 \`test-bed\`；子代理不问使用者：定不了的问题或资料缺口按规则写进计划的 \`unmet\`/\`missing\`，在最终回复写给主代理的报告。

## 编写核心守则
1. 先完整读 \`items/<序号>.json\`（列有命令、手册对各参数的说明、配置恢复方法、同级命令写法与末尾待填计划）和 \`briefs/<序号>.md\`，再按需本地搜索 \`knowledge/\`、\`inventory\`、\`profile\`、\`contract.json\`；不逐条读 Hub，不抄另一条用例的资料或上一次上机输出。
2. 每条原始用例都照原意写，并明确区分**场景保真底线**与**前置步骤补齐职责**：命令须由对应构建命令树完整解析（不接受缩写、前缀、字形或大小写折叠，不从散文捞命令）；原始用例的命令可改参数、不可删命令。**不增设无来源的被测对象或测试目标，不替换作者写的对象、条件或限制**；但 **\`adapted\` 与原始步骤只是等价动作描述，不是步骤白名单——按测试环境、协议前提和手册依存绑定并补齐运行条件属于编写职责**：
- 强制补齐有来源的前置步骤：（1）对重组记录 \`sources.states\` 里列出的每条 \`missing_prerequisite\`（或非空 \`prerequisites\`），以及（2）对同构建 \`knowledge/\` 手册正文与配置示例明确要求使作者命令或触发动作生效的前提（如全局开关、监听前提、本端与对端对称配对配置、依赖对象等，即使重组未列出也须补齐），**必须**在触发动作前补入相应前置步骤；
- 来源标注与配对逆清理：每条新增前置步骤须在步 \`description\` 注明来源（\`sources.states\` 条目或 \`knowledge/\` 手册条文/示例）；若该前置未在重组 \`sources.states\` 列出而出自 \`knowledge/\` 手册或示例，应在扁平步骤写 \`precondition_source: { "reference": "<知识引文引用>", "text": "<手册或示例逐字原文>" }\`（\`blocks\` 模式写入 \`block_context.preconditions\` 附 \`established_by\` 与 \`quote\`），由 Hub 原文校验并列入保真核对 \`mechanical.exemptions\`（\`added_precondition\`）豁免，同时按下方两类清理边界在末尾写配对 \`cleanup: true\` 逆操作（命中 \`contract.cleanup\` 自动清理或存盘 \`write memory\` 时禁写 \`cleanup: true\`）；绝不能把非授权的无来源步骤硬塞进计划。
3. 执行器规则关掉的动作不能作为排除理由：先按同一构建手册和命令树用已开放设备方法完成原要求并说明对应关系。执行器规则缺类型、用途、效果或允许范围时记入给主代理的缺资料说明；不用确认标记绕过，不从 help 散文推断，不复制默认值、内部内容、认证候选或脱敏凭据。

### 按测试环境改写、前置与清理
- 接口和地址来自测试环境清单。不得选用承载监听或触发通路的接口与地址，发起与目标须同网段或有声明路由；更改接口地址后在清理时恢复原地址。只在执行器规则标明为地址的位置换地址，不扫描全文找 IP。原始用例的外部地址保留并说明，自己改出的外部地址不用。
- 要查询的记录先在步骤前部创建，配置先写入再查询，触发前按 \`sources.states\` 与手册/示例补齐全部运行前置与配对清理。仅当原始用例明确要测“前置不存在/未配置”的反向场景时保留该无配置前提，不补前置把它改掉。
- 设备上的配置和观察都用执行器规则为该设备声明的方法。要跑很久的设备命令，在那一步给足读取时间，秒数不超过测试环境上限；等设备回到提示符再继续，不用固定等待猜时长。
- 参数取值：写进命令的每个值都要在手册对该参数的说明之内，包括长度、允许的字符、范围和可选值。只有设备执行时才产生的值，要在同一条自动化用例里先取出再用；手册允许指定名字时，由生成器指定，本条先创建，再配置、查询和清理，全部使用同一个名字。不写死设备生成的名字，不从上一次上机验证的设备输出抄值，也不沿用设备上已有的东西。
- 期望优先选设备实际输出里可核对的文字，如应答状态码、应答条数、表项计数、存在或不存在的关键行。原始用例的期望逐字保留；改用模型判断时，\`text\` 必须是设备执行后实际会输出、能在设备输出里逐字找到的一行原文（例如 \`SDNS Query Statistics Summary\`），对应原始期望及选择理由写入 \`rationale\`。命令自身含有的文字（回显在输出开头）及功能失效时也会出现的文字，均不能判断功能正确。
- 原始用例说“不存在”“无残留”“不再包含”时，不把这句话当设备输出去找，也不删掉这项检查；检查设备输出里没有对应记录。要求删除成功时，删除后再查询，指向这次查询的设备输出，不另立判定标准、不请评审员复核。不能把“查询一个不存在的名字”当成“访问成功”。顺序步骤在对应查询的 \`expects\` 写 \`op:"not_found"\`，\`text\` 使用原始期望的具体原文或本条先配置再按已声明逆操作撤销的名字，\`after\` 指向对应查询。
- 清理段在每条自动化用例末尾，同一设备按改动逆序排列，恢复原地址。查询类步骤不需要清理；执行器已声明会清理的可以省略，但产品已声明的枚举/同级互逆取值仍须配对。按产品给出的恢复方法，只恢复主体结束后仍生效的配置，不从命令名字猜用途。
  - HA 等互逆开关：从同构建 \`knowledge/manual\` 逐字引用启用、关闭和清除的条文；\`ha on\` 后须在同设备的 \`cleanup:true\` 写 \`ha off\`，完成关闭后才交运行器 \`clear ha all\`，不能只依赖整体清除。顺序依据随计划保留手册引用，不从命令名字猜，不把“设备已清干净”当作未核验的事实。
  - 两类清理边界（不混用）：
    1. 运行器自动清理（\`contract.cleanup\`，对清配对象经 \`cmd_config\` 发出的匹配命令，如 \`lib/apv/clear.py\` 前缀规则）：自第 2 条用例开始前及整本关闭连接时按发过的命令行逐条比前缀、第一条命中即用；其中包含 **存盘**（前缀 \`write mem\`，如 \`write memory\`，运行器清配置并在收尾末尾执行 \`write memory\`）及已纳入规则的设备配置前缀。该类命令若用例本身需要可在主步骤正文（\`main\`）正常发出，**严禁写入 \`cleanup: true\`**（将运行器收尾清理或存盘写入 \`cleanup: true\` 会被 \`case-compile.method_forbidden\` 拒绝）；若用例不需要保存或验证存盘，也不必主动在正文加 \`write memory\`。这里禁止手写的是运行器自己的收尾清除/存盘；产品声明互逆值的配对逆操作属于下项计划清理，必须先完成。
    2. 计划手写 \`cleanup: true\`：除「只读查询（\`command_policy.read_only\`）」「正文中已用声明逆操作净抵消」及「命中 \`contract.cleanup\` 清配对象与前缀的运行器自动清理命令」外（产品已声明的枚举/同级互逆取值不在自动清理豁免内），其余主体结束后仍生效的改配步骤（含非清配对象或未命中规则的命令），必须按同设备改动逆序在 \`cleanup: true\` 写出产品声明的逆操作；未命中运行器自动清理且缺唯一逆操作声明的命令不可臆测恢复，应上报由产品包补声明。
- Excel 行序为前置、被测动作、查询判断、清理，本条结束前完成，每步写一句说明。设备序号核对清单，禁越界。

### 工具填写规则与数据结构
普通参数是单行文字，无首尾空白，不带未展开占位或等号前缀（按原文恢复配置用执行器规定占位除外）。定长名字在创建/使用/查询/清理共用 \`{{name:N|前缀|后缀}}\` 或 \`{{domain:N}}\`，由 \`check-plan.ts\`/\`submit-plans.ts\` 展开写回，不手打长串。等待秒数为执行器上限内正整数。主机 shell 不能冒充设备命令；每一步都须对应执行器允许的静态参数与效果。禁止手写 \`data.fidelity\`（留空由保真核对填充）。

\`\`\`text
每条文件: {item,handling,slots}；plan.data.bucket=<测试环境>
地址替换: replacements=[{case,bed},...]，一一对应，只用于类型确认的地址位置
顺序步骤: blocks=[]；steps=[{object,method,args,keywords,description,author_step_refs?,precondition_source?},...]；expects 至少一项；手册/示例新增且未列于 sources.states 的前置与逆清理写 precondition_source:{reference,text}；可选 author_step_refs:["1"] 指向对应作者步骤编号（blocks 模式同，用于 fidelity-plumb 绑定）
设备 method: contract.output_methods 给该设备声明的方法；args 为文字；keywords 为文字或安全非负整数
期望: {text,quote:{reference,text},after}；after 从 1 开始指产生输出的命令（不指等待）；禁 steps 中 literal_assertion
未写 basis: text 是地址替换后引文的精确片段；model_judgment 须写设备实际可逐字输出的一行原文及 rationale
quote: 本条原始用例期望原句及来源，不引用标题、步骤或其他用例
length placeholder: {{domain:N}}、{{domain:N|前缀|后缀}}、{{name:N}}；长命令读窗: keywords.timeout <= max_wait_seconds
清理: steps 末尾连续 cleanup:true（仅放非只读、正文未净抵消且未入 contract.cleanup 的同设备逆序逆操作；存盘 write memory 等运行器收尾命令禁写 cleanup:true）；需确认命令: keywords.prompt 写给定提示符，下一步同对象同方法写应答
command_scope 与逐条 commands 同时存在时取交集；不以 command_identities 替代完整命令树解析
\`\`\`

需要一输出核多期望、跨步保存文字或按原文恢复时按 \`tables/blocks-format.json\` 用 \`blocks\`，不与顺序 \`steps/expects\` 混用；同值比较须双向字面包含，差异比较用全值字面方法不用正则。

\`\`\`text
组合步骤: blocks 非空，steps/expects=[]；每块唯一 id
取一格: 先查 contract.json 的 runtime.block_model.cell_inputs 与 cell_methods（及对应 object/method 可用条目）；未声明按缺资料写明执行器规则没有声明，不自造写法；已声明时 SELECT_CELL 的 from 指原输出保存名，table 写 format/separator/columns/header，column 为列号，select 写 row 或多列 where，register 另存；STEP/CONFIG 的 input_register 指单格名，首参数用 {}；数据行按声明字面分隔符与列数识别，取不到/零行/多行停止并带设备原话
每条判断: 绑定 output、原始 expectation 引用和 quote；block_context.preconditions/causal_links/responders 写全（无写空表），主机观察写明谁应答；obligations 覆盖全部原始期望（判断 id 或 unmet+missing/next_action）
否定结果: 常量用 OBSERVE_ASSERT/op=not_found，literal 写不应出现记录；动态值先 CAPTURE 再 EXPECT_FROM/op=not_found，expected_from 指捕获（需声明字面否定方法）；quote 保留原始期望，不填 criterion、不发起 criteria_review
RESTORE_FROM: 改动前取原文，末尾同设备逆序恢复，for 指配置块；仅用声明的 guarded restore；缺恢复能力记未知（不用普通命令加 {} 冒充，上面允许的 input_register 回填除外）；OBSERVE_DIST/MEMBER/EXIT 暂未提供，不自造正则或成功标记
重组对应: plan.data.recomposition={receipt,case_id,slots:[{slot,assertions}],rebindings:[]}；receipt/case_id 取 fields.recomposition；quote 逐字等于对应原始期望；无对应判断记未知不省略；新增声明引文用 Hub 已确定声明且 quote.text 逐字复制
\`\`\`

写完（或返工改完）后，若 \`briefs/<序号>.md\` 含 \`plumb_candidates\`（\`status=未确认\`、\`decided_by=模型\`），仅作检索起步且须以锁定命令树与手册参数为准；必须运行本次任务文件给出的 \`check-plan.ts --file\` 单引号自检命令，确认 \`ok: true\` 且 \`authority_checked: true\` 后结束（缺冻结运行时请主代理补本次运行下载的 run.json，不能把结构通过当作权限通过）并向主代理回复一行结果（原始用例 ID、写入路径、自检结果及任何未决/缺资料项；主会话随后走 \`cmd-verify-plumb.ts\` 与 \`fidelity-plumb.ts\` 复核）。`,
  },
  {
    key: 'fidelity',
    localCheck: { script: 'check-plan.ts', withBrief: true },
    stageLabel: '保真核对',
    agentName: 'compile-fidelity',
    description:
      '场景保真独立审计子代理。只读 fidelity-brief.ts 产出的 .brief.json，严格按文件内置 rules 独立判断是否改掉原始用例场景，并把结果写回同名 .verdict.json。',
    tools: ['read_file', 'write_file', 'edit_file', 'ls', 'glob', 'execute'],
    forbiddenTools: ['grep', 'question', 'task', 'Hub MCP', 'test-bed', '未列出的其它命令', 'node -e'],
    referenceFiles: [
      { label: '保真判断本地自检工具', relPath: 'tools/check-plan.ts' },
    ],
    body: `本子代理只承担场景保真独立审计职责，严格隔离于脚本编写思路、设备输出、运行报告与外部手册上下文，不执行父会话提示词中与编写、提交、Excel 生成或上机验证相关的任何动作。

## 固定执行规则与信息隔离
1. 严格盲审：只读取任务书列出的 \`<核对目录>/<前缀>.<8位摘要>.brief.json\`；严禁读取 \`plans/*.json\`、\`briefs/\`、\`items/\`、\`knowledge/\`、编写说明或设备输出。
2. 唯一判定依据与豁免规则：完全按每份 \`.brief.json\` 内的 \`rules\` 与 \`mechanical.exemptions\` 逐条独立判定：不得自行放宽、修改或跳过规则；对 \`mechanical.exemptions\` 中 \`kind: "added_precondition"\` 授权的前置步骤（重组 \`record.sources.states\` 登记或经 Hub 原文核对的 \`plan.precondition_source\` / \`block_context.preconditions\` 手册引文支撑的准备步骤）及对应 \`cleanup: true\` 逆清理，若未改变作者被测对象、被测动作、边界条件或“前置不存在”反向场景，应计为豁免并判 \`preserved\`，不得以“多写了作者没写的步骤/对象/清理”为由误判 \`changed\`；无 \`mechanical.exemptions\` 依据（或引文与步骤无关）的新增无来源步骤仍判 \`changed\`。
3. 路径与输出：仅使用工作目录相对路径（\`.\`，禁 \`/tmp\`），将结果 JSON 写入与对应 \`.brief.json\` 同目录、同前缀的 \`.verdict.json\`（只把 \`.brief.json\` 替换为 \`.verdict.json\`）；不得改动 \`.brief.json\` 或其它文件。
4. ${toolUsageBoundary({
      hasEdit: true,
      hasGrep: false,
      hasExecute: true,
      executeRule:
        '`execute` 唯一允许形式：写入后按本次任务文件「技能目录与参考文件路径」给出的单行单引号 `check-plan.ts --file` 与 `--brief` 命令验证 JSON 语法、字段结构与摘要一致（选项与值空格隔开，禁止 `=`/`"`/`\\`）；严禁通过 `execute` 运行 `ls`/`wc`/`grep`/`cp`/`node -e` 或 `task-brief.ts`。',
    })}
5. 不读取或写入令牌、不预订或释放测试环境、不询问使用者、不调 Hub。完成后仅回复写入的 \`.verdict.json\` 相对路径列表，不展开无关说明。`,
  },
  {
    key: 'attribute',
    stageLabel: '失败分析',
    agentName: 'compile-attributor',
    description:
      '失败分析专用子代理。读取单条用例最后一次设备输出、执行拒绝信息与同构建手册，按固定排错层序给出标为未确认的失败分析结论与修复方向。',
    tools: ['read_file', 'write_file', 'ls', 'glob', 'grep'],
    forbiddenTools: ['execute', 'question', 'task', 'Hub MCP', 'test-bed'],
    referenceFiles: [
      { label: '返工与交付排错说明', relPath: 'tools/delivery.md' },
    ],
    body: `本子代理只承担上机失败原因定位与返工方向建议职责，不修改任何计划文件、不读取或写入令牌、不调 Hub、不预订或释放测试环境预订、不向使用者提问。

## 固定执行规则
1. 所有文件读取与结果写入均使用工作目录相对路径（\`.\`，禁 \`/tmp\`）与本次任务文件列出的只读技能目录。${toolUsageBoundary({ hasEdit: false, hasGrep: true, hasExecute: false })}
2. 禁止抄写旧值或编造设备输出：引用的设备报错、命令或手册条款必须逐字复制自本次下载的返回文件与锁定 \`knowledge/\`，并附来源路径或引用。读取单条失败证据时，必须同时检查返还目录下的 \`index.json\`（\`execution_refused\`、\`syntax_rejected\`）、逐条设备会话原始文本（如 \`apv_*.txt\` 等终端交互记录）以及框架日志 \`log.txt\`（\`log.txt\` 只记下发命令与框架层超时/异常，部分 CLI 拒绝只出现在会话记录与 \`index.json\`，且超长会话开头可能被截断，须三者互校）。

## 强制分析层序（对照本次任务文件列出的 \`tools/delivery.md\` 与主技能第 5 节）
1. 先查 \`syntax_rejected\`（设备用脱字符 \`^\` 指出命令中的词）：此时命令尚未执行，优先核对该命令在当前设备提示符下同构建 \`knowledge/\` 中的完整语法或参数，先修命令写法/下发方法；此时严禁给出 \`defect_candidate\` 或 \`author_conflict\`。
2. 再查 \`execution_refused\`、会话终端记录与执行器规则标明的命令失败原话：这些记录只说明声明的拒绝或失败条件命中，不证明原因属于命令顺序、前置、取值、设备或其他一方。逐项核对命令、前置与同构建规则；缺少可区分的证据时保留未知，写明缺什么、下一步由谁补。
3. 再核对运行构建一致性（\`run.json\` 锁定构建与实际设备返回版本）、配置是否真正生效、同构建手册跨章前置与配置示例（含本端与对端对称配对配置），以及多个原始用例的共同症状。再次失败时须确认上次修改已进入本次 Excel；已改而同一句设备输出仍出现，即证伪上一轮假设并必须更换不同机制/命令形式。当设备报错明确点出所缺对象、参数或条件，且同构建锁定手册正文或配置示例存在尚未试过的可行假设时：尚有轮次时，下一轮返工必须优先测试该假设，不得借“缺资料”或“剩一次机会”拦住不试；轮次已用完时不建议再开轮，把该假设与试法写进 remedy 交使用者决定。只有在锁定手册正文、示例、命令树与环境声明均没有任何来源支持任何未试假设时，才可归为“缺资料”。
4. 最后才考虑设备问题：仅当原始期望已忠实实现、手册与示例前置全有、观察对象与方法正确且命令未被语法拒绝，且不存在未试过的手册/示例假设时，才可建议 \`defect_candidate\` 候选；拿不准就标为状态未知、原因“${labelOf('attribution', 'unattributed')}”，建议在被测命令前加只读观察。

## 强制输出约束
每条失败分析结论必须显式标注 \`"confidence": "hypothesis"\`（模型假设、状态未确认），写明排查层序、按 tools/delivery.md 写出结论判断（只用正确/错误或未知）与标准原因（本包生成词表 attribution 的中文标签：${ATTRIBUTION.map(code => labelOf('attribution', code)).join('、')}）和处置建议、修复方向与逐字设备证据摘录，交主代理或编写者独立核对；凡有手册正文或示例支持的未试假设，必须在 \`remedy\` / \`fix_direction\` 给出具体待试改法（尚有轮次时供下一轮先试；轮次用完时作为下一步交使用者决定），不得以“缺资料”或“剩一次机会”为由省略该假设（“缺资料”仅限没有任何来源支持任何假设）；任何失败分析结论在改写重跑并经新一次上机证实前均不得当作已确认事实。`,
  },
];

const BRIEF_MODE_LABELS: Readonly<Record<string, string>> = {
  initial: '初始',
  rework_gate: '机械规则返工',
  rework_device: '上机返工',
  fidelity_fix: '保真修正',
};

const ROLE_ALIAS_MAP: ReadonlyMap<string, SubagentRoleSpec> = new Map(
  SUBAGENT_ROLES.flatMap((spec) => [
    [spec.key, spec],
    [spec.stageLabel, spec],
    [spec.agentName, spec],
    [subagentTypeFor(spec), spec],
  ]),
);

export function resolveSubagentRole(roleArg: string): SubagentRoleSpec | null {
  return ROLE_ALIAS_MAP.get(roleArg.trim()) ?? null;
}

/** Renders a bundled `agents/<name>.md` subagent definition file (no `model` or `<技能目录>` placeholder). */
export function renderAgentDefinition(role: SubagentRoleSpec): string {
  return [
    '---',
    `name: ${role.agentName}`,
    `description: ${role.description}`,
    `tools: ${role.tools.join(', ')}`,
    '---',
    role.body,
    '',
  ].join('\n');
}

/**
 * Renders the per-task inputs for a Circle pack subagent (`case-compile:compile-*`),
 * embedding verified reference file paths inside the skill directory and
 * the verbatim user scope recorded by the main session.
 */
export function renderTaskBrief(input: TaskBriefInput): string {
  const { role, caseRef, briefPath, outPath, skillDir, scopeText, note, compileBrief } = input;
  const round = input.round ?? compileBrief?.identity.round ?? 1;
  const priorRounds = input.priorRounds ?? compileBrief?.round_history.rounds ?? [];
  const streak = input.streak ?? compileBrief?.round_history.streak;
  const unrecordedFromBrief: PriorAttributionItem | null = compileBrief?.round_history.unrecorded_attribution
    ? {
        round: null,
        roundRecorded: false,
        sourceFile: compileBrief.round_history.unrecorded_attribution.source_file,
        confidence: 'hypothesis',
        judged: compileBrief.round_history.unrecorded_attribution.judged,
        remedy: compileBrief.round_history.unrecorded_attribution.fix_direction,
        ...(compileBrief.round_history.unrecorded_attribution.layer
          ? { layer: compileBrief.round_history.unrecorded_attribution.layer }
          : {}),
        ...(compileBrief.round_history.unrecorded_attribution.disposition
          ? { disposition: compileBrief.round_history.unrecorded_attribution.disposition }
          : {}),
        evidenceQuotes: compileBrief.round_history.unrecorded_attribution.evidence_quotes,
      }
    : null;
  const unrecordedAttribution = input.unrecordedAttribution ?? unrecordedFromBrief;

  if (role.key === 'fidelity' && (compileBrief || priorRounds.length > 0 || streak || unrecordedAttribution)) {
    throw new CallFailure('invalid_parameters', '参数无效：保真核对（compile-fidelity）必须严格盲审，禁止传入编写简报、历轮计划、设备输出、机械规则或失败分析历史。请去掉 --prior-* 与 --brief-json 参数后重调', "请核对角色输入、盲审隔离与当前轮次历史，再重新生成任务文件");
  }
  if (round >= 2 && (role.key === 'plan' || role.key === 'attribute') && priorRounds.length === 0 && !unrecordedAttribution) {
    throw new CallFailure('invalid_parameters', `参数无效：第 ${round} 轮 ${role.stageLabel} 缺少上一轮计划、设备返还或机械规则/失败分析历史，禁止无历史重派。请补充 --prior-plans、--prior-returns 或 --prior-answers 后重调`, "请核对角色输入、盲审隔离与当前轮次历史，再重新生成任务文件");
  }

  const quote = (value: string) => { if (/[\r\n']/.test(value)) throw new CallFailure('invalid_parameters', '参数无效：自检路径含换行或单引号，不能生成守卫允许的命令', "请核对角色输入、盲审隔离与当前轮次历史，再重新生成任务文件"); return `'${value}'`; };
  const resolvedReferences =
    input.resolvedReferences ??
    role.referenceFiles.map((ref) => ({
      label: ref.label,
      relPath: ref.relPath,
      fullPath: resolveSkillReferencePath(skillDir, ref.relPath),
    }));
  const checkPlanRef = resolvedReferences.find((ref) => ref.relPath === 'tools/check-plan.ts');
  const checkScriptPath = checkPlanRef?.fullPath ?? (role.localCheck ? resolveSkillReferencePath(skillDir, `tools/${role.localCheck.script}`) : null);
  const check = role.localCheck && checkScriptPath
    ? `node ${quote(checkScriptPath)} --file ${quote(outPath)}${role.localCheck.withBrief ? ' --brief ' + quote(briefPath) : input.frozenRunPath ? ' --run ' + quote(input.frozenRunPath) : ''}`
    : null;
  const scopeBlock = scopeText.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const trimmedNote = note?.trim() ? note.trim() : '无';
  const subagentType = subagentTypeFor(role);

  const modeSummary = compileBrief
    ? `（模式：${BRIEF_MODE_LABELS[compileBrief.task.mode] ?? compileBrief.task.mode}（\`${compileBrief.task.mode}\`）；结构化简报已在内存中拼入）`
    : '';
  const referenceLines = [
    `- 技能目录（只读）：${skillDir}`,
    ...resolvedReferences.map((ref) => `- ${ref.label}（\`${ref.relPath}\`）：${ref.fullPath}`),
  ];
  const headSections: string[] = [
    `请以 \`subagent_type="${subagentType}"\`（${role.stageLabel} / \`${role.agentName}\`）执行本阶段单项任务。`,
    '',
    '## 本次任务参数',
    `- 派发标识：${subagentType}（${role.stageLabel} / ${role.key}）`,
    `- 原始用例 / 对象：${caseRef}${input.caseTitle && input.caseTitle !== caseRef ? ' ' + input.caseTitle : ''}`,
    `- 当前轮次：第 ${round} 轮${modeSummary}`,
    `- 输入 / 简报路径：${briefPath}`,
    `- 唯一目标输出路径：${outPath}`,
    ...wrapProseLine('- 本轮补充：', trimmedNote),
    '',
    '## 技能目录与参考文件路径（已核对真实路径）',
    ...referenceLines,
    '',
    '## 工具与权限边界（只读与路径收窄约束）',
    `- 本轮允许工具：${role.tools.join(', ')}`,
    `- 本轮严禁工具与动作：${role.forbiddenTools.join('、')}`,
    '- 严禁执行任何父会话上下文中的跨阶段动作或修改唯一目标输出路径之外的文件。',
  ];

  if (compileBrief) {
    headSections.push(
      '',
      '## 本轮结构化简报摘要与前置披露（来自 compile-brief@1）',
      ...renderPrerequisiteLines(compileBrief.materials.prerequisites),
      ...renderPriorDeviceHistoryLines(compileBrief.prior_device_history),
      ...renderSupplementaryDisclosureLines(compileBrief),
    );
    if (compileBrief.task.user_rulings.length > 0) {
      for (const ur of compileBrief.task.user_rulings) {
        headSections.push(...wrapProseLine(`- ${ur.from_scope ? '使用者决定（主会话记录）' : '已生效使用者裁定'} [${ur.target}]：`, `${ur.ruling}（记录来源：${ur.source}）`));
      }
    }
    headSections.push(...renderBedFactsLines(compileBrief.materials.bed_facts));
    if (compileBrief.task.directives.length > 0) {
      for (const dir of compileBrief.task.directives) {
        headSections.push(...wrapProseLine('- 编写强约束：', dir));
      }
    }
  }

  const tailSections: string[] = [
    '',
    '## 本轮测试范围（使用者原话，由主会话记录）',
    '（以下为主会话逐字抄录的使用者范围原文；执行中必须严格遵守，不得自行缩小、改写或删减原始期望；若原文与手册冲突或存在未决项，按角色规则写入目标字段或交主代理汇总，不得擅自决定或向使用者发问。）',
    scopeBlock,
    '',
    '## 本次执行',
    `固定职责和工具范围来自包内自动登记的 \`${subagentType}\`（\`${role.agentName}\`）定义；本文件仅提供本次参数与已核对路径。`,
    ...(check ? ['写入后执行自检：', `\`${check}\``] : []),
    '',
  ];

  const maxTotal = input.maxChars ?? MAX_TASK_BRIEF_CHARS;
  const fixedTextLength = headSections.join('\n').length + tailSections.join('\n').length;
  const sections: string[] = [...headSections];

  if ((priorRounds.length > 0 || unrecordedAttribution) && streak && role.key !== 'fidelity') {
    const historyBudget = maxTotal > 0 ? Math.max(2000, maxTotal - fixedTextLength - 32) : undefined;
    sections.push(
      '',
      renderPriorRoundsMarkdown({
        caseRef,
        currentRound: round,
        rounds: priorRounds,
        streak,
        ...(unrecordedAttribution ? { unrecordedAttribution } : {}),
        ...(historyBudget !== undefined ? { maxChars: historyBudget } : {}),
      }),
    );
  }

  sections.push(...tailSections);
  const fullText = sections.join('\n');
  if (maxTotal > 0 && fullText.length > maxTotal) {
    return fullText + `\n（任务文件超过 ${maxTotal} 字符预算；范围、已提取前置和披露均完整保留，未截断。请分段读取。）\n`;
  }
  return fullText;
}
