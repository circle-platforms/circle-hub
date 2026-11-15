# 第 30 轮作业投影中继

基线 `03cd3118ec`。允许修改本页、`hub/ports.ts`、`hub/runs/engine/dispatch-results.ts`、`hub/runs/engine/export-row.test.ts`、`hub/runs/engine/dispatch-results.test.ts` 及中英文兼容性历史。输出逐条行使用已核验投影的完整结构副本，保留缺失事实、下一步、性质、限定、原件校验、判断前提和 accepted_as_fact，不新增判定或改变动态终态。字段可选以保留旧读取方兼容；未提供不代表已确认。

新增合成测试 2 通过、0 跳过；`npx tsc --noEmit` 退出 0。派发投影与导出集成回归 4 通过、0 跳过；原导出快照断言更新为完整保留投影，来源伪造和不同工作簿的拒绝断言仍保留，没有部署或真实设备验证。
