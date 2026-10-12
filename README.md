# Circle Server

Circle 的企业 Agent 服务端，面向网络安全产品的研发、测试、诊断和维护。

普通用户使用 Circle 默认插件库中的连接插件，配置 server 的 IP 或域名并登录。Circle 保留通用 harness；服务端保存产品资料和证据、持续推进任务、管理实际执行资源，并提供版本化的专业方法。管理员和运维使用 server 自己的管理入口。

## 当前已经做了什么

仓库已从 Circle 的公开 TypeScript 主干派生，保留源历史及 upstream，作为独立私有仓库维护。共享基础放在 [foundation/circle](foundation/circle/README.md)，保持源文件原字节；旧客户端的安装、发布和 Pages 工作流随来源保留在子目录，不作为 server 的工作流启用。

之前 infosec-platform 的代码、契约、测试、样本、研究脚本和原型已经归入[参考库](references/README.md)。参考原件保留完整目录关系，按职责提供入口，并登记来源提交、Git blob 和 SHA-256。这里的代码没有接入新的生产运行路径。

| 服务端职责 | 对应参考 |
|---|---|
| B：产品知识、证据和制品 | [知识记录、快照与证据登记](references/platform/by-object/B.md) |
| C：任务、权限和协作 | [内存与 PostgreSQL 任务服务](references/platform/by-object/C.md) |
| D：实际执行和资源 | [操作、租约、进程和浏览器](references/platform/by-object/D.md) |
| E：专业方法与规则 | [知识问答、用例评审和脑图编译](references/platform/by-object/E.md) |
| 共享与验证 | [契约 F](references/platform/by-object/F.md)、[实验与样本 G](references/platform/by-object/G.md)、[界面 A](references/platform/by-object/A.md) |

## 接下来怎样建设

先核对共同代码的接口与使用者，再逐项建设 server 的身份、持久任务、执行节点和管理入口。已有知识和 PostgreSQL 决策继续沿用；真实输入输出、模型判断、实际操作和已验证结果分别记录。复杂网络调查覆盖物理到应用层，产品方法按型号、版本和环境限定。

