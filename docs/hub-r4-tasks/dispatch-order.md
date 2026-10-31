# 派发顺序与无判定原因（R5 A2）

分支 `dispatch-order`。跑后床态探针在停止心跳和释放远端租约之前取完。`dynamic_terminal` 为 `no_verdict` 时，结果写明缺的前提（归属值相符但未认证时前提为 `result_ownership`）并给出出口。`explain-release` 在不连接执行器的前提下，写明执行器尚未登记 `result_ownership` 时结果不能成立的原因和出口；第 3 款是否满足保持原判。

Circle 交来的操作记录（会话、对象、步骤、时间、上传原件引用、结果）等 A1 词表合入后再对齐，本任务不加字段。

可改路径：

- `hub/dispatch/service.ts`
- `hub/dispatch/dynamic.ts`
- `hub/dispatch/dynamic.test.ts`
- `hub/dispatch/bed-state.test.ts`
- `hub/dispatch/ownership-recovery.test.ts`
- `hub/dispatch/release-explanation.test.ts`
- `hub/dispatch/testing/context.ts`
- `hub/server/cli-job.ts`
- `docs/hub-r4-tasks/dispatch-order.md`

合成执行器夹具。不连接真实自动化测试环境，不读环境配置，不使用钥匙串。地址只使用 192.0.2.0/24。
