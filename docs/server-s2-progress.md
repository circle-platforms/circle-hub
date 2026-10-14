# circle-server 第二阶段进度

## 2026-10-14：组织维护、公开 CI 与兼容说明

按本次组织体检修复授权，在 main 的独立工作区补充 `Hub checks`：类型检查、契约测试、方法测试、临时回环 PostgreSQL 和合成服务验收。保留独立的参考档案完整性工作流。Circle 数据目录独立创建，不提供真实用户数据、设备或付费模型端点；固定 Circle RPC 运行时不在公开 CI 中，相关已有用例明确报告跳过，不计入已验证通过，也没有升级原验收基线。

兼容矩阵中英文将截至本次检查的 Circle 最新公开发行 1.4.1、扩展目标基线 1.2.1 和固定 RPC 提交 8b2ceb6 分开。circle-packs 的 CI 依赖集固定为 hub 完整提交 dc93c69826f73f16d2f20f7520ba4c6663d014ac，获取后核对 HEAD；固定的是测试依赖集，不是生产兼容承诺。组织资料仓库同步贡献许可与安全报告范围，并标明内部看板、提供三个公开 Issues 入口。

本地执行记录：

- Node.js 24.19.0；`npm ci` 按既有锁文件安装，未改变依赖版本。既有依赖的弃用提示保留，不计为安装失败。
- `npm run typecheck` 对应的 TypeScript 检查通过；契约、方法与参考档案测试合计 142 项通过、无跳过。参考完整性脚本复核 714 个原件，未更改冻结字节。
- 合成服务验收全量首次为 145 项通过、5 项失败、10 项跳过；5 项失败均为本机验证环境找不到 npm。补齐临时 npm 路径后，启动与重启相关的 6 项测试全部通过，合并两次记录为 150 个不同用例通过、10 个固定 Circle RPC 用例未验证。没有修改断言或跳过失败项。
- circle-packs 获取并核对上述提交，按锁文件安装其依赖；模块清单匹配。技能与清单测试 61 项通过，产品线包测试 31 项通过。中文目录下既有夹具使用 URL pathname 导致一项测试失败；在纯临时 ASCII 检出中复测通过，未修改模块内容或清单字节。
- actionlint 1.7.12 检查两份变更工作流通过；未启用 ShellCheck。三仓差异空白检查通过，三个公开 Issues 链接均返回 200。

以上记录是提交与推送前的本地验证；远端 Actions 在推送后单独复核，不以本地结果代替。它不是实际产品或生产验收。

## 1：授权与工作树

2026-10-12。按第二阶段简报从本地 server-s1 提交 `7d54a49` 创建 `server-s2`，工作树为 `../circle-server-s2`。主工作树只提供未跟踪简报，server-s1 留给 PR #5 修正；本阶段没有修改 Circle。

已读取 AGENTS、README、初始化/参考说明、B/C/D/E 提案、第一阶段简报与进度、第二阶段简报。第一阶段运行代码 `9ab3c8b` 的 40/40 与桌面任务/审批联验已有用户提供的独立复核；本节登记其来源，不作为第二阶段验收。

第一笔提交更新 AGENTS 的公开仓库与第二阶段授权范围，并登记原简报。公开提交只允许合成样本和相对路径；InfoTest 仅可只读参考行为，不运行、不复制代码或配置值。push、开 PR、部署及范围扩张需要用户另行决定。

