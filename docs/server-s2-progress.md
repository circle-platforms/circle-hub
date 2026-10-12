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
