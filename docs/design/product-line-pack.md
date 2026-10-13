# 产品线包典范

一个产品线接进 circle-hub，交付物只有一样东西：**产品线包**——四种 harness 原语的集合（Skill、MCP server 实例声明及其 Tool、Hook 处理器）加原件 role、流程版本和一份清单。hub 核心不为任何产品线改代码；产品线包按本文的布局和适配单来写，装进 hub 后经独立审批人批准生效。

本仓库里的合成产品线 [meridian](../../packs/meridian/) 是公开的样板；真实产品线包放在各自的 packs 仓库里（例如 [circle-packs](https://github.com/qingshanfeihu/circle-packs)），不进 hub。

## 和对象标准的对应

产品线包只能从**扩展点**插进去，插进去的东西都是**资产**，生效都走**变更集**审批，运行留下**证据**。

| 包里的东西 | 插到哪个扩展点 | 资产 kind | 谁解读 |
|---|---|---|---|
| MCP server 实例声明（只读连接器） | B · 连接器包（按系统类型） | connector-instance | hub 的连接器包，只按声明遍历，不认产品 |
| 原件（命令树、函数契约、手册…） | B · 原件上传（文件 + role + metadata） | knowledge-source | 方法模块；hub 只存字节与 SHA |
| 对象词表、知识映射 | B · 词表 / 清单 | 写在产品线清单里 | hub 的知识层按映射登记声明 |
| Skill（技能包） | E · 技能包 | skill-package | 无界面的 Circle 执行；hub 核对声明工具与试跑 |
| Tool 实现（解析器、契约、结果解释） | B / D · provider 的 `provides` | product-line 模块 | provider 调用时在 hub 内执行，输入是 B 的字节 |
| Hook 处理器 | E · 执行链钩子点（verify.* / beforeDispatch / afterResult） | product-line 模块 | hub 在执行链第 3 步按顺序调用 |
| 流程版本 | C · 流程版本 | product-line 模块 | hub 的任务引擎按版本推进 |
| MCP server 实例声明（执行资源） | D · 资源适配器（MCP 协议）+ 凭据模式 + profile | connector-instance（执行资源） | hub 的 worker 作为 MCP client；端点与密钥在库外 profile 和保险箱 |

不在表里的东西不属于产品线包：改 hub 核心、改 Circle 核心、写死地址或凭据，都不是「适配」。

## 目录布局

```
<packs 仓库>/
  modules.json                   安装清单：每个模块的 root、manifestPath、version、files + sha、digest
  products/<line>/
    product-line.json            清单 product-line/1：连接器包、工具别名、连接器选项、知识映射、tools、hooks、流程
    connectors/<package>.json    连接器实例声明模板：declaration + configuration，不含地址与凭据
    sources/<role>.md            每类原件的 role、metadata 键、谁上传、怎么核对
    tools/<name>.ts              Tool 实现：解析器、契约、结果解释；纯函数，输入是 B 的字节
    hooks/<name>.ts              Hook 处理器：对一次运行的确定性判定，返回 pass 或错误码与事实；清单里声明挂点与顺序
    flows/<name>.json            流程版本：阶段、等待原因枚举、交付项
    resources/<name>.json        执行资源声明：writes、凭据模式、runtimeProfileRef、是否 executionIsChange
    README.md                    填好的适配单 + 验收记录
  skills/<skill-id>/
    SKILL.md                     给模型看的流程：哪些步骤是脚本、哪些是判断
    skillpack.json               清单：id、version、tools、inputs、outputs、triggers、model
    scripts/                     有唯一答案的步骤全在这里；不调外部系统，只处理 B 给的字节
    references/                  契约、规则的说明（不含原件）
    tests/                       合成样本上的测试
```

原件、设备配置、真实返回不进仓库：它们是运行时上传到 hub 的原件，带 SHA、经独立审批人批准后才被模块读到。

## 适配单

把一项能力接进来，先填这张表；答案只能是「N 个资产 + M 条流程 + K 条规则」。哪一格的答案是「改 hub」，就回到设计。

| 对象 | 要回答的问题 | 答案形式 |
|---|---|---|
| B | 读哪些系统？每个系统类型一个连接器 | `connectors/*.json` + 清单 connectorPackages / toolAliases |
| B | 有没有要上传的原件？ | `sources/*.md` 定义 role；运行时上传 |
| B | 产生什么证据？能提交什么声明？来源是脚本还是模型？ | 技能包的 outputs；claim 的 origin |
| C | 有哪些流程？每条有版本号 | `flows/*.json` |
| C | 哪些动作要独立审批人？ | 只有变更集；运行不审批 |
| C | 有哪些身份？ | 范围策略里的角色；资源用机器身份 |
| D | 碰哪些资源？走哪种协议的适配器？ | `resources/*.json` |
| D | 凭据怎么给？ | static-secret / 平台签发 / 外部 OAuth |
| D | 什么叫未知？怎么核对？ | 流程里的 unknown 分支与 reconcile |
| E | Skill 里哪些是脚本、哪些是模型判断？ | SKILL.md 分段写明；脚本在 scripts/ |
| E | 产品线清单声明什么？ | `product-line.json` |
| E | 执行链上挂哪些 Hook？ | `hooks/*.ts`，返回固定错误码 |
| A | 用户在 Circle 里看什么、做什么？ | 用到的工具、命令、卡片与登记簿；不加新界面 |

## 每类资产怎么写

- **连接器实例声明**：只写 declaration 和 configuration 的形状；地址、账号、CA 在管理员登记时填进库外 profile 或保险箱。
- **原件**：每种 role 一段说明——文件是什么、metadata 必填哪些键、怎么核对 SHA、谁有权上传与阅读。metadata 是上传者的声明，hub 不验证；要验证的事在运行时由资源回报。
- **Skill**：SKILL.md 先写输入、工具、输出，再按步骤写；每一步标明「脚本」或「判断」。脚本只处理 B 给的字节和自己的产物；工具返回由 hub 原样保存，脚本只拿 evidenceId 指针。试跑记录要覆盖技能声明的每条路径。
- **Tool 实现**：纯函数，输入字节、输出结构；不读环境、不连网、不写文件。在内存里用解析库处理字节是允许的（例如用 ExcelJS 读一个 Buffer），但只能 import hub 自带依赖集里的包（exceljs、read-excel-file、fflate、zod、saxes、parse5，精确版本），并在清单的 `tools[].imports` 里声明；Node 内建模块（`node:*`）也不行，散列用全局 WebCrypto `crypto.subtle`，不需要 import；装载时核对，声明外的 import 以 `IMPORT_NOT_DECLARED` 拒绝装入。包的测试需要 hub 的依赖集（node_modules 软链或安装同版本）。
- **Hook 处理器**：输入一次运行的绑定与待核对象，输出通过或一个固定错误码加事实。判定不了的不写 Hook，交给披露。
- **流程版本**：阶段枚举固定，等待原因是枚举字段，交付项列清楚。
- **资源声明**：writes 写实话；要两人规则的生产资源声明 executionIsChange。

## 开发到生效

1. 本地开发技能包与模块，用合成样本跑 tests/。
2. 在 Circle 里登录 hub，开始试跑记录，按 SKILL.md 走一遍真实工具（只读），产物带 SHA。
3. 推送：清单、文件、试跑记录一起作为变更集提交；hub 核对声明工具 = 试跑实际调用、引用的资产已就绪。
4. 独立审批人在自己的 Circle 里决定；批准后版本不可变，改动就是新版本。
5. 产品线清单、Tool 实现、Hook 处理器、流程由 `modules.json` 列出，从仓库装入，同样是变更集。
6. 运行走执行链，不审批；报错带错误码回会话，未知如实披露。

## 验收清单

- hub 核心零改动；产品名只出现在清单、模块、规则和数据里。
- 每个资产都能被独立审批人批准、被 SHA 钉住、被停用。
- Skill 的试跑覆盖每条声明路径；未声明的 Tool 一个都没调。
- 运行失败只有固定错误码；没有「平台批准」的记录。
- 第二条产品线装进去不改核心。
- 仓库里没有原件、地址、凭据、真实返回。

## 样例：meridian

[packs/meridian](../../packs/meridian/) 是一条虚构的产品线：一份 product-line/1 清单和一个源码评审技能 `meridian-source-review`。它读文档连接器、提交候选声明、产出评审报告，不碰任何资源，只有登记要审批。它存在的意义是证明：第二条产品线用同一套核心、权限、审批和执行走通，不改一行核心代码。
