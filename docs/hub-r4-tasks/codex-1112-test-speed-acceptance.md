# 本机验收测试并行

依据任务书 6，在 `31f53fb2f0` 上建立 `test-speed-acceptance`，交由集成者合入独立的 `test-speed` 分支，不并入 C4。

可改路径：

- `tools/run-acceptance-tests.ts`
- `tools/run-unit-tests.ts`，仅导出现有 `prepareTemplate` 与 `sharedEnv`
- `tools/run-acceptance-tests.test.ts`，仅同步确有变化的既有断言
- `docs/hub-r4-tasks/codex-1112-test-speed-acceptance.md`

本机完整验收共用一个临时 PostgreSQL 集群和已迁移模板，每个测试文件仍通过现有 helper 使用随机数据库和临时目录。并发为 `max(2, min(8, availableParallelism() - 1))`。指定 `ACCEPTANCE_SHARD` 时仍按原规则分片、一个文件一个文件执行，保留原来的私有集群路径。

资源审计覆盖现有 69 个验收文件及共同 helper：数据库由 `hub/testing/records.ts` 调用 `createDatabase()` 随机命名，数据目录和 Hub 解包目录通过 `mkdtemp` 创建；Hub、连接器和执行器的合成服务器均使用端口 0。场景 17 和 40 只重建自己数据目录上的 Hub 对象；场景 18 终止的是自己的沙箱子进程。没有找到需要独占的备份恢复、部署、launchd、固定监听端口或集群全局修改，因此没有另建空的串行组，也不按文件名称推断资源占用。

复用单元测试已有的模板准备和子进程环境函数。测试结束时先等测试进程退出，再停止共用集群；转发原有中断信号。每个共享句柄只删除自己创建的数据库，底层集群停止和信号清理由现有 PostgreSQL helper 处理。

集成者在未修改的 C4 最终提交上测得验收文件耗时合计 2212.348 秒，最长文件 146.710 秒，整段 2262.725 秒。按原工作量除以 8 得到 276.543 秒下限，目标为 280 至 300 秒，实际效果等待集成者测量。基准中的失败照原样保留，不为提速调整断言。

本任务仅运行一次 `node --test tools/run-acceptance-tests.test.ts`，6 项通过、0 失败、0 跳过，命令墙钟 0.205 秒；原始结果保存在验收工作目录的 `briefs/test-speed/acceptance-runner-own.log`、`.exit`、`.seconds`。既有测试未更改。完整验收测量由集成者执行，本任务没有运行全量、类型检查或版本命令。不删除测试、不改变断言强度和规模、不增加跳过，不访问真实系统、环境文件或凭据，不推送或部署。
