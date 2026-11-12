# 评估函数按输入预算分批

来源：所有者要求恢复一次 34 条目编译运行的来源核对能力后原样重交。基线 `origin/main` 0ce64322，分支 `fix/evaluation-batch-chunks`。

## 问题

每项输入各自未超过沙箱上限，但一个评估的聚合输入超过 32 MiB 时，subject 构建和检查函数都退成逐项启动沙箱。大量子进程及排队耗尽了同一次提交的文档操作期限，最后在来源核对阶段报基础设施读取错误。不能把最后读到的来源当作慢节点，也不能删除核验或放宽业务判据。

## 做法

- 按 JSON 数组的实际 UTF-8 字节数和本次调用的 `inputBytes` 上限，把有序输入切成连续小批；单项超限仍走原有逐项错误边界。
- 每一小批保持原有逐条输出、失败隔离、沙箱违规重试和停止语义；只有聚合级失败才回退该小批的逐项调用。
- subject 与检查函数共用同一个纯切块函数，不改沙箱上限、文档期限、任务包或提交内容。
- 用合成输入和子进程启动计数验证：34 项聚合成多批，不再退成 34 次逐项启动；现有单项失败、违规、输入上限和取消测试保持通过。

## 允许路径

`hub/runs/engine/{function-batches.ts,function-batches.test.ts,evaluate.ts,README.md}`、`hub/runs/engine/*batch*.test.ts`（仅在现有测试需要精确调整时）、本任务页。

## 验证

测试只用合成输入，不读取真实提交正文、真实来源或业务系统。部署和原样重交另行记录实际命令与结果；合成通过不等于真实运行已受理。

- `node --test hub/runs/engine/function-batches.test.ts`：8 项通过、0 失败、0 跳过。覆盖 34 项多字节输入的 17 次分批启动、精确字节边界、单项超限、当前小批局部回退，以及原有失败和取消语义。
- `node --test hub/rules/sandbox/batch.test.ts`：4 项通过、0 失败、0 跳过。
- `node --test hub/runs/engine/subject-concurrency.test.ts`：4 项因本机没有所需操作系统隔离而跳过，不记为通过。
- `npx tsc --noEmit`：修改工作树与未修改基线均只报 `hub/health/readings.ts(197,55)` 的 `StatsFs.frsize` 类型错误；该错误属于其他包，未修改。
- `git diff --check`：通过。远端 `5af06d0015cd` 的 `function-batches.ts` 与本地基线一致；`evaluate.ts` 仅有一处既有文案差异。仅含两个运行源码文件的补丁已在该 release 上执行 `git apply --check`，通过且未写入。

所有者随后授权创建 GitHub issue 和关联 PR；本次变更不包含部署或真实重交。标准部署只归档提交；后续部署需另行授权并核对完整 release 差异，不用非标准热补丁替代。
