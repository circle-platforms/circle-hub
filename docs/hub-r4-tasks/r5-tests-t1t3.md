# R5 测试阶段准备 T1–T3（知识、平台事实、构建差异）

分支 `r5-tests-t1t3`。依据：`docs/hub-r5-brief.md`、`docs/hub-r5-tests.md`。

任务范围：
1. 覆盖表：分析 `docs/hub-r5-tests.md` 中 T1、T2、T3 的全部场景与反例，梳理 `tests/acceptance`、`hub/**/*.test.ts`、`packs/**/*.test.ts` 现有断言与缺口，输出 `docs/hub-r5-test-map-t1-t3.md`。
2. 补全无依赖缺口的 `tests/acceptance` 用例（从编号 33 开始，使用 `r5-t1t3` 前缀）。
3. 发现的实现或设计问题单独记录在覆盖表的“发现的问题”节中，不在此分支修改实现代码。

可改路径：
- `docs/hub-r4-tasks/r5-tests-t1t3.md`
- `docs/hub-r5-test-map-t1-t3.md`
- `tests/acceptance/33-r5-t1t3-*.test.ts` (及其相关 acceptance 测试文件)

规矩：
- 只按结构判定，不许关键词匹配；
- 仓库只用合成数据（产品 ORBIT/COMET、lumen-api，地址 192.0.2.0/24）；
- 不删不跳测试；测试并发不超过 2；
- 不碰钥匙串、环境配置文件和任何真实系统；
- 不碰 `docs/hub-r5-test-map.md`，不写 T4–T9 用例。
