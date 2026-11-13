# 21:00 knowledge 回归簇

依据：所有者 2026-11-13 紧急回归授权与 Boss 的 regression-failures-2100。基线 `3ff62bcf24`；分支 `wp/codex/regression-knowledge`。

可改：`hub/knowledge/personal-mount-recovery.test.ts`、`hub/knowledge/search-index.test.ts`、必要的同包生产文件及本任务页。`feeding-visibility-batch.test.ts` 属于另一个代理，不改。

先逐文件判定；仅有明确决定证明已删除行为才删对应测试。C1 删除旧个人对象转换/退役路径，15:00 决定只修改公共空间标签，内部 `team` 保留。不改六工具输入、text.ts、packs 函数或 SKILL，不写 integration 或主回归分支。

Boss 的全量锁占用期间不运行 tests/types/gen；只能收到 Boss 通知并经主代理排时段后再运行，不自动等锁启动。逐文件判定、实际提交及未跑项写入指定外部 regression-verdicts 与 codex-progress。
