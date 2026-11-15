# 第 30 轮重核次数修复

本任务基线为所有者确认的 `03cd3118ec`。仅允许修改本页、`hub/runs/engine/submit.ts`、`hub/runs/engine/rounds-current.test.ts`。不迁入两笔禁用的关键词补丁，不改变摘要的身份规则。

重核把本次内容摘要排除在已用轮次之外；其他摘要、去重及 Hub 故障豁免保留。新增两项合成回归在修复前均失败，修复后 2 通过、0 跳过。`npx tsc --noEmit` 退出 0。现有 submit、runtime-admission、parent-recovery 三文件回归 26 通过、0 跳过；没有部署或实床验证。
