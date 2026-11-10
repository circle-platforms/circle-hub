# B3：整卷检查来源预算核对

来源：所有者 2026-11-09 批准全量计划。基线 `aded2ffd`，分支 `fix/check-source-accounting`，关联 #189、#130、#199。

## 允许路径

- `hub/runs/engine/read-budget.ts`、`read-budget.test.ts`、`evaluate.ts`、`README.md`
- `packs/workflow/case-compile/production.test.ts`、`examples.test.ts`、`README.md`
- `packs/workflow/case-compile/testing/undeclared-example.json`：保留原脑图/原提交逐字负对照，与#262新增文件一致
- `docs/hub-r4-tasks/check-source-accounting.md`
- `CHANGELOG.md`

## 核对和验收

当前 CheckReadBudget 已按原引用取最大字节并在同次evaluation共享，不能沿旧issue诊断直接提高容量。先用实际编译引擎、合成大合约与多个用例复现；确认同一原件跨检查、跨用例的来源计数与原始/片段/解析输出关系。与不同原件总量超限对照，不改变每个检查的max_bytes，不删安全断言。原文只读取合成内容，不访问真实环境。

#130 当前已有同代示例推导测试，另核其在当前包运行及工作簿验证的证据；已有修复只补验证，不重复重写。检查发生容量错误后仍准确返回unknown/refusal，不能将未检查写成满足。

## 实际结果

- 原始 examples + production 基线：12 通过、0 失败、0 跳过。
- 大合约回归在原基线实现上通过：合约原始 JSON 超过 3 MiB、4 个唯一 AUTOID，单次提交所有用例、单份 XLSX、后继整卷回读，每项要求满足，4 项回执均指向同一工作簿摘要并列出4个AUTOID。没有改实现或提高16MiB限额，未重现当前重复计费；真实报告/部署仍需另核。
- 新增预算控制：4用例×6检查复用单引用仍仅计3MiB；变大只加差值、变小不减计；不同片段分别计；下一 evaluation 独立；多一个字节的合计溢出拒绝且不计成功。
- 示例真实边界验证：上传的原始脑图 hash、逐字引文及条目ID与例子一致，resolve_reference 解析到原节点。示例还包含当前合约/合成目录未声明的创建/查询/清理四条命令，引擎确定反驳，生成器阻止生成。本批不把“提交已受理”当“全部要求满足”，#130 完整例子可运行性需后续补齐声明，保持开启。
- 全包及预算控制：`node --test --test-concurrency=1 "packs/workflow/case-compile/**/*.test.ts" hub/runs/engine/read-budget.test.ts`：564 通过、0 失败、0 跳过。包含 sandbox-exec 真实沙箱路径、临时PG与脚本模型，均为合成数据。
- `npm run test:docs`：333通过、0失败、0跳过。
- `npm run typecheck`：退出0。初轮夹具类型、单用例生成API、输入类型及预览字段误用已修正；不将这些夹具错误称业务缺陷。没有修改正式合约/生成文件、冻结包字节或迁移。
- 未运行全量仓库unit/acceptance、Linux隔离或真实部署/业务来源；不作线上修复或真实设备验收结论。

## #262 并行集成准备

旧多命令示例原脑图/原提交逐字保存在testing/undeclared-example.json，与#262文件相同；负对照改读该固定夹具，四处拒绝/生成器拒绝/逐字引用解析断言不变。因此#262可替换主示例而不让本分支的负对照误读新正例。未合并或改写#262。此次仅对照夹具引用变化，`node --test packs/workflow/case-compile/production.test.ts hub/runs/engine/read-budget.test.ts`16通过、0失败、0跳过；typecheck退出0。

#189原报告为34用例、1179215字节合约；本批4用例/>3MiB是新的合成压力场景，不是原事故输入的复刻。#262另交付与声明对齐的新主例全链路，本PR历史验证不据其存在自动变为线上修复。

## 事故规模的一档（2026-11-10）

原有的四例、3 MiB 契约的整卷回归即使有按条目重复计费也只有约 12 MiB，没有超过 16 MiB 预算，区分不了问题。把整卷回归参数化为 `verifyWholeWorkbook(cases, repeats, size)`，另加一档：34 个用例、约 1.2 MiB 契约（#189 报告的规模），整卷计划受理、生成工作簿、二次核验全部满足，全程在读取预算之内：该测试通过，47 秒；四例一档 13 秒。

变异验证：临时让预算对同一引用的每次读取全额计费（去掉 `read-budget.ts` 里只计增量的 `old`），两档仍然通过，说明这条路径上契约没有被每个用例各读一次到预算边界；因此这一档守的是“事故规模的端到端场景不再出现”，不是“预算去重机制”（后者由 `read-budget.test.ts` 的精确计费控制覆盖）。变异已还原。结论不变：现有代码在报告的规模上没有复现 #189，原始事故运行用的是 3.9.18 与更早的部署，哪一处改动修了它没有确定。