实际执行 `git worktree add ../circle-server-s2 -b server-s2 server-s1`，创建成功；首笔提交 `52d61ea` 登记 AGENTS、简报和进度，`cmp` 核对简报字节一致后已删除主工作树副本。GitHub 只读查询确认 [PR #5](https://github.com/qingshanfeihu/circle-server/pull/5) 仍 OPEN、head 为 `7d54a49`，本次无需 rebase。接下来先写第 7 幕的通用核心守卫并确认旧代码失败，列出迁移边界，再建设对象/关联存储与权限过滤。尚未执行第二阶段业务验收。

## 2：通用核心守卫与迁移清单

先新增并运行 `node --test tests/acceptance/s2-07-core.test.ts`，实际失败 0/1。守卫扫描 apps/packages 的运行文件和文件名，连接器、对象映射、方法与策略包允许定义专业行为；核心中禁止出现已知具体系统、产品和能力名。没有用跳过、注释屏蔽或拼接名称使旧代码通过。

旧代码检出 15 个位置：server 的 main/两个专业 runner，worker main，contracts，execution 的旧执行入口/operations/资源迁移/合成设备，knowledge 的制品登记，tasks 的 checklist/连接器注册/任务入口/专业迁移/rules。后续分别搬出专业 schema、编译/评审/检查流程、目标初始化和包清单，用通用注册、声明和权限检查连接其消费者。机制的事务、租约、fence、独立核对与事实交付继续保留，不用删除验收替代迁移。

实际 `npm ci` 使用已有精确锁文件，安装完成，审计 0 个已报告漏洞，未改变依赖版本。`npm run verify:references` 验证 714 原件；`npm run test:references` 7/7；`git diff --check` 通过。第 7 幕仍是明确的未通过项，将在迁移完成后转绿。下一步为通用对象/关联/出处与权限的 HTTP 验收和实现；连接器、阅读方法、订阅与能力固化尚未实现。

## 范围更新：PLM 只读镜像

2026-10-12。第二阶段撤销双缺陷系统与 HTML 桩计划，来源改为禅道同步镜像的 PLM HTTP JSON 查询；第 1 幕改为单系统状态、resolution 和严重程度映射。鉴权为每用户 SSO JWT，直接置于 Authorization 头；相对路径例子已写进简报，服务地址和令牌不登记。

当前继续对象存储。未新增任何第二阶段 Bugzilla 或禅道桩；镜像字段、分页和失败行为等用户的已脱敏探测结果，再实现连接器与映射。第一阶段继承的旧来源桩仍属于后续兼容迁移清理项，不能把新对象存储验收当作该清理或 bug 闭环已经完成。

## 3：通用对象、关联与权限存储

先写 `s2-objects.test.ts`，旧代码因对象目录入口缺失失败 0/3。新增第 10 号迁移、类型包登记、实体身份和不可变观察、关联观察及原件出处；没有更改第一阶段迁移的校验字节。专业词表在 `packages/object-types/src/enterprise-v1.ts`，自定义 widget 类型也可通过登记使用，核心不按类型名处理业务。

管理导入绑定 tenant/scope/来源系统/来源类型/外部编号；观察键与内容冲突拒绝，相同观察重提复用原修订。原件经 B 按 SHA 保存，来源登记、观察、当前指针与审计在同一数据库事务中提交。原始字节与字段类型分别校验，手工观察明确标为 `manual-observation`，没有把它宣称为真实镜像鉴权或映射结果。

读取先取当前平台策略，按 scope、来源读取 ACL 和平台读取 ACL 的交集过滤；计数、分页和关联两端都受同一权限约束。不存在与不可见的对象统一 `OBJECT_NOT_VISIBLE`。B 的来源下载也增加对象权限检查，不能绕过对象读取直接取受限原件。

补测并复现了当前修订变公开后，旧受限观察仍被历史入口返回的问题，实际 2 条而预期 1 条；修复后，历史观察及旧原件同时检查历史 ACL 与当前对象 ACL。目录与关联计数/页内容使用同一个只读重复读快照，避免并发更新产生不一致页。当前来源权限由受信手工观察声明，真实源权限与每用户 JWT 尚待连接器切片接入。

实际命令与结果：

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `node --test tests/acceptance/s2-objects.test.ts` | 3/3，通过身份隔离、修订/原件、类型包、自定义类型、权限/历史/关联、非法输入与权限撤回 |
| `npm run test:contracts` / `npm run test:methods` | 4/4 + 4/4 |
| HTTP 验收全集 | 28/29；原 S1 的 25 条和新增对象 3 条通过，唯一失败为第 7 幕守卫，仍检出 15 个继承位置；约 116.76 秒 |
| `npm run verify:references` / `npm run test:references` | 714 原件完整，7/7 |
| `git diff --check` 与新内容路径/地址/令牌值扫描 | 通过；扫描未检出本机绝对路径、内网 URL 或 JWT 值 |

验收命令尝试使用 `--test-name-pattern='^(?!Act S2\.7:)'`，实际仍运行了核心守卫并以 1 退出；按实际 28 通过、1 失败登记，未将该运行称为全套通过。综合已跑的契约、方法、验收、参考测试，当前 43 通过、核心守卫 1 失败。没有关闭或跳过该守卫；迁出第一阶段具体能力后才应转绿。

[对象存储接口说明](object-storage-api.md)记录当前路由、schema、权限、原件和分页边界。既有 dev:stack 的 objects 权限与示例目录尚未集成。下一步需按脱敏 PLM 探测设计连接器，再推进阅读方法、订阅、固化和核心迁移；这些当前未完成，未写来源桩。阶段 1 与主工作树保持原提交，PR #5 再次只读核对仍 OPEN。所有本阶段更改仅在 server-s2 本地提交，不 push、开 PR 或部署。

## 4：PLM 脱敏只读探测契约

2026-10-12。以下是用户提供的 Claude 只读探测结构，使用用户本人 token，探测结束后已删除 token；本仓库未获取服务地址、令牌或真实记录，也未重复真实服务探测。仅据结构设计虚构桩与 TypeScript 映射。

| 项 | 已确认的结构/行为 |
|---|---|
| 鉴权 | 工作台 SSO JWT，本人凭据直接置于 Authorization，无 Bearer 前缀；服务无登录接口；有效期约 30 天，claims 含 username/userId |
| 信封 | 所有成功/失败 HTTP 均 200；JSON code=1000 成功，code=401 的 msg 可为「Token不存在.」「Token解码失败.」 |
| 产品 | GET `/plmquery/product/all/` 返回 id/name 数组 |
| 缺陷列表 | GET `/plmquery/bug/`，query 可过滤 product/status/severity/assignedTo/openedBy/lastEditedDate_start/end；数组无分页，page 无效 |
| 列表字段 | id/title/type/severity/pri/status/product/project/module/openedBy/openedDate/assignedTo/resolvedBy/resolvedDate/closedBy/closedDate/deleted；severity/pri 是数字 |
| 详情 | POST `/plmquery/bug/detail/`，body `{bug_ids:[...]}`，每批最多 100，数组；共 59 字段，数字多为字符串，已给字段以外不猜测 |
| 详情补充 | openedBuild（trunk 或构建 ID 字符串）、resolvedBuild、resolution、外部历史编号字段 bugzillaID、repo/entry/lines/v1/v2、lastEditedBy/lastEditedDate；actions 为 id/actor/action/date/comment/extra 数组；assignedTo 可能是 closed 状态值 |
| 日期 | 列表日期 T 分隔、详情空格分隔，均无时区且实际 +08:00；空串与 `0000-00-00 00:00:00` 表示缺失 |
| 词表 | severity 1=致命、2=严重、3=一般、4=轻微、5=建议；pri 1=立即、2=高、3=正常、4=低；status 为 active/resolved/closed |
| 增量 | 用 lastEditedDate_start 轮询，按 id 与 lastEditedDate 去重；最新修改时间可能较本机时间超前数分钟 |
| 构建列表 | GET `/plmquery/build/`，product/start_date/end_date 过滤；id/product/branch/project/name/scmPath/filePath/date/builder/desc，无 bugs |
| 构建详情 | GET `/plmquery/build/{id}/`，另有 stories/bugs 逗号 ID 列表、deleted/mailto |
| 修复构建 | resolvedBuild 查详情、详情 bugs 反查。构建可为缺陷收集桶；输出构建名和日期，不能据构建名或关联缺陷就判发布版本 |

地址只从运行时配置注入。合成 JWT 的签名材料、令牌值也仅运行时生成；不存在来源登录接口或共享更宽账号的退路。成功数组是否在 data 字段、resolution 全词表与“确认不存在/没权限”的业务码尚待补充：先按 data 和仅 fixed 明确表示修复建立合成样本，未确认值保留并标未映射，空详情不负缓存。新增桩与映射将先写验收；核心迁移守卫及其他第二阶段故事仍待后续完成。

### 补充：个人凭据、本机部署与发布证据

原计划的来源凭据使用用户本人的工作台 SSO token，运行时注册为“某人的个人凭据 → 某连接器引用”。注册接口应保存引用和所有者，值不进仓库、日志、审计或 API 返回；该接口尚未实现。未来改服务 token，不在当前实现里默认借用共享身份。server 先运行于用户 Mac，本机监听；网络开放与部署仍需另行授权。

发布记录与命令树 XML 在同一构建站点。首页链接各版本线与平台/系统/芯片变体页；平台示例为 kvm、docker、xen、vmware、hyperv。版本线页每条构建含 Rel_/Beta_ 名称、构建时间、Released on 日期，以及系统镜像 .array、SNMP MIB、command_tree-构建名.xml、Bugs_Fixed_with_构建名.html 四个文件链接。

Bugs_Fixed 页每行的 show_bug.cgi?id 链接承载历史 Bugzilla 编号。将禅道详情 bugzillaID 与这些编号连接，再取构建名和发布日期；只提取链接编号，不访问 Bugzilla 本体。resolvedBuild 改为补充线索。第 2 幕须覆盖连接键缺失、多构建命中选择最早正式发布并列出全部、仅 Beta 命中不算正式发布；保留发布页/清单/XML 的原件 SHA 与出处。

本节只登记结构，未登记任何构建站点地址、真实构建名、编号、发布日期或 token。后续桩与页面全部重新构造虚构数据，PLM JSON 源与 HTML/XML 发布源分属不同连接器和映射包。

## 5：暂停收尾，等待知识库方向的新简报

2026-10-12。用户暂停当前实施，第一个目标从 bug 闭环改为以知识库为核心，将 InfoTest 现有产品问答、用例编译、用例评审能力经 Circle 与 circle-server 接起来。新的执行方式、采用范围与验收以待提供的新简报为准；目前不继续编写禅道或构建站点桩，也不据这一方向运行/复制 InfoTest。

已完成并本地提交：工作树与公开仓库约束 `52d61ea`、核心迁移守卫/清单 `2fcf0e3`、只读镜像范围更新 `4c33a34`、通用对象/关联/权限/原件存储 `ed537f1`、脱敏 PLM 契约记录 `7376cf2`。最后一个运行代码切片仍是 ed537f1；对象验收 3/3 与第一阶段原 40 项通过，已知核心守卫仍失败，尚未达到第二阶段全绿。

本步完成的内容仅为个人凭据、本机部署、发布清单/命令树结构和三个发布边界的文档登记，当前一并收尾提交。尚未实现：PLM HTTP 桩、映射与轮询，发布站点 HTML/XML 桩与读取方法，个人凭据注册/注入，源码内核迁移、遗留 Bugzilla 桩移除、订阅与能力固化，以及新的知识库三类能力集成。没有新增这些功能的代码、验收文件或真实来源调用。

暂停前仅做了 HTML/XML 解析依赖准备：`npm install --save-exact parse5@8.0.1 saxes@5.0.1` 完成，安装审计 0 个已报告漏洞，尚未被应用代码采用或完成功能验收。`package.json` 与 `package-lock.json` 的准备变更留在工作区，不提交；此前提交的失败核心守卫保留历史与待迁移标记，不改写历史。当前没有新增失败功能代码要提交。

收尾只核对文档与类型/参考完整性，不重复宣称此前业务测试为本次新功能测试。运行检查与最终工作区状态在下方登记；之后停止工作，等待新简报，不 push、开 PR、部署或开放网络。

本步实际 `npm run typecheck` 通过，`npm run verify:references` 验证 714 原件，`npm run test:references` 7/7，`git diff --check` 通过。文档扫描未检出本机绝对路径、内网 URL 或 JWT 值。本步只提交 AGENTS、暂停标记后的原简报及本进度，未提交解析依赖准备。工作区保留 package.json/package-lock.json 两项修改，供新简报决定采用或撤回；此后不继续实施旧切片。

## 6：修订 2 恢复，资产先行

2026-10-12。新简报 `server-s2-brief-r2.md` 取代旧 bug 闭环方案，恢复本地实施：资产/个人凭据 → 四类只读连接器 → 六类知识记录 → 工具目录与客户端交接 → 技能包和无界面执行 → 触发/bot → 第二产品线与核心回归。自动化环境第一版只查看，命令白名单外拒绝；真实来源、付费模型、环境改动、push/PR 与部署均需再问。

采用原有精确依赖准备 parse5 8.0.1、saxes 5.0.1，后续与应用和锁文件一起验证。已有通用对象/权限存储保留；旧核心守卫继续作为最终验收门槛。只读核对 PR #5 仍 OPEN、head `7d54a49`，当前不需要 rebase；Circle 与 server-s1 保持不动。

首步登记新简报并更新 AGENTS；简报与主工作树副本比较一致，提交成功后删除主副本。接下来先写资产/凭据验收。工具目录客户端交接一旦完成就先通知用户，之后再继续技能包与执行引擎；引入 Circle 内核的入口/版本有疑问时先询问。

### 修订 2 补充约束

平台与版本线为独立维度：构建站点的 kvm/docker/系统/芯片变体不是型号。查询指定版本线中，哪些正式构建的命令树具备功能相关命令，并结合修复清单和发布日期给出最新正式构建；命令存在与完整功能语义区分。第 6 幕输出先只用 Circle 事件流，企业微信桩延后，渠道接口保留扩展性。

知识共用六种记录，增加类别与来源类型。产品知识来自连接器、程序抽取、来源修订与源权限，是检索优先项；沉淀知识来自获准共享的会话片段、技能/bot 运行与评审纠正。整理技能包定时用脚本模型抽取、去重，附原片段和工具返回；先个人候选，复核/审核后才进团队，不覆盖产品，冲突显示。第 3 幕增加候选不进正式快照、个人对他人不可见、冲突标注；第 6 幕用定时整理技能包验收。相关 InfoTest 三类机制仅只读参考；本阶段没有读取真实会话或执行旧代码。

## 7：资产登记与个人凭据引用（修订 2 第 1 幕）

先运行 `r2-01-assets.test.ts`，资产路由尚不存在，0/3 失败。新增第 11 号迁移、通用资产版本/摘要/声明/读取范围/生命周期/健康/审计，以及个人凭据引用。凭据值写入本机私有目录，AES-GCM 加密、目录和文件限权；API、审计、日志仅元数据。无公共读取值的接口；内部执行解析检查当前身份、scope、所有者、连接器绑定和停用状态。

生命周期批准绑定版本/摘要并拒绝自批；新版本重新进入 draft，旧批准不能启动新声明。读取在计数与分页之前过滤 tenant/scope/readers；跨身份的凭据不可见。凭据健康是本地密钥可读性，不冒充来源登录成功；未安装检查器的连接器返回 unknown/checker-not-registered。

实际 `npm run typecheck` 通过，资产与既有对象存储的六条 HTTP 验收 6/6；`npm run verify:references` 714 原件、`npm run test:references` 7/7；diff 和新内容地址/令牌扫描通过。采用 parse5 8.0.1、saxes 5.0.1 的精确依赖与锁文件；此时尚未实现四类只读连接器、知识入库、工具目录或执行引擎，核心守卫仍是最终迁移待办。

客户端工具/技能包 shape 已收到：工具数组含 name/title/description/inputSchema/effect/mode/permission/assetId/assetVersion，调用含 args/idempotencyKey；目录 ETag；技能包清单、文件摘要与试跑记录。正在澄清名称在多实例下的唯一性、来源不可见的错误披露、技能审批所用的 taskId；当前资产步骤独立完成，不依赖这些答案。
## 8：只读连接器 SDK 与合成来源（2026-10-12）

先新增 `r2-02-connectors.test.ts`，运行因 SDK 文件缺席而失败，再实现 TypeScript HTTP 传输、WebDAV、HTML/XML 构建站点、PLM 查询镜像、跳板查看协议。parse5/saxes 解析结构；拒绝 XML DTD、跨来源抓取和跳板白名单外的命令。原始返回逐份保存字节与 SHA-256，增量分别采用文件修订、构建内容摘要、缺陷 `(id,lastEditedDate)` 和环境资源修订。PLM 使用无 Bearer 的运行时 Authorization，日期按 +08:00 统一；未掌握的 resolution 明示未映射。成功载荷暂按 `data`，支持配置字段，尚待真实结构补充。

构建站点桩含首页、版本线、四种文件链接、修复清单和命令 XML。只提取历史编号链接，不访问旧缺陷系统；正式发布与 Beta 分开。多构建修复选最早正式发布并保留全部；版本线命令查询选择最新正式构建，并明确命令存在不能证明完整功能语义。平台维度独立保留。自动化仅通过合成跳板 HTTP 查看协议读清单、拓扑、状态与框架文件；真实跳板协议和源系统连接没有验收。

实际验证：`node --test tests/acceptance/r2-02-connectors.test.ts` **5/5**；`npm run typecheck` 通过。这证明合成来源上的连接器包行为，尚未证明 C/D 调度、B 持久留证和源 ACL 入库链路；这些会随知识库和工具调用入口接通，不能把包级结果当成整个第 2 幕交付。

用户已确认客户端补充约定：工具名在 tenant 内唯一，多实例用别名；普通调用将缺失/无权限统一隐藏为 `SOURCE_FORBIDDEN`，诊断权限可见完整失败分类；技能包提交可增加 `approvalTaskId`，复用绑定 digest 的任务审批。其他请求形状保持原约定。

Claude 复核 `9a8efd3` 后补充实际构建页结构，本轮先改桩和回归验收，原解析在两个案例失败（4/6）。随后改为大小写混用的 `font + blockquote + a + br + hr`，不依赖 table/tr 或泛化 h2 中的版本号；版本线来自首页链接或文件名。记录 ArrayOS 镜像大小/页面声明 SHA-256、英文/中文 `.txt` MIB，`build on` 空白与正式发布日期分别解析。增量摘要绑定构建段落文字及链接，未变化仅取版本页，单个变化只多取该构建的 XML 与修复清单；验收直接检查 HTTP 请求次数。XML 按声明解码 ISO-8859-1，保留解码前原字节 SHA。`node --test tests/acceptance/r2-02-connectors.test.ts` **6/6**，`npm run typecheck` 通过；来源声明的镜像 SHA 是页面证据，没有下载镜像而声称独立核实它。

## 9：知识记录、候选与发布（2026-10-12）

先写 HTTP 验收并确认 0/5（入口不存在），再实现六类记录、引用闭包、原件/片段 SHA、来源修订头和 stable 快照指针。产品和沉淀共用记录机制，每条带类别和来源类型；已有对象观察补上类别/来源类型。来源、证据、实体、声明、评估、快照均可展开，快照以固定 canonical manifest 字节核对 SHA，并用预期旧指针原子切换，重启可读回。

声明始终从候选开始，包括模型/footprint 内容。产品源权限与平台权限取交集，当前来源 ACL 收紧后历史证据、检索和原件下载同步不可见。沉淀来源需要显式共享许可，初始为个人候选，普通他人不可见且不进正式快照；作者显式指定审核人后才允许专门审核展开，作者不能自批。提升需要来源的团队共享许可，以及独立人工审核或与已审核产品声明的精确比对。自动比对只声明字段相等，不宣称完成语义裁决。不同值的同 subject/predicate/conditions 标为 potential-conflict，授权后才能看到对方记录；沉淀永不覆盖产品，检索产品优先。

提供精确、前缀、目录与 PostgreSQL simple 全文检索；中文未切分正文另有字面片段命中，不宣称真实资料上的分词质量。命中不代表语义支持，未命中不代表不存在。合成桩的 C/D 入库仍将接工具调用链；本节的写入验收是受权知识 API，没有运行真实会话或 InfoTest 整理程序。

实际 `node --test --test-concurrency=1 tests/acceptance/r2-03-knowledge.test.ts tests/acceptance/s2-objects.test.ts` **9/9**（知识 6 + 对象 3），`npm run typecheck` 通过。中途发现 JSONB 不保留对象键序，改为在快照中保存 canonical manifest 字符串并校验其原字节；独立客户端下载验收通过。

用户确认 `knowledge.claim_submit` 为 write/task，其余新增脑图知识工具为 read/sync，Circle 已支持调用前询问写工具与后台等待 task 结束。工具需求已纳入第 4 幕：构建列表、命令头/参数/确定性命令检查、手册全文/章节、查询镜像搜索/详情和候选提交。产品线包统一位于 `packs/<产品线>/`；Claude 在独立 apv-pack 分支提交 `e147364`，尚未合入或作为本分支运行验收。已通过 Otty 向 Claude 确认 headless Circle 的精确依赖入口，当前本地 Circle 1.1.1 仍为 private 且无 library exports，先继续目录步骤。

## 10：目录与脑图知识工具（2026-10-12）

先写 `r2-04-tools.test.ts` 并确认 0/4，再实现调用者过滤目录、tenant 唯一名称/别名、对象 JSON Schema、ETag/304、同步调用和候选 task。连接器 SDK 通过 C 受理及 D 原有操作账本/租约/fence 推进，worker 执行真实本机合成 HTTP 请求；B 核对回传原字节 SHA 并保存来源/证据，结果再交付。同键同内容及 server 重启复用收据，同键不同内容拒绝，工具参数固定在当前修订。个人凭据仅通过共享本机的加密注入引用交给 worker，值不在 API 元数据、操作 args/result、审计或日志里。

新增构建列表、命令树、命令头/参数/核对，文档目录/原件/全文/章节，镜像缺陷列表/详情，环境清单/拓扑/状态/框架查看和个人候选提交。E 的命令规则独立写了验收，原模块缺席失败后实现，2/2；几十条虚构命令覆盖 STRING/U16/IPADDR/枚举和构建缺失。最长八词匹配、参数数量/类型/位宽/枚举/范围违规分别输出；超过 128 头明确 result_too_large，不截断，手册不改变 missing。

新工具任务/事件归调用者个人，普通同 scope 读者不能从 task/result/events 绕过来源 ACL 或读到个人候选；task/admin 列表和事件在 limit 前过滤。包里同时返回构建页与 XML 时，来源类型按原件分别记录，修复首次联验发现的同一页被误标成两种类型而撞上不可变修订的问题。资产清单允许暂未安装执行包的资产，但不为其发布工具；修复目录 hook 误拦资产第 1 幕的回归。

`npm run dev:stack` 已加入合成来源和五个经独立批准的工具资产，developer 登录后即有工具；原脑图上传/编译/下载仍通过，一条命令启动/清理验收增加了实际 command_check。交接文档已写入 `docs/client-api-handoff.md` 并通过当前终端与 Otty 告知 Claude，客户端开始核对。第 5 幕协议在文档明确标为待开放。

实际验收：目录/资产/一键栈联合 **8/8**；新增命令与连接器包 **8/8**；最新完整 `npm test` 的 contracts **4/4**、methods **6/6**、acceptance **47/48**，唯一失败仍是原先 15 个核心专业位置的第 7 幕守卫，没有屏蔽它。第一阶段 40 项继续通过；参考另跑 **7/7**，714 原件核对通过，typecheck 通过。最后补验了 environment.inventory 的 D/B 链及超限错误的 wire details，`r2-04-tools.test.ts` **4/4**。尚未完成自动产品声明发布、技能包/真实 RPC 执行、定时整理/bot 和核心专业代码迁出；不能声称第二阶段或整套已全绿。

用户确认技能包 scope 走可选 `X-Scope-Id`，多 scope 必须明确；manifest.owner 是声明。missingTools 是声明但目录不可用的工具，undeclaredTools 是试跑未声明调用；提交/批准/运行重查。第 5 幕正式边界改为 Circle CLI RPC，固定 `551dc46ecc702df755b37eb69df3898b0807a547` + 1.1.1；开发期 CIRCLE_BIN 仅运行时提供，HOME/CIRCLE_HOME 都隔离，不 import Circle、不改 foundation。Claude 的构建与协议已就绪，下一步先写技能包/RPC 验收。

### 用户提供的第 4 幕 Otty/Circle 独立观察

Claude 在另外的固定 `87efb41` 临时 worktree 起 dev:stack，用真实 Otty 的 Circle server-tools 分支登录，自动发现 **17 个工具**，没有修改本工作区。脚本模型按 APV 技能依次调用 versions（选择最新正式构建 109）、command_heads、command_param、docs.search、command_check；写出 2 个用例，109 的 feature.enable 为 missing，相应用例标不支持，缺期望的用例标需要决定。Claude 用 openpyxl 独立读出 case.xlsx。用户未提供工作簿 SHA，本节不补造；试跑记录留在原 Circle 会话，待技能包路由开放后由同会话推送。独立整套复核同为 contracts 4/4、methods 6/6、acceptance 47/48，唯一红项核心守卫。这是用户提供的客户端观察，不冒充本 agent 已复跑或真实模型/设备验收。

后续排队：第 5 幕告一段落后，把构建同步改为按需 XML/修复清单，按 SHA 缓存、限制并发/间隔，增加 versions 不触发 XML 下载的明确验收；不连接真实站点。当前 versions 已只读首页/版本页，SDK 首次全量 sync 仍需改造。此项不提前打断第 5 幕。

Circle 固定版本更新：用户提供当前构建提交 `d9f8ec6261597bc2cfcfa91dc8903965a6df7fe7`，版本仍 1.1.1；551dc46 后的三个提交只改扩展/桌面展示和 X-Scope-Id，RPC/--extensions 行为保持。活动交接和新验收改用此完整提交号，旧观察保留原基线。

## 11：技能包登记、审批与真实 Circle RPC（2026-10-12）

先写第 5 幕验收并确认 0/4（路由缺席），再实现 skillpacks 的 F schema/CLIENT_ROUTES、内容寻址提交/列表/运行、绑定 digest/当前资产修订的既有审批、短期运行委托、worker RPC 槽和 C 事件/B 产物。X-Scope-Id 单 scope 可省略、多 scope 必须明确；manifest.owner 不作身份。文件路径/原字节 SHA/总量检查，必有 SKILL.md；trial 未声明工具或目录不可用工具拒绝并带两张清单。提交、批准、运行重查目录；批准核对申请人而非给审核者执行权。相同内容复用包与审批任务，原版本不可覆盖；同键不同运行输入拒绝。

真实 Circle 使用用户提供的本机构建、Git 完整提交 `d9f8ec6261597bc2cfcfa91dc8903965a6df7fe7` 和版本 1.1.1 双重核对，未 import 源码、未改 foundation。每次运行独立 HOME/CIRCLE_HOME/workspace，加载提交的 SKILL.md，OpenAI 兼容脚本模型从首轮可见声明工具，实际调用 server 文档工具并写出 JSON 文件。worker 保留一个 RPC 槽，同时执行子工具读，单 worker 也不会互等。发现 Mac /var 与 /private/var 的规范路径别名会误报输出逃逸，改为比较 realpath 后的工作目录，真实回归通过。

run token 仅授予声明工具/对应 scope/该任务及子工具任务，直接资产/其他任务/审批入口不可用。token 值只在 server 内存和认证 worker 的私有本机 IPC/子进程环境，不进公开 preflight/日志/运行文件；运行结束/取消失效。验收用同一授权私有通道取到实际 token，扫描已写出的 Circle home/workspace 字节没有值，目录仅显示声明的 docs.search，API 不能借它扩权。

RPC prompt/turn/tool/settled 等真实事件进入 C。只在 agent_settled、进程退出、声明输出存在且原字节 SHA 匹配后交付；B 保存输入/产物/独立字节收据，机械完整性与模型回答分开。个人产物下载也核对可读任务绑定，不能只凭 scope 绕过个人结果权限。取消先 abort/关 stdin，超时 kill；已观察本地退出仍保持 unknown、冻结资源、remoteStoppingVerified:false，旧 run token 不再可用，不把本地停止当远端停止。

实际 `r2-05-skillpacks.test.ts` **5/5**；完整 `npm test` contracts **4/4**、methods **6/6**、acceptance **52/53**，仍仅核心迁出守卫失败；参考另跑 **7/7**、714 原件完整，typecheck 通过。实际 CLI 入口字节 SHA 在运行收据登记；Git HEAD/版本校验不是整个编译 bundle 的发布证明。本阶段无付费模型、真实源/设备或部署，未 push。已更新交接文档为路由开放，并准备通知 Claude 从原会话推送 APV 包；APV 分支尚未合入/在 server 上重跑，auto-consolidation/bot、产品自动声明发布和核心迁出仍未完成。

只读查询确认 [PR #5](https://github.com/qingshanfeihu/circle-server/pull/5) 仍 OPEN，未触发 rebase。下一步按用户排队要求先改按需构建抓取，再继续第 6、7 幕。

### 第 5 幕独立复核与 Circle 版本选择

用户提供 Claude 对 `7be8576` 的独立复核：contracts 4/4、methods 6/6，在单独固定 d9f8ec6 的 Circle 构建上 r2-05 **5/5**。其他工作树向前移动导致 RUNTIME_VERSION_MISMATCH，是版本门禁按预期拒绝，不是业务失败。按用户建议，真实 CLI 验收现在明确读 `CIRCLE_BIN` 和 `CIRCLE_COMMIT`，缺少时三个用例标出原因并跳过；运行器的 profile/版本门禁保持严格。实际本机指定新提交 `3f08f0ed4216c356bbbd7db49531cb3ea22caf97`（1.1.1）联合复验目录/RPC **9/9**，没有跳过。新提交包含稳定 srv_ 后缀消歧、--file 输入和 X-Scope-Id，活动交接已更新。APV 分支更新到 `e8ecbc8`，outputs 改到 out/ 并读 inputs.json；尚未合入本分支。

## 12：按需构建资料与 SHA 缓存

按用户排队顺序，在第 5 幕提交后先写 `r2-buildsite-lazy.test.ts`，确认缺模块失败，再实现 metadata-only sync、按需 commandTree/fixed、持久 SHA 缓存和抓取限额。版本首页/版本线不抓 XML 或修复清单；命令首次使用才抓，后续不同 SourceCache 实例/worker 通过相同身份/资产版本/来源/构建段落索引复用原字节，构建声明变化重新抓。blob 每次读取验 SHA，文件锁避免重复并发下载，坏格式不入成功 XML 缓存；不存在/权限/登录/不通的失败不会成为成功缓存。

新增 read/sync `buildsite.fixed_releases`，只按指定的 1–20 个相关构建抓清单，保留所有匹配和候选内最早正式发布；空编号 unknown、Beta-only 不当正式版。coverage 明确不是全站完整覆盖。请求并发/开始间隔可配，默认构建工具 2/200ms，验收同时检查最大活跃请求数和开始间隔。没有连接真实构建站点。

实际 SDK/按需/限额 **9/9**，目录/RPC 在显式 3f08f0 Circle 上 **9/9**（无跳过），typecheck 通过。先前超限用例直接换 XML 而没换构建段落，现在按新缓存契约更新虚构镜像摘要后再测，wire RESULT_TOO_LARGE 保持。旧同步案例调整为明确按需取树/清单，原正式/Beta/ISO 编码/不访问旧跟踪链接机制继续通过。下一步第 6 幕定时整理和 bot，以及自动产品声明/第 7 幕专业核心迁出；这些仍未完成。

### 独立复核和真实云运行观察

用户提供 Claude 对 `2aa991f` 的复核：contracts 4/4、methods 6/6、acceptance 55/56，只有核心守卫失败，RPC 使用显式 cf32f7f 没有跳过。真实 Otty/Circle 在独立批准后把包变成 registered，worker 以无界面 Circle cf32f7f 执行 APV 包，15 次工具调用与本地一致，4 个产物 SHA 与本地相同（用户给出 case.xlsx 前缀 `6fcd622b`），remoteStoppingVerified=false。完整 Circle 提交只读核对为 `cf32f7f288ef1f0477d9537a138bfc6996654699`。这是用户观察，未补造完整制品 SHA。

用户复现缺失 fixed 链接/404 会令 releasesFor 全量失败，排在第 6 幕后补 allSettled/coverage 验收；页面不变原地替换 XML 会沿用缓存、暂无淘汰也记为现有限制，未宣称解决。

## 13：定时整理、事件与 bot

先写第 6 幕并确认入口失败（普通两条 0/2，实际 RPC 初始未配置而注明 skip），随后显式 cf32f7f 本机构建实现/验收。资产组合保留技能、触发、渠道与执行身份，第一版执行身份限登记者本人，权限/目录每次重查，尚未声称支持另一服务身份代理个人凭据。定时 dueAt、事件游标、task/occurrence 唯一键同事务落地；重启不丢不重，范围越权隐藏，外部 id 同内容去重/异内容拒绝。D 原件收据按 path/SHA 发 source.changed，未调用真实连接器。

整理用共用包 `packs/common/skills/knowledge-consolidation`，只读参考 InfoTest 的 session-checkpoint/memory-consolidator 边界说明，未执行或复制其代码/固定章节。运行者共享许可/所有权/当前源权限由程序固定；只取已授权合成片段，未共享原件不参与。真实 Circle 的脚本模型实际加载 SKILL.md、取共享片段、运行自写 TypeScript normalize、提交有原片段/工具返回的个人候选；规则去重，不声称真实会话的语义质量。候选不进正式快照、他人不可见，团队审核与产品来源权威边界沿用第 3 幕。

联验发现 z.toJSONSchema 默认输出形状把 default 参数也标为 required，Circle 拒绝省略 limit/conditions；改为 io=input，真实 RPC 省略参数后通过。渠道仅 Circle 事件、bot.output 与发布游标同事务保存，渠道注册可扩展，未做企业微信。当前声明仍未被自动提升到产品 stable，专业核心迁出待第 7 幕。

实际第 6 幕及规范器 **4/4**；显式 cf32f7f 的完整 `npm test` contracts **4/4**、methods **7/7**、acceptance **58/59**、无 skip，唯一红项仍旧专业核心守卫；typecheck/diff 检查通过。本阶段所有验收为合成资料/脚本模型，不是实际 auto dream 质量或生产部署。下一步修缺失修复清单，再第 7 幕。

## 14：缺失修复清单的部分覆盖

先增加 missing-link/404 的合成回归，确认抛 SOURCE_ABSENT 失败，再把 releasesFor 改为逐构建 Promise.allSettled。成功清单保留匹配、最早正式发布和原件 evidence；失败进入 coverage.missing（build/code），coverage.read 保留实际读到的构建。status 只由已读清单决定，全部缺失为 unknown，不因一份缺失丢掉其他答案；不宣称候选集合覆盖全站。普通工具结果仍把缺失/无权限分类统一隐藏，诊断者才看到完整来源分类。缓存原地替换/淘汰限制继续保留。

实际 `r2-buildsite-missing` + lazy + connectors **10/10**，typecheck 通过。没有连接真实站点。这项与第 6 幕分笔提交，下一步处理第 7 幕及自动产品来源提炼/第二产品线。

## 15：第 6 幕独立复核后的故障修复

用户提供 Claude 在临时工作树的独立复核：4700ef0 contracts 4/4、methods 7/7、acceptance 58/59，没有 skip，唯一红项 S2.7；2cdbca4 missing/lazy/r2-02 10/10，缺清单时 unknown 和 coverage.missing 正确。另复现晚批补跑洪泛、共享片段超过默认 20 后回报事务回滚而操作停在 running；单事件 ApiError 毒化整批是代码阅读发现，本轮新增回归确认同样失败。

先写四条验收并运行 **0/4**。定时案例进一步单跑确认原行为 31 个运行而预期 1；事件受理失败没有 runs 记录、游标停住；21 个共享来源首次读取留下 running；错误证据回报同样不能进入 failed。随后实现最近一次到期合并：原 due 游标到当前最新 due 之间只受理一次，skippedOccurrences/firstDueAt/dueAt 进输入、bot.started 事件与 runs，下一 due 严格在未来。新登记 intervalMs 下限 60000，runtime 也拒绝旧的过小间隔。bot 激活状态在受理事务内再次锁定核对。新增第 16 号迁移，不修改已经执行的迁移字节。

每个 occurrence 用 savepoint 隔离受理 ApiError，失败单独保存 status/error/trigger、taskId=null、审计原因并推进游标；后续新事件不受影响。没有为失败受理伪造任务或 bot.output。runs 保留 occurrenceKey/channel/published，新增字段已写客户端交接，Claude 将相应显示 error。非 ApiError 的数据库/程序故障仍回滚，不把它伪装成已处理事件。

共享片段改为 SQL 级 LIMIT 和基于源创建时间、recordId、片段 offset 的 after 游标，原件/历史引用仍验 SHA 与当前权限。默认 20、边界 1–100；返回 nextCursor，null 表示本次已到末尾。支持同一源包含超过一页的片段、来源之间翻页、重启续页、同键原页回放和身份隔离。索引在第 17 号迁移登记；整理 SKILL.md 明确逐页处理，未宣称每次 bot 自动保存已整理位置。

托管 worker 回报处理用 savepoint 回滚被拒绝的知识/制品写入，再落 failed 操作/任务、删除租约，并保存原回报 hash；迟到 fence、租约和输入校验仍在前置门禁。修复四条回归 **4/4**、typecheck 通过。来源返回 JSON null/非片段结构明确记 unmapped，不因访问空结构挂起。缺修复清单的补充验收先失败后通过：若有早于或同日于观察 earliestFormal 的正式构建清单未读，coverage.earliestFormalCertain=false；这个标志只覆盖候选集合，不宣称全站最早。

联验期间 Circle 的活动工作树由 cf32f7f 前进，严格 Git 门禁拒绝三个实际 RPC 用例。用户确认新提交 `8b2ceb6df620832bfd7925aede93bb35f4a605a2`（1.1.1）已构建，并提供固定 detached 工作树；后续验收使用其运行时 CIRCLE_BIN/CIRCLE_COMMIT，地址和本机路径不入库。Claude 正在 7420 的独立 2cdbca4 dev stack 做 Otty bot 联验，本轮没有操作该进程，也没有修改 Circle。

实际只读资产/连接器/知识/工具/按需/缺清单/分页专项 **25/25**。在用户提供的固定 8b2ceb6 构建上完整运行：contracts **4/4**、methods **7/7**、acceptance **63/64**，**无 skip**，实际 RPC、取消与定时整理均通过；唯一红项仍是已有 S2.7 的 15 处专业核心迁出。因 npm test 在这一红项处退出，另行执行 test:references **7/7**，verify:references 验证 **714** 原件。typecheck 和 diff 检查通过；相同被拒回报的幂等重传另补验证。第 7 幕、自动产品知识声明/快照和第二产品线仍未完成，没有宣称全阶段通过或远端停止，未 push。

### 494b4a2 独立复核与 Otty bot 观察

用户提供 Claude 独立复核：固定 Circle 8b2ceb6，contracts 4/4、methods 7/7、acceptance 63/64 无 skip、references 7/7，只有 S2.7 红；原两个复现脚本确认 startsAt 早 30 分钟只建 1 个任务、skippedOccurrences=30，21 片段为 20+nextCursor 再 1+null，操作 succeeded。真实 Otty 使用 server 494b4a2 + Circle 8ed6660：晚 3 小时的每小时 bot 只编译 1 次，Circle 显示合并 3 次错过项，4 个产物 SHA 与手动运行一致；停用技能资产后的事件受理记录 null/failed/APPROVAL_STALE，未编译且显示 not started；事件同 id 去重和异内容拒绝在该栈确认。这些是用户观察，不补造制品摘要。

新发现的设计风险是动态页面可能让 bot 的工具读回执产生 source.changed 再触发自己；排在本步入库收尾之后，须增加真实脚本模型的回归。开发登录 token 有效 5 分钟，Circle 后台 401 只提示 sign-in expired、不弹密码；正式身份的刷新机制是第 7 幕之外的已知限制，当前没有实现刷新或声称接入正式身份。

## 16：产品来源的自动知识入库

先写三条验收，确认 **0/3**：读回执只存 SourceRevision/Evidence，没有正式检索声明；共享/footprint 类型误标 product 可绕过许可检查。新增通用 B 的产品观察接收/快照机制；具体结构抽取在连接器包。server 从已验 SHA 的原字节重新抽取，保留 来源修订 → 证据 → 实体 → 脚本声明 → 脚本评估 → 快照 闭包；原件、类别、来源类型、抽取规则版本固定。脚本仅确认文档字面内容、构建发布字段、命令定义/参数、镜像字段和环境读回值，不声明功能语义或模型判断正确。非 UTF-8/过大正文仅入原件摘要，未运行文档转换。

来源身份增加不含凭据的请求 hash，批量 POST 和不同查看参数不会互相覆盖修订。重复读取同字节不新增知识记录；当前产品 stable 排除已被新源修订替代的声明，历史原件和声明不改。空列表也更新快照，新增验收先确认旧列表声明残留，再修复；不删除独立详情来源的观察。源读取权限仍只授予实际读取者，按当前资产读者、相应读取 grant、个人凭据所有者/引用/停用状态再过滤；停用凭据的派生访问回归先失败后通过。旧工具来源也补上当前资产读者约束，不读取任何凭据值做知识检索。

shared-session/skill-run/bot-run/review-correction/footprint 必须标 consolidated 且有显式共享许可；模型候选不自动变产品事实或进正式快照。单独人工审核/API 能力沿用第 3 幕。当前没有使用真实知识、会话或企业来源；源系统自身的权限观察仍以取得的来源 ACL/执行身份为准，没有实时探测真实系统撤权。

实际新增入库验收 **4/4**，与原知识/目录联合 **14/14**；固定 8b2ceb6 的 SDK/按需/RPC/bot 联验 **19/19**，无 skip，typecheck/diff 检查通过。核心迁出与第二产品线仍待完成，下一步先隔离 bot 自己的 observed 事件，再迁出核心；APV 三笔已由用户明确指定 cherry-pick，保持 Claude 作者/信息，不修改其技能脚本或 SKILL.md。

### 4b7866d 独立复核与规模问题

用户提供 Claude 对 4b7866d 的独立复核：固定 Circle 8b2ceb6，contracts 4/4、methods 7/7、acceptance 67/68 无 skip、references 7/7，只有 S2.7 红。同时量化出同步入库的性能缺陷：2000 条命令、两个构建的四次读耗时约 9.7/19.5/18.0/11.7 秒，原 494b4a2 对照约 0.55/0.55/0.36/0.36 秒。缓存命中和仅版本页也随整个 scope 的已审声明数量增长，说明本节通过的是行为/权限验收，未达到真实规模的延迟要求。须补规模验收，改为持久异步入库、批量投影写入、增量或去抖快照发布；原件仍在同步回报留证，读取结果不等待知识发布。该修复排在核心迁出之前。

## 17：APV 技能包采用与 bot observed 隔离

按用户明确指示 cherry-pick 三笔 APV 提交，原作者、日期、提交信息和 co-author 保留：e147364 → 4fcf98c，e8ecbc8 → c6471d0，b00ce21 → 5f11c5d。包内脚本、SKILL.md、清单和合成材料字节未改，`node --test packs/apv/skills/apv-mindmap-compile/tests/compile.test.mjs` **4/4**。后续要改技能脚本/SKILL.md 时先通过 Otty 告知 Claude，由他修改和复核；第一阶段兼容方法、配置与知识映射也归 packs/apv，尚未迁出核心。

先新增固定 Circle/脚本模型的动态来源回归，确认 bot 读回执立即产生第二个运行而失败（2 对 1）。随后按 C 保存的子工具任务 → parentRunTaskId → automation_runs 关系识别 bot 来源，不相信输入 trigger 或客户端声明；任何 bot 运行产生的 observed 事件不进入触发流，仍保留 SHA 原件、证据和知识观察。外部显式连接器事件与普通人工工具读取仍触发，避免自循环和多个 bot 互相放大。新增第 18 号来源索引迁移，旧迁移不改。

实际 RPC/bot/分页/产品入库联合 **17/17**，固定 8b2ceb6，无 skip；动态来源原件至少读取三次，但仅外部事件和人工读产生两个触发、两个 bot 运行；入库可检索、产物交付未损。typecheck/diff 检查通过。性能修复、核心迁出和第二产品线仍待完成，未 push，未动 Claude 的 Otty 栈。

用户独立复核 73c91d0：contracts 4/4、methods 7/7、acceptance 68/69 无 skip、references 7/7，只有 S2.7 红，新动态来源回归通过；认可持久 parentRunTaskId→automation_runs 的来源判断。性能复测将使用相同 2000 命令四次读脚本。

## 18：异步产品投影与规模回归

先写 2000 命令、两个构建、缓存命中和版本列表的延迟验收，首条读取实际约 8.9 秒，超过 1 秒门槛而失败。第 19 号迁移新增持久投影 outbox、source head generation、已索引来源和增量快照成员。同步回报仍保存/核对原件与证据，再受理个人 asset-index 任务；不运行投影或快照发布，工具形状与结果不改。独立 runner 的租约/尝试号支持 server 中断重取，使用 sealed 原件重新抽取、每 200 条批量写入记录/引用，每批及最终发布重新查权限，progress/completed 或 task.failed 可补读。

已索引同来源/规则不再逐命令写库。知识成员按声明与来源增量维护，整组投影成功才由暂存成员切入 stable；已替换来源通过索引删除，快照清单用一次集合查询生成，不逐声明算 closure。清单序列化仍随成员字节数增长，但位于异步 runner；同步读取不拿 stable 锁。六记录的通用引用登记也改批量插入。旧快照成员在迁移时回填，手工审核/快照维护仍接同一成员表。源 generation 支持新字节变化后再次观察旧字节，复用原记录并正确恢复发布；空源和独立详情保留边界继续测。

本机规模专项初验 **2/2**：四次读 p95 约 **170ms**，投影同时运行时版本读取约 **195/145/146/120ms**；读取时尚无声明，SIGKILL server 后恢复 outbox，两个构建共 4000 多条命令异步完成且检索可见。另故意让后续批次失败，已写的暂存成员不会进入后续独立文档任务的快照，原读取保持成功、索引任务清楚失败。RPC/bot/分页在固定 8b2ceb6 上 **13/13** 无 skip，知识/目录联合此前 **14/14**；升级与整套回归正在收尾，不把这些专项数字当成全阶段通过。核心迁出与第二产品线仍待完成。

收尾实际：产品入库/升级 **5/5**；固定 8b2ceb6 的完整 contracts **4/4**、methods **7/7**、acceptance **71/72**，**无 skip**，唯一红项仍为 S2.7 的 15 处专业核心迁出。该整套规模案例四次读 p95 **163ms**，投影同时运行的版本读取 **224/140/127/119ms**。因 npm test 在守卫失败后退出，另行执行 references **7/7**、verify:references **714** 原件；typecheck/diff 检查通过。并发重启的验收使用随机端口，须让验收 worker 重新连接新地址，已修正这个夹具重连再复测；没有改运行中的 Otty 栈。以上是本机合成规模，不当作真实内网吞吐保证。未 push；下一步继续核心迁出与第二产品线。

### 892a80c 独立性能复测

用户提供 Claude 独立复核：固定 8b2ceb6，contracts 4/4、methods 7/7、acceptance 71/72 无 skip、references 7/7，只有 S2.7 红。相同四次读实测 **536/590/325/324ms**，接近 494b4a2 的 **547/554/359/356ms**；约 **2.8s** 异步完成 **4013** 条声明，同修订读复用工作，四次读共三个索引任务。全文检索 service inspect 1999 命中两个构建。用户确认性能问题解决。这是独立观察，未改写本机专项数字。

## 19：产品包注册、核心迁出与工作列表

第 7 幕先增加包注册/撤下旧能力验收，与原守卫一起 **0/2**。编译专用契约、解析/写出/独立回读、服务器推进与 worker 方法迁入 packs/apv；原编译接口、固定版本、产物 key 算法与冻结八行预期保留。旧迁移 SQL 字节、版本、名称不改；第 2 号迁移按通用交付改文件名，第 5 号兼容索引归 APV 包。无能力包的旧流程 pin 通过显式兼容注册继续支持，不改历史记录。

C 使用已安装能力/流程版本及交付验证注册表；D 使用声明的 claim/preflight/report 控制器，租约、fence、心跳、未知冻结和独立核对留在核心；B 的制品描述由专业包提供，不计算固定专业方法的 key。专业 checklist 判断通过注册谓词实现，模型不能满足事实项的核心门禁仍在。worker 的编译与合成操作由安装方法分派，核心入口不含具体能力或系统名。守卫没有扩充豁免、缩小扫描或拼字符串规避，15 处实际迁出后为 0。

旧 LBX 健康能力从可用包和受理撤下。中性 SYNTH 资源、record-feed-a/record-feed-b 和 document-store 保留原审批、改配置、超时未知、游标/外部 id 去重、转换与标记回读机制；不再提供旧缺陷系统/文档系统命名的运行桩。InfoTest 和归档业务模块未引入；运行导入守卫扩大到 packs 的 TS/MJS。所有新自写执行代码为 TS；Claude 的 APV Node 脚本按用户授权原字节保留，产品参数/知识映射在 packs/apv/product-line.json，别名实际由包安装读取。

第二个虚构包 packs/meridian 使用同一文档连接器及自己的别名、技能、TS 规则，登记在第二个 scope，经独立人员审批、固定 Circle RPC/脚本模型取原件、校验 SHA、生成字面匹配报告并存入 B。跨 scope 拒绝、工具目录不带另一产品工具、agent_settled/产物回读均验收；只证明来源字面观察，不宣称完整产品语义。包内没有修改 APV 技能脚本或 SKILL.md。新注册验收初次还暴露把资产登记审批任务设为个人可见会阻止独立审核，调整登记任务为原授权范围可见；工具、索引、运行仍个人分区，实际技能包审批回归通过。

用户另指出内部任务挤满最近 100 条，Circle f505db0 已先在客户端隐藏工具/索引。服务端先写 **0/1** 回归（110 条内部任务挤掉工作），再增加 kind=work|tool|index、精确 capabilityPackId 和 after taskId；TaskView 数组不变，权限/类别过滤先于 limit，游标按完整创建时间/taskId，跨 scope/个人游标拒绝。新分页及原客户端读接口联合 **4/4**，交接文档已写明。

本次本机实际：迁出编译与中性治理专项 **20/20**；注册/第二产品线和 RPC 联合 **7/7**，固定 8b2ceb6，无 skip；完整 `npm test` contracts **4/4**、methods **7/7**、acceptance **75/75**、references **7/7**，**无 skip**，第 7 幕守卫通过。APV 包内另 **4/4**，与 b00ce21 的技能目录字节相同。当前是修订 2 七幕合成范围全绿；真实源、正式身份刷新、模型质量、付费模型、自动化环境改动、网络开放和部署未验收/授权，缓存原地换 XML/淘汰限制继续存在。本步只本地提交，不 push/开 PR，Circle、server-s1 和运行中 Otty 栈未改。

### 第 7 幕独立认可与客户端任务分类

用户提供 Claude 对 330edae+a04f84c 的独立复核：临时工作树、固定 Circle 8b2ceb6，contracts 4/4、methods 7/7、acceptance 75/75、references 7/7、typecheck 通过，没有 skip；R2.7 两条含实际 Meridian RPC 通过。a04f84c 只移除一个空行，APV 技能目录与 5f11c5d 相同。额外用 apv/photon/xmind/plmquery/show_bug/bugs_fixed/meridian 扫描非连接器核心未发现具体名，核心只从 packs/index.ts 和 packs/worker.ts 安装入口接包。用户认可第 7 幕，并建议扩大守卫和通用安装清单。

Claude 报告 Circle bd646a5 已把工作页改用 kind=work&limit=20，工具/索引 kind 各 limit=100 只计数，对旧 server 保留 capabilityPackId 过滤。客户端 npm run check 425 条中 423 通过、2 跳过，workbench 24/24。server a04f84c + Circle bd646a5 的最后一轮真实 Otty 联验由 Claude 控制 7420 栈，尚未提供最终结果；本轮没有操作该栈。固定 8b2ceb6 工作树保留用于服务端验收。

## 20：产品线守卫与运行时清单加载

先写更宽守卫和连接器独立守卫；实际连接器守卫初次失败，指出 synthetic-readonly.ts 的 7 处 PHOTON 合成名。将整份合成源移到 packs/synthetic/readonly-sources.ts，dev:stack 与测试夹具改从这里加载，源字节和场景未改变。核心加入 apv/photon/meridian/xmind，所有 apps/packages 的产品线名均扫描，连接器/映射/方法/策略只豁免具体系统行为，不豁免产品线名。连接器另有独立扫描。

再写运行时第三产品线和无效声明验收，实际 **0/2**：清单未生效导致两个文档实例使用同前缀冲突，通用加载器也尚不存在。随后按 installed-product-lines/1 文件逐个读取 product-line/1，不再从 index.ts 写死 APV 清单或别名。清单文件从 CIRCLE_SERVER_PRODUCT_LINES 选择，缺省使用 packs 的版本化安装列表；支持原来的字符串 connectorPackages 和 Meridian 的 packageId/alias 对象。未知包、重复产品线/连接器、冲突声明、非法相对文件路径或 schema 版本拒绝启动，错误不回显配置原文或本机路径。

连接器资产可用 configuration.productLineId 选清单默认前缀，显式 alias 继续作为实例别名；名称唯一、当前权限、个人凭据、ETag、worker 受理/证据路径保持。移除产品线后明确绑定的工具隐藏；省略 productLineId 的旧资产使用已安装通用连接器，默认名称兼容。清单不会自动导入可执行文件或绕过技能审批，历史迁移和既有编译实现继续安装。新产品线复用已有连接器和受治理技能运行器，仅增加清单、文件与运行配置即可。接口及配置写入 client-api-handoff 和 packs/README。

新增守卫/安装专项 **4/4**、typecheck 通过；第三条虚构产品线实际读原件并留 SHA 证据，移除后调用拒绝、恢复后绑定可见，跨实例冲突门禁保留，空安装列表只保留公共知识工具。原 Meridian RPC 验收改为只带 productLineId，由服务器加载其别名。完整固定 Circle 回归 contracts **4/4**、methods **7/7**、acceptance **78/78**、references **7/7**，**无 skip**；规模四次读 p95 **164ms**。APV 技能目录与 5f11c5d 字节相同、包内 4/4，references 验证 714 原件，typecheck/diff 检查通过。本轮只本地提交，不 push。

### 真实构建站点冒烟发现的下一步阻塞

Claude 报告以 a04f84c 连接器和其控制的 7420 栈新资产做过只读冒烟，并发 2、间隔 200ms，只取 1 个 XML 和少量页面；本代理没有访问真实源。发现四项结构差异：索引先链接汇总页，汇总页混合多个产品及变体再链接列表；只有正式已发布构建标题被 font 包住，其余是纯文本紧随 BLOCKQUOTE，变体文件有前缀和不同镜像后缀；命令头须由全部祖先 menu 与 item 拼接、scope 独立保留；修复链接同时有直接缺陷编号和历史外部编号，须标识编号体系。现有合成全绿不覆盖这些结构，真实连接器路径尚不可用。下一步先用同形虚构数据验收，再修通用解析、产品包过滤/平台配置与知识投影，保持按需下载和来源证据，不写内网地址、域名或真实构建名，也不改 Claude 的技能脚本。

用户提供 Claude 对 a22ea1b 的独立复核：固定 Circle 8b2ceb6，contracts 4/4、methods 7/7、acceptance 78/78、typecheck 通过、无 skip；连接器搜不到产品线名，两条非阻塞建议均认可。真实站点结构修复提交后，仍由 Claude 在其控制的 7420 栈只读复测。

## 21：构建站点的真实结构回归

先写五条同形合成验收，实际 **0/5**：汇总遍历得到 0 个构建而应为 8；混合 font/纯文本只读 2 条而应为 4；两条不同路径的 group 都被读成 group；修复清单没有编号体系；产品选项还不能注册。这些仅用临时 HTTP 夹具与 PostgreSQL，构建名、编号、日期、内容全是虚构，没有访问企业源。

通用 catalog 支持首页/汇总/列表遍历、同源路径、循环去重和深度/页数上限。APV 的列表前缀与变体映射归 packs/apv/product-line.json，连接器只使用配置；未知变体保留源后缀。只读版本工具留首页、汇总、列表证据，不下 XML 或修复页。构建按标题文本紧随 BLOCKQUOTE 解析，font 不作门槛；支持 .array/.click 与变体前缀、大小/SHA。buildId 包含名称和平台，同名变体各自保留；旧构建名有歧义则明确拒绝，可按 buildId 或 platform 选择。XML/修复清单仍只对选定构建按需取，CAS/个人缓存与并发/间隔限制沿用。

命令由所有祖先 menu 加 item 拼接，scope/menuPath 原样保留。heads/param/check 和异步产品抽取共用同一解析；parserVersion 为 menu-path/2，专业匹配规则仍最长八词。参数、缺失与违规继续确定性核对，不用手册填补缺失。旧合成 XML 的完整命令名去掉冗余包裹 menu，既有命令预期保持；新增多级真实形状夹具独立证明路径，未改 APV 技能脚本。

修复清单同时读直接禅道链接和历史 Bugzilla 链接，不跟随这些链接。带 system/id 的编号分别关联原缺陷 id 或 bugzillaID，数字相同不能混用。fixed_releases 新增 issueSystem/issueId，旧 legacyIssueId 默认历史体系兼容；SDK 旧字符串 fixedIds 仍只表示历史体系，新增 fixedIssues。正式/Beta/未知、多个发布与部分缺失 coverage 保留，平台身份进入覆盖引用。产品修复知识新增 fixed-issues，原 fixed-identifiers 旧义保留。

发现修复投影版本后、同 SHA 重读会把旧叶子声明和新全路径声明同时留在 stable。新增旧版投影种子回归，先确认为 **1 条旧成员残留而失败**，再将已完成源投影作为整组原子替换：仅重新索引的来源替换旧脚本成员，缓存命中来源和人工声明保留；历史 Claim/原件不改。构建投影升级 source-projection/2，同源重读触发新版本索引；尚未重读的历史来源不补造修复结果。

专项首次收尾 **26/26**；再加入同 SHA 投影替换回归后，知识/规模/结构专项 **12/12**，p95 **170ms**、索引中版本读 **204/146/146/122ms**。typecheck 通过，APV 技能目录字节未改。固定 8b2ceb6 的完整回归正在运行，真实站点仍待 Claude 复测，不把合成通过当成真实来源通过。本轮不 push、不改 Circle/7420。

收尾完整回归：固定 Circle 8b2ceb6，contracts **4/4**、methods **7/7**、acceptance **83/83**、references **7/7**，**无 skip**；实际 RPC、脑图接口、审批/中断/连接器、bot、守卫均通过。整套规模 p95 **167ms**、索引中版本读 **210/142/121/152ms**。verify:references **714** 原件，typecheck/diff 检查通过，APV 包内另 **4/4**、技能目录仍与 5f11c5d 相同。本代理只读确认 PR #5 仍 OPEN，无需改基线；主工作树 clean。本笔只在 server-s2 本地提交，更新交接并通过 Otty 告知 Claude 可复测，未访问真实来源。真实复测结果与非合成的业务正确性继续待确认。

### 7dae089 独立复核与第二轮真实只读观察

Claude 报告临时工作树、固定 Circle 8b2ceb6，contracts 4/4、methods 7/7、acceptance 83/83、typecheck 通过。其控制的 7420 栈新 build-site 资产按 productLineId 和实例别名接入真实站点：汇总遍历、纯文本标题已通，多条版本线可列出，一条线的普通/OS 页面共 260 个构建、正式 2 个；直接缺陷编号能找到正式发布，同号历史体系 unknown，不串编号。真实完整命令最长 7 词。此处仅保留结构和汇总，不记录真实构建名、缺陷编号、地址或域名。

仍有 A–E 阻塞：同号同平台重建导致整页冲突；同 scope 同头的不同参数是重载；单 build 调用每次遍历全站、任一线失败就整体失败；平台映射大小写不同且变体词表需扩展；带连字符、只有 nodebug 镜像/MIB/修复页而无 XML 的构建被漏掉。

Claude 另报告匿名 WebDAV PROPFIND 207，不需要账号：list 根目录约 124ms、一个 md get 约 138ms、重读 SHA 相同；两个平铺目录各约千文件，命令目录按版本、多层组织。原 search 只看一层而根下均是目录，真实搜索为零；不能改成每次全站下载。路径是站点绝对路径，`/` 不支持该站 PROPFIND。PLM 等用户本人重新注册运行时凭据后再测。本代理未访问这些真实来源或取得 token。

## 22：重建、重载、单页定位与文档搜索

先加 A/C/D/E 三条连接器验收和 B 方法验收，四条新增实际 **0/4**（另两条原方法通过）：重建抛 conflicting page segments，单构建被另一线 404 拖垮，连字符变体少一条，重载导致任意 prefix 失败。再加两条版本目录/WebDAV 验收，实际 **0/2**：目录搜索零命中，产品文档选项尚不支持。所有夹具为同形虚构数据、临时 HTTP/PostgreSQL，不含真实源内容。

重建按有效时间取唯一最新条，旧段落及 SHA/时间留在 superseded；相同或缺失时间的冲突标 current=false/coverage.conflicts，不选一个冒充最新。source/listing/catalog 都局部返回，页面读取失败进入 coverage.missing；其余构建、版本线照常可用。SDK 直接取 XML/清单也核对冲突，另补先失败后通过的调用回归；release allSettled 仍保留其他匹配。带连字符名称、nodebug click 和无命令树元数据保留，commandTreeAvailable 明确。平台映射忽略大小写，APV 词表增加所报告的新后缀；未知值保留规范化来源标签，不推测其芯片/系统含义。

同头按 scope/完整参数签名去重，heads 唯一列出；param 返回完整 signatures，单签名旧 parameters 保留，多签名为空并标 overloaded。check 独立评估每条签名，任一完整通过才无违规；matchedSignatures/signatureChecks 留下依据，不混拼参数。command-tree 升级 1.1.0，构建投影升级 source-projection/3；知识里一组命令签名只一条声明，历史版本仍留原件/旧结论。实际 worker/API 与稳定检索覆盖重载，不只测方法函数。通过 Otty 提前告知 Claude 检查 APV 包的 signatures 适配；本代理未改脚本或 SKILL.md。

版本列表建立私有持久定位：身份/资产修订/凭据/来源/策略绑定的 buildId 或名称 → 列表页与平台。已知构建只重读相关页，更新当前段落，再取按 SHA 缓存的选定 XML/清单；冷调用先发现一次。元数据索引加原子文件写入和并发锁，worker 重启仍定位；不拿缓存代替当前源权限和段落核对。原件投影可以仅靠保留的列表页，不再要求每次带全站首页；未引入同步知识扫描。

docs.search 新增 path，产品包声明版本目录模板；APV 的 cli/版本目录约定留在包中。按选定目录有界递归，默认深度 3、文件 100、目录 64、原件 4 MiB、命中 100；超限明确 RESULT_TOO_LARGE，不截断或伪造无命中。先扫目录，文件超限不下载正文；get/search 原件按当前目录 etag 复用，无稳定标识才重取。返回行号/片段/SHA、coverage 和 skipped，原件进 B 后仍异步进入产品全文检索。越权调用拒绝、许可沿用当前资产/源身份；站点绝对路径约定已写交接。

专项知识/规模/构建/WebDAV/守卫 **19/19**，规模 p95 **164ms**、索引中版本读 **196/145/148/151ms**；目录/工具联合此前 **6/6**，方法重载 **3/3**，typecheck/diff 检查通过。完整固定 Circle 8b2ceb6 回归正在运行，真实站点和 WebDAV 待 Claude 同一套只读复测；只在 server-s2 本地提交，不 push，不动 7420 或 Circle。

收尾实际完整 `npm test`：固定 8b2ceb6，contracts **4/4**、methods **8/8**、acceptance **88/88**、references **7/7**，**无 skip**。整套规模 p95 **164ms**、索引中版本读 **239/134/135/177ms**。typecheck/diff 检查通过，verify:references **714**，APV 包内另 **4/4**且技能目录仍与 5f11c5d 字节相同。通过 Otty 已向 Claude 的唯一窗口发送 signatures/doc.search 交接预告，实际修改的仅产品配置/通用代码/合成夹具。PR #5 只读确认仍 OPEN。本笔只本地提交，接下来由 Claude 复测真实构建站点/WebDAV；PLM 不做未授权探测。缓存暂无淘汰、列表段落不变而 XML 原地替换的限制仍在，不把回归数字当成真实站点已通过。

## 23：第三轮真实只读观察与 APV 技能适配采用

用户提供 Claude 对 f36613a 的独立复核：临时工作树、固定 Circle 8b2ceb6，contracts **4/4**、methods **8/8**、acceptance **88/88**、typecheck 通过、无 skip。其控制的 7420 栈以 productLineId=apv 做第三轮真实只读冒烟，报告基本通过；本代理没有访问真实来源。

八条版本线均可列出，冷遍历 **9.9s**、**4521** 个构建，superseded **9**、conflicts **1**；冲突仅影响一条线，complete=false，其余正常。无 versionLine 的选定 XML 冷取 **605ms**、缓存读 **143ms**；一个命令前缀列出 **36** 个头，重载有 **2** 个签名，TYPE_MISMATCH/ARGUMENT_COUNT/OUT_OF_RANGE 与逐签名原因符合观察。按直接缺陷编号查修复约 **347ms**，published 且 earliestFormalCertain=true。文档 version 定位到包声明的 CLI 目录，查到 **92** 个命中，无 version 明确 RESULT_TOO_LARGE；异步入库约 **2s** 后可全文查命令声明。此处只保存结构、聚合及延迟，不写真实构建名、编号、地址、域名或原文。

按用户明确授权 cherry-pick APV 分支 **eb10d12 → 42977fd**，原作者、作者日期、提交正文与 Claude co-author 保留。仅 SKILL.md 变化：默认绑定主平台上 current 不为 false 且有命令树的最新正式构建；后续用 buildId、报告保留构建名；重载读 signatures；手册搜索用 version，缺少手册可继续并披露。整个技能目录与 eb10d12 字节相同，脚本和测试未由本代理修改。Claude 报告合成栈上这版完成试跑、推送、批准和 server 运行，case.xlsx SHA 仍以 **6fcd622b** 开头；只记录用户给出的前缀，不补造完整 SHA。

本次实际只验证适用范围：APV 包内 **4/4**、两条核心/连接器守卫 **2/2**，无 skip，diff 检查通过。没有重新运行未变的整套代码，也没有把用户观察冒充本代理的真实复跑。PR #5 只读确认仍 OPEN；本步只在 server-s2 本地提交，不 push、不改 Circle 或运行中的 7420 栈。

两条非阻塞观察保留：部分后缀可能是功能分支或平台/架构，当前统一作为 platform 标签，不能据名称认定其类型；后续清单可增加 platform/branch/unknown 的变体类别，经确认后填写。同名多平台只传构建名时失败是明确选择要求，交接已有说明。PLM 等用户本人提供并注册运行时 token 后由 Claude 测试，本代理不取得 token 或探测真实服务。另已核对普通身份的缺失/无权限仍统一 SOURCE_FORBIDDEN，只有 sources.diagnose 才暴露 SOURCE_ABSENT；技能中的缺手册披露应同时尊重这条已确认隐藏规则，已通过 Otty 提醒维护者，不改其原件。

### 缺手册错误隐藏规则的技能说明修正

Claude 确认原文会让模型从错误码推断手册不存在，并在 apv-pack 提交 9931f20，仅改 SKILL.md 一行。按用户新授权 cherry-pick **9931f20 → 6b1eae8**，保留原作者、日期、完整正文与 co-author；整个技能目录与 9931f20 字节相同。手册搜索失败只表示本次运行未取得手册，继续编译并披露“未取得手册”，不得从 SOURCE_FORBIDDEN/SOURCE_ABSENT 推断不存在或具体权限原因，手册仍只解释显示方式，不决定命令和预期。

本次 APV 包内 **4/4**、核心/连接器守卫 **2/2**、无 skip，diff 检查通过；脚本及核心代码未改，未重复未变的全套测试。用户认可变体分类只记待确认，本步不增加猜测的分类。本地提交，不 push，不修改 Circle/7420，未取得凭据或连接真实源。

## 24：版本列表输出与开发会话续期

用户暂停脑图编译，报告 versions 一条线超过万行、全站十万行，开发会话五分钟过期且长任务弹密码框。核对确认 Auth.issue 默认和上限均为 300000ms；Circle 普通工具 request 收到 401 会调用 reauthorize/askSecret，后台部分检查才不弹。版本工具直接返回完整 BuildRecord、文件与替代历史。没有把登录、任务、执行生命周期混成一个问题，未修改 Circle 或演示栈。

先写五条分页/会话验收，实际 **0/5**：508 个虚构构建全量回传、警告嵌套历史，默认仍五分钟，refresh 路由 404。随后默认 page=1/limit=20、上限 100，版本线与 formal/platform/current/commandTreeAvailable 过滤在计数与分页之前；正式/发布日期倒序稳定排序，返回七字段和 total/hasMore/nextPage/revision。coverage 只给有限浅层诊断和完整 counts，不丢完整原件、全部定位或异步产品抽取。508 构建默认回复小于 12 KiB；跨页不重复，源修订一致可核对，边界拒绝。只挑主平台最新可用正式构建可 limit=1，不要求模型读取全集。

开发默认八小时，可配置一秒至二十四小时，显式短期限仍用于原失效回归。新增 CLIENT_ROUTES.authRefresh：有效 Bearer + 空 JSON，无密码，同 token 延有效期；并发旧请求继续可用，不接受自报 scope/身份/期限，当前策略再查，过期/撤销/禁用不能续。短会话持续跟读到原到期后并重启 server，仍可读/续期，无额外密码交换。正式企业认证/SSO 刷新没有因这次改动自动接入。

短 run token 仍按当前租约、操作/fence/修订约束，由已校验 worker preflight 续期且不超过操作 deadline；不让客户端 refresh 升成八小时通用会话。固定 Circle、脚本模型延迟使运行跨过原一秒 token 到期，仍交付；终态后即失效，取消、租约与 fence 边界沿用。token 不落盘、授权没有扩大，任务 deadline 与本地取消/远端停止的区别保留。

通过 Otty 告知 Claude 负责客户端边界。用户报告 Circle server-tools **2035247** 只改扩展/测试，npm run check **428** 中 **426** 通过、**2** 跳过；新增临近到期无交互续期、旧 server 404/405 只尝试一次、过期工具和任务轮询只提示不弹框。接口已按其 Bearer/空 JSON/登录同形响应约定实现。待 server 本地提交后由 Claude 更新其控制的 7420、重开演示 Circle；本代理不操作栈，也不把客户端报告算成本机验收。

实际固定 Circle 8b2ceb6 的分页、开发会话、慢速 RPC 和结构专项 **16/16**，无 skip；typecheck 通过。完整回归正在收尾，APV 包内 **4/4**、引用验证 **714** 原件；技能目录未修改。交接已更新，后续仍只本地提交，不 push，等待用户侧部署后再编译。

本次完整收尾：固定 8b2ceb6 的 contracts **4/4**、methods **8/8**、acceptance **94/94**、references **7/7**，**无 skip**；typecheck/diff 检查通过，引用 **714**、APV 包内另 **4/4**。整套规模 p95 **164ms**、索引中版本读 **227/142/127/143ms**。技能目录仍与 9931f20 相同，无框架/Circle 源码或真实连接器改动。只读确认 PR #5 仍 OPEN，工作保持 server-s2。本地提交后通过 Otty 告知 Claude 接口就绪，由其部署演示栈及重开客户端；本代理不 push、不操作 7420，不把尚未重新联验的演示说成已恢复。

## 25：上机授权与读侧故障修复

用户新增授权 APV 执行工作簿经既有 MCP 网关提交测试床、本机部署，并要求在投递前由 server 重读所有设备命令、对绑定构建独立 command_check；客户端/技能包回执不得放行。真实投递等用户上传，既有网关、设备初始化和环境改造不在实现范围内。地址、个人访问/刷新令牌和 CA 配置全部只在运行时提供。server-s1/主工作树/Circle/InfoTest/归档未改，本步不 push。

Claude 提供脱敏诊断：镜像 keyword 仅客户端过滤，无源筛选时取全表约 49 MiB/11.9 万条，首字节约 11.3 秒、总 13 秒；带 product/status 时约 1.7 MiB/0.9 秒。文档 `/` 的 PROPFIND 是 405，登记的 WebDAV 根正常，spec 有千级平铺文件。网关本身在线，但上游 introspect 不可达，任何调用均 503；这是环境阻塞，不能靠换用户令牌修复。仅记录结构与聚合，不保存真实原件、内部地址或日志。

先写四条读侧回归，实际 **0/4**：无筛选发了 HTTP、page/limit 流入源查询、文档列表未分页、1018 文件触发旧上限。修复后与原文档联合 **6/6**，目录/工具/入库/守卫联合 **15/15**。镜像要求 product/status/日期，keyword 还须 product；本地分页默认 20/上限 100，过滤后过大报 RESULT_TOO_LARGE，30 秒请求超时。文档列表分页，默认登记根、错误站点根提示授权 root，405 与非 207 明确。搜索目录元数据最多 5000 文件，原件每页默认 20/最多 100，命中续行游标；etag 缓存复用，游标绑定身份/查询/修订，完整性显式披露。交接已更新。

上机实现仍在工作区：独立工作簿读取和四种检查点判定/歧义回归 **2/2**，令牌单写者轮换与网关传输 **2/2**，第一轮治理执行专项 **4/4**。新增更严格的“列表段落不变、XML 原地变化”验收实际失败，正在补执行关口强制重新取 XML；普通只读缓存的历史限制不伪称已消失。尚需中断/未知/审批变化边界、完整测试、部署交接及真实网关可达性验收。当前读侧提交不包含未完成执行代码。

Claude 确认逐步字段在线不可读，本地 gateway 源码仅逐案判定和日志；server 自写 TS 按明确日志帧抽检查点，数量/模式/方法有歧义则 unknown/unmapped，不把整案 PASS 推成逐步 PASS。原始 case log/sessions 保留 SHA 证据。Circle **97c786e** 已把同步工具完整响应写 `.circle/server-returns/` 并返回 savedAs；server 不写客户端工作区、不重复这项实现。Claude 控制唯一 7420 演示栈，将在本地提交复核后部署；本代理不停止该栈，不读取个人 token 文件，也没有真实上机。

### f95a951 的独立复核、真实部署观察与更正

Claude 报告 typecheck、contracts 4/4、methods 8/8、references 7/7 和原件验证通过；acceptance 97/98，record-feed-b 在并发负载下一次失败，单跑两次均通过。已由其部署到 7420：缺陷空参/纯 keyword 被拒，受筛选列表约 1.1–5 秒、分页和标题过滤正常；文档默认登记根、站点根提示、千级 spec 列表分页正常，搜索每页 20 原件约 4.2 秒。完整 spec 约 51 页，当前没有短期目录遍历缓存，查询需补页，不能把单页无命中当成全目录无命中。只记用户提供的聚合与结构，不写真实产品 id、名称、缺陷或源地址。

用户更正“大目录坏了”和游标 revision 抖动的推断：不带尾斜杠的目录会收到 301，补 `/` 正常；被拒的是手拼游标，服务返回的 nextCursor 正常续页。因此本步自动规范化目录路径，不把大目录或连续游标误记为故障。新增同形 1018 文件、不带 `/` 的回归先失败、修后通过。zentao.products 先失败再实现分页 id/name，并投影成产品记录，不误当缺陷；product 只允许正数字 id，status 约束源词表。schema 错误带安全的 path/code/message，帮助补筛选，不回显值。审批类默认一天且可配置，澄清默认仍五分钟；独立修订/目标/摘要门禁不变，新增期限验收先 **0/2**、修后 **2/2**。

Circle **68c6405** 已让 circle_server_submit 支持附加执行 input，源 id/SHA 由工具填，客户端工作仍由 Claude 维护。网关上游 introspect 已交用户处理；本代理未改旧网关、生产设备或现有客户端令牌文件。

## 26：执行能力、服务端命令证明和令牌恢复

先写工作簿/结果、刷新/传输和执行故事验收：缺模块及未安装能力均实际失败；随后实现 packs/apv/execution，通用 MCP/私有 HTTP 与凭据锁在 packages。C 受理/幂等、审批、事件、B 原件/制品和 D 租约/fence 复用。工作簿要求单表隐藏标记与九列，从 SHA 原件独立读取显式 APV_n/Segn_tmp 命令，初始化也核对；临时变量和无法确定展开的 opaque 方法不放行。原 APV 技能目录未改，与 9931f20 保持一致。

cases.verify 的 worker 只取已授权来源，server 从保留的列表/XML 字节独立重定位构建、解析完整头/重载、再跑 command_check。不存在的命令或参数违规在网关调用前失败，客户端回执字段拒绝。证明 JSON 作为 B artifact，可在批准前下载；批准绑定修订、测试床配置/CA身份、构建/tree SHA、证明摘要及 artifact 引用，申请人不能自批。

批准后再次强制取得当前 XML，server 再核对。新增“列表不变、原地改 XML”验收实际失败，补 freshCommands 后通过；普通读缓存限制仍保留，执行关口绕过它。再增加“跳过复核直接要 submit intent”验收，实际被旧实现放行而失败；修为持久 validation_fence/tree/proof 记录、五分钟时效、一次性消费，修后通过。原件/产物 SHA、remoteTaskId、投递 intent 和当前 fence 持久；C 和网关各自心跳，不因 worker 失联重新投递。

访问令牌临期单写者轮换刷新令牌，成功值原子加密持久，跨实例/重启重读最新；撤销与未知刷新回执停止重放。runtime CA 指纹每次检查，拒绝跳转，网关 503 保持不可达分类。个人凭据可由所有者在同一引用/当前版本安全换新会话，复用刷新锁，审计无值；该恢复验收先因旧端点只认连接器而失败，修后通过，并实际用新会话完成未知任务独立核对。

结果自写 TS 从原始网关 case log 抽明确检查点帧，覆盖四个真值组合、多行模式、收尾摘要、数量/模式不符和 stale。逐命令只记唯一派发行的 observed，其他步 unknown，不继承整案 PASS；用例 fail 可交付，不混成任务失败。原始/解释结果分别 JSON artifact，模型判断为空。取消前无派发 closes pending 后 cancelled；投递后取消、lost、断线和租约过期 unknown/资源冻结，旧 fence 拒绝；独立 worker 核对绑定终态后 reconciled。新增核对尚未完工回归，旧实现把原任务误改 cancelled，修为只失败核对操作，原任务继续 unknown、资源不解冻。

最终执行/凭据/资产专项 **15/15**、方法 **2/2**、只读隐藏与失败核对加强回归 **2/2**、typecheck 通过。此前固定 Circle 8b2ceb6 的两轮整套 contracts **4/4**、methods **10/10**、acceptance **112/112**、references **7/7**，无 skip；最后恢复边界变更后的整套正在复验。APV 包内 **4/4**，引用 **714**。交接写入 case-execution-handoff 和 client-api-handoff。本次只本地提交；真实上机仍待恢复网关核验、登记用户凭据并上传工作簿，结果不能冒充真实通过。

最终树整套收尾：固定 Circle 8b2ceb6，contracts **4/4**、methods **10/10**、acceptance **112/112**、references **7/7**，共 **133/133**，无 skip；实际 RPC、原脑图、admin 重启、源映射、bot、核心守卫和执行恢复均覆盖。typecheck/diff 检查通过，引用 **714**；APV 包内另 **4/4**，技能目录与 9931f20 相同。PR #5 只读确认仍 OPEN，主工作树 clean。本地提交后通过 Otty 将最终提交和执行交接交给 Claude，在其控制的 7420 复核部署；本代理不 push、不改 Circle/旧网关，不把未完成的真实投递记成通过。

### ea72b08 独立部署复核与 test_env 阻断更正

Claude 独立报告 typecheck、contracts 4/4、methods 10/10、references 7/7、原件核验通过；acceptance 111/112，record-feed-a 的游标 10 秒超时，单跑三轮均 2/2。已由其将 7420 部署到 ea72b08，开发身份增加 cases.execute；网关 profile 变量指向仓库外尚待填写的文件。真实只读复测：不带斜杠的 spec 和版本 app 目录正常规范化，spec 1017 项；products 总 190 项、分页正常；错误产品名/无条件查询有修复提示；packs/inputSchema 能发现新执行包。只保留聚合和结构，不写真实产品 id、连接值或业务原件。

用户指出过严的 test_env 拒绝使两份真实工作簿无法提交，并提供脱敏行形状及框架接口。其 F 是启用的主机方法，G 是 shell 实参，返回值供紧邻检查点；不是不透明设备函数。生命周期/未知 reboot 由客户端纠正，APV execute 的模糊分派仍须拒绝或展开。console 真实用途不能据名字猜，须以床配置角色为准。只读核对用户指定的 ../InfoTest_Engine/knowledge/framework/mirror 的 test_xlsx/env/ssh_server 源函数及 compile_ref/excel_contract，未运行、导入或复制代码/配置值。

先写 test_env 分派验收，实际失败；再写实参/闭集规则，缺模块失败后自写 TS dialect。支持八个明确测试主机方法、引号外逗号、prompt/timeout、多行整体、H 捕获，拒绝 I 替换、未知/生命周期/禁用方法和未验证 console。APV 字面 cmd 及 kwargs 也按实际实参重新 command_check；shell 单列证明与审批摘要，不当 APV 命令头。直接主机的字面 cmd 支持，模糊 execute 拒绝。新增合成 HTTP 流量/检查点、默认闭集、运行时缩小名单、证据分离和未知方法门禁，执行/旧连接器/方言联合 **17/17**；最终实参/读取方法 **5/5**，typecheck 通过。未改 Claude 的技能包，不以来源统计冒充真实投递。

本机单跑也复现 record-feed-b 等待 unknown 阶段 10 秒超时，下一轮加状态诊断后未再复现；不能只认定是游标等待。按独立复核建议，仅 Act 8 的事件/阶段/游标等待扩到 30 秒，原期待值、去重数量、标记与资源核对不变，其他验收默认期限不变。保留合成超时状态/操作诊断，联合两条均通过。

最终固定 Circle 8b2ceb6 的整套 contracts **4/4**、methods **13/13**、acceptance **113/113**、references **7/7**，共 **137/137**，无 skip；typecheck、diff 检查和引用 **714** 核验通过，APV 包内另 **4/4**。技能目录仍与 9931f20 字节相同，主工作树未改。本步只在 server-s2 本地提交，通知 Claude 复核并更新其控制的 7420，未 push、未操作现有栈。真实设备任务仍未提交，网关上游和用户会话待恢复；合法 test_env 接受不代表客户端未知 reboot 或模糊 APV execute 被放行。

### 延迟旧消息撤回、离线实件观察与错误定位

用户确认再次送达的 test_env/reboot 建议是最早排队的旧消息，已撤回“reboot 是框架已知动作”：Env 无此方法，APV.reboot 在专业契约里 disabled，仍明确拒绝。其在 121c9cb 离线用实际单表工作簿调用读取器，四条 test_env/reboot 被拒；清空后通过，**24** 例、**268** 条设备命令、**20** 条 routera 主机命令。旧定稿双表格式被拒符合契约。这里只记录用户报告的结构及聚合，本代理未读取、修改或投递真实工作簿。

按新建议先写四条验收：HTTP/读取器定位与运行时策略实际失败 **3/4**，默认多种字面 shell 分派已通过。补 INVALID_EXECUTION_WORKBOOK 的 row/autoid/object(E)/method(F)，继承用例头、初始化空身份，非字面格附 column；不回显命令或寄存器内容。框架实参错误同样补定位，客户端修订无须猜错误发生在哪一例。

不采纳默认 dig 白名单，合成覆盖 routera 的 dig/sleep/echo/curl/chmod/kdig/for/dnsperf 与 server231 的 rm/tc/iptables/systemctl。新增可选仓库外 hostCommandPolicies：逐主机完整命令精确名单、字节/timeout 上限、多行开关；全部默认不附加限制，不能扩大闭集或开启 disabled 方法。受理、后台证明、投递前重核对；策略钉入原目标身份，变化使旧审批失效。交接已更新，HTTP 与后台失败定位正在联合复验，随后跑完整最终树。本代理未操作 7420、旧框架、Circle 或网关，真实设备仍未投递。

用户后续报告 121c9cb 独立复核完整 **137/137**、无 skip、typecheck 通过，已由其部署 7420；开发身份有 cases.execute，执行网关 profile 文件仍未填写。真实只读复测的文档规范化/千级 spec 分页、products **190** 项、查询修复提示与执行包发现正常；实际件四条 reboot 被拒且去掉后离线读取通过。没有真实投递，不把此观察算成本代理的设备验收。

回答执行路由时只读核对既有网关 tools/framework 文档与源码、镜像 test_xlsx/Env 的接口，未执行、导入、采纳旧代码或连接值：网关原样冻结工作簿交给原框架；server 是闭集验证，原框架按 E/F 派发。routera 方法找床配置 env.RouterA，APV_n 按 comm.ssh_ips 的有序索引，不能从标签猜 DUT 顺序。重启步骤维持未实现，普通重启协议未提供，init_device 是清空/重建基线，不能替代“重启后保留配置”测试；未向用户推荐会重启测试主机的误写。

联合复验中另遇合成网关空请求导致 JSON.parse 未捕获错误。用空 GET 独立复现并先写失败验收 **0/1**；仅桩修为非 MCP POST 返回 405、坏 JSON 返回 400，避免把桩异常当真实网关故障。第一轮新验收还有误把 C 的同步 admitted 写成 accepted，已按既有契约修正期待值；实现中的受理阶段未改。完整最终树待复验。

工作簿这轮最终实现的整套已实际通过：固定 Circle 8b2ceb6，contracts **4/4**、methods **15/15**、acceptance **116/116**、references **7/7**，共 **142/142**，无 skip；typecheck、引用 **714**、APV 包内另 **4/4**，技能目录保持 9931f20 原字节。期间用户新增技能推送诊断问题，以下继续处理，未把尚未通过的新验收提交。

### 技能推送目录不匹配诊断

用户报告 SKILLPACK_CHECK_FAILED 泛称无法定位，怀疑新工具未进入当前目录。只读核对现有 server 已在 details.check 返回 undeclaredTools/missingTools；当前 Circle 扩展源码也会附 details，但 message 本身只有泛称。没有取得其失败请求的实际安全清单，因此不能据口述工具数猜是哪一项。已通过 Otty 请 Claude 核对同次错误的两张工具名清单与当前身份 GET /v1/tools，未请求凭据、业务内容或完整回执，也未改客户端。

先写提交混合不匹配、长清单和批准/运行复核验收，实际 **0/3**，失败均为泛称不含具体名称。补 message 分别列试跑未声明/当前目录不可用的规范工具名；保留原完整、排序、去重的 details.check，消息最多 1000 字符，过长留完整名称和剩余数量，提示查看完整清单。普通身份仍不区分来源缺失/无权限，不新增全目录、内部地址或真实凭据输出，不放宽 manifest/试跑/审批边界。

再先写“受理后目录撤销”的回归，实际 **0/1**：claim 拒绝的 HTTP 有 details，但操作及 task result 的失败记录只留 code/message，丢完整清单。通用 C 回报路径统一保留 ApiError.details，后台拒绝仍不启动运行；审批和运行仍核对当时的身份目录。交接已补格式，专项与最终全套正在复验，真实网关/设备仍未投递。

最终联合技能/RPC 专项 **10/10**，完整最终实现 contracts **4/4**、methods **15/15**、acceptance **120/120**、references **7/7**，共 **146/146**，固定 Circle 8b2ceb6，**无 skip**。typecheck、diff 检查通过，引用 **714** 核验、APV 包内另 **4/4**；技能目录仍与 9931f20 字节相同。整套规模回归 p95 **195ms**，异步索引期间读 **226/123/141/157ms**。接口和错误清单形状兼容，未修改 Circle、旧网关、InfoTest 或归档，主工作树 clean。只在 server-s2 本地提交并经 Otty 交给 Claude 复核部署；当前已获部署确认的是 121c9cb，本笔新修改待其更新 7420，不 push，也没有真实设备验收。

## 27：独立部署复核、撤回误报与通用外部来源制品

用户报告 e46dd89 独立 typecheck、contracts 4/4、methods 15/15、acceptance 120/120、references 7/7，共 **146/146**、无 skip，7420 已更新至该提交且执行权限正常。网关配置尚未填写，未投递网关或设备。Circle 修复了错误 details 展示（dfba0a4）；真实失败的 undeclaredTools 仅 env.framework_files、missingTools 空，原因是中途问框架没有重开试跑记录。新试跑技能版本已可受理，后因缺命令核对被人工驳回。现有 server 治理判定正确，不放宽工具匹配。

用户也撤回 claim_submit 接口故障：实际 data.error 为 SOURCE_FORBIDDEN，提交证据与拟登记的命令原件无关，一次 SHA 为空。保留原证据校验，候选 claim 不变成可执行来源；本代理未读取这些真实任务或原件。后续必须原件上传、来源资产登记、另一人批准后绑定。只保存安全工具名和结论，不保存失败请求、业务文本或凭据。

床的真实构建尚未确认，旧客户端、本机旧安装配置和上游 healthz 的声明相互不一致。它们不能建立床构建事实；执行以 env_prepare 核对为准，上传者的构建关联只是预期声明。命令原件和函数契约等待用户在新接口上传，本代理不访问真实文件、InfoTest/旧客户端配置或网关。远端签发服务为明文 HTTP，网关为 HTTPS；默认私有请求 TLS 规则保留，已向用户/Claude 提交 HTTPS 入口或限定签发端点例外的待决定项，未修改真实配置或默默降级。

按用户通用平台方向，未提交的专用命令源草案改为通用外部来源制品：POST /v1/source-artifacts 接收任意已上传原件的 files/metadata，GET /v1/source-artifacts/{assetId} 查询；复用 knowledge-source 资产和独立生命周期审批，批准后才提供 sar_ 稳定 id。id 绑定资产版本、声明和原件 SHA，版本替换不自动选择新字节。平台仅核对权限、来源身份、字节、修订与审批，不验证格式或声明的语义。

工具目录统一增加可选 sourceArtifactId，普通连接器按绑定 id 使用保留原件，任务、fence、证据和幂等机制沿用；结果标 uploaded-artifact/live=false。命令树消费者仍用既有 buildsite command_heads/param/check，build 参数可使用 sar_ id。InfoTest 函数契约解释仅在现有 APV 模块，执行绑定树/函数契约 SHA并再次独立检查；disabled/internal/absent 拒绝，既有不透明函数限制不扩大。现有目录结构、技能原件、打包/独立仓库安排不变，产品包是否另发仍由用户确认。

先写四条原件/独立批准/查询/上机/换版验收，草案接口实际 **0/4**；改成通用制品后加入文档连接器共享测试，首轮 **3/5**，两红分别为测试遗漏审核者读者声明和错误期待文档返回纯文本（既有接口是 base64），修正测试后 **5/5**。共享读者进一步先复现仅有读权限却被要求 knowledge.submit；改为受权读取的内部证据记录，保持其写权限不变，共享索引独立完成。typecheck 通过；后续还需更多绑定边界、真实 RPC、全套回归及通用 OAuth device/client_credentials 合成验收，本步尚未提交或部署。

新增固定 Circle 8b2ceb6 的真实 RPC 源绑定先失败：短 run token 没有资产/知识读取权限，在工具任务受理前被拒。委托增加调用者原本已有的内部读 grant，HTTP 路由白名单仍禁止资产列表；修后源/RPC **6/6**、无 skip。再写未批准/停用/冲突选择器验收，两个有效 id 冲突时旧实现等 worker 而超时，修为受理前明确 INVALID_PAYLOAD，专项通过。旧工具/执行联合 **21/21**。

通用 OAuth 按 RFC 8628/RFC 6749 配置任意签发方的 device/client_credentials 端点、客户端认证方式与私有引用，不保存真实地址或 credential 值。先写流程验收（草案接口尚未存在），首次运行被合成资产工具名碰撞挡住，改为不同别名后设备流程两条复现 INTERNAL_ERROR：SQL 同一参数被推断为整数和 double，独立临时 PostgreSQL 确认 42P08，显式整数 cast 后四条通过。存储 code/token 在私有加密 vault，流程绑定 owner/connector version/profile digest，轮询限速与 slow_down/过期/拒绝持久，不把源授权当平台登录。

新增标准 token 续期测试先因缺模块失败，再自写通用 OAuthToken：client_credentials 无刷新令牌也可单写者重取，标准非轮换刷新可保留旧 refresh_token，未知结果停止重放，端点来自配置。再覆盖回执持久后重启恢复同一 credential id，以及连接器实际用 bearer header/到期前续期；流程/续期联合 **8/8**。既有手工 token bundle 路径兼容，新网关凭据走通用 provider；令牌未在 API、任务、审计或仓库出现。引用 RFC 只读协议，未采用旧 auth 客户端代码，也未访问真实签发方。

client-api-handoff 的通用来源/凭据接口已通过 Otty 交给 Claude。case-execution-handoff 已补预期构建与真实床核对边界。当前 typecheck、引用 714、APV 包内 4/4 通过，原技能目录与 9931f20 字节相同；完整固定 Circle 最终回归正在运行。真实 HTTP 签发处置决定仍待回复，默认拒绝不变，未操作 7420、网关或设备，也未调整产品包目录/发布结构。

完整最终实现已实际通过：contracts **4/4**、methods **17/17**、acceptance **133/133**、references **7/7**，共 **161/161**，固定 Circle 8b2ceb6，**无 skip**。typecheck、diff 检查与引用 **714** 通过；APV 包内另 **4/4**，原技能目录保持 9931f20 字节。源/RPC 七条和通用 OAuth 六条均在整套内通过，核心/连接器守卫通过；新源与 OAuth 特定规则未加到平台主进程，InfoTest 解释在既有产品模块。实际床构建仍未知，real HTTP issuer 未启用例外，未读取或投递真实系统。接下来只在 server-s2 本地提交，经 Otty 交给 Claude 更新其控制的 7420；不 push、不改已有产品目录。

## 28：现有资产登记链路、原件形状与失败证据定位

上述通用源/OAuth 实现已本地提交 8009864，真实部署待 Claude 确认。用户再次撤回 claim 接口故障：Circle 把失败信封当成 HTTP 请求失败，又未读取 data.error；496830c 已修。两次实际拒绝均为 SOURCE_FORBIDDEN，引用与拟登记原件无关且当前身份不可见，另一次 SHA 为空。server 判定正确，不改 claim 规则或失败结果信封。

用户明确客户端沿用 POST /v1/sources 上传 XML/JSON 原字节，再 POST /v1/assets 登记 knowledge-source，仅用既有资产独立批准。先写三条验收，现有链路 **0/3**；其中诊断测试首轮错误期待每个失败结果都有 result=null，按既有返回形状修正后独立复现 details={}。补通用登记 preparation，在同一资产事务中核对原件权限/真实 SHA/范围并生成 product SourceRevision，然后封存标准化配置；另一个人批准，资产状态顶层返回可用 sar_ id。命令树版本工具绑定该 id 后给一条精简 buildId，不作站点遍历，不把上传构建名认成正式发布或床事实。三条修复后 **3/3**、typecheck 通过；继而加强现有链路到合成网关投递的验收，仍须任务独立批准。兼容辅助接口复用同一登记/批准机制，无产品专用命令源路由。

确切 configuration 为 schema=external-source-artifact/1、metadata（消费者的 packageId/buildName/platform/versionLine）、files 原件引用（path/role/mediaType?/sourceRevisionId 或 sourceRecordId/sha256?）。命令树和函数契约角色只由消费模块解释，核心不读产品字段；规范化 size/sourceRecordId/sourceArtifactId 由 server 产生。CLIENT_ROUTES 补 assetSubmit/asset/assetLifecycle，client-api-handoff 与执行交接已更新，并通过 Otty 提交给 Claude 实现窄上传工具。

用户提供的函数契约结构已记录：schema=ist.excel.function-contract、complete、runtime（minimum_version/runner_source/runner_sha256/found_times_supported）、source_hashes、objects/entries/execute_actions、atlas_snapshot、contract_sha256 及 certification（basis_contract_sha256/certified_entries_sha256/basis_contract_file_sha256/deployment_receipt_sha256/receipt_set_sha256/receipt_count）。entry 包含 e/f/python_symbol、signature、G/H/I 语义、dispatch/status/reason/status_authority/source/minimum_runtime，部分含 certification_candidate。聚合为 objects **14**、entries **770**、execute_actions **72**；enabled **42**、disabled **465**、internal **263**。test_env 的九个主机方法 enabled（含 console），生命周期三项 internal，设备 reboot disabled。原件文件摘要前缀 **f3d85e6270cf3b19** 与文件内自报 **ca32544f** 分开；XML **1,933,307** 字节、SHA 前缀 **d76b2f5d43746bcb**。仅保存结构/聚合/摘要前缀，不保存实际文件、构建名、地址或配置值。只读核对参考 JSON 的键名/类型，objects 确认为数组，每项 e/python_type/status/reason/status_authority 为 string、mro 为 array、source 为 object，状态词表 enabled/disabled；与既有消费解析器兼容。未运行框架、导入旧模块或读取床配置。新增两条全形状合成契约验收，metadata/certification 不替代函数状态；不完整、重复、未知状态和 disabled 对象拒绝，enabled console 不能绕过尚未核实的床角色限制。

claim 不可用证据仅增加调用者提交项的 details={field:evidence,index,evidenceId}，缺失和隐藏记录同码同文，成功仍是个人沉淀候选。新增失效 SHA、跨 scope、重复路径及伪造生成字段验收，拒绝事务不留下半份知识。另先写旧版重提不得回滚当前来源 head 的回归，实际 **0/1**；登记旧版本虽然复用资产，却先把 source head 写回旧原件。修为重复版本不更新来源 head，仍核对不可变摘要。当前来源/执行/固定 RPC 联合 **11/11**、无 skip，包含 POST /assets 原件上传到合成网关投递的完整批准链路。接下来跑最终全套；未操作 7420、真实签发方、网关或设备，明文远端签发接入决策仍待回复，目录/发布安排不变。

最终验收已通过：contracts **4/4**、methods **19/19**（原整套 17 条及补充完整契约形状两条）、acceptance **137/137**、references **7/7**，共 **167/167**，固定 Circle 8b2ceb6，**无 skip**。typecheck、归档原件 **714** 核验与 diff 检查通过，APV 包内另 **4/4**；skills 与 9931f20 原字节相同。规模回归四次读取 p95 **167ms**，异步索引时读取 **228/144/120/143ms**。新登记接口和旧辅助接口共用现有批准治理；claim 失败仍在 data.error，仅新增请求证据项定位。本笔只在 server-s2 本地提交并交给 Claude 复核/部署，已获部署确认的最新 server 为 e46dd89；真实来源上传、床构建核对、网关令牌及设备执行仍由用户在环境恢复后验收，本代理未投递，也未 push。

## 29：平台签发资源身份与独立模块方向

用户已决定由 circle-server C 接管执行令牌签发，旧签发服务退役，**不设远端 HTTP 例外、不加反代**。HTTPS 可达性、证书和跳板机配置由用户后续决定，本代理不连接或调整真实系统。先只读核对既有网关的协议：Basic 内省 POST /v1/introspect 表单 token，读取顶层 active/sub/scope/exp/username；它读规则还用 Basic POST /token client_credentials 取得 bundles:read，GET build bundle，再按条目 SHA 取 blob。未运行、导入或复制旧代码/配置值。标准参考 RFC 7662/6749。

先写客户端管理、标准令牌/内省、受众/表单与原件分发四条 HTTP 验收，实际 **0/4**（路由不存在）；自写 C 服务客户端、资源令牌账本及迁移 22 后 **4/4**。客户端绑定同 tenant/scope 的资源资产，密钥只写为盐化摘要，能轮换/吊销；独立服务 principal 只有读取原件所需平台权限，原件必须显式授权 readers。OAuth 客户端令牌与平台登录分开，scope 不升级用户权限，不发 refresh_token。

再先写实际 C/D 执行验收，无个人凭据时被旧关口 SOURCE_LOGIN_EXPIRED 拒绝。资源资产以 serviceClientId 选平台签发，专业适配只声明所需外部 scope，通用 C 核对声明、调用者权限、资源/操作/输入/fence/有效租约，私有 vault 注入 worker；每次请求前重新核对，跨短期限重签。两秒合成令牌跨长任务续行，用户 sub/username 正确，原件规则按 SHA 回读，任务/事件/结果不带令牌或密钥，personal_credentials 为零，撤权后 unknown，不重派。

增加取消/旧 fence/独立核对验收。首轮在投递回执尚未持久化时就撤权，合理地无法核对；改为等持久回执。核对需另一 worker，补第二 worker 后复现取消时内省仍 active；暂停两 worker 保持租约、改变 fence 即 inactive、恢复 fence 后取消仍 active，定位为漏了取消状态。修为普通执行取消立即 inactive，通用 reconcile 操作使用新 worker/fence 可继续独立观察，不推断远端停止。原生 HTTPS 另先跑 **0/1**，运行时证书/私钥配置后通过：验证合成 CA 的 token/introspect 均成功，未信任证书失败；默认绑定回环不变，未部署或开放网络。

来源 bundle/blob 使用既有批准、修订与 ACL，只按 metadata.bindings 命名空间选固定原件；稳定 sar_ id 同样可用。平台不解析 domain_grammar 或其他规则，非 JSON 字节亦可按 SHA 交付；全局 CAS 不开放，隐藏、缺失、停用和异 scope不能借摘要取原件。新的 CLIENT_ROUTES、client-api-handoff、resource-identity-handoff 和执行交接已写明形状。当前专项 **6/6**、typecheck 通过，最终固定 Circle 回归待完成。

用户另确认技能已迁入独立 circle-packs：20a5ba9 字节导入旧版、7a9e634 采用已批准 0.2.4 回执指针形状、21d814d 的 0.2.5 用 --contract 按 enabled 主机方法验证，误写 reboot 的客户端行不支持，技能不写死产品号。用户报告包内 **5/5** 和实际批次聚合 **20** 通过、**4** 未写入、**2** 被拒；这是其观察，本代理未运行实际批次。本代理只读 README/manifest 确认版本，旧 server 技能目录仍与 9931f20 原字节一致，未修改。通用模块清单/安装入口已通过 Otty 向 Claude 提出与 product-line/1、skillpacks 试跑/独立批准复用的接口问题，待对齐后再迁出目录；不复制新技能回 server，不擅改私有包。

最终复核补同一操作以更窄 scope/另一权限委托的回归，旧查询复用原较宽令牌，实际失败；复用改为主体、权限与 canonical scope 集合完全相同。该通用入口并发验收还触发 40P01：入口先持 token 咨询锁，再在 FK 插入时等 operation 行锁，与执行 preflight 的反向顺序冲突。统一为先锁 operation 行再锁 token，未降低 fence/权限检查。第一轮整套在新增 scope 验收处失败，其他检查通过；修后继续专项与最终树，不把之前的整套算作通过。

连跑短期限验收又发现 token 复用阈值的整数除法在两秒 TTL 时变成零。补确定性边界：暂停 worker，在 operation 锁下把可用 token 期限改为剩150ms，旧实现仍复用该引用，实际失败。改为提前量向上取整且至少一秒（最多15秒），每次跨资源请求重新获得有余量的令牌；不会用临期零余量令牌去碰资源。复验与最终全套继续，未把测试时序失败当真实环境结果。

最终固定 Circle 8b2ceb6 的整套已实际通过：contracts **4/4**、methods **19/19**、acceptance **143/143**、references **7/7**，共 **173/173**，无 skip；typecheck 与 diff 检查通过、归档原件 **714** 保持。长任务/窄 scope/临期/旧 fence/取消/另一 worker 核对联合验收另连续三轮 **3/3**。原技能目录与 9931f20 同字节，未修改、删除或替换，后续以独立包为准。资源身份接口和 TLS/原件交接已通过 Otty 告知 Claude；本笔只在 server-s2 本地提交并交其复核，不 push、不改实际网关，不启用 HTTP 例外。网络/HTTPS可达部署仍待用户选择，模块清单/安装入口仍待对齐，不把本机合成通过表述为真实上机。

后送达的结构确认补充：objects 为 **14** 个对象的数组，无字符串项；每项都有 e/python_type/status/reason/status_authority:string、mro:array(string)（长度 **1–7**）、source:object，source 键形状与 entries 一致。对象状态为 enabled **11**、disabled **3**，无 internal；internal 出现在 entries。与既有消费解析器和完整形状合成验收兼容，本次仅记录，不改校验。用户报告 8009864 独立复核仍在运行，完成后由其部署 7420并回报；尚无新的部署确认。用户再次明确 C 自身签发优先于外部 OAuth，执行资源身份已在 **436a9ec** 本地实现并交接，维持无 HTTP 例外、无反代、未改跳板机；外部 OAuth 只保留其他连接器用途，不作为当前执行签发路径。

## 30：待批资产的通用治理可见性

用户报告 8009864 独立 typecheck、contracts **4/4**、methods **17/17**、acceptance **133/133**、references **7/7**，共 **161/161**、无 skip，7420 已更新，工具 schema 已有 sourceArtifactId。实际 source-artifacts 草稿两原件 SHA 正确、user-upload/not-asserted，却因未声明批准者 readers 导致 ASSET_NOT_VISIBLE。Circle 已透传 readers 作为临时办法；这是 server 通用资产治理缺口，不能要求申请人知道批准者 principalId。

先写三条 source 草稿发现/批准、tenant/scope/实时权限/凭据边界、原件和换版边界验收，实际 **0/3**；同时修订原资产列表验收，加入待批可见和分页后的过滤，原实现也失败。新增 metadataRow/metadataPolicy 仅用于管理 GET、列表、来源定义查询及 approved 转换：同 tenant、授权 scope、有 assets.approve 的人可看非 credential-reference 当前 draft，无须普通 assets.read 或 readers。正常资产数据 row、原件、工具、运行与私有凭据的权限路径保持严格，不把审批权变成源读权。

AssetListQuery 增 lifecycle 过滤，待批查询 GET /v1/assets?lifecycle=draft，范围和可见性在 SQL 中先过滤再计数/分页。批准锁资产后重新核对元数据可见性和批准权限，version/sha256、自批及作用范围规则不变；批准完成后返回状态和来源 id，原本没有 readers 的审批人不因此获得长期资料访问。源码原件/知识记录在批准前后对无源读权的审批人仍拒绝，凭据即使 draft 也不进入审批发现。专项及原资产验收 **6/6**、typecheck 通过；交接已补精确权限与查询说明，待最终回归、本地提交并交 Claude 复核。未改 Circle、技能副本、私有包或实际 7420 栈。

最终固定 Circle 8b2ceb6 的整套通过：contracts **4/4**、methods **19/19**、acceptance **146/146**、references **7/7**，共 **176/176**、无 skip；typecheck、diff 检查和 **714** 归档核验通过。规模回归 p95 **169ms**，索引活跃时读 **204/167/139/148ms**。新的审批发现、换版、边界和原件拒绝均在完整树内通过，技能 RPC/任务个人范围、bot 私有输出及资源身份回归继续通过。原技能目录仍与 9931f20 同字节。只在 server-s2 本地提交并通过 Otty 交 Claude 复核/部署，不 push；当前已确认部署的是用户报告的 8009864，待其更新后另记录真实审批联验。

## 31：外部命令回执的构建标识兼容

用户报告 8009864 真实流程已通：Circle 上传命令 XML 和函数契约、登记来源（临时写入批准者 readers）、另一身份批准后获得 sar_ id，再绑定命令核对。返回 uploaded-artifact/live=false；同一作者输入在不同固定树上产生合规、参数个数违规或 HEAD_MISSING，符合按真实来源分别判断。这里只记录结构观察，不复制实际构建名、源 id、命令原文、文件或日志；不能把该比较视为床构建已确认。

用户发现上传来源的回执缺 result.build/buildId，技能 gate 无法用同一套字段核对，站点来源已有这些字段。先加强原 HTTP 验收，核对 tree/heads/param/check 的两字段和原 source/证据；实际 **0/1**（build=undefined）。统一四工具返回 build=buildId=实际绑定 sar_，来源说明、原件 SHA、origin/live、确定性命令判定保持。metadata.expectedBuild 是客户端误写，由 Circle 改为既定 buildName，server 不加猜测或兼容字段。

签发状态已在此轮直接答复用户：C 自身资源客户端、轮换/吊销、短期资源令牌、RFC 7662 内省及 SHA 规则分发在 **436a9ec** 完成，合成身份/资源联合和完整回归已通过；真实 HTTPS 可达部署及网关配置仍由用户决定。本代理未连接或修改跳板机/真实设备，未因本地原件核对就声明实际床版本。当前接口修复正在跑来源/RPC/站点联合与最终回归，完成后只本地提交并通过 Otty 交接。

来源/站点/固定 RPC 联合 **15/15**，完整最终树 contracts **4/4**、methods **19/19**、acceptance **146/146**、references **7/7**，共 **176/176**，固定 Circle 8b2ceb6、无 skip。typecheck、diff 和 **714** 归档核验通过；规模 p95 **144ms**、索引活跃读取 **228/121/160/147ms**，原技能副本仍与 9931f20 同字节。本笔只本地提交，经 Otty 交给 Claude，未 push、未更新真实栈。当前用户确认的 7420/8009864 尚不含 436a9ec 的 C 签发；升级后仍待其与用户确定可达 HTTPS、证书信任、客户端配置，再做真实 env_prepare/床构建核对。

## 32：独立模块清单、冻结安装与旧技能副本移除

用户确认独立 circle-packs 的 94aab54 已推送：modules.json 使用 circle-packs/modules/1，skill-pack/product-line 分别放 skills/products，id/版本必须与目录及自身清单一致。非隐藏文件全部计入 files，digest 是按生成器排序的 `<sha256>  <path>\n` 原字节拼接摘要；清单证明字节身份，不自动批准。只读运行本平台 CLI check 核验独立仓库的 apv-mindmap-compile **0.2.5**、**13** 文件、摘要 **5fcd1dea65477decf50a89c5746cce617a0d5ba9dd5ae3bc5c2ed6fcc56fdf42**，未运行、复制或修改该仓库脚本和测试。

先写文件集/路径/摘要/清单身份及 HTTP/CLI 安装验收：缺实现时方法导入失败，HTTP **0/4**。实现通用 F 清单和路由、modules check/install、本地文件冻结与服务端复核。最初联合 **5/7** 的问题分别是测试误带顶层 manifest 和模块相对路径不能直接作 sources 的 basename，修正为保留制品相对路径、上传使用 basename 后 **7/7**。新增固定 Circle 的合成 RPC 封存运行，首次 **7/8** 暴露技能旧 localeCompare 排序与模块清单不一致；仅模块提交改用清单字符串顺序，原 skillpack 摘要保持兼容，随后 **8/8**、无 skip。

POST /v1/modules/install 接收 `{module,files,trial?}`，scope 与既有技能提交规则一致；CLI 读完整非隐藏文件集，拒绝符号链接、额外/缺失文件、目录/manifest id 不一致及摘要变化。每模块最多 100 个文件、1000 个子目录、16 MiB，读取时按剩余预算限制。技能试跑必填，复用工具目录检查、approvalTaskId、独立批准和 C/RPC 运行；响应区分模块 digest 与 skillPackDigest，元数据参与既有批准摘要。相同提交复用既有包，资产停用不会因再次安装自动启用。产品线模块原件作为普通 draft knowledge-source 封存，批准不 import 代码、不启用产品线、不改运行配置。

RPC 验收用独立合成模块和脚本模型：批准后改动外部源文件，运行仍读取 B 中封存脚本，产物 SHA 和内容一致；安装过程没有执行模块 tests。该验收通过后才按用户授权删除 server 内旧 packs/apv/skills，移除 product-line 清单中的旧路径。剩余第一阶段产品方法适配器和编译 API 保持兼容；新的技能版本以独立仓库为准，产品线其余目录未擅自迁移。

补充零字节与生命周期回归先确认失败：模块包含空文件时旧公开上传非空规则阻止封存；已经停用的技能重提被响应误标 approved。实现 B 的内部 storeOriginal 以保留清单中的空文件，公开 sources 上传仍拒空；来源制品 size 允许零，实际生命周期从当前资产取得。模块总字节预算回归亦通过。模块安装交接已写 docs/module-installation.md 和 docs/client-api-handoff.md，并经 Otty 先告知 Claude 开始客户端适配。

最终模块专项 **9/9**；完整 contracts **4/4**、methods **23/23**、acceptance **151/151**、references **7/7**，共 **185/185**，固定 Circle 8b2ceb6，**无 skip**。typecheck、diff 检查和 **714** 归档核验通过；四次读取规模回归 p95 **165ms**。独立技能 manifest 另通过现有 SkillManifest 契约只读核验；独立仓库和主工作树保持干净。当前分支已包含 ae0c6dc 的待批审批人自动可见、eebb178 的 sar_ command_check 顶层 build/buildId，以及 436a9ec 的 C 资源签发。只在 server-s2 本地提交并交 Claude 复核；无 push、部署或真实系统/设备/付费模型操作，7420 保持由 Claude 管理。真实网络/HTTPS 和网关配置仍等用户决定，不把模块或合成执行验收表述为实际床已运行。

## 33：完整栈的原生 HTTPS 与反向隧道交接

用户报告 ae0c6dc 独立复核 **176/176**，在实际 7420 尝试 CIRCLE_SERVER_TLS_CONFIG + 自签 CA + NODE_EXTRA_CA_CERTS 时，worker 的仅 HTTP 启动限制阻止完整栈就绪。原 TLS 验收确实只覆盖 server。核实同类限制也在 admin CLI；Circle RPC 的精简子进程环境还漏传了 CA 信任。未操作该真实栈或网关。

先加完整 TLS 验收，HTTP 基线和新增 HTTPS/拒绝边界联合实际 **1/6**，失败含 worker 拒绝 HTTPS 及旧重定向抵达另一合成监听者。worker/admin 接受 HTTP 或 HTTPS，但仍只准 127.0.0.1、禁止 URL 内嵌凭据，登录、回报、原件下载和管理请求拒绝重定向。没有关闭证书或主机名校验；自签 CA 由 Node 启动时 NODE_EXTRA_CA_CERTS 提供，TLS 配置/CA/私钥均在仓库外。dev-stack 传递相同启动信任，bootstrap 保持同 origin，两个真实 worker 注册后才就绪。

中间联合 **5/6** 的余项先修正合成知识资产遗漏 candidate writes 的测试声明。随后单独 RPC **0/1** 暴露更强的验收缺口：未传 CA 时 Circle 仍写出产物，但 C 中没有对应的工具操作；不能拿文件存在作为 server 工具完成的证据。补传 NODE_EXTRA_CA_CERTS 至正式 CLI 子进程，不传 TLS 私钥/完整进程环境/关闭校验的变量。新 RPC 验收要求同一任务下实际 tools.invoke=succeeded，再核对产物；固定 Circle 和脚本模型联合 **6/6**、无 skip，typecheck 通过。

组合验收用临时 PostgreSQL 和独立合成 CA/签发证书：HTTPS worker 登录/claim/preflight/下载原件/回报，脑图编译完成、事件补读、下载产物并重算 SHA；dev-stack 的两个 worker 在 HTTPS 下注册，admin 优雅重启改变 bootId 并保留交付结果。未信任 CA、已信任但 SAN 不匹配均不能注册 worker；远端地址在登录前拒绝，重定向接收端保持零请求。另有原 HTTP dev-stack 与清理基线，HTTPS 固定 Circle 真实调用 scoped 工具并交付封存脚本产物。

用户已决定由 Mac 建 SSH 反向隧道，把网关主机的回环端口映射到 server 的本机端口；网关配置由用户按维护者准备的内容修改。已在 docs/resource-identity-handoff.md 写运行时参数化命令、HTTPS/CA/SAN 要求和启动方式，client-api-handoff.md 与 AGENTS.md 同步。server 仍只监听回环，隧道传 TLS 原字节，不增加 HTTP 例外或反代。本代理未建立实际隧道、未更改 7420/网关、未投递真实设备。

最终完整 contracts **4/4**、methods **23/23**、acceptance **156/156**、references **7/7**，共 **190/190**，固定 Circle 8b2ceb6，**无 skip**；HTTPS/HTTP 组合专项 **6/6**。typecheck、diff 和 **714** 归档核验通过；四次读取规模回归 p95 **169ms**，原 HTTP、模块安装、资源身份、脑图编译和审批/bot 机制均继续通过。主工作树与独立 circle-packs 保持干净，仅 server-s2 本地提交，经 Otty 交 Claude 复核/部署；未 push。真实 HTTPS 栈与 SSH/网关接入仍由用户和维护者按此交接操作，真实床构建仍须 env_prepare 核对。

## 34：签发服务事实更正与隧道可达观察

用户/Claude 更正：网关实际使用的旧签发服务是本机可达的 HTTPS，证书与网关来自同一实验 CA；此前“明文 HTTP”取自旧客户端配置，判断错误。第 27 节的相应环境事实撤回，当前执行交接已纠正。用户知道实际 HTTPS 后仍决定由 circle-server 的通用 C 身份管理接管签发、旧服务退役；无需 HTTP 例外，不回到外部签发方的个人刷新令牌方案。

网关当前配置包含一个构建标签，这是配置声明，不是设备观测；设备实际构建仍须 env_prepare 核对。实验 CA 已由维护者只读取回，本机验证网关证书通过，使用 DER SHA-256 记录指纹；最终信任确认仍待用户。本代理不自动信任或投递，只记录状态，不写内网地址、实际构建名、CA 原件/指纹值或凭据。

用户/Claude 报告 Mac→网关回环的 SSH 反向隧道已建立，网关主机请求 /v1/status 得到未认证 401。该观察确认 API 可达，未证明有身份的 introspection、资源授权、env_prepare 或设备执行。平台→网关的 CA 核验，与网关/worker/客户端→circle-server 的 HTTPS 信任分别配置；不把一侧证书验证结果推成另一侧已经受信。本代理未建立、修改或探测该实际隧道和网关。

当前等待的 worker 回环 HTTPS 支持已经包含在 333f3ce，同时修了 admin 和 Circle RPC 的 CA 传递；第 33 节已有完整 **190/190**、无 skip 和 HTTPS 组合 **6/6**。已通过 Otty 通知维护者复核/更新真实栈，本次只更正进度与交接，无实现变更，不重跑无关回归；本地文档提交，未 push。

## 35：被新版取代的技能申请可驳回关单

用户报告旧版本登记任务仍 waiting-review，新版获批后再驳回旧版却收到 APPROVAL_STALE/Package target revision differs，只能等过期。问题属于通用 C 技能治理：approvalCheck 不区分批准/驳回，都调用要求当前资产和申请人权限的 approvalAuthorize。没有读取实际任务、版本文件或业务内容；用同一合成技能 id 的两个版本复现，新增四条 HTTP 验收先 **0/4**。

选择允许独立审批人驳回原申请，沿用现有 declined/answered/delivered 状态，不引入产品规则、自动版本比较或新的任务阶段。驳回从同 tenant/scope 的技能记录和不可变 asset_versions 核对原申请人、taskId、skillPackId、digest、assetId/version/历史 SHA，仍要求原输入修订、动作摘要和回应绑定一致，以及审批人当前 decisions.approve + assets.approve；不查原申请人的现时提交/读取权限或资产当前指针。批准保留现时申请人权限、当前修订和目录复查。整个决定、旧技能状态、pending input 和任务关闭沿用同一 C 事务，不能写新版本的批准状态。

专项 **4/4**，typecheck 通过：新版批准后旧版批准仍被拒，但驳回立即关单；最新资产完整元数据不变，最新运行可受理并通过 worker preflight；重启后旧决定保持。申请人失去原 scope/提交/读取权限也不阻止独立 reviewer 关单。自决、越 scope/tenant、错误修订/目标/动作摘要、缺 assets.approve 仍拒绝；两个 reviewer 并发仅一次成功，其余 DECISION_CONFLICT。原 admin 接口保留审批历史，但 open 队列无该旧记录。交接已补旧绑定原样 approve:false 的调用方式，升级后现有未过期待批旧申请即可处理，无迁移。

完整最终 contracts **4/4**、methods **23/23**、acceptance **160/160**、references **7/7**，共 **194/194**，固定 Circle 8b2ceb6，**无 skip**。typecheck、diff 与 **714** 归档核验通过。第一阶段、模块、HTTPS、技能 RPC、bot、资源身份和上机关口均继续通过。本笔只在 server-s2 本地提交，交复核部署人；未 push、未读取或处理实际任务、未更改真实栈和独立产品包。

## 36：独立复核、就地升级观察与修订 3 开始

用户/Claude 报告 f45cdc8 的独立工作树 typecheck、contracts **4/4**、methods **23/23**、acceptance **160/160**、references **7/7**，共 **194/194**、无 skip，归档核验通过。维护者已就地升级其真实栈并保留数据库和资源服务客户端；旧版申请驳回得到 approval=declined、task=delivered、pending input=answered，两份已批准的技能版本仍 registered，客户端 /token 和 introspect 正常。本代理未操作该真实任务或部署，未把凭据回读、版本标签或业务数据放进仓库。

用户授权修订 3（docs/server-s2-brief-r3.md），文件实际已在 server-s2 工作区；主工作树无副本。按 **3→4→5→6→7→8** 每节一笔本地提交、验收先行：角色/范围策略、变更集、执行链、通知流/工作队列、静态密钥、列表即查询。原客户端调用和固定 Circle 8b2ceb6 RPC 保持；Circle/网关 Python 由 Claude 维护，不改名、不 push/PR、不部署或连接真实系统/设备/付费模型。

角色与范围策略先写角色预设/审批资格方法验收，缺实现时导入失败。通过 Otty 向简报维护者提出三项接口边界：executionIsChange 的提交用冻结的执行申请资产表示；列表用显式 view=page 与旧数组兼容；runtime profile 作为待批依赖资产登记而非平台自动批准运行配置。继续做不依赖这些答复的角色验收与授权基础，后续每笔都补客户端交接和实际验收结果。

用户补充仓库已改名并公开为 circle-hub，main 已快进至 f45cdc8 加上维护者的公开门面提交；本代理只继续 server-s2，合并由维护者处理，不自行 rebase/merge，不改 README 或运行时环境变量/路由前缀。进度只记本文档。按用户要求清理本分支 docs 中的本机绝对路径，旧 demo 引用改为相对路径；不写回不可变 references，也不修改维护者的 main 门面。

## 37：修订 3 第 3 节，角色、范围策略与明确自决

先写角色预设/资格方法和 HTTP 验收，缺实现时方法导入失败、HTTP **0/6**。实现 principal × scope × role 登记簿，人的内部授权只由三个数据预设和安装扩展的最小角色生成，历史动作串仅作一次迁移；机器继续使用 scope/动作串。角色撤销留下版本记录，重启不重授角色。根管理员管理权与子范围资料读取权分开；资源目标、来源 readers、个人任务和凭据边界继续检查。

角色与范围策略修改冻结为单项变更集、生成绑定审批请求，明确决定后原子更新登记簿。twoPersonRule 默认开，两名管理员仍须独立决定；单管理员或规则关时允许明确自决，决定、响应、审计保存 decisionMode、singleAdminMode、policyVersion 与规则 id/版本核验。程序核验不写人的批准。新增直接资产注册绕过/机器角色和决定历史回归均先失败；修正后角色 HTTP **8/8**、预设方法 **2/2**、对象边界联合 **11/11**。

首次完整回归 contracts **4/4**、methods **25/25**、acceptance **165/168**、无 skip。其中两个旧授权验收仍使用人的动作串或把资产停用误当源读权限撤销，改为当前来源 readers 变更、技能资产停用，保留原来的隐藏/缺失统一错误及失败事件游标边界，专项 **2/2**。另一项揭示资源 introspection 仍从旧 policies.grants 判断人，角色降为 viewer 后令牌仍 active；已改为当前范围角色生成的权限，并用原资源运行回归核实 **1/1**。不把第一轮算作全套通过，当前固定 Circle 8b2ceb6 重跑该节完整验收。

第 3 节最终回归实际通过：contracts **4/4**、methods **25/25**、acceptance **168/168**、references **7/7**，共 **204/204**，固定 Circle 8b2ceb6、无 skip；typecheck、diff 检查与 **714** 原件归档核验通过。后续第 4 节四条多资产/依赖验收已先写，当前 **0/4**，未计入或提交本节。只本地提交并通过 Otty 交独立复核，不 push、不部署，不修改维护者的 README、Circle、私有产品包、真实栈或网关。

## 38：修订 3 第 4 节，多资产变更集与依赖重核

先写四条 HTTP 验收，实际 **0/4**。扩展第 3 节骨架：有序资产版本摘要与身份摘要、单条绑定请求、多项原子批准/驳回、新申请自动取代旧请求。普通资产、外部来源、技能与模块登记都使用单项变更集；历史 assets.publish 请求仍能按旧绑定驳回，旧兼容验收明确构造升级前的持久形状，新的自动关单另验收。缺声明工具、runtime profile 或已批准来源时保存 blocked 及原因，保持请求 open，不让程序成为审批人。

Claude 已在简报第 11 节确认冻结 execution-submission、view=page 与 runtime-profile 三项接口决定，记录合入本节。runtime-profile 只存 ref/type/版本/配置摘要，不保存地址或密钥；当前配置观察与人的批准分开，已有真实部署由管理员补登记与决定。合成旧验收由 fixture 明确提交和独立决定配置依赖，生产代码无自动批准。声明引用与原件自身身份分开，修复来源查询错误匹配依赖方/把外部制品自身当依赖的问题。生命周期变更通过持久重核队列更新 blocked/ready，重启补核，避免持续全表核验。

第 4 节验收扩展到 **7/7**，技能/诊断及固定 RPC 联合 **17/17**；原待批可见性、历史技能驳回、模块封存兼容 **12/12**。依赖再核会实时拒绝不就绪的决定并保留完整工具名；同项不能重复、跨 tenant/scope 拒绝；并发决定只有一个生效。typecheck 与 diff 检查通过，当前固定 Circle 全套回归运行中。未动真实栈、Circle、网关 Python 或独立技能仓库。

首次全套 acceptance **169/175**：开发栈与第二产品线缺少显式批准的运行依赖，已按新规则补合成身份登记/决定；重启验收从“空队列”改为“已受理任务集合前后相同”，仍证明未完成请求体不受理。最终完整 contracts **4/4**、methods **25/25**、acceptance **175/175**、references **7/7**，共 **211/211**，固定 Circle 8b2ceb6、无 skip；typecheck、diff 和原件归档核验通过。本节只本地提交并交复核，下一节的私有修订/终态 claim 两条复现已先写，**0/2**，未包含在本节验收或提交中。

## 39：修订 3 第 5 节，执行链、Hook 与运行报错

验收先覆盖普通执行不审批、未知命令、网关修复等待、床构建观测、一次性执行变更、终态任务领取和私有任务修订，再实现。默认资源直接走当前角色/来源 readers/资源策略、批准的 Tool/产品线模块、running 资源与依赖、Hook、租约/fence、执行和证据；executionIsChange 资源冻结执行-submission 资产并走唯一的变更集决定，只能由对应操作消费一次。旧审批三项回应和生产资源机制继续兼容，终态任务不会领取旧操作。等待原因持久化为 waitingReason，申请人修订保留私有所有者和父运行授权，丢弃旧绑定；unknown 仍冻结、不重派、独立核对并拒绝旧 fence。床配置标签不当成设备构建观测。

Hook 运行器按 hub-hook/1 和既定三个 subject 原形实现，五个挂点均接入，按顺序运行批准模块中的纯 TS 处理器。零处理器无产品判定；block 原 code/facts、规则 id/版本、授权行与原件 SHA 进入事件、审计和失败证据。处理器不能读取环境/网络、动态生成代码或无限运行。Tool 装载前核对直接/动态/局部 imports 与冻结集合、明确声明及精确六种依赖，Node 内建与计算式 import 拒绝为 IMPORT_NOT_DECLARED。原件不改写；Tool 字节在独立进程中执行，OS 运行隔离和静态密钥留给下一笔第 7 节。professional_permissions 撤下，Tool 增加 MCP annotations/minimumRole/approval；人的授权跟随范围角色，兼容机器和旧客户端 permission 标识。

独立 circle-packs ced41a6 的 products/apv 按原字节冻结与批准，**18/18** 包内测试在 hub 依赖集下通过，实际 Tool 读取工作簿通过。先以零 Hook 派发，再批准 APV Hook 后同一本工作簿报 COMMAND_NOT_IN_TREE 且没有第二次网关提交。Meridian 扩为 Tool+imports、五个 Hook、resources/flows 的完整夹具，并由同一装载器执行。包作者在回归期间继续推进 main 后，验收改为从 Git 固定读取约定提交，避免把移动样本计数当成平台失败；未修改独立包。

审计中本节的修复有复现验收：执行批准单次消费、终态领取阻断、修订保留私有范围、开发会话族轮换/24 小时绝对寿命/退出吊销、移除开发身份失效、异步 scrypt 与请求/用户名/并发容量、实际解压字节上限及先核权限。文档 get/section 不能越过注册根，机器服务客户端不会继承创建者未持有的读取能力。脚本产品声明记录 verified 与规则核验，不冒充人的 approve。

最终用冻结工作树复核，contracts **4/4**、methods **31/31**、acceptance **189/189**、references **7/7**，共 **231/231**，固定 Circle 8b2ceb6 和 APV ced41a6，**无 skip**。typecheck、diff 和 **714** 归档核验通过。独立包的 18 条另计；没有读取业务原件、连接真实系统/网关、付费模型、改 Circle 或部署。接口与条件执行说明已交接；下一笔按用户新顺序先做第 7 节，再第 6、8、9 节。harness-adapters 和权限导出规范分别由其他作者负责，本分支不修改。

## 40：第 5 节独立复核与第 7 节边界补充

维护者在独立工作树复核 8e212a6，固定 Circle 8b2ceb6、APV ced41a6，完整 **231/231** 与 **714** 归档核验通过；报告已就地升级演示栈、迁移 28 并轮换开发审批人口令。本代理未部署、未读取口令或业务文件。

代码复核指出的第 5 节缺口并入第 7 节：所有归档入口改为实际字节 boundedUnzip；主机闭集移出工作簿 parser，由批准的资源声明与产品线 Hook 核验；Hook 和 Tool 同用隔离子进程及批量命令核验；三个 subject 形状校验；权限错误不冒充审批修订过期；变更集决定记录 singleAdminMode；访客去掉 credentials.use。增加三项绑定逐项篡改、非草稿所有者、blocked 决定、最后根管理员、权限/租约/来源错误、普通资源 unknown/独立 reconcile 的验收。开发身份 role_initialized 后不覆盖治理角色是既定行为；更改身份文件不会重新授予角色，范围角色须走变更集。

简报 host subject 现为 {command,host,method,kwargs}，三个 verify 的 binding.resource 带批准版本的 {assetId,version,sha256,declaration}。allowedTestHosts/hostCommandPolicies 只从批准声明读取；运行文件里的同名策略不作授权。独立 APV 样本固定为 316760a / 1.2.0 / 28 条包内测试，原字节装入，未改独立包；Meridian 五挂点同形。

用户决定纯内网明文认证可作显式例外：默认仍要求 HTTPS；只有管理员登记 runtime-profile 的 allowPlaintextAuthentication:true、经独立审批人才生效；修改需新版本重批。每次调用证据与审计永久留 plaintextAuthentication:true。执行网关及外部签发方的 HTTPS 要求保持。维护者确认当前某查询镜像为非回环 HTTP，认证来自注入的个人凭据而非 profile 文件；源地址、业务内容、令牌均不记录。

另有两个现网问题排在第 7 节后、第 6 节前：只读工具超时/失联误入 unknown 并冻结资源；大文档 worker 回报失败、事务回滚后操作悬挂。只读失联的合成复现已失败，纯大文本回报尚未复现；加 NUL 的合成大文档能复现回报拒绝与悬挂，但不能据此认定真实文件含 NUL。本代理没有读取真实文件，继续以受控样本定位，修法包括 SHA 对象指针、异常干净失败、读取效果不冻结及搜索部分进度。

## 41：修订 3 第 7 节，静态密钥、运行隔离与明文认证例外完成

先写静态模式、隔离和明文例外验收，旧实现均能复现缺口后实现。static-secret 只写登记/轮换，模式不可原地改变；running 的批准资源按当前角色和 readers 绑定密钥，授权成员可以通过 worker 使用共享资源，不能读其他人的凭据。网关收到 Bearer、没有签发/introspect 调用，吊销和版本/权限/fence 再核有效；资源返回授权材料时拒绝保留，不将其写入日志或 API。

Mac 内核隔离限制 Skill/Tool/Hook 及后代读取文件内容、写入、网络和其他进程信息，vault、运行配置直接/符号链接读取被拒；固定 Circle 实际执行合成脚本、工具与 HTTPS/CA 组合继续通过。模型凭据 home 在退出时清理，短期注入副本及无效令牌清理；未支持的平台以 SANDBOX_UNAVAILABLE 明确失败，没有无限权降级。Hook 在同一 tool-host 子进程按批次核验，10 秒/16 MiB 返回上限，subject 校验与批准声明保持原形。新版 APV 316760a 原字节装入，**28/28** 包内测试通过；独立包里 parser 的剩余闭集已提醒包作者，本代理不改包原件。

非回环 HTTP 认证默认拒绝。管理员登记 runtime-profile 的 allowPlaintextAuthentication:true，经独立决定才注入 worker；即使 scope 普通允许自决，该例外仍不能自批。改字段变新 draft、立即阻止依赖运行。合成验收核对无例外拒绝、有例外批准后放行、修改重批，以及 SourceRevision/Evidence/派发审计的永久 plaintextAuthentication:true 标记。当前真实查询源的例外需部署管理员单独登记/批准；本代理未更改真实配置。

第 40 节列出的第 5 节复核补项与盲区均加入本笔回归。最终冻结工作树 contracts **4/4**、methods **35/35**、acceptance **201/201**、references **7/7**，共 **247/247**，固定 Circle 8b2ceb6、APV 316760a，**无 skip**；typecheck、diff、**714** 归档核验通过。独立包 28 条另计。未 push、部署、改真实网关/Circle/独立包或读取业务原件；后续提交按用户新规则附 Signed-off-by。

## 42：只读失联、原件指针与回报处理的修复验收

用户给出文档统计：失败原件约 2.65MB、UTF-8 合法、有四个 NUL；成功对照约 1.52MB、无 NUL。未提供地址、内容或令牌，本代理未取真实件。纯 3MB/5MB 合成文本的原报告路径成功，加 NUL 可复现 JSONB 回报事务失败/操作仍 running；PostgreSQL 不允许 JSONB 字符串内的 NUL，实测合成存储拒绝及用户统计支持这一定位，真实数据库错误码仍未直接取得。

worker 原件先以 SHA 存进 B，再回报 objectKey/sha256/size，C 在当前租约、fence、修订和来源授权下回读验证；伪造 SHA/size/缺对象拒绝。旧内联协议兼容，get 的客户端结果形状不改。Evidence 不再存大原件或任意字节的完整 text，保留引用/范围/SHA/编码统计；预览剔除 NUL 并标 sanitized。3MB、唯一词文本及 NUL 原件均经 worker/report/content 回读并逐字节 SHA 一致。人工触发存储拒绝以安全 storageCode 落为 RECEIPT_PROCESSING_FAILED，回报事务不再让操作悬挂；不回显 SQL、参数、原文。

按 Tool effect 记录 source_effect；read 失联/unknown 回报/等待超时是 UPSTREAM_TIMEOUT + failed + retryable，不冻结、不要求副作用核对，重复回报保持幂等。迁移 29 清理历史只读 unknown 的任务/租约并重算冻结，写 unknown 规则不变。合成复现从失败到通过，旧数据库状态升级后自动恢复，随后同资源可重试读取。

文档搜索文件读到一半超时，已读原件和命中保留，coverage.stopped 与 nextCursor 精确指向未完成文件，结果 partial；零进度/目录遍历超时给明确错误和覆盖统计。游标续页通过，没有截断或推断未读命中。工具消费者、异步知识投影及指针篡改验收通过；最终完整回归结果待冻结验证结束后补入。第 6 节通知/队列已先写验收；用户新审计要求排在本修复之后、第 6 节之前，独立包的新固定 224daa6 也在那笔核对。

冻结验证完整 contracts **4/4**、methods **37/37**、acceptance **206/206**、references **7/7**，共 **254/254**，固定 Circle 8b2ceb6、APV 316760a，**无 skip**。最后按用户要求将预览替换改为剔除 NUL 并加 sanitized/编码统计，原件/存储拒绝回读专项重新 **2/2**；最终 typecheck、diff、**714** 归档核验通过。完整回归与最后的小元数据专项分别记录，未用真实设备或模型替代。仅本地签署提交，未 push、部署或改变演示栈。

## 43：独立只读复核与模型边界补项

维护者报告 0b5406a 独立全量 **254/254** 通过、演示栈迁移 29 已应用，历史只读冻结为零。本代理未部署或触碰演示栈。维护者新增 NUL 小节/搜索结果、get 大件指针、effect 显式声明、迁移释放审计和写 unknown 保留、supervisor 日志、候选技能内容、网关健康与正规拓扑读取的补项；各项已先写合成验收，不将维护者的真实环境观察当成本代理的实机测试。

本笔先完成审计修正：带凭据的只读 Tool 最低成员，访客仅匿名读取；非申请人资格不足为 FORBIDDEN_ACTION；主机对象全部按形状解析，闭集与函数启用交批准 Hook；五挂点 subject 与批准 resource.declaration 定形。Tool/Hook 子进程加 256MiB 堆上限、命令按 200 个 subject 分批，每批十秒，APV 固定 224daa6 / 1.2.1 原字节验收 **29/29**。

按用户决定实现每运行一个回环临时模型代理：256 位 nonce、固定批准上游、剥凭据头、双向 16MiB、SSE 流式、只记调用元数据；失败为 MODEL_PROXY_UNAVAILABLE / MODEL_UPSTREAM_REJECTED，关闭覆盖成功、取消、超时和 unknown，没有真实 key 文件降级。真实 key 留在可信进程/保险箱，沙箱 home 只有 nonce；固定 Circle 的合成技能读取自己的 credentials.json，产物只有经掩码的 nonce，直接/符号链接读取运行配置与 vault 均失败。产物按字节脱敏后重算 SHA，记录 sanitized；事件和回答同样脱敏。

第一轮加入代理元数据后，取消验收发现事件权限撤销错误覆盖本地退出观察；已修正，专项 **1/1**，unknown 与远端停止未确认保持。重新完整冻结回归 contracts **4/4**、methods **40/40**、acceptance **207/207**、references **7/7**，共 **258/258**，固定 Circle 8b2ceb6 / APV 224daa6，**无 skip**。最后将旧脚本模型配置的 key 封入保险箱，授权记录只存占位引用，配置摘要不改；此小改动的固定 RPC/静态模式联合验证结果另记后续行。

保险箱引用小改动最终固定 Circle 联合 **9/9**（含取消、慢运行续期、静态共享与隔离）、typecheck 通过；上述完整回归与最后的小改动专项分别记录。diff 检查通过。仅本地签署提交，后续只读/网关/通知代码和验收继续留工作区，未混入本笔。

## 44：读结果、迁移审计、候选内容和网关元数据

先写合成验收：含 NUL 的 section/search 复现任务 JSONB 失败；显式 effect 缺实现；候选 GET 返回 404；网关 health 没 checker；supervisor 重启没有日志。逐项实现后，NUL 投影剔除并计数/标记，原件 SHA 保持，大件 docs.get 只交付内容指针。Tool effect 必填。迁移 30 不改已部署的第 29 版，逐个记录释放审计与事件、限定租约集合、保留同任务的 unknown 写操作，并补偿第 29 版可能写错的任务 phase。

候选技能的 GET 只展示冻结文件路径/SHA/大小、声明工具与试跑哈希，待批审批人可见，角色撤销和跨范围仍拒绝。supervisor 记录 start/exit/error 的时间、pid、退出码/信号、是否 graceful，dev-stack 也转出这些 JSON 行；合成意外退出与真实启动脚本的 graceful 重启分别通过，不据此推断先前现网 PID 变化的原因。

网关 health 经 worker 调 lease_status，不占床租约。选择正规 gateway.topology Tool：C 的当前授权/资源租约/fence → 远端取得租约 → 读取缓存拓扑 → 立即释放，结果仅主机名字，原 JSON 按 SHA 保存并可由授权者回读；没有地址进入提示或元数据响应。管理员用观察登记 allowedTestHosts，再经变更集独立批准，程序不代批。静态密钥与 server-issued 合成路径 **2/2**；后者按操作租约签发，吊销客户端立刻阻止调用。未调用真实网关或设备。

补充联合 **6/6**、完整原件两条与显式 effect 契约验证通过，完整冻结回归待下一行记录。第 6 节通知验收已扩为无任务的失败 bot 也有持久、私有通知，仍留在工作区，未混入这笔。

最终冻结完整 contracts **5/5**、methods **40/40**、acceptance **213/213**、references **7/7**，共 **265/265**，固定 Circle 8b2ceb6 / APV 224daa6，**无 skip**。typecheck、diff 与 **714** 归档核验通过；补充联合为 **12/12**。仅本地签署提交，不 push、不部署、不改真实网关或 Circle。第 6/8 节的当前工作仍未混入本笔。

## 45：修订 3 第 6 节，持久通知与工作队列

先写过滤、游标、重启、队列 SLA 和 SSE 验收，缺接口时 **0/3**；加入权限撤销和无任务 bot 失败后 **5/5**。通知复用持久 outbox，迁移 31 为无 taskId 的失败 bot 记录明确 tenant/scope/owner；程序不造任务，事件受理失败实际路径也验证只通知本人。审批创建/决定/取代、waiting-input/review、交付/失败、unknown 和 bot 输出均由原持久事件投影，授权先于分页。

SSE 与轮询共用游标，保存已处理序号后补读；连接每轮重新认证，过期/撤权/内部错误用明确控制事件结束，背压/断线/关停会释放等待。队列按当前资格与所有权算 count、最久等待与超 SLA；任务输入/原件不为计数全量载入。assignedToMe 不推断模型文本；没有持久分派即零。原件、决定、脚本事实与未知不混为通知中的平台批准。专项 **5/5**、第 6/8 节临时联合 **7/7**、typecheck 通过；完整冻结验证待下一行。

第 6 节最终冻结 contracts **5/5**、methods **40/40**、acceptance **218/218**、references **7/7**，共 **270/270**，固定 Circle 8b2ceb6 / APV 224daa6，**无 skip**。typecheck、diff、**714** 原件归档核验通过。只本地签署提交，未 push 或部署；第 8 节查询代码和第 9 节的缺接口验收仍留工作区，未混入本节。

## 46：修订 3 第 8 节，授权分面与稳定列表游标

先写任务与资产分页验收，修正 fixture 的旧 submit 参数后确认 **0/2**；扩展到十种登记簿与 PostgreSQL 微秒回归，专项最终 **4/4**。view=page 显式启用 total/items/cursor，原数组/nextCursor 接口保持。授权、私有资料与分面先于 LIMIT/总数；查询/身份绑定游标、精准时间/id keyset，避免 Date 截掉微秒造成漏项。每页重新核角色与来源可见性，不能凭旧游标扩大权限。

tasks/assets/skills/change-sets/scopes/roles/service-clients/object-types/objects 使用统一 SQL 分面，工具在完整调用者目录内筛选分页；未声明的维度不推断。范围、产品线、flow、状态/生命周期、owner、年龄区间、更新时间与年龄排序都交接；注册主体与观测者的 owner 含义逐项明确。迁移 32 补资产/技能/服务客户端更新时间及触发器，不更改既有版本内容摘要。原件/凭据不会进入额外计数或游标。typecheck、专项通过，冻结完整回归待下一行。

第 8 节最终冻结 contracts **5/5**、methods **40/40**、acceptance **222/222**、references **7/7**，共 **274/274**，固定 Circle 8b2ceb6 / APV 224daa6，**无 skip**。typecheck、diff、**714** 原件归档核验通过。仅本地签署提交；维护者刚指出的模型上游批准 allowlist 修复及第 9 节 MCP 缺接口验收另留工作区，不混入本节。

## 47：模型上游批准绑定与独立健康检查租约

维护者独立审阅 4f49ac3 与 9b7485f，无高项；模型代理只允许回环是本代理将验收约束错当运行规则的缺口。本笔先写非回环 HTTPS + 合成 CA、未批准拒绝两条方法验收，正路径失败；C 上未批准 profile/运行版本绑定验收在旧实现因启动拒绝失败。现只允许该运行已批准 circle-runtime 版本配置的端点，非回环须 HTTPS，CA/指纹/主机名照常验证；入站 Host/路径仍不能改变上游，没有重定向和不校验证书的降级。

每次技能运行冻结 runtime-profile 的 assetId/version/sha256/profileSha256，受理、派发及私有凭据通道再核；配置换版后旧运行为 APPROVAL_STALE，不拿新端点替代。沙箱还是只有单个临时回环代理和 nonce，真实 key 在保险箱/可信进程，模型流量不入证据。模型 kind 可 scripted/remote，元数据按实际配置记录；本代理验收只用合成 HTTPS/脚本模型，没有真实或付费模型调用。方法联合 **5/5**、C profile 正路径 **1/1**、固定 Circle RPC/隔离联合 **9/9** 通过。

health 与执行共用 gateway resource 会在冻结或忙时挡住状态检查，合成冻结资源复现失败。改 gateway-health 独立资源，只做 lease_status；执行资源继续 frozen，健康调用不取远端 lease，不被当成设备就绪或独立 reconcile。专项 **1/1**。完整冻结回归待下一行。

审阅的小项与盲区留补项：docs.get 小件统一指针/可选预览；拓扑 release 失败与读取超时；第二身份下载拒绝；supervisor spawn error；oauth/server-issued/写 Tool 的访客负路径；第 201 条 Hook 分批进程；unknown/内部超时/取消的代理端口关闭；含 nonce 的产物 sanitized 已有真实 RPC 落库验收。候选试跑当前契约严格只收 name/argsSha256/ok，不能提交参数值，后续加带秘密参数的拒绝验收。hostCommandPolicies 的未知键收紧需兼容检查。

迁移 29/30 的校验不重写。维护者指出第 30 版把已 failed/UPSTREAM_TIMEOUT 也纳入历史释放审计；第 29 版缺状态日志，不能用现态证明历史一定 unknown。已向维护者请求补偿口径：新增迁移只选当前 unknown read；历史保留并补偿说明“原状态无法证明”，不恢复失效租约。此项不依赖上游模型修复，也没有在本机/现网直接改库。

模型/健康修复最终冻结 contracts **5/5**、methods **42/42**、acceptance **224/224**、references **7/7**，共 **278/278**，固定 Circle 8b2ceb6 / APV 224daa6，**无 skip**。typecheck、diff、**714** 原件归档核验通过。只本地签署提交，未连真实模型、网关或部署；随后按维护者授权合入 main 的中立适配器/公开规范，保留其文件和作者，不改那两个分工目录。

## 48：按授权合并公开规范与中立适配器

维护者允许第 9 节前以签署 merge 提交合入 main。合并其公开门面、Apache-2.0/贡献规范、五种 harness 的纯导入导出库及权限导出规范；未自行编辑 README、harness-adapters 或 permission-export。冲突仅 AGENTS.md/package.json：采用 main 的统一指令和公开名称/许可/仓库元数据，保留 server 实际运行需要的 TypeScript 依赖；锁文件根元数据同步。业务代码、Circle/产品包、真实配置均未更改。合并验证结果另记下一行。

merge 内容本身 typecheck、methods **127/127**（含五种适配器原测试）、references **7/7**、**714** 归档核验与 diff 通过。待实现的第 9 节测试先证明缺模块/缺接口，未把它们算作合并的通过项；未改适配器内部文件或权限规范。

## 49：修订 3 第 9 节，中立原语与通用 MCP

先写中立方法缺模块与 MCP 404 验收，再接已授权合入的 importFrom/exportTo 公开 API，未修改 packages/harness-adapters 或 permission-export.md。Circle 从冻结 manifest/frontmatter 推导 hub-skill/1，不丢特有原文；已验证兼容性另存执行观察，不能由提交者自报，原 byte/digest 不改。四种 E 原语从虚拟文件表按 SHA 冻结，整批事务、同内容去重、共用 C 变更集，批准后导出可读原件；未支持的 Hook/provider 或 Circle 原生 Agent/Command 不伪造成功，明确 warning。缺模型/输出的原件投影不自动进入云运行。

外部 Claude Code Skill 原样导入/独立批准，导出回原来源字节一致，并导出 Circle；固定 Circle 实际加载同一 SKILL.md/脚本、交付产物 SHA 一致。原语中立清单不把 permission hint 误认工具闭集；有真实声明才拒绝声明外试跑。Meridian 既有完整布局、五个挂点与原语夹具继续走同一装载器，后续完整验收包括它。

MCP 使用官方 SDK 固定 1.32.1（仅增加公开依赖，安装禁 lifecycle scripts），按官方 2025-11-25 传输做 stateless JSON/会话 Bearer/Origin/协议协商。专业目录不改 inputSchema，写确认按维护者决定走 _meta 摘要；平台控制调用与幂等回执共用事务，上传一次、拒绝重复变参，确认不能越过独立审批。返回原样按 SHA 留 B 回执，mcr_ 仅操作者可读；审批失败决定也持久化。resources/prompts 授权后分页，纯 MCP SDK 客户端和原始客户端能列工具、读证据、调用读取；许可导出按中立规范，不把本机 allow/ask 说成平台批准。

专项联合 **14/14**、另资源分页 **1/1**，typecheck；适配器合入后方法 **129/129**（含本笔两个方法），均无 skip。完整冻结验收待下一行。没有真实系统/模型、设备、付费调用或部署，标识继续 CIRCLE_SERVER_* 等兼容前缀，不在本笔零散改名。

第 9 节首轮完整冻结 contracts **5/5**、methods **129/129**、acceptance **237/237**、references **7/7**，共 **378/378**，固定 Circle 8b2ceb6 / APV 224daa6，**无 skip**。最后复核将兼容性收紧为成功 Skill 装载事件（仅文件齐全的运行不能宣称兼容），重放在已解析 scope 再核权限，并给 MCP schema 错误保持 INVALID_PAYLOAD 分类。增加装载负例和参数错误不回显值两条；最终冻结回归运行中，不用首轮代替最后版本。

第 47 节的小项继续列为未完成/待决定，尤其迁移 30 历史释放分类补偿尚无维护者答复；不重写历史校验、不直接修现网库。MCP 与中立库的实现不依赖它。运行身份/前缀统一改名、适配器第四轮 warning 更新、各 harness 本地权限文件映射、Agent/Command 的 Circle 原生执行仍留各自后续范围，不将协议接入算成这些实机能力已交付。

第 9 节最后版本完整冻结 contracts **5/5**、methods **129/129**、acceptance **239/239**、references **7/7**，共 **380/380**，固定 Circle 8b2ceb6 / APV 224daa6，**无 skip**。typecheck、diff、**714** 原件归档核验通过。新增两个负例包含在此完整回归；原件投影、独立批准、固定 Circle 实际装载、工具/资源/提示/MCP 写确认及全部旧机制均通过。仅本地签署提交，未 push、PR、部署、连接真实系统或付费模型；主工作树、Circle、网关 Python、独立产品包和两处分工文件没有改动。当前 r3 第 3/4/5/7/6/8/9 各节已分别交付，明确列出的补项与历史补偿决定仍保留，不冒充全部已修。

## 50：独立复核与现网反馈排期

维护者独立复核 c864144 **270/270**、3e51a23 **274/274**、3d5f214 **278/278**、合并 fc89a99 **363/363**、bcf9995 **380/380** 及归档核验通过，Grok 无高项。现网观察来自维护者而非本代理：网关健康读确认；拓扑返回十一节点并释放，资源声明按八个 shell 主机经批准；两条已交付执行与一条整批二十一例执行作为派发后正对照。没有复制任务 id、源内容、地址、凭据或日志。

优先补两条上机拒绝样本：case_submit 以契约诊断明确拒绝且未派发，旧 worker 丢 reason/details、local stage 停在 environment，C 将 submit-intent 一律当已派发；因此错误变 BUILD_MISMATCH/unknown 并未释放租约。先写合成复现 **0/5** 后实现，原拒绝回执保留、明确派发前失败不冻结并释放；不把 environment 阶段猜成构建错误，env_prepare 与 case_submit 内部观察分开。无法证明派发状态仍 unknown，断连/迟回报机制保持。新增联合首轮 **25/26**，已把网关契约等待与本地主机策略失败分开；最后专项 **6/6**、执行链联合 **26/26**，typecheck 通过。完整回归运行中。

其后依次补：runtime-profile 取批准修订，draft 不扰新旧运行、旧批准版本仅停用或摘要失配才失效；导入 Skill 事务内即有变更集、兼容观察核对本包 skill 名；worker 安全升级及 provider 别名缺省；历史释放补偿；通知保留/精简事件/连接上限、真实 assignee/dueAt 与共同查询队列；稳定分页和其它登记簿接入。每项先写验收、本地签署提交，交接相应调整，不 push、部署、改真实栈/设备/网关或其他作者的目录。

维护者确认历史补偿口径：29/30 SQL 原字节不动，租约不恢复；只释放当前 unknown/read，资源按仍有 unknown/write 重算，同任务写 unknown 不改失败；逐条补偿 30 审计并引用原 audit id，明示原始状态无法证明及 failed/read 可重试不持租约，无重复。当前已提交 33–35 为中立/MCP/兼容性迁移，不能占用已用版本号；补偿将使用下一个新版本并按同一确认口径实现，不重写这些已审核的校验。

main 的 ab12ed4 是适配器第四轮，用户允许后续再签署 merge；不自行改纯库或权限规范。私有产品包已有 1.2.2 别名/主机名大小写修正，合成验收仍固定 224daa6 / 29 条，不将现网新包代入旧冻结样本。

派发前拒绝修复完整回归 contracts **5/5**、methods **129/129**、acceptance **245/245**、references **7/7**，共 **386/386**、无 skip，固定 Circle 8b2ceb6 / APV 224daa6；typecheck、diff 与 **714** 归档核验通过。只本地签署提交，未部署；worker 必须同时换到本笔代码才能保留网关拒绝事实，旧 worker 不会因只重启 server 自动升级。滚动升级机制仍是独立补项。两条 runtime 修订与中立治理的失败复现、历史补偿准备仍留工作区，未混入此笔提交。

## 51：模型运行绑定批准修订

先写两条草稿打断旧任务的验收，首轮 **0/2**。改为新任务选择最新已批准修订；派发后的 preflight 使用任务冻结的版本和该版 readers，不依赖 current_version 指针。C 的技能依赖也使用批准修订，私有模型通道不会被草稿误阻断。运行中的旧版本仍批准且摘要匹配就继续，新版本批准后只影响新受理；只允许所有者按精确版本/SHA 停用历史 runtime-profile，其他资产仍要求当前版本。系统 CA/自定义固定 CA 两条信任口径写入交接。

专项与既有 RPC 联合 **10/10**、无 skip（固定 Circle 8b2ceb6）：草稿/新批准不停止实际运行的 Circle，停用其冻结版本后观察到本地进程退出、unknown 且不宣称远端已停；另一次真实固定 RPC 用新批准 2.0.0 成功交付，任务/代理事件/产物运行回执均绑定 2.0.0 和同一 profileSha。未调用真实模型。完整冻结回归随后在独立只读验证工作树运行，结果另记；不把专项当成完整回归。

54f0ed7 的完整冻结回归 contracts **5/5**、methods **129/129**、acceptance **248/248**、references **7/7**，共 **389/389**、无 skip，固定 Circle 8b2ceb6 / APV 224daa6。该验证工作树没有后续补项文件，不混用正在编辑的版本。

## 52：中立 Skill 的即时治理与 MCP 回执

先写四条复现 **0/4**：外部 Skill 导入漏变更集、平台读重放每次新 evidence、专业 Tool 体内键未比对、另一个 Skill 的成功装载误记本包兼容。仅 Circle 原生 skillpacks.submit 保留插入 skill_packages 后的建单顺序，普通 hub-skill/1 导入与 instruction/agent/command 在同事务直接建单；重复返回原治理引用，批准前不得导出。

平台读写共用持久、当前权限重核的幂等回执；同键不重读/不加回执，改参拒绝。专业 Tool 也核对体内键，24 小时受理窗口与平台持久窗口在交接明确区分。RPC 成功装载按 call id 关联先前 assistant.tool_calls，args.name 必须为本包 manifest.id；固定 Circle 真加载另一个技能的负例不记兼容，本包装载正例记入。最后联合含方法 **20/20**、无 skip，typecheck/diff 通过。未改 adapters、设计分工文件或外部仓库，未 push/部署；完整补项回归单独冻结，不用专项代替。

## 53：迁移历史的追加补偿

按维护者确认新增 **36**（33–35 已部署用途不变）。29/30 的 SQL 字节、原释放审计都未改。36 只释放当前 unknown/read、只删这些操作租约，对受影响资源按仍有 unknown/write 重算；同任务的写仍 unknown 时不落 failed。30 的释放集合把当时已是 failed+UPSTREAM_TIMEOUT 的 read 也计入；29 释放时没有状态日志，这些操作在 29 之前的原始状态无法证明。逐条以 system:migration 的 operation.read-release-compensated 引用 correctsAudit 原 id，写 originalState=unprovable/migration=36。租约已被 30 删除且不恢复，failed/read 可重试、不持租约，因而不重新授予旧权限。

29/30 也没有留下任务 phase 的修前日志，补偿记录引用原 read 审计及任务，历史 phase 标 unprovable，仅记 36 前实际观察的 phase。仍存在 unknown/write 的现态错误 failed/UPSTREAM_TIMEOUT 可修回 unknown；已由 30 修回的任务保持现态并追加同一来源说明，不猜历史。重复执行不重复补偿。先写缺模块验收，再按 **29→30→36** 合成序列跑历史 failed 被计入、任务 phase 修复、新 unknown/read、并存 unknown/write、无关租约和资源；联合只读机制 **5/5**、无 skip，typecheck/diff 通过。没有真实库操作或恢复租约，部署由维护者决定。

## 54：受监督的 worker 升级、provider 默认名与健康失败

升级/缺省前缀先复现 **0/3**：server 换进程时 worker pid 未变，直接退出一个 worker 会触发整栈删除。dev-stack 现在独立监督 worker，server ready 后顺序排空并换进程，保留同伴服务运行中的子 Tool，不以强杀赶升级期限；任何单 worker 退出都保留数据库并单独重新启动，整体停止才清理。每次 worker ready/draining/exit/restart-error 记录 JSON，含时间、pid、码/信号及 graceful。独立部署的外部 worker 明确仍由部署进程管理器 drain/替换，CLI workersRestartRequested 标明是否请求了栈内替换，不假装全部 worker 已换。

provider 已声明产品线但没有 alias 的，回落包 prefix/packageId；未安装的产品线仍拒绝，租户名字冲突不隐藏。原通用装载器已有 manifest 缺 alias 时用默认 prefix 的分支，本笔补目录的直接 provider 防御与缺 prefix 兜底。健康 503/超时两条补例证明 gateway-health 与 gateway 资源均不冻结、不取远端租约。

最后联合 HTTP/HTTPS dev-stack、admin keep-alive/长轮询重启、两 worker 真实 pid 替换与在途操作不丢、健康失败、prefix 方法 **14/14**、无 skip，typecheck/diff 通过。只合成数据库/网关；没有改现网部署脚本、7420 或外部产品包。

## 55：执行实现 1.1.0 与设备归属结果

维护者独立复核 288faa5 全量 **386/386**，Grok 无高项；指出摘要变化但内置实现未升版。先写 1.1.0 负例与成功释放标记缺失、三条派发未知边界；升内置版本到 **1.1.0**，保留 flow/1 兼容，部署须管理员重新登记/独立批准当前 version/flow/implementationSha256。合成旧批准实现不能充当新版本；旧任务 methodAssetId 不自动迁移，新提交明确用新实现才执行。产品线模块 SHA 与治理状态未改，两份交接同步。

成功终态也如实写 remoteLeaseReleased，失败释放写 false/leaseReleaseError；拒绝体有 task_id/dispatched:true、成功 submit 后 status 命中契约诊断都保持 unknown、不释放。维护者又提供跨设备相同命令被误判的统计（仅记数字：五例、十六步，不存真实日志/地址），先写设备归属方法复现 **0/3**。改为接收 {environment,topology} 原件，按 conf.device_ips 或 topology.applies_to.device_ssh_ips 顺序映射 APV_n；不唯一/缺失不猜。每设备独立推进日志游标，不再要求命令整例唯一。主机行维持主机归属，检查点/整案结论不替代设备步证据。

合成方法与真实 worker 回报链：同命令跨两设备、同设备重复、仅缺 APV_1 命令、环境/拓扑两种映射、映射缺失/重复/冲突；专项 **21/21**、执行链联合 **41/41**，另空/null task_id 不许断言未派发方法 **1/1**，无 skip，typecheck/diff 通过。按需拓扑为已持租约内只读，原件随 gateway-results 入 B；取不到时仍可交付逐步 unknown/partial，不能标 observed。解析暂在 packs/apv，接口留给独立产品包 Tool 后续接管，未移动/修改私有产品包。完整冻结回归另跑；没有真实网关/设备投递。

## 56：合入已确认的适配器第四轮

按维护者授权签署 merge **ab12ed4**：SKILL_SHADOWED/HOOK_ENTRY_DROPPED_ON_EXPORT、OpenCode commands 配置、兼容 Skill 目录、导出时保留被略过 Hook。实际三方合并仅十二个适配器/其测试与该简报文件，没有冲突；不自行编辑分工库或权限规范。main 后续第五轮内容尚未在此笔吸入。方法/typecheck/归档核验结果另记；当前队列与分页负例保留工作区，不纳入 merge。

合并后的方法 **145/145**、references **7/7**、typecheck 与 **714** 归档核验通过，无 skip。packages/harness-adapters 与 ab12ed4 字节相同，permission-export.md 未改。完整冻结验收从该 merge 单独运行，排除队列/分页未通过复现。

774f65f 冻结全套 contracts **5/5**、methods **145/145**、acceptance **266/266**、references **7/7**，共 **423/423**、无 skip，固定 Circle 8b2ceb6 / APV 224daa6。队列/通知未完成补项不在该树中。

## 57：按现网字段纠正设备映射

维护者只读核对指出：部署版 env_prepare 没有 conf.device_ips，topology 也没有 applies_to（它仅是生成器输入，不能当返回证据）。b65478e 因而无法覆盖现网映射；本笔更正该假设，不把合成两候选通过当真实协议通过。新增当前真实形状的合成方法复现：正例失败、负例通过。补第三候选 topology.devices：type=负载均衡、全部名字符合 APV<index>、索引集合恰为 0..device_count-1；日志 IP 唯一落在对应设备 ipv4/CIDR 中才归属，共享虚拟 IP 不猜。任意名字、缺/重复/越界序号或计数不符仍 unknown/device_map_unavailable。优先级保留未来 conf.device_ips、有序 applies_to、最后名字规则，实际无字段则回退。

紧接升 **1.1.1**，不让已发出的 1.1.0 同版本不同实现摘要；两份交接同步三来源边界和 worker 排空无截止/在途 claim 仍可能完成一笔的限制。专项 **22/22**、无 skip，typecheck/diff 通过，新增真实 worker 路径返回 source=gateway.bed_topology.devices，未使用真实数据或访问网关。维护者 Grok 对迁移/worker/1.1.0 无高中项；两个迁移归因低项随后用追加修复处理，不覆盖已发迁移字节。队列/分页与通知完整性仍在工作区继续，不混入本笔。

## 58：共同工作查询、SLA 与有界通知

先写队列/更新页复现与通知五条失败：缺 assignment API、过期仍待批、后页更新漏/重、未知分面空页、通知正文/全局游标/SSE 不限/不裁剪。任务登记与队列现在共用 taskQueryPlan + facetedWhere，权限/私有范围/run 委托/分面/队列条件同源，不再让通知类自己全表读取计数。负责者/dueAt 为记录元数据并有受控写 API；分派不扩大私有读取。SLA 从迁移 **37** 的范围策略数据来，经变更集独立决定，任务 dueAt 优先。expired/open 按实际时间分类，四类任务异常分组，worker/bot 例外也使用分面编译器，不适用分面明示 omittedGroups。

更新时间页有 PostgreSQL 微秒锚点，锚点后的更新项下一次查询展示；同微秒 id 平局继续可翻，未知分面明确 INVALID_PAYLOAD，源于对象类型未声明的 productLineId/flowVersion 已去掉伪 NULL 查询。管理类 service-client 权限例外写清。按维护者允许，尚未接的登记簿在 handoff 明列后续顺序，不冒充全部已接入。

通知投影仅引用/状态/原因码，完整任务事件原文仍可按权限在保留窗口内补读；规范审批创建/决定/取代、waiting-review 与 bot.started 均有发出点，无发出点的白名单项去掉。游标只记最后可见项，权限新增后从零重查被滤区间。SSE 同主体连接上限，关闭释放名额。outbox 保最近至少一万条/最多十万行、七天年龄目标；写后同事务批量裁剪与每分钟维护，持久 minCursor 让过窗显式 CURSOR_EXPIRED，不默默漏读。不删除当前任务结果/B 原件/审计。

专项与角色/变更集/旧查询/通知联合 **36/36**、无 skip，typecheck/diff 通过；两条迁移归因补充仍独立留工作区，完整冻结回归另跑。没有部署、真实源访问或付费模型调用。新接口和数据形状在 CLIENT_ROUTES 与 handoff，旧数组形状保持。

defbeb2 的完整冻结回归 contracts **5/5**、methods **147/147**、acceptance **267/267**、references **7/7**，共 **426/426**，无 skip；其树没有共同查询/通知工作区改动。

## 59：多读结果与完整历史链接

针对维护者 Grok 两条低项，保留已发 **36** 字节/原审计，追加 **38**。只对 36 释放审计可证且仍同输入、failed/UPSTREAM_TIMEOUT 的多读任务聚合为一个固定结果：排序的 operationIds 与 sideEffects=none，不再采用 UPDATE FROM 不确定的一条操作。并存 unknown/write 不触动。任务级补偿原 min(id) 引用保留，追加 task.read-release-audit-links-completed 指回原 36 审计并列 relatedAudits 的全部同任务/输入 30 审计 id；历史 phase 仍不可证明，不填猜测。

先写缺模块复现，多读/全部链接/重跑不重复/已聚合不改更新时间/写 unknown 冻结不动，与旧只读机制联合 **6/6**、无 skip，typecheck/diff 通过。37 为工作查询/通知迁移，38 只追加归因修复，未覆盖任何已经签发的迁移校验。没有现场 SQL 操作或部署。

## 60：裁剪与事件补读共用快照

最终复查用 PostgreSQL 表锁稳定复现 task/admin 两条 **0/2**：游标先单独校验，随后 outbox 查询被锁住，裁剪提交后查询返回空页，形成静默缺页。改为每次权限重核/游标窗口校验/事件选择共用 REPEATABLE READ READ ONLY 事务；长轮询每次迭代重查窗口。并发裁剪期间返回校验时的完整可见快照，或显式 CURSOR_EXPIRED，不能把缺页伪装成空页。通知原本已有这一快照事务。

abdb701 的完整验收 contracts **5/5**、methods **147/147**；acceptance **279/280**，唯一失败为旧 bot 断言读取通知 payload.error，按第 58 节精简契约应读取 reason.code。完整 bot 失败记录仍保留原 error，没有放宽治理规则。该断言已同步；新快照与通知/bot/admin 联合 **18/18**、无 skip，typecheck/diff 通过。最后版本重新全套回归，结果随后记录；不把上一轮或专项当作最后全绿。

最后 **82b260d** 冻结全套 contracts **5/5**、methods **147/147**、acceptance **282/282**、references **7/7**，共 **441/441，无 skip**。typecheck、diff 与 **714** 原件归档核验通过，固定 Circle 8b2ceb6 / APV 224daa6。包含 task/admin 真实并发裁剪回归、规范通知断言及前面全部补项；工作区干净，仅随后追加这条验证记录。

本轮提交全部签署、本地保留，未 push/PR/部署、未连真实网关/设备/资料源或付费模型，未改 Circle、网关 Python、独立产品包或分工规范。已通过 Otty 逐笔交接维护者。执行内置版为 **1.1.1**，部署者须重新登记/独立批准该实现，旧任务不自动迁移；独立产品线模块按自身冻结版本。明确未接统一分面的其它登记簿按第 58 节 handoff 的次序继续，服务标识统一改名、真实上机观察与部署归维护者后续范围，不用本机合成全绿替代这些事实。

## 61：独立复核补充与确定性验收

维护者指出 admin 补读测试 expected 取得过早：两个新任务的 waiting-input 是异步事件，锁表前还能追加一条；产品快照正确，旧断言时序不稳定。取 expected 前等两任务都进 waiting-input，随后锁表，task/admin **三次连续 2/2**，不把正确新增事件当缺页。共享地址新增实际日志行，证明不归属且两边游标都不消费；名字自定义及 cexg 0.3.1 的实际有序字段边界写入两份 handoff。方法/更新页联合 **7/7**，升序显式回填到锚点内的重复作为可证限制披露，客户端稳定 id 去重，不伪称保存了旧版本快照。

明确当前 outbox 不保护主体未读水位；首次从零也有 minCursor，过窗从零补窗口并查任务/审批当前状态，不能凭当前态重建历史顺序。轮询预算按全局峰值速率与窗口估算，跨 scope 洪泛可缩短窗口，建议非永久未读保证。SSE 上限为进程内，集群没有全局总额保证。尚未接统一分面登记簿与管理权限例外仍按第 58 节已确认顺序，不改其余机制。事件正文投影与 worker 离线阈值补项随后独立实现；没有现场操作或部署。

## 62：事件正文按引用回读与离线检测依据

先写两条事件正文/回读权限与一条可配离线阈值复现 **0/3**。task/admin events 现在同样经 notificationPayload 显式投影：不内联结果、工具/模型输出、参数或错误详情，保留规范元数据与可观察的规则结论/fence/工具状态/运行版本/bot 跳过次数。每条给 content 的 SHA/字节数/下载路径，新增受同任务权限与委托限制的 events/{seq}/content 原 payload 回读，过窗明确拒绝。原 C outbox、已记录结果与兼容判断不修改；回读窗口不被说成永久原件保存。

固定 Circle 实际装载技能的原输出改由 content 按 SHA 核对，工具元数据继续可跟随；其它范围、私有任务另一主体、过窗原引用都拒绝。workerOffline 以部署配置的正毫秒阈值判断，默认九十秒，响应披露 workerOfflineAfterMs，超 SLA 仍用范围策略。事件/回读/委托与 RPC/bot/钩子/补读/新阈值联合 **36/36**、无 skip，typecheck/diff 通过。现有接口的新引用和正文迁移已通过 Otty 告知维护者，Circle 客户端改动归维护者。

只本地签署提交、不 push/部署，不改真实网关、Circle、产品包、历史迁移或分工目录；完整冻结回归随后跑最终版本，不将专项替代全套。

最终 **f09fae9** 冻结全套 contracts **5/5**、methods **149/149**、acceptance **286/286**、references **7/7**，共 **447/447，无 skip**；typecheck、diff 与 **714** 原件归档核验通过。固定 Circle 8b2ceb6 / APV 224daa6，仅用本机脚本模型与合成资源。包含三轮稳定回放后的全套重验、共享地址不消费设备游标、锚点内升序回填的已披露限制、事件正文引用及权限/保留窗口、可配离线阈值。本轮执行实现字节未改，仍为 **1.1.1**；083cc44 与 f09fae9 已本地签署，随后仅提交这条最终验证记录，未 push 或部署。

## 63：按客户端消费者统一事件元数据

维护者给出 Circle 两个实际消费者：eventLine 的七个字符串与 bot.output 的状态/产物清单/未知项须保持内联，结果正文始终走 result。上一笔投影漏了 bot 清单/未知项，通知与任务事件又有两套字段；本笔先写合成 HTTP/SSE/原件保留验收，旧实现 **1/5**（taskless 元数据负例已通过），其余四条分别复现元数据缺失、B 引用缺失、普通 worker 列表缺失、投影分歧。纠正 handoff 中客户端读取工具 output 的假设，不要求 Circle 改动。

现在 task/admin/通知轮询/SSE 共用 projectedEvent 与同一字段类别白名单，保留 Circle 消费字段，任何大小的结果/工具输出/模型正文/参数仍不内联。所有 taskId 非空事件带 canonicalJson 字节引用，SHA 与 x-content-sha256 覆盖实际响应；taskless bot.admission-failed 只给原主体元数据，admin 目前不列无任务通知，不生成虚假路径。content.retained 并列事件已有的 B 原件/证据/产物引用，各自 SHA 独立；环境 JSON 与交付引用过窗仍按 B 权限可读，未留存事件仅窗口可读，不推断永久历史。

新增 /v1/workers，兼容 admin workers 旧数组，披露 offline/workerOfflineAfterMs，和队列使用同一配置阈值；范围过滤与管理权限继续核对。专项 **6/6**、字段类别/knr 引用与契约 **3/3**；实际 worker 执行、固定 Circle RPC、bot、通知、权限/窗口与新阈值联合 **41/41**，无 skip，typecheck/diff 与 **714** 归档核验通过。执行实现、历史迁移、Circle、独立产品包与分工目录均不改。完整冻结回归另跑，不将专项替代全套；只本地签署，不 push/部署。

82ad8bc 首轮冻结全套 contracts **6/6**、methods **150/150**，acceptance **288/289**；失败为角色验收的 worker 就绪观察超时，单独重现 **7/8**。原因可证：该夹具 admin 只有根范围，新的 worker 列表遵守子范围读取权限，harness 用根身份读列表判断注册因而永远看不到；worker 实际已注册。改测试 helper 从合成库观察注册，补普通/兼容列表均不让根管理员自动读子范围 worker 的验收，保留生产授权过滤、不放宽权限。角色/worker/admin 联合 **14/14**，typecheck/diff 通过；最后全套重新运行。

23407a3 第二轮 contracts **6/6**、methods **150/150**，acceptance **289/290**；角色夹具和根不可继承读取已过，唯一失败是主机策略在改版后等待 failed 超过十秒。单独重跑该项 **1/1**；不把偶发时限称作已确定的产品错误。进一步纠正就绪 helper：旧注册记录也不能证明新进程已就绪，改等新子进程自己的 worker-ready/username 回执，维持十秒启动限。主机策略用例包含多次批准、排空重启与多笔验证排队，失败等待设有界三十秒，断言与权限不放宽。新就绪逻辑下主机策略连续三次 **1/1**、角色/worker/admin **14/14**，无 skip，typecheck/diff 通过；最终重新冻结验收。

最终 **9fa2420** 冻结全套 contracts **6/6**、methods **150/150**、acceptance **290/290**、references **7/7**，共 **453/453，无 skip**；typecheck、diff 与 **714** 归档核验通过。固定 Circle 8b2ceb6 / APV 224daa6，只用脚本模型和合成数据库/资料源/网关。生产实现提交 **82ad8bc**，测试边界修正 **23407a3、9fa2420**，均已签署、本地保留；随后只追加这条验证记录。五条元数据/内容约束与 worker 阈值交接已写明，未 push、部署或碰 7420/真实网关/独立产品包，执行实现仍 **1.1.1**。

## 64：按合并简报继续登记簿查询

维护者合并意见替代旧队列：事件冻结，不扩字段选择或增加接口；只把首次 minCursor 说明限定通知补读页，task/admin events 仍 events/after，过窗读错误 details.minCursor。维护者独立 23407a3 **453/453**、试验栈升级与 cexg 0.3.1 实际 conf.device_ips 均作为外部观察记录，不再改设备映射。全套从本轮只由维护者在独立树运行，Codex 只跑变更相关文件，避免两套临时 PostgreSQL 干扰。

第一组先复现审批/服务客户端 **0/3**。task/admin approvals 复用 facetedPage 与任务授权/私有边界；原数组保留，admin 集合不借别的范围角色放宽读取。页的过期状态显式 expired，迁移 **39** 初始化 approvals.updated_at 到既存 created_at，后续行更新用既有 registry_touch，不猜缺失历史。service-client 列表先筛拥有管理权限的 scope，没有则同形空集合，limit/游标/分面仍校验；详情、登记、轮换、吊销权限不改。三新例与原列表/签发验收 **13/13**、无 skip，typecheck/diff 通过；未跑全套。

来源/证据/制品原先没有 HTTP 集合 GET；按维护者 Otty 明确答复，在既有资源路径补集合页，并令 MCP resources/list 投影复用同一分页权限核心；不另起 MCP 查询规则。后续按 B 三类、审计/worker、bot runs、通知次序，分组本地签署，不 push/部署，不触碰 7420/网关/Circle/独立包。

B 三类先写旧路由 **0/4**（与 operations 三例顺序复现合计 **0/7**），再接既有路径 GET view=page。来源复用企业/知识原件 ACL，证据保留任务私有与 run 边界，产物可读绑定去重及 owner 过滤不泄漏隐藏申请人。MCP resources/list 改共用授权元数据 + facetedPage，既有 knr/mcr 加上可读 src 原件，不为列目录下载 bytes；游标为统一绑定形状，旧资源游标需重列，不误称兼容。直调相同核心证明 run 分区、knr/个人 mcr 与禁止字节读取；B/MCP 相关 **11/11**，无 skip，typecheck/diff 通过。规模边界与引用形状已交接；审计/worker/bot 与通知仍在本轮后续，不纳入本组提交，未跑全套。

读取维护者对 8c9896b 的认可与规模边界要求后，接审计/worker/bot runs。旧实现三例 **0/3**，页都复用 facetedPage，管理范围与 bot owner-only 保留，worker 多 scope 不重复。worker 首页计数先发现未用参数类型错误；把离线计算放进 FROM 派生表，让计数/投影同源且都确定阈值类型。bot 平局游标用完整主键 SHA，页项带 recordId/version，旧数组形状不变；status 仍 admitted/failed，不能拿任务结论替换。联合 **8/8**、最终计数专项 **4/4**、无 skip，typecheck/diff 通过。worker 观测年龄与 B 当前内存权限判定限制已明确交接；全套仍仅维护者跑，事件冻结、本机外部系统均不动。

最后读取维护者消息后接通知登记页，先复现 **0/2**。仅 /v1/notifications 的 view=page 分流到共同分面页，旧整数游标补读/SSE 与冻结的 projectedEvent 均未改；按当前保留窗口查询，不把普通页游标当 seq 补读或完整历史。对象项、taskless owner-only、私有任务计数、状态/未支持维度、查询/身份绑定与过窗当前查询边界均验收。通知/SSE/冻结事件兼容相关 **16/16**，最终新增页专项 **2/2**，无 skip，typecheck/diff 通过。整轮只跑上述相关文件，全套交维护者；39 是唯一新迁移，未 push/部署，未改 7420/网关/Circle/独立包或事件挑选表。

最终 **cb4d485** 定向收尾验收按文件串行运行：registry-approval-pages **3/3**、registry-content-pages **5/5**、registry-mcp-pages **1/1**、registry-operations-pages **3/3**、registry-notification-pages **2/2**、worker-liveness-query **1/1**，共 **15/15**，失败/取消/跳过均为零；typecheck 通过。验收时工作区与生产提交冻结，未出现 terminating connection，不需要文件重跑；随后仅追加本条验证记录。没有运行 npm test 或全套，完整独立验收由维护者负责。只用临时 PostgreSQL 与合成资料，未 push/部署或访问 7420/真实网关/Circle/独立包；B 当前范围内存 ACL 与分页成本保持 handoff 已披露口径，不以页大小推断查询成本上限。

## 65：统一标识、冻结包基线与执行流迁移设计

按维护者一份简报顺序签署三笔：**69363e3** 统一 circle-hub 标识与 `CIRCLE_HUB_*`，新名优先（包含显式空值），仅新名未定义时读取旧名，启动只输出一行不含值的旧键弃用提示；旧 controller lookup 集中适配、编译器 creator 与 Circle 扩展旧协议保留，原生 Execution **1.1.1** 及实现摘要不变，HTTP 路由、dev-login 与数据库 schema 不改，专项 **54/54**（新用例 5、直接消费者 38、mindmap 4、归档 7）及 typecheck 通过。**dfd8144** 默认样本改钉 **ba06eed**，Hub hooks **3/3**、冻结产品线 **31/31**、技能 **57/57** 与 catalog **4/4**（合计 **61/61**）通过，TAP 用例数动态读取，均无 skip，typecheck 通过；只读冻结包字节，不修改独立包。**b87c64c** 提交 148 行中文执行流迁移设计，四个相对文档链接及路径/凭据静态检查通过；明确当前 loader 不会运行完整 controller，后续需通用驱动、历史批准 pin、设备终态与产品解析隔离及 Meridian 双产品执行验收，旧任务不改数据库重绑，本轮未实施迁移，待维护者复核与后续实施授权。最终仅对齐 packs/README 的主配置新名说明并追加本段；未运行全套（由维护者独立执行），未 push、部署、访问 7420/真实网关或改 Circle 与独立包源，只用合成验收与只读冻结样本，不扩事件、通知或分页面。

## 66：公开 CI 的隔离前提显式跳过

维护者核对 f03f91d 的 Hub checks：244 通过、42 失败、18 跳过，失败来自执行宿主不支持当前 macOS seatbelt 隔离。统一测试 harness 每进程探测一次当前 adapter 的实际启动与文件拒读；只有明确 SANDBOX_UNAVAILABLE 才跳过，Tool/Hook/依赖/版本/断言错误仍失败。59 个 acceptance 隔离 leaf 与方法阳性用例在资源/worker/模型调用前明确 skip，负例、普通连接器与治理登记不跳过；混合外部来源用例保留上传/批准/命令查询，把实际执行拆为有前提的子用例，跳过不计通过。

实际 macOS 定向 45/45 加外部来源 12/12，共 **57/57，无 skip**；最终 unsupported 模拟定向 108 项为 **48 通过、60 跳过、0 失败/取消**，typecheck/diff 通过。模拟仅用测试 preload 将 server/worker 置于不支持平台，PostgreSQL 父进程保留真实宿主；这是失败闭合与报告边界验证，不是 Ubuntu 实机验收，不能启用假隔离。生产 isolation 与其它生产字节、原业务断言保持不变，只改测试和兼容说明；未跑全套、未 push/部署或访问 7420、真实网关、Circle 或独立包工作树。

## 67：A1 历史批准修订解析

先写历史产品/来源 pin 验收，旧实现 **1/5**（基础来源实时 ACL 负例原本成立），随后实现内部 `{assetId,version,sha256,digest?}` 精确绑定。来源制品与产品模块读取历史 approved/running 修订，未指定版本时选择本资产最新批准修订；跨产品/原生多实现必须显式选择，旧 assetId 字符串不被称作冻结。缓存与原件读取前重核批准摘要、历史与最新批准 readers 交集及当前角色；草稿收窄 readers 不撤旧批准 pin，批准 reader 撤销、旧修订 disabled/retired 和批准失效均拒绝。pin 只适用于批准清单中的自有原件记录，basis 引用、企业原件及其它来源继续原实时 ACL；补篡改记录摘要、空 digest 和缓存回执边界。合法合成 builders 明确选各自方法，通用请求/任务提交不偷注入 selector，无 selector 歧义负例仍有效。

新历史绑定六例与既有 APV/执行链/外部来源/模块/服务客户端相关六文件 **47/47**，providers 方法 **8/8**，共 **55/55，无 skip**；typecheck/diff 通过，固定 Circle 8b2ceb6、冻结产品包 ba06eed，只用合成资源和脚本模型。原生 1.1.1 及摘要依赖、HTTP 路由、数据库迁移/归档字节不改；公开 SAR 语义与旧任务不自动重绑。A2 契约待复核、A3 未实施，本步单独本地签署，全套仍由维护者跑；未 push、部署或访问 7420/真实网关/Circle/独立包工作树。

## 68：A2 有界 transition 内部契约

仅定义 `hub-execution-transition/1` 的输入/输出 schema、六种严格动作、步骤身份与独立请求摘要，F 的 factory 不反向依赖 B/D/E。当前输入值、canonical SHA 与冻结 binding 双重相等，仍须由 C 按不可变修订提供并核验；自报一致不证明权限。依维护者提供的真实 21 案纯数字统计推导 state 256 KiB、metadata 512 KiB、output 256 KiB、受控解码字节 8 MiB 等初版预算，完整 wire 仍受现有 24/16 MiB 限制；明确请求估算与实测字节的区别、环境/结果 Tool 可见事实与原件清单。有限 JSON、累计预算、规范 base64、原件 SHA/大小与真实字节长度均有合成负例，不截断；sessions 缺样本如实记为覆盖缺口。定向合同 **6/6，无 skip**，typecheck/diff 通过，多 agent 交叉复核；只定义数据与校验函数，未注册驱动或新增 HTTP，原生执行 **1.1.1** 字节不改。A3 须待维护者复核本契约后才开始，仅 Meridian 合成流程；APV 新 Tool/flow 由独立产品包负责，旧任务不重绑。未跑全套、push、部署或访问真实系统，全套仍由维护者独立运行。

## 69：合入设计文档收敛

A1 **b0c3172**、A2 **da3d679** 提交后工作区干净，按维护者授权将 main **312cc5c** 合入 server-s2，无冲突。接收 18 份设计文档及交接对照表的收敛，不修改两份 handoff、A2 契约、原生执行或历史绑定；合并静态 diff 检查通过，文档合并不重跑运行验收。维护者对 **296db62** 的独立全量 **491/491、无 skip** 仅记为外部复核结果。本地签署 merge，不 push 或部署；A3 继续等待维护者复核 A2。

## 70：provider 受控字节参数

维护者通过 A2，授权开始 A3 前先补派发原件引用。新增合同先复现 **6/7**，再加入 `provider.call.byteArgs` 的参数名到槽映射；普通 args 不得覆盖映射参数，超过 32 KiB 的 base64 仍拒绝。请求摘要核对引用槽并绑定原件 id/SHA/大小，支持只含引用的输入，不迫使 transition 复制正文；纯 Tool 的 byteSlots 同样绑定原件身份，步骤 key 不变。B 的上传上限与受控原件、完整 wire 的独立预算如实区分，未扩大七项预算或通道上限。定向合同 **7/7，无 skip**、typecheck/diff 通过；原生执行 **1.1.1** 一字未改。本补项单独签署，随后 A3 先写 Meridian 合成验收再实现通用驱动，APV 新产品代码仍由独立包负责。维护者对 A1 有一项全量失败正在独立定位，本地不猜原因或重跑全套；未 push、部署或访问真实系统。

## 71：A3 通用执行驱动与 Meridian 合成流程

多 agent 分担合同 / worker 协议、C/D 持久驱动、Meridian 与验收，首八条先跑 **0/8**（新能力未安装），再实现 `module-execute` 与迁移 **40** 的 flow_runs / flow_steps。沿既有提交、状态、操作、事件、结果和核对路径；精确方法 / 原件 / 资源 / runtime-profile pin、步骤 key 与请求摘要、意图和真实回报分别冻结。有限动作经真实 worker，纯 Tool / Hook 保持隔离和 imports 边界，网络与凭据只有 D 注入。provider 协议是已批准 provides / schema / 字段路径数据，核原请求、远端身份和实际字节 SHA，不识别产品名或日志。默认资源直接执行，executionIsChange 冻结可审核内容与三类 pin、独立批准后仅消费一次；普通 work 任务按 scope 可读，run 委托的私有边界仍保留。

初次 33 条定向 **20 通过、13 失败，无 skip**，无 PostgreSQL 连接终止；按失败记录修复协议 shape 不一致、回报与运行器的锁序、同 Store 多 Execution 实例的过期处理、缺意图写与只读失败分类、核对失败误释放、核对子操作替换逻辑原操作及证据 / release 投影，未归为负载假红或放宽时限。status 可证终态先独立存 B/D，结果读取失败和六种解释缺口只影响交付，不冻结、不重派；大件 / NUL 原件以 canonical JSON 字节入 B，事件 / 回报只带绑定操作和 stage 的 SHA 指针。beforeDispatch 在实际出口强制核验，afterResult 回执与最终候选摘要一致，产品不能省略或换正文。预算补项另先复现部分入队干扰，再以已登记步骤加新增唯一步骤整批预检，超限不留下半批写；有在途操作时不因预算中止它。

最终主体 **33/33**、Hook / 原子预算 **3/3**，共 **36** 个不同集成用例；原生 APV **12/12**、资源身份 **6/6**、网关 **4/4**、拒绝路径 **11/11**，旧消费者 **33/33**；合同 **7/7** 与纯边界方法 **12/12**，合计本轮定向 **88 项通过，无 skip**。预算最后补项后只重跑直接相关三例，不重跑无关主体或全套；最后 typecheck / diff 检查通过。两份完全合成模块以不同 Tool / 回报形状交替运行，工作簿字节参数、故障 / unknown / 独立核对、旧 fence、重复回报、修订 / 权限、全部五挂点、原件回读 SHA 及取消均有断言。原生 `packs/apv/execution` **1.1.1** 全目录与实现摘要保持不变，旧任务未迁移，harness-adapters / permission-export / 历史迁移字节未改。A3 单独本地签署，不 push、不部署、不访问 7420 / 真实网关 / 设备 / 模型；B 的 APV 新产品代码与 C/D 切换、退役仍交维护者协调，完整独立验收由维护者运行。

## 72：A3 复核修复与通用错误登记

维护者补充独立观察：A1 验收重跑 **313/313**，首轮失败不可复现且与并发验收重叠；**e1ca68d** 全量 **512/512** 后由维护者升级验证栈，真实单例 80 秒交付、5 步及检查点通过、unmapped=0，环境原件字段与引用齐全。上述为维护者现网观察，不称 A3 已部署或独立确认。随后 **f4e294f** 的复核指出期限、拒绝来源、终态后的失败处理、运行器隔离、occurrence 与 worker 能力边界，本轮逐项修复，全套仍由维护者运行。

通用错误登记先单独复现 **0/1**：仅导入 contracts 时 GATEWAY_REFUSED 未登记，实际为 500/internal。将其加入 F 注册表，不依赖产品模块导入副作用；相同旧产品登记保持幂等，原生实现字节不改。新增例与 transition 合同联合 **8/8、无 skip**，typecheck/diff 通过；仅本地签署，不 push 或部署。worker 回报码校验随后单独修，不把此登记变更当作全部复核问题已完成。

## 73：H1 步骤期限与过期收尾

先用合成数据库时间压缩复现五例，旧实现 **1/5**：活跃写跨旧五分钟的兼容例原本成立，另外四例复现晚审批不刷新、输入 / flow 期限字段拒绝、accepted 真过期无人清理及真实写期限不触发。期限按 input → 批准 flow → 默认一小时冻结，数值沿现有 OperationRequest 的正整数 / 一小时上界；入队、审批消费刷新与核对步骤共同使用冻结时长。waiting-review 不按执行期限清理；accepted 真过期 failed / UPSTREAM_TIMEOUT / sideEffects:none，有意图写超真实期限按 unknown 保留核对。没有通过延长断言时间模拟正确性。

独立 worktree 新五例 **5/5**、晚审批 / 核对 / 变更相关旧例 **3/3**，均无 skip；应用补丁后的 typecheck/diff 通过。只暂存本项的合同、驱动、验收与交接 / 进度，单独本地签署；迁移 40、原生执行 1.1.1 字节不改。其余复核项仍逐项进行，不跑全套、不 push / 部署或访问真实系统。

## 74：M4 运行器与任务事务隔离

先以真实 makeRun 路径及 PostgreSQL 事务中止语义复现 **0/1**：state 的 JSONB 错误后直接写 failed 仍触发 25P02，回滚整笔。逐 flow 任务加 savepoint，撤销失败写入后再落明确失败；候选任务之间与 task / flow / 原生 packages / automation / change-set / secrets 各运行器之间独立捕错，诊断不带 state 或 SQL 原文。不会用单一总 catch 抑制后续运行器。

故障方法 **2/2**，组合 H1 后的实际临时 PostgreSQL 新验收 **1/1**：含 NUL 的已批准初状态只失败一次，另一历史批准 flow、原生知识读取、bot 定时受理失败记录和变更依赖 wakeup 均继续推进。首个实际测试夹具漏声明 knowledge-candidates，被既有资产规则正确拒绝；补合法声明后验证通过，生产授权规则未放宽。typecheck/diff 通过，独立本地签署，不跑全套或部署。

## 75：H2 拒绝来源与已派发事实

纯边界先 **1/3**、实际合成 submit / status / 短 TTL heartbeat 三例先 **0/3**。B 拒绝原件增加有限来源 envelope，保存实际调用工具 / 阶段及内层原文；只有绑定 submit 调用本身、没有已成功提交或持久远端身份，且原文机械满足未派发，才能 failed / 释放。提交成功之后的 status / heartbeat 拒绝仍 unknown / 冻结 / 不释放。C 独立检查持久 remote_identity，新增把 worker submitted:false 与伪 submit 来源都改写的回报，不能撤销已派发事实；旧来源不明的原文不猜未派发。

独立临时 PostgreSQL 四例 **4/4**，新纯三例与既有协议边界 **15/15**，均无 skip；应用到已含 H1/M4 的主工作树后纯例与 typecheck/diff 通过。仅本项来源 / 分类及夹具单独签署；M3 终态后 result 拒绝的处理随后独立修，不把本项当成解释错误已解决。原生执行 / 迁移字节、真实系统和全套均未改动或运行。
