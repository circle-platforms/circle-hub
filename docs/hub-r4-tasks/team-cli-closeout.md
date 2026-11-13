# C2 命令行接口收尾

依据：所有者 2026-11-13 的 C2 独立任务授权；基线 `7c5ddc8f1fb570464659fe6258a198bb445c3cd1`，分支 `wp/codex/team-cli-closeout`。

可改路径：

- `hub/server/cli-team.ts`、`hub/server/cli-team.test.ts`
- `hub/server/cli-resource.ts`、`hub/server/cli-resource.test.ts`
- `hub/server/command-parameters.ts`、`hub/server/command-parameters.test.ts`
- 本任务页

对齐已定团队接口的删除计数与接入资源时的使用对象选项。不改 records、console、packs 或 reset。删除实际撤回计数须来自领域删除回执；当前基线没有此返回字段，已请求 main 协调 records，不用预读数量代替。

任何测试前确认 full-test.lock 不存在；PG/types 须 main 分配时段。纯合成回归不读取真实配置。外部交接证据记录于指定 review 目录的 `codex/team-cli-closeout-internal.md`。不写 Boss progress。
