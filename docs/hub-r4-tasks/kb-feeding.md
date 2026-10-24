# 任务：知识库喂入层（kb-feeding，方向 2）

设计依据：所有者 10-24 定稿（修订 2，评审目录 `kb-design-1024.md`）与进度页决定 62。树苗（`docs/hub-r4-tasks/kb-seedling.md`，方向 1）之外的一切资料——用例、缺陷、需求/规格、构建、自由文本——都由 Circle 喂给树：Circle 实际用到什么，Hub 就按来源的 schema 把什么填进去；Circle 只补程序填不了的语义，带逐字引文；Hub 只核验、登记、写账，不问人、不调模型、不裁决矛盾。本页把 `knowledge-structure@1` 的结构逐项写死；实现拆分待本页审定后另列。

## 喂入层的位置与形状（照定稿）

- 挂在树苗旁，**不进根摘要**：喂入对象是独立内容寻址对象，只带指向树苗（和节点路径）的引用。
- 进入时机 = Circle 用到：运行里经 Hub 连接器读到，或上传为输入；Hub 之外读到的只有上传才算用到。不再整批生产。
- 运行中不问人：待办只登记在控制台；唯一的问人在 start_run（包要求版本而没给、结构也定不出时拒绝并列候选）。
- 冲突：结构问题按产品包声明的权威源判；语义矛盾两边都留、建 contradicts，不裁决。
- 伪造：一切陈述的根据必须是 Hub 自己经连接器读到并保存的原文，引文逐字核对，不存在整条拒收；闭集、命令、路径解析不出即拒；管理员撤回记录是唯一的事后纠正。

## 0. 总则（不许的东西）

不许关键词、词表、同义词、前缀表或自由文本正则决定身份、绑定或关联；一切匹配是结构化值的完全相等（命令串↔命令树路径按 CommandIdentity，编号↔声明语法，版本↔目录语法）。例子全部合成：平台 `zx-u`、版本线 `10.8` 起、地址只用 `192.0.2.0/24`。

## 1. 五类对象的身份、出处与字段

身份一律是内容摘要（K01 同款规范化：排序紧凑 UTF-8、身份字段不含时间戳）；文档号/节点号是出处，不是身份。10 份字节相同的脑图 = 一个对象、多条来源、多条绑定。

### 1.1 用例（fed-case@1）

- **身份**：规范化的用例子树摘要。复用 cases.ts 的投影：kityminder@1 子树 → `{autoid, priority, 资源, 步骤文本, 期望文本}` 规范形（cases.ts `caseStatement` 的输入形状），摘要 = canonical JSON 的 SHA-256。autoid 缺失时身份只按内容（autoid 是字段，不是键）。
- **出处字段**：`source = { system: 'agile', document: <文档号>, element: <节点号>, revision: <平台修订>, bytes: <原件对象摘要> }`；一份文档多来源就多条 `source`，身份不变。
- **程序读到即填的字段**（全部来自 apv 包结构化解析，逐字段）：
  - `autoid`、`priority`、`resources` ← 敏捷平台 meta + 脑图 JSON 节点 data（cases.ts `elementDocument` / 脑图解析）。
  - `steps[].text`、`expects[].text` ← 脑图叶子原文（逐字，不整理）。
  - `commands` ← 步骤文本按**锁定树苗的命令目录**精确解析出的 `CommandIdentity` 列表（cases-commands.ts `resolvePhrase`；解析不出的步骤不猜，计入 `unparsed_steps` 计数）。
  - `document_lines` ← 敏捷目录版本层（documents.ts `documentLines`）。
- **Circle 可经回注提出的字段**（每个都带逐字引文 `quote = {source 对象摘要 + 选择器}`）：`classification`（闭集：功能/反向/升级/…）、`manual_link`（用例↔手册章节提议，见关联规则）、`relations`（same_subject / contradicts / covers）、`applicability`（逐字段，APV_COMPONENTS 等闭集）、`correction`（对步骤/期望原文的更正建议，不改原件）。
- **关联规则**：用例↔命令：`steps` 里的命令串与树苗 `/commands/<词…>` 路径**完全相等**（CommandIdentity 相等）→ 程序建（结构），核验只查锁定根里路径仍可解析。用例↔手册章节：**只经核验的提议**——Circle 提 `manual_link`，Hub 核引文在手册原件逐字存在、章节路径在锁定树苗 `/manual/*` 下可解析；核不过整条拒。程序不建章节关联。

