# B3：整卷检查来源预算核对

来源：所有者 2026-11-09 批准全量计划。基线 `aded2ffd`，分支 `fix/check-source-accounting`，关联 #189、#130、#199。

## 允许路径

- `hub/runs/engine/read-budget.ts`、`read-budget.test.ts`、`evaluate.ts`、`README.md`
- `packs/workflow/case-compile/production.test.ts`、`examples.test.ts`、`README.md`
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
