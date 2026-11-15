# 第 30 轮重核次数修复

本任务基线为所有者确认的 `03cd3118ec`。仅允许修改本页、`hub/runs/engine/submit.ts`、`hub/runs/engine/rounds-current.test.ts`。不迁入两笔禁用的关键词补丁，不改变摘要的身份规则。

重核把本次内容摘要排除在已用轮次之外；其他摘要、去重及 Hub 故障豁免保留。新增两项合成回归在修复前均失败，修复后 2 通过、0 跳过。`npx tsc --noEmit` 退出 0。现有 submit、runtime-admission、parent-recovery 三文件回归 26 通过、0 跳过；没有部署或实床验证。

独立评审补充：新增实际 submitResult 入口测试，未决结果同摘要重交确实新增核验动作（不是缓存捷径），相同会话与新会话的预算均不增加；不同内容摘要仍计算之前的尝试。合成命令目录由缺失变为可用时，同一提交得到新核对结果、预算不变。临时移除 submitResult 对当前摘要的传参后，该入口测试红（used 从 0 变 1）；源文件已恢复。稳定回执、Hub 故障与恢复的原断言保留。

评审最终验证：`node --test hub/runs/engine/rounds-current.test.ts hub/runs/engine/submit.test.ts hub/runs/engine/runtime-admission.test.ts hub/runs/engine/parent-recovery.test.ts hub/runs/engine/dispatch-results.test.ts hub/runs/engine/export-row.test.ts`：37 通过、0 失败、0 跳过。`npx tsc --noEmit`：退出 0。仅合成测试与临时数据库；没有发布或真实业务验证。
