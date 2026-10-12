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
