# 第 30 轮工作流包修复实施中

基线为所有者确认的 `03cd3118ec`，分支 `fix/run30-package`。允许修改本页、`packs/workflow/case-compile/`、相应生成副本和中英文兼容性历史。禁用的两笔关键词补丁不得合入。本任务尚未完成，不可安装或发布当前工作树的包。

当前草稿仅处理保真判断/信封矛盾：新增纯判断检查和唯一信封构造器；check-plan 的有/无 brief 路径都按两字段判断文件处理；carry-plans 使用同一入口；fidelity-apply 是持久化摘要的调用方。现有 carry/check 测试夹具由信封改为真正的判断文件，原负向检查保留。

`node --test packs/workflow/case-compile/functions/fidelity.test.ts packs/workflow/case-compile/tools/check-plan.test.ts packs/workflow/case-compile/tools/carry-plans.test.ts`：13 通过、0 跳过。新增函数测试在实现前缺导出而失败。尚未重新生成包清单、副本、版本和样例，未运行完整包测试，因此不把焦点测试通过当作完整包通过。

待继续：逐条总收口与结构化归因/gaps/出口；共同计划状态；实际交付文件清单；按名派发与安装清理；来源命名及内容缓存；类型化拒绝及全部相关文字；词表生成；最终同一包版本的生成与全包回归。守卫搬入和安装、后续命令域预检也未完成。

已独立完成的提交：网关只读分页 `4cc03ef`（完整网关套件受 Python 3.9/tomllib 限制）；Hub 当前摘要排除 `141501de93`；Hub 行限定与恢复证据中继 `ccf3c6ba0d`。这些提交尚未合并或部署，原有外仓未提交变更未覆盖。

保真草稿的 `npx tsc --noEmit` 退出 0。网关已找到本机 uv Python 3.12，使用既有 requirements 的离线临时环境后，完整探测套件仍因未生成 cex_core 而无法收集；没有把带内部资产的现用 vendor 复制到测试树。网关四项独立合成协议测试通过，整套网关测试未通过验收。

所有者随后要求完成全部代码并评审，并明确批准独立子 agent / worktree 并行。当前检查点属于未发布草稿：新增总收口、状态与缓存测试通过，但现有整包测试仍有失败，主要涉及旧整批拒绝和已确认措辞断言、按名派发、安装和命名。不得将检查点视作完成或发布。

集成者另拥有 `contracts/model.json`、`tools/gen-contracts.ts`、对应生成物和 `hub/server/claims.ts` 的词表消重；这些改动将交合约工作项复核。后续每项在独立工作树按明确文件范围修改，集成时保留全部失败并逐条解决。
