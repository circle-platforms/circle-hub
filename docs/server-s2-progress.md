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