### 1.2 缺陷（fed-defect@1）

- **身份**：PLM 导出的规范化记录摘要（定稿：编号是出处不是身份；同编号内容变了 = 新身份、旧主张失效）。
- **出处**：`source = { system: 'plm', ticket: <编号>, revision: <导出批次>, bytes }`。
- **程序填**：`id`（编号）、`status`、`affected_lines`、`resolved_lines`、`fix_builds` ← PLM 结构化字段（fixed-bugs.ts 同款投影）；`affected_lines` 为空 → 版本"未声明"。
- **Circle 回注**（带引文）：`classification`、`same_subject`/`contradicts`/`covers` 关系、`applicability`、对描述的更正建议。

### 1.3 需求/规格（fed-spec@1）

- **身份**：规格文档规范化摘要（specifications.ts 的文档形状）。
- **出处**：`source = { system: 'plm-requirements' | 'manual-store', ticket | path, bytes }`。
- **程序填**：`id`、`title`、`linked_builds` ← PLM 构建的需求字段；文档目录行（documents.ts）。
- **Circle 回注**（带引文）：章节↔命令提议、章节↔用例提议、`applicability`、更正。

### 1.4 构建（fed-build@1）

- **身份**：构建站写法的完整构建名本身 + 家族/线/平台解析（naming.ts `parseBuildName` 的规范输出）。
- **出处**：`source = { system: 'build-site', page: <页名>, bytes }`。
- **程序填**：`name`、`family`、`line`、`platform`、`built_at`、`released_at`、`tree`（命令树对象摘要）、`fixed_bugs`（修复清单，fixed-bugs.ts）——全部来自 sync.ts 已有投影；**点名构建**（APV_PINNED_BUILDS）进喂入层照常。
- **Circle 回注**（带引文）：`applicability`、构建↔缺陷 covers 提议。运行目标不产生任何绑定，只产生使用记录。

### 1.5 自由文本（fed-note@1）

- **身份**：上传原件的内容摘要（工单、纪要，任何自由文本）。
- **出处**：`source = { system: 'upload', bytes }`；上传原件来源类型是"声明"，只对上传者和管理员可见（B02 R[3]），不作团队知识的根据。
- **程序填**：只有采集事实（谁、哪次运行、时刻）；不解析内容、不抽关键词。
- **Circle 回注**（带引文）：`classification`（闭集 = 对象种类加工单、纪要，其余记未分类——决定 62 集成者七项）、逐字引文的段落声明、关系提议。

## 2. 版本绑定（version-binding@1）

一条绑定是一条主张（B01 形状）：

| 字段 | 取值 |
| --- | --- |
| `object` | 喂入对象摘要 |
| `product` | 产品线 |
| `line` | 版本线（按产品包声明的目录/名称语法解析；C07 R[9]：10.8 = 10.8.0） |
| `basis` | `source_structure`（来源结构）或 `declared`（人的声明）；组成依据词表加"来源结构"一档（决定 62） |
| `grounds` | source_structure：目录标签原文片段 + 解析语法名；declared：声明人 + 运行号（case-location 的 line 参数、回注的版本声明） |
| `state` | `bound` / `undeclared` / `conflict`；conflict 带 `candidates: line[]`（目录里两个版本层时两个都留） |