Circle 和 server 分别发布，默认连接插件留在 Circle，不另建插件项目。共同代码通过来源记录和同步 PR 管理；兼容清单固定实际验证的客户端、API、worker、能力包和数据库版本。详见[工程计划](https://github.com/qingshanfeihu/infosec-platform/blob/main/docs/circle-server-plan.md)。

开发分支已有认证 HTTP API、PostgreSQL 持久任务、独立 worker 和自写 TypeScript `mindmap-compile` 能力包。可上传 XMind 2020+ 的 `.xmind` / `content.json` 或主题树 JSON，生成固定两表七列 `.xlsx`，由独立读取器回读核对后交付。原件、IR 核验记录和工作簿保存 SHA-256；同键重提复用任务，同源内容跨键重提复用制品；未映射元素以 partial 披露。

使用 Node.js 24，在本目录运行 `npm ci`，再运行 `npm run dev:stack`。命令启动临时真实 PostgreSQL、server 和 worker，打印仅本机可访问的地址、开发登录方式及合成 XMind 文件路径。Ctrl+C 停止并删除本次临时环境。它不使用现有 compile-excel skill、InfoTest 或 Python。

[Circle 客户端接口交接](docs/client-api-handoff.md) · [第一阶段进度与实际验收](docs/server-s1-progress.md) · [参考采用清单](docs/server-s1-adoption.md)

第一阶段八幕的本地合成验收、完整 LBX 审批/修正故事和 admin 命令已经通过，最新整套检查 40/40。优雅重启的间歇失败已修复，原案例与两条新增回归验收在修复时连续十轮通过，共 30/30。Bugzilla/Jira 角色替换、OpenKM 文档取回与转换、worker 中断后的独立核对、当前修订事实交付均由新的 TypeScript 模块实现；管理命令见[说明](docs/admin-cli.md)。真实 Otty/Circle 脑图组合观察已单独登记，Circle 插件仍由 Claude 维护，本分支未修改 Circle。

普通用户可通过 `GET /v1/tasks?limit=N` 和 `GET /v1/tasks/{taskId}/approvals` 读取授权范围内的任务与审批记录，只需 `tasks.read`。字段、排序与查询边界见[客户端接口交接](docs/client-api-handoff.md)。

第二阶段 `server-s2` 已完成资产、只读连接器、两类六种知识记录、工具目录、审批技能包、Circle RPC 执行、定时/事件 bot 和产品包注册的本机合成验收。产品知识从 SHA 原件异步投影，批量入库并增量发布，索引进度使用任务和事件补读。APV 编译代码及 Claude 提供的技能包归 [packs/apv](packs/apv/)，第二条虚构产品线 [Meridian](packs/meridian/) 使用相同核心、权限、审批和 RPC。旧产品健康能力撤下，合成设备/记录协议仅保留机制验收；脑图编译 HTTP 与两表七列契约兼容。

已安装产品线由运行时 `CIRCLE_SERVER_PRODUCT_LINES` 文件选择，逐个加载 product-line/1 清单及工具别名；格式见 [产品包安装说明](packs/README.md)。连接器资产可带 productLineId，复用既有连接器的新增产品线无需改核心或安装入口。合成源数据归 packs/synthetic，核心和连接器守卫均拒绝产品线名。

工作列表可用 `GET /v1/tasks?kind=work&limit=20` 先过滤内部工具/索引任务，再以末项 taskId 作为 after 续页。构建版本工具默认精简分页（20、最多 100），主平台最新可用正式构建可筛选后 limit=1；开发登录默认八小时，支持无密码续期。完整回归当前 contracts 4/4、methods 17/17、acceptance 133/133、references 7/7，显式固定 Circle 构建、无跳过；APV 包内测试另 4/4。构建站点的重建、重载、变体和单页定位，以及版本目录的有界 WebDAV 搜索已补同形合成回归，实际来源复测仍由用户/Claude 执行。独立 Otty 编译、bot 与规模复测观察见[第二阶段进度](docs/server-s2-progress.md)。这些数字不代表真实来源权限同步、正式企业身份、付费模型或设备验收。

`apv-case-execute` 已补合成网关验收：执行单表工作簿先由 server 从绑定来源独立核对全部字面设备命令，另一人审批后再强制取当前 XML 复核，才通过既有 MCP 网关投递。逐案、步骤和检查点结果保留原件与 SHA；取消/中断后 unknown、冻结和独立核对恢复。个人访问/刷新令牌只在私有 vault，由单写者轮换，配置和恢复见[执行交接](docs/case-execution-handoff.md)。文档目录自动补尾斜杠、列表/搜索分页；缺陷查询先用 `zentao.products` 查 id，再有界筛选。审批默认一天，可配置。Claude 已部署并复测读侧版本，执行版部署交接在进度记录中；真实网关的上游核验尚需恢复，真实投递等用户上传工作簿。

这些结果覆盖开发身份、临时 PostgreSQL 和合成设备/企业系统；真实源只读观察与本机演示部署另行记录，真实执行未通过合成结果替代。原参考中的历史结果不作为新 server 的验收结果。本阶段没有 push 或发布，运行时地址、凭据和业务原件不进仓库。

## 核对参考原件

使用 Node.js 24，无需安装依赖：

```sh
npm run verify:references
npm run test:references
```

检查包含文件摘要、Git blob、完整来源树、路径闭包，以及被改动的原件能否被拒绝。它只证明来源和归档完整性，不证明业务行为或设备兼容。

[开源基础检查](docs/open-source-readiness.md) · [B/C/D/E 融合提案](docs/bcde-integration-plan.md)

基础检查已完成，自有内容采用 [MIT](LICENSE)，完整 platform 自有归档已由内容持有人确认可公开。第三方范围见[来源与许可说明](THIRD_PARTY_NOTICES.md)。项目可以作为开发中的开源项目公开；本轮没有执行可见性变更，GitHub 仓库仍为私有。融合提案尚未实施或排期。

[参与方式](CONTRIBUTING.md) · [安全问题与支持范围](SECURITY.md)

[初始化记录](docs/bootstrap.md) · [来源清单](references/source-manifest.json) · [共同产品看板](https://github.com/users/qingshanfeihu/projects/1)
