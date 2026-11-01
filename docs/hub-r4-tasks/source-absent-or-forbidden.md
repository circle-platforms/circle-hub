# 任务：读不到时分清"没有"和"没有权限"

依据：决定 112（所有者，2026-11-01，"3这是两种形态应该区分not found 和no permission"；凭据和登录两类选"照旧只说'对你不可用'"）；通用模型 D05 R[3]、R[8]。

此前读不到时，不论 Hub 里没有这个对象，还是有但读者没有读取权限，回答都是中性的"对你不可用"，修正写着"核对引用；需要读权时请管理员分享或分配任务包"。10-31 所有者亲测时，模型据这句判断"672 的索引用户无读权"，更可能的原因是 Hub 里还没有那个构建的知识。

- 分支和工作树：`source-absent-or-forbidden`（从 hub-redesign 508ada3ce 开出）
- 可以改的路径：
  - `contracts/model.json`（D05 R[3] 改写和变更记录；协议码新增 SOURCE_NOT_PERMITTED，改写 SOURCE_UNAVAILABLE、SOURCE_ABSENT 的说明），以及 `npm run gen:contracts` 重新生成的文件（含四个技能包内嵌的协议表）；
  - `hub/runs/engine/**`、`hub/runs/packs/ports.ts`、`hub/refs/resolve.ts`、`hub/server/tools.ts`、`hub/server/readers.ts`、`hub/server/docs.ts`、`hub/knowledge/views.ts`、`hub/knowledge/read.ts`、`hub/knowledge/contributions.ts`、`hub/knowledge/feeding.ts`；
  - `packs/skill/{html,mindmap,workbook,xml}-format/**`（只因内嵌协议表变化升版）、`packs/workflow/source-read/**`（说明改写，升 0.1.4）、`packs/workflow/knowledge-contribution/README.md`；
  - 以上各处的测试；`docs/hub-r4-architecture.md` 第 176 行；`docs/hub-r4-progress.md` 补记决定 112 的第 2、3 条。
- 规则：同前（不推送、不建 PR；部署和发布逐次请所有者点头；测试只用合成数据）。

## 做了什么

1. **两种形态**：Hub 或外部系统里确定没有这个对象，答 SOURCE_ABSENT（"Hub 里没有 X"）；对象存在而读者没有读取权限，答新码 SOURCE_NOT_PERMITTED（"X 存在，你没有读取权限"），修正写明谁能分享或分配。
2. **仍然中性的**：Hub 登录来源失败或过期、来源系统拒绝 Hub 的账号、应答里有疑似凭据被扣下（原件只在"只保留"档）、读取者不是有效账号（含停用账号）。SOURCE_UNAVAILABLE 的修正改成"Hub 这次读不到它，原因只记在管理员记录里；请管理员按管理员记录恢复读取后按原引用重读"，不再提读权。
3. **逐处**：
   - start_run 的任务包：查无此包、只剩已下架版本答没有；有这个包但没分配给你答没有权限；给的是技能包或产品包按调用写错答；账号停用照旧中性。
   - 前序运行、get_nodes 和 resolve_reference 的运行、submit_result 的运行：查不到答没有，查得到但看不到答没有权限；submit_result 不带运行号按调用写错答。
   - 引用解析（src、rec、tree、entry）：三个读取器各加一个不按读者过滤的存在查询，看不到时按它分开；没有这个查询的读取器照旧中性。
   - 运行输入：上传原件、Hub 记录按存在分开；Hub 没有能读这类外部对象的已启用资源时如实说并指向管理员（SOURCE_READ_FAILED）；读取没给出原件时同样如实说。
   - 知识视图：产品不存在、构建不存在、构建还没有知识根答没有（修正写明由管理员同步这条产品线或育苗）；读者不能读这个产品答没有权限；视图标识写错按调用写错答并给写法。
   - 命名文档：先查文档在不在；在而读法不对（不经运行、不是自己的运行、任务包没声明命名文档输入）答没有权限；字节或源文件记录丢了按完整性故障交给管理员。
   - 知识回注受理、喂入层：引用的原件和归位节点按存在分开；只保留档的原件照旧中性。
   - 原来借用中性码的内部故障（锁定任务包或技能包读不出、需要的技能包没有安装、记录库缺能力、核验中途读源失败）改成 SOURCE_READ_FAILED，原有的说明和修正不变；start_run 和引用解析对"技能包没装"给同一个回答。
   - 读取者是停用账号时（身份类），知识视图不给调用方说明，照旧中性。
4. **说明**：source-read 的 SKILL 写清三种回答（升 0.1.4）；knowledge-contribution 的 README 改掉"非管理员收到中性回答"（并入 1.3.14）。
5. **升版**：四个技能包只因内嵌协议表变化升版：html-format 1.0.2，mindmap-format、workbook-format、xml-format 1.0.3；任务包按包名声明依赖，不受影响。
6. **预期变化**：T7-3 原来要求未分配的包和不存在的包同形，现在分开；`docs/hub-r5-tests.md`、`docs/hub-r4-guide.md`、`docs/hub-r4-architecture.md` 第 176 行和覆盖表跟着改，相关测试按新规则改写，测试原来要证明的"不泄露包的内容"保留（除错误外同形）。

## 没做

- 管理处置（放弃运行）是运行者和管理员的管理入口，回答已写明"运行或管理请求对操作者不可用"和修正，这次没动。
- 列表照旧只列读者能读的，没有就是同形空集。
