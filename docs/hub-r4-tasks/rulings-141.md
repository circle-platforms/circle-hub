# 任务：落实所有者对 #141 的逐条裁定

依据：所有者 2026-11-03 在 #141 的逐条裁定（决定 137 的补充，跟踪见 #147）。①③④ 改，② 加首次提示，⑤⑥ 照现状。同步协议 v1 只做加法（`docs/protocols/knowledge-sync-v1.md` 第 13 节）：不改字段名，已有操作不增必填字段，新行为只以发现文档 `/.well-known/knowledge-sync` 公布的能力名提供。

## 做法

- 独立工作树，分支 `rulings-141`，从 `origin/main` 开出；推送本分支并开 PR，不合并。
- 测试只用合成账户、合成原文和脚本，临时 PostgreSQL。
- 模型升到 35 版，`npm run gen:contracts` 生成，四个通用技能包（html-format、mindmap-format、workbook-format、xml-format）因生成的 `protocol.ts` 变化各升一个修订号。

## 裁定与实现

1. **仅本机模式下的单条分享**（能力 `share-single-item`）。连着同步服务器、条目带团队标记的，可以分享：`POST /api/sync/v1/share`，请求 `personal-sync-share@1` 只带这一条条目版本、它的引文和它自己的来源（来源版本及分块），多一个对象就拒收。服务器按普通分享同样的顺序重新核对（有依据、只用团队解析器解析、逐字引文、来源能否分享、团队里是否重复、凭据扫描），通过就追加团队条目和团队持有的来源副本，不在服务器留个人副本；不通过时答复登记的拒收码。两种结果都追加共享回执，回执的 `single_item` 记条目、版本、团队标记、代次、操作键摘要、请求摘要、本机路径和来源摘要，不记正文和文件名。同一条目再次单条分享，只替换本人先前单条分享的团队条目。
   - **团队标记**：客户端本机条目（按 `item_id`）上的标记，只由本人明确操作设定（例如“分享到团队”）；不进同步对象，不改对象标识，不作为内容同步。请求里以 `team_mark: true` 重申，服务器只接受带这个值的请求。不带标记或没连服务器的条目留在本机。
2. **默认同步方式不变**（能力 `first-sync-notice`）。同步状态 `personal-sync-state@1` 增加 `never_synced`：本账户的客户端在任何代次都没有上传、提交、中止会话或改过同步方式时为 `true`；控制台或 MCP 的写入不算。客户端（Circle 另行改动）首次连上时据此告诉用户个人内容会同步上去、随时可以改成仅本机。
3. **清除时一并清掉运行引用过的私人原文**。迁移 24 新增只追加的 `run_original_purges`，`run_originals` 改用专门的守卫：只有清除函数先记下清除后才能删除行。清除（切换到仅本机、删除成员）时，该代次私人原文中、为运行（运行本身、其断言、提交与结果）单独保存的副本一并清除；团队知识来源持有的副本照旧保留。引用过它们的运行，运行详情给出 `grounds_purged`，控制台运行页显示“根据不可用”和登记的原因 `GROUNDS_PURGED`。清除预检增加 `run_held_originals`（将清掉的副本数）和 `affected_runs`（受影响的运行数），两者进入预检摘要和清除记录；控制台确认文字写明。运行记录、采集记录及其摘要不改写。成员账户代次里的运行输入与冻结的包文件仍按 #139 保留。
4. **删除成员时私人工作流和技能转给管理员**：接收人是执行删除的管理员。删除检查逐版本列出移交结果（词表 `member_handover_status`）：“转移”“管理员已有相同版本”或“冲突”（管理员空间已有同号同版本而内容不同，或同号不同种类；不转移，随账户清除），并把这份清单计入检查状态。开始删除的同一事务里，按原清单、原文件和原检查报告在管理员个人空间追加版本记录，并追加 `personal_pack_transfer`（`from` 为被删成员）。分享不随之转移；依赖里写明了被删成员空间的技能不再能解析。管理员删除本人账户时不转移。删除对话框和主机命令列出接收人和每个版本的结果。

## 可改的路径

- `contracts/model.json`、`contracts/src/sync.ts`、`contracts/src/sharing.ts`、`contracts/generated/**`（只经生成）、`contracts/src/*.test.ts` 中的模型版本断言、`contracts/test-fixtures/sync/v1-capabilities/**`
- `packs/skill/{html,mindmap,workbook,xml}-format/pack.json` 与其 `functions/generated/protocol.ts`（只经生成）
- `hub/records/{migrations.ts,migrations.snapshot.test.ts,personal-sync.ts,personal-payloads.ts,member-deletions.ts,api.ts,personal-run-originals.test.ts}`
- `hub/knowledge/{spaces.ts,sharing.test.ts}`、`hub/knowledge/personal-sync/service.ts`
- `hub/runs/engine/{deps.ts,queries.ts}`、`hub/runs/packs/{personal.ts,member-deletion.test.ts}`、`hub/ports.ts`
- `hub/server/{personal-sync.ts,member-deletion.ts,cli.ts,text.ts,README.md,sync-rulings.test.ts}`、`hub/server/console/{personal-sync.ts,pages.ts,member-deletion.ts,member-deletion.test.ts,personal-origin.ts,space-records.ts,sharing-history.ts}`
- `hub/platform/ownership.test.ts`
- `tests/acceptance/{48-knowledge-console-memory,49-personal-sync,54-member-deletion}.test.ts`
- `docs/protocols/knowledge-sync-v1.md`、`docs/protocols/knowledge-sync-v1.zh-CN.md`、本页

## 验收

- ①②：`hub/server/sync-rulings.test.ts` 经真实 HTTP 核对发现文档、`never_synced`、仅本机模式下的单条分享（合并、回执、重放与键冲突、同一条目的新版本替换、不留个人副本）和拒收（引文不符、凭据、缺团队标记、多余对象、缺对象、代次变化）。
- ③：`hub/records/personal-run-originals.test.ts`（清除后副本消失、清除记录、记录行不改写、运行角色和表所有者都不能直接删除副本）、`hub/platform/ownership.test.ts`（备份恢复前后）、验收 49（预检数量、控制台确认文字、运行详情和运行页的“根据不可用”与原因）。
- ④：`hub/runs/packs/member-deletion.test.ts`（转移、冲突不转移、分享不随之转移、转移记录）、`hub/server/console/member-deletion.test.ts`（对话框接收人）、验收 54（对话框逐版本说明、删除后管理员可用、控制台工作流页可见）。
- 不在本任务：Circle 客户端的团队标记、首次提示和单条分享调用（Circle 仓库另开改动）；真实部署。
