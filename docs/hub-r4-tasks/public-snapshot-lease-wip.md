# 任务：把租约分支（WIP）按公开身份同步成第二个公开分支（只在公开副本里做，不提交，不推送）

依据：所有者 10-28 的目标"交接所有代码到 GitHub，更新交接文档"；R6 快照任务页 `public-snapshot-r6.md`（做法、映射 T、红线、扫描清单都沿用，**先读完它**，再读公开仓库里的 `docs/hub-r4-publication.md` 和 `docs/hub-r5-publication.md`）；GitHub issue #28（阻断项的公开说明）。

## 位置

- 私有集成树（只读，不要改、不要在里面提交）：集成者的 `circle-hub-redesign` 工作树。要同步的变化是 `768ff328..operation-device-lease`（分支末端 `38000008`）：`git diff --no-renames --name-status 768ff328 38000008`，共 59 个路径，其中 `docs/**` 2 个不带。`768ff328` 正是 R6 快照的私有来源，所以这份变化叠在 R6 快照之上：base = T(`768ff328` 版本)，theirs = T(`38000008` 版本)，ours = 公开副本里已有的文件。
- 公开副本：同级目录 `circle-hub-publication`。**先确认 `hub-r6` 已由集成者提交**（`git log -1 hub-r6` 是一个签名提交，`git status` 干净），然后从它开新分支 `hub-lease-wip`（`git switch -c hub-lease-wip hub-r6`）。不要 commit、不要 push、不要用 gh、不要联网访问 GitHub（`npm ci` 可以）。提交由集成者做。

## 做法

与 R6 相同（路径映射 + 内容映射 T + `git merge-file` 三方合并，新增文件直接放 T(NEW)）。本批特有的几点：

- `contracts/model.json`、`contracts/src/{run,tools,validation}.ts` 有变化：先合并源文件，再 `npm run gen:contracts` 重新生成 `contracts/generated/**`（不手工合并），并跑 `node tools/gen-contracts.ts --check`；`contracts/model.json` 的改动逐行读一遍并在报告里说明（模型改动归集成者负责）。
- `packs/workflow/knowledge-contribution`：私有侧已升到 1.3.6 并重签；公开侧按公开身份重算摘要并用 `node packs/workflow/knowledge-contribution/api.ts sign` 重签，版本号以公开侧现有版本为基准再升一级（不复用已发布的身份）；`tools/*/generated.json` 用拥有它们的工具重新生成，不手改。
- 不碰任何摘要、完整性值、签名的字面。

## 红线和不带的清单

与 R6 任务页相同。额外一条：这是**带已知阻断项的 WIP**，不要为了让测试变绿而改断言、删测试或放宽任何检查；测试有失败就如实报，并说明失败是否属于 issue #28 列的阻断项。

## 验证和扫描

按 R6 任务页的做法全做并报数字：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；单元分区；docs 检查；临时 PostgreSQL 验收；引用存档测试；并发最多 2。扫描：整个工作区和相对 `hub-r6` 的全部改动，`git grep` 禁用词、自定义正则、`gitleaks`（目录和改动扫描，必须零命中，不加允许名单）。扫描产物放仓库外。

## 报告

写 `~/Library/Application Support/circle-hub-acceptance/handoff/publication-lease-wip-report.txt`，格式同 R6（带了多少文件、冲突、升版本、测试计数与跳过与失败、扫描结果、没解决的事）；终端里只回一行结论加路径。工作区里不要留扫描产物，`git status --short` 只应该是要提交的改动。中途需要我定的事，直接在终端里写清楚问题再等。
