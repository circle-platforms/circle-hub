# R5 合成层覆盖表（测试准备）

分支 `r5-tests-map`。读 `docs/hub-r5-tests.md` 的 T1–T9，按测试里的断言写 `docs/hub-r5-test-map.md`。依赖为「无」且还没有机械断言的优先缺口，补 `tests/acceptance` 用例。不改派发、连接器或知识实现。

可改路径：

- `docs/hub-r5-test-map.md`
- `docs/hub-r4-tasks/r5-tests-map.md`
- `tests/acceptance/32-r5-dispatch-rules.test.ts`

合成执行器、合成产品 ORBIT/COMET 与 lumen-api、地址 192.0.2.0/24、临时 PostgreSQL。不连接真实自动化测试环境，不读环境配置，不使用钥匙串。
