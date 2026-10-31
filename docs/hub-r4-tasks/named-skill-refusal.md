# 任务：T9-2 的运行级拒绝要核对点名

依据：所有者 2026-10-31「修复这 4 个问题，检查过了就上线」里的第 1 项。补跑时以为"缺解析器包不拒绝、不点名"，复查是误诊：当时用的 source-read 不声明依赖，读的来源早先已按冻结摘要解析过。start_run 在冻结依赖时已经拒绝并点名（`hub/runs/engine/start.ts` 的 `startFresh`），只是已有测试只断言回答里含"安装"二字，"没有已安装技能包的注册表"那句也能满足。

- 分支和工作树：`named-skill-refusal`（从 hub-redesign ead9b9907 开出）。
- 改动：`hub/refs/skills.test.ts` 里运行级拒绝的断言改为核对错误码、`/pack` 指针和点名缺包的原文。只加强，不放松。
- 可以改的路径：`hub/refs/skills.test.ts`、本页。
- 规则：合成数据，不连接真实系统；`git commit -s`。
- 验证：`node --test hub/refs/skills.test.ts`。
