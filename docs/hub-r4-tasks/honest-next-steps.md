# 任务：判据依据的角色按 A03 核对，扣留来源给出下一步

依据：所有者 2026-10-31「修复这 4 个问题，检查过了就上线」里的第 3、4 项（补跑中的发现，见 `docs/hub-r4-progress.md` 暂缓清单）。

- 分支和工作树：`honest-next-steps`（从 hub-redesign 9fa99e916 开出）。
- 判据变更（W10）：判据只能取期望来源的片段（A03 R[0]），依据可以取期望来源，也可以引被判对象原文（A03 R[3]），被判对象依据在评判请求和等待步骤里按序号标出角色。其他角色（线索、报告的实际结果、派生、待判定产物、请求原文）照旧在本条声明处拒绝；每个放错的片段在自己的 JSON 指针处报出它的角色，不再只报声明本身。树引用的判据和依据仍要求全部出处在本次运行绑定为期望来源。
- 扣留来源（只保留档位）：内容页在"含凭据，原文不可读"之后给出下一步：请管理员核看为何只保留；凭据误报经管理员接受后用同一引用重读；含真凭据或按策略只保留的不会放行。调用方文字不出现管理员命令。
- 不改：凭据类读取失败对调用方仍只说「对你不可用」（`docs/hub-r4-tasks/unreachable-next-step.md`），SOURCE_UNAVAILABLE 的登记修正文字不变（改它要连带四个技能包的生成协议表升版）。
- 可以改的路径：
  - `hub/runs/engine/exact.ts`、`hub/runs/engine/submit.ts`、`hub/runs/engine/criterion-changes.ts`；
  - `hub/runs/engine/criterion-boundary.test.ts`、`hub/runs/engine/criterion-engine.test.ts`、`hub/runs/engine/criterion-tree-role.test.ts`（后两个只把拒绝指针从声明改到具体位置）；
  - `hub/runs/engine/README.md`；
  - `hub/server/text.ts`、`hub/server/source-readable-display.test.ts`；
  - 本页。
- 规则：合成数据，不连接真实系统，不读环境配置，不用钥匙串；`git commit -s`。
- 验证：`npx tsc --noEmit`；受影响测试（`wf/affected-tests.py --run`）。
