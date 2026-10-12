# circle-server 第二阶段进度

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