- 出处只有两种：来源结构（敏捷目录版本层、PLM 影响/解决版本、构建站修复清单、手册库目录名、构建名语法——全部程序按声明语法解析，等级"观察上的规则"）和人的声明（等级"声明"）；**模型读内容推断版本禁止**。结构与声明冲突（目录说 10.8，某人声明 10.9）：两者都留，等级决定显示顺序，不覆盖。
- **继承**：绑定只记直接那条；视图按产品包声明的规则展开（现规则：不晚于目标线、不早于 min_line 的用例都算，沿用 min_line），展开项标"继承自 10.8（产品包规则）"；没有声明规则的不继承。
- 定不出版本 → 对象进产品线**不分版本范围**，`state = undeclared`，标"版本未声明"，照常参与一切、单列计数、不进版本差；控制台每份文档一条待办（重复不再发、不推送），目录改好后下一次读到自动绑定。同一身份多版本目录 → 多条绑定，不复制。
- start_run 的问人保留一处：包声明"必须有版本"而 start_run 没给、结构也定不出 → 拒绝并列候选（C07 R[3]）。

## 3. 使用记录、序号冻结、撤回（usage@1 / feeding-offset@1 / retraction@1）

- **usage@1**：`{object, run, line(运行目标), at}`——Hub 观察到就记（事实）；**不算版本绑定**。凡经 Hub 读的都在（必须回）：运行里读过的对象全部出现在本次运行的喂入清单里，不是可选。
- **feeding-offset@1**：运行开始时冻结喂入层序号（只追加日志的位置），与锁根一起记进运行；重跑按同一序号复现。回归范围、巡检、查缺、看板、追溯一律读"锁定树苗 + 冻结序号之前的喂入层"。
- **retraction@1**：`{objects[] | runs[] | entries[], by: 管理员, at, reason 一行}`——追加式，被撤回条目有效条件记失效，不删、留痕；吊销令牌账号的回注进撤回待办。唯一的事后纠正，不做事前审批。

## 4. 视图怎么读喂入层

- 对象清单走视图（index / facets），get_nodes 在关联节点旁附带对象引用（像现在的 contributions）；不新增读取机制。
- 回归范围 / 巡检 / 查缺 / 看板 / 追溯：**锁定树苗 + 冻结序号之前的喂入层**；"版本未声明"单列计数、不进版本差；矛盾（contradicts）数单列；冲突（conflict）照常参与并单列。
- 未声明版本的对象命令照**锁定版本的命令树**核（封闭世界），不因未声明降级核验。

## 5. 读到即喂（触发点与复用）

程序投影由这些现有读取触发（复用 apv 包既有函数，不写新的解析）：

| 触发点 | 投影 |
| --- | --- |
| start_run 绑定的期望来源读取（检查声明 `reads`，6a36255） | 用例（cases.ts / cases-commands.ts / locate.ts）、缺陷（fixed-bugs.ts）按读到即填 |
| get_nodes 按引用读原件 | 同上 + documents.ts（目录行 → 绑定候选） |
| upload_file | 自由文本（fed-note@1，声明级可见性） |
| 同步里的构建清单（含 APV_PINNED_BUILDS 点名构建） | fed-build@1（sync.ts 已有投影，转喂入层） |

Hub 之外读到的（模型在 Circle 里自己看的）不触发；只有上传才算用到。

## 6. 过渡（决定 62：旧每构建根不动）

- 现有每构建知识根上的用例索引**不动**：继续由现有同步生产，视图对旧根照旧。
- 新树苗路径上，视图先读喂入层；喂入层里这个版本没有任何用例时，**照实报**"这个版本的用例还没有被用到过"，给出口（用到即进来：下次运行读到即入层），不报错、不回退去整批生产。
- `knowledge-structure@1` 的 schema 草案进 `contracts/model.json` 的路径：与 seedling@1 并列，五类对象 + version-binding + usage/feeding-offset/retraction 三记录 + 视图闭集；生成走 gen:contracts。**实现前不改 contracts，本页即草案。**

## 顺序

1. 本页审定（所有者过目）。
2. contracts：knowledge-structure@1 schema + 词表"来源结构"档（gen:contracts 重生成）。
3. Hub：喂入层存储与读到即喂投影、核验管线、冻结序号、视图改造。
4. 包：knowledge-contribution 承接回注；apv 包函数转喂入投影（声明已去，函数在）。
5. 客户端：Circle 提议格式与"必须回"清单。
