# 床面残留与恢复

分支 `bed-state-gate`。通用派发能力：开跑前用执行器已声明的只读探针核对冻结台架清单，终态后再核是否回到开跑前快照。

可改路径：

- `contracts/src/resources.ts`（执行器定义增加可选 `bed_state`）
- `hub/dispatch/bed-state.ts`
- `hub/dispatch/bed-state.test.ts`
- `hub/dispatch/service.ts`
- `hub/dispatch/README.md`
- `packs/workflow/test-bed/functions/manifest.ts`
- `packs/workflow/test-bed/functions/manifest.test.ts`
- `packs/workflow/test-bed/functions/match.test.ts`
- `packs/workflow/test-bed/pack-files.ts`
- `packs/workflow/test-bed/pack.json`
- `packs/workflow/test-bed/README.md`
- `docs/hub-r4-tasks/bed-state-gate.md`

不连接真实台架，不读环境配置，不使用 7420 和钥匙串。探针输出只按声明解析器与清单字段比较。
