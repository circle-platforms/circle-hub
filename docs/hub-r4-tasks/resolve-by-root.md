# R5 阶段 A 工作项 A6：resolve_reference 支持 root 模式

分支 `resolve-by-root`。依据：`docs/hub-r5-brief.md` 工作项 A6。

## 目标
1. `contracts/src/tools.ts` 中 `ResolveReferenceInput` 支持 `run` 与 `root` 二选一（恰好给一个；`root` 是知识根的 Sha256，与 `get_nodes` 的 `root` 形状一致）。工具描述详细说明两种用法。运行 `npm run gen:contracts` 并通过 `npm run verify:contracts`。
2. 语义：
   - 给 `run` 时行为完全不变；
   - 给 `root` 时：
     - 解析 `tree:`（按该 root 内容寻址）与该 root 组成中记录的来源原件 `src:`（沿用 `get_nodes` 的读侧权限与档位规则）；
     - `rec:` 引用和回注层条目在 root 模式下拒绝并提供出口（改用运行并说明用法）；
     - root 不存在或调用者读不了时返回与 `get_nodes` 相同的拒绝形状；
     - `run` 与 `root` 同时给出或均未给出时返回参数错误。
3. 实现落点：
   - `contracts/src/tools.ts`
   - `hub/ports.ts`
   - `hub/server/tools.ts`
   - `hub/server/fakes.ts`
   - 实际 resolver（`hub/runs/engine/queries.ts` 或相关模块）
4. 覆盖测试与文档更新。

## 可改路径
- `docs/hub-r4-tasks/resolve-by-root.md`
- `contracts/src/tools.ts`
- `contracts/generated/**`
- `hub/ports.ts`
- `hub/knowledge/**`
- `hub/server/**`
- `hub/runs/**`
- `hub/testing/**`
- `tests/acceptance/**`
- 相关包文档/SKILL.md（如有改动同提交升版本重签）
