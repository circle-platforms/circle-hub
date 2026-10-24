# 任务：引擎：每个未知进回执、有出口；轮数用完、跳过、到期都交给人

依据：

- 所有者 2026-10-23 的规矩：未知只是过渡状态，要写明缺哪个事实、取得它的下一步动作、由谁做、何时到期；流程自动执行这一步，或者写成请求交给具名的人。以未知结束的运行、报告或检查都是缺陷。
- 全量普查 `docs/hub-r4-research/unknown-sweep.md`：第 2 节缺陷、第 3 节设计缺口、第 4.2 节缺的动作、第 5.2 节数据缺口。下面各条写了位置和要改的模型元素，动手前先读普查里同一处的真实影响。
- 理论文档 `docs/design/truth-docked-architecture.md`；模型用 `node tools/show-element.ts <元素>` 读。

- 分支和工作树：`hub-unknown-exits`，目录 `circle-hub-unknown-exits`。等这一批（K2、core-fixes、views-and-notes、kb-sections、hub-job-dispatch 等）合并以后，由集成者从 hub-redesign 开出并通知。
- 范围（普查拟定，集成者照当时合并后的代码再核一遍）：依赖 hub-unknown-model 的契约字段。可以改：hub/runs/engine/terminals.ts、partitions.ts、submit.ts、queries.ts、start.ts（期限与启动时拒绝的一段）、evaluate.ts（路由与 errors 一段，约 600-725 行）、README.md；新增请求记录的写入与列出（其余几件用它）；hub/rules/check.ts 的 outcomeProblems；hub/runs/packs/validate.ts；hub/server/console/pages.ts；对应测试。evaluate.ts 的检查调用与来源读取一段归 hub-retry-split。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后，地址只用 192.0.2.0/24 和 2001:db8::/32；`git commit -s`）。枚举只来自生成的词表；Hub 只核验，不生成内容。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=1` 对改到的目录；每条先写改前失败、改后通过的测试。

## 要做的

1. 在 BY_REASON 旁加出口表（satisfies Record<Reason, Exit>），每个未核对、未完成、未运行终态带 missing 和 exit；交付前边界拒绝没有出口的未知；outcomeProblems 拒收不带顶层 missing 的包未知。
2. errors 点名每个未知（路径、缺什么、剩余轮数）并计一轮；错误表按原因的行可路由；缺的事实归到待判定产物上时给修复（case-review 负向用例那 33 个条目是第一个用例）。
3. 跳过：每个跳过条目一条错误（带模型的理由和剩余轮数）并计轮；SkippedItem.reason 进结果的未完成分区（W07 R[2] 的“附理由”）。
4. 轮数用完：写 B07 修复请求记录（运行、条目、要求项、领头的码），在 errors 和控制台列出；回执写明完整的新提交仍可取代；剩 0 轮的未覆盖改记修复轮数用完；“发请求”行写请求记录，“记未知”行写假设集（V08）并点名。
5. 运行期限：过期仍无已受理提交的运行，交付为全部条目未完成（提交未覆盖），给运行者发处置请求（以本运行为前驱续跑 / 放弃）；list_runs 和控制台列出未收口的运行与未回答的请求。
6. 内部失败也写校验动作（受理为空、内部码、重试提示）；getRun 显示“未校验（中断）”；启动时和定时重验孤儿提交。
7. 终态映射：装了检查却对条目零结果记未核对（检查出错，包缺陷）；出件失败后动态层记未运行（出件失败）；层上保留每个不同原因及其缺的事实；依赖被路由修复的要求项记“在等某一步”并指向那条修复。
8. 发布：声明的静态层没有检查即拒（requirements.no_check）；start_run：执行 knowledge.json 的 requires（拒绝并列出可选构建），声明有误的包拒绝并给包作者发修复请求；修好的版本发布后，提示运行者以原运行为前驱重跑；模型驱动的运行在根更新后给运行者发重跑请求；只保留来源上的引文给管理员发接受请求。
9. 控制台：产品页、差异页、运行页按已有游标翻页，截断处写明（pages.ts:257、397-408、476-477）。
10. hub-job-dispatch 合并后：把派发结局接进动态层终态和已隔离分区，自动发起核对；过去的结局仍观察不到时重证基线、以新修订重跑用例。

## 决定 35 加的

依据：决定 35 第 23、24 项（`docs/hub-r4-progress.md`）；普查 5.1 第 1、2 条；A04 R[3]、R[5]，W06 F[10]，W07 R[2]–R[3]，T03 R[3]；引擎 README（`hub/runs/engine/README.md`）的 Deviations 第二条和开放问题 1、3、4。

- 模型文字由集成者改：A04 R[5] 和 T03 R[3]（要求独立判断的运行，不带会话 id 的开始和提交整份不受理；被判工作那一侧有不带会话 id 的，开始也不受理）；W07 R[2]–R[3]（只接受事实的要求项用 Hub 自己算出的终态）。
- 这两条在上面的范围之外加两处路径：`hub/runs/engine/lineage.ts`（列出缺会话 id 的是哪几份）；`tests/acceptance/oracle/**`（W07 的规则在那里也写了一遍）。同一批写的 share-production-results 也改 `start.ts` 核对前驱的那一处，集成者排先后。行号照现在的写，合并以后以函数为准。

11. **要求独立复核的提交不带会话 id 就拒收**（第 23 项）。“要求独立”指运行冻结的要求项里有独立判断（`independent_of`），现有的包里是 case-review-verify 的 verification 和 final。
    - submit_result 没带 `Circle-Session-Id`（`sessionOf(call)` 为 null）就整份不受理：SUBMISSION_SCHEMA_VIOLATION，path 为空串，修正说明写“在请求头 Circle-Session-Id 里带上本会话的 id（1 到 200 个可打印 ASCII 字符），把同一份提交原样再交”。提交和回执照常存下；其余条目照 W08 R[1] 照常核对，原因一次给全。带上以后原样重交会重新核验：`resultForObserver`（submit.ts 67 行）按会话和模型区分，拿不回这次的拒收。
    - 不计修复轮，要在记录上分开：
      - 按引擎 README 的决定 15，一份被拒的提交里转去修复的驳回算一轮；`submit.ts` 的 `roundsUsedOf`（84–95 行）又在第一次见到某个提交摘要时把它记成见过，后来同一摘要的动作的修复键就跳过了。照现在的写法，这次拒收要么白占一轮，要么让带上会话 id 原样重交的那一份白得一轮。
      - 做法：这次拒收的 validate 动作写 `detail.refusal: "session_missing"`，不带 `repair`；`roundsUsedOf` 跳过这种动作，也不把它的摘要记成见过。
      - 测试：先拒收；再带上会话 id 原样重交，里面有一条转去修复的驳回；再下一份提交的 `rounds_left` 正好少一。
    - start_run 同样拒绝，放在 startFresh 里、绑定输入之前（约 455 行以前），不放进 `checkLineage`：`checkLineage` 只在有前驱时才调，没有独立要求项的包又立刻返回，放进去的话没有前驱的开始就漏过去了。只要包里有独立要求项，有没有前驱都核。运行的开始会话也算生产者（submit.ts 387 行的 `origin.sessions`），开始时缺了，之后每份提交的独立性都定不了。
    - 要求独立判断、又有前驱的运行开始时，被判工作那一侧（`lineage.ts` 的 `authorOriginOf` 找到的运行和它们已受理的提交）有没带会话 id 的，也拒绝：修正说明列出是哪几份；下一步是带上会话 id、以它为前驱开新修订重新提交，再对新修订开运行。这一条以前已经开出来的运行，独立性照记未知，missing 写缺会话 id 的是哪几份，出口是同一个下一步。
    - README 的开放问题改写：1 已经由草稿包回答（case-review 的 findings 是判断）；4 的模型族规则不变；3 见下一条。
    - 测试：
      - 要求独立的包，提交缺会话 id：被拒，有修正说明，回执已存，不计轮，带上以后受理；
      - 开始缺会话 id：被拒，有修正说明。开始的拒绝什么都不存（核对在绑定输入之前，D05 的回执只给提交、上传和效果写），只断言拒绝、修正说明和调用日志；
      - 没有前驱的开始缺会话 id 也被拒；
      - 被判工作那一侧缺会话 id 时开始被拒，列出是哪几份；
      - 不要求独立的包不受影响；
      - `verify.test.ts` 158 行“没观察到会话，独立性未知”那条改成拒收。
12. **跳过或未覆盖的条目上，事实要求项用 Hub 自己算出的终态**（第 24 项）。
    - evaluate.ts 624 行的 `handling`：只接受事实、检查都不判待判定产物（不在 206 行的 `artifactRequirements` 里）的要求项，跳过和未覆盖都给 null，用检查自己的终态。现在跳过的一律记未完成（declared_skip），未覆盖的在有判断的包里也记未完成。
    - 判待判定产物的事实要求项照旧记未完成：条目没交产物，没有东西可判，这就是 Hub 算出的终态。接受判断的要求项照旧。
    - 分区照 V05 R[3]：还有必需要求项未完成的进未完成，其余照终态交付；跳过的理由照第 3 条进结果。
    - README 的 Deviations 第二条照这一条改写：它说只有判断类的记未完成，代码从 bca2dbe 起事实类也记了，两边一直对不上。
    - oracle（`tests/acceptance/oracle/oracle.ts` 286–287 行）同步改，差分测试照新规则。
    - 测试：只判被判对象的事实要求项，在跳过和未覆盖的条目上各给出通过和不通过；判待判定产物的照旧未完成；只出事实的包里声明跳过的条目照样交付。

## 集成者答复（2026-10-24 凌晨）

- **05:28 的契约口径；06:35 答 codex-b**：unknown 的缺失事实写**顶层 `missing`**；check-outcome 的 `exit` 可由 Hub 按原因补，新写的 `LayerResult` 则须有 missing 和完整出口。可改 `hub/rules/outcome.ts` 的 `unknown()`，把 detail 写进顶层 missing；旧结果缺出口只显示“出口未写”。
- **06:06，可改路径补充**：`hub/runs/engine/service.ts`、`deps.ts`、`api.ts`、`store.ts`、`hub/ports.ts` 及 Hub 启停生命周期的最小接线，用于请求列出、期限、孤儿重验、已有派发核对；包注册表可加 `ownerOf(digest)` 读取包主人，账号表可取具名管理员。只接本页流程，不借机改其他运行行为。
- **06:17**：分区不改，gaps 的未知另计“带未决未知”数（可选字段或 Needs），不改 `isUnknownTerminal`。依赖只认 `Claim.validity.premises` 的显式路径：依赖层记 `awaiting_step`，missing 点明要求项和修复路径，继承该修复的具名出口，不从正文猜依赖。
- **06:24，第 10 条**：可在 `hub/dispatch/**` 加按运行读取既有 journal 绑定、结果引用的只读函数，在 `api.ts` 导出并测试；不改派发、重发或核对行为。
- **07:00，发布作答**：可改 `hub/server/cli-admin.ts` 的 pack publish 接线、包注册表和对应测试，加可重复的 `--answer-request <请求摘要>`。注册表核对请求绑定的包与具名作者，发布成功后只按实际 `pack_version` 记录作答。
- **07:26，读取归属**：可改服务端与运行读取器（`hub/server/readers.ts`、`hub/runs/engine/readers.ts`）识别 request 和 `hypothesis-set@1` 的所属运行，沿用运行可见性，不给新记录另开可见范围。
- **07:26、07:59，放弃运行**：授权 `circle-hub run abandon <run> --answer-request <摘要> --reason <理由>` 的 CLI、运行服务及测试接线；仅运行者本人或管理员、持有效操作令牌可作出。只追加处置与新的交付结果，要求项标已放弃；保留原层终态和未知计数。新管理投影注明“旧技术记录未写、此次未重验”，出口引用本次真实处置请求的受众和期限，原件仍显示“出口未写”。旧结果、远端和冻结不改，不加 MCP 工具。
- **07:59，模型负责人授权**：动态 `fail` 的 `code` 可选；登记 `EFFECT_UNKNOWN_DISPOSED`、`RUN_ABANDONED` 两个协议码，模型协议码源、变更记录、相关契约和生成物可作这一处最小修改并加测试。前者是效果原结局未证明时的具名标记失败处置、归已拒收；后者是已放弃运行的新提交原样保存但不受理，继续须开新修订。用途、受众、下一步与不改写技术事实的边界见[决定 45](../hub-r4-progress.md)。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
