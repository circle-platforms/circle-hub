# 任务：T1–T3 合成层场景机械验收用例补充与覆盖表更新

依据：`docs/hub-r5-tests.md`、`docs/hub-r5-test-map.md`、`docs/hub-r5-test-map-t1-t3.md`。

## 任务背景与目标

开发项基本合入完毕后，进入合成层测试验收阶段。针对 T1–T3（知识、平台事实、构建差异）各场景补充机械验收用例并更新覆盖矩阵：
1. T1-2 评审全链合成版：定位（case-location）→ 初评（case-review）→ 独立复核（case-review-verify）→ 终稿（case-review-report）。验证同族复核不满足独立性且终稿不放行；换家族后满足独立性并放行；验证命令不存在反驳、PASS 携被推翻发现拒绝、终稿多重结论拒绝等反例。
2. T1-1 只给根的核对（A6）：根模式引用解析、改字失败反例、跨版本线根反例、参数校验反例。
3. T2-2 按编号读原件（source-read）：全部反例（编号不存在、路由未声明、来源不可达带下一步出口且无主机泄露、空输入拒绝、参数格式非法）。
4. T2-3、T2-4、T2-5、T2-6 平台事实正反例（缺陷修复缺失请求、需求单条无效拒绝、质量看板阈值越界提示档不阻断）。
5. T3-1、T3-2 影响视图残缺目录启动期拒绝（缺少 `catalog=commands@1` 或目录名不符在 start_run 投影期拒绝）。
6. 更新 `docs/hub-r5-test-map-t1-t3.md` 与 `docs/hub-r5-test-map.md` 覆盖表与发现的问题。

- 分支和工作树：`t1t3-acceptance-2`，目录 `circle-trees/t1t3-acceptance-2`。
- 本任务可修改路径：
  - `docs/hub-r4-tasks/t1t3-acceptance-2.md`
  - `docs/hub-r5-test-map-t1-t3.md`
  - `docs/hub-r5-test-map.md`
  - `tests/acceptance/38-r5-t1t3-acceptance.test.ts`
- 规则：
  - 旧测试一个字不改；
  - 纯合成数据与夹具（ORBIT/COMET、lumen-api、192.0.2.0/24 与 2001:db8::/32），不出现任何真实地址与产品名；
  - 发现的问题不直接修改核心实现，记录进覆盖表并上报；
  - 合入前全量测试（docs, contracts, hub, packs, acceptance 并发 2）。
