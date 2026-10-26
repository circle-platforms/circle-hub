# 任务：回归范围的原因写清是新增命令、删除命令还是修改命令

在真实数据上（同一版本线里相邻的两个构建）核对回归范围：Hub 的影响视图和另写的脚本直接比较命令树 XML 得到的变更路径逐条相同（12 条），但分类口径不同。影响视图按路径上条目（命令定义和手册里的行为说明）的增减判断，手册里已有说明的新命令，在视图里是“修改”（`change: modified`），而脚本看命令定义，是“新增”。范围本身不受影响（新增和修改都进范围），但回答里写“某某命令修改”，读的人会以为是旧命令改了。

- 分支和工作树：`hub-reasons`，目录 `circle-hub-reasons`
- 可以改的路径：`packs/workflow/regression-scope/**`。别的路径不动。
- 先读：`AGENTS.md`、`docs/hub-r4-handoff.md`、`contracts/src/views.ts`（`PathChange`、`ViewEntry`）、`packs/workflow/regression-scope/README.md` 和 `functions/`。
- 规则：不推送、不建 PR；不发布、不部署，不碰 7420 上的持久部署、钥匙串、环境配置文件和任何真实系统；提交只暂存明确的路径，`git commit -s`，一句首字母大写的英文祈使句，不加前缀和句号，空一行后写你自己的署名行；包升到 1.0.1 并重新签（`node packs/workflow/case-review/packaging.ts sign regression-scope`）。

## 要做的

1. 每个原因（`reasons` 里的一项）新增 `definition_change`：看这个路径的 `before` 和 `after` 两组条目在视图 `entries` 里的种类——前者没有“定义”种类的条目而后者有，是 `added`；前者有后者没有，是 `removed`；两边都有但摘要不同，是 `modified`；两边的定义条目相同（只有行为说明变了），是 `none`。保留原来的 `change`（路径上条目的增减）不动，别的包读它。
2. 条目摘要和结论文字用 `definition_change` 写：新增命令写“新增命令”，修改的写“命令定义有变更”，只有说明文字变了的写“仅说明文字有变更”；不再把新增命令写成“修改”。
3. 样例、README、SKILL.md 同步；先写测试（含改前失败的）：新增命令（路径上已有行为条目）、删除命令、定义修改、只改行为说明、没有定义条目的路径；验证 `npx tsc --noEmit` 和 `node --test --test-concurrency=2 "packs/workflow/regression-scope/**/*.test.ts"`。
完成后在终端里回报：提交号、测试通过/跳过/todo 的数量、没做完或拿不准的地方。
