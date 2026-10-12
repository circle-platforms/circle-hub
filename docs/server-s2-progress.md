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
