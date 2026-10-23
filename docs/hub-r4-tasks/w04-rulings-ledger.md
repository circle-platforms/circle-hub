# 任务：判定形状与判定台账（W04）：运行内的表按台账判，台账以外的形状记“判断（判定形状未裁定）”

依据：

- 决定 35 第 13、16 项（`docs/hub-r4-progress.md`）：W04（判定台账）要做。
- 模型：W04 R[0]–R[3]；P03（第 3 步，定判定形状）；B07 R[8]（运行时不发“裁定”请求，台账以外的形状由包作者在下一版裁定）；W02 F[3]（表是否可由运行内检查提供）、R[3]（运行内检查只能判定声明了这一点的要求项，不能替换或放宽模板里的检查）；W07 F[4]；C05 R[5]（运行内检查的准入）；V01 R[7]（“运行内检查@摘要”）；V02 R[2]（要求事实的要求项不接受判断）；T02 R[2]、R[4]；P10 DEF（裁定进台账）。用 `node tools/show-element.ts W04 P03 B07 W02 W07 C05 V01 V02 T02 P10` 读。
- 对照模型的复核 `docs/hub-r4-model-review.md` 第 2 节第 4 条：没有台账；不认识的解释器在发布时整份拒绝（`hub/runs/packs/validate.ts` 292 行 `checks.interpreter_missing`），运行中没有“未裁定的形状”这条路。合约 README 决定 8：运行内检查不在提交的形状里。
- 架构第 1 节说这一里程碑各包的判定形状都是固定的；决定 35 改成要做。

这里说的判定形状，就是一个要求项由什么判定：核心解释器@版本加一张表，包内检查函数，或者交给判断。模板里的检查随发布裁定（新版本只能由包的所有者发布，T02 R[4]）。台账另列包作者裁定过、允许在运行中带表来判的形状：哪个要求项可以用哪个解释器。W04 R[3] 读作：台账里列了的通用检查，带上运行内的表还是这个形状，表只是数据。

- 集成者先做（模型文字归集成者），开分支前提交：限定标记加一个值，标签用 W04 R[1] 的原文“判定形状未裁定”，码由集成者定；格式提案的包文件加 `ledger.json`（台账，W04），生成的 `PACK_FILE_PATHS` 跟着变；W04 的变更记录写决定 35；架构第 1 节那句。
- 分支和工作树：`w04-rulings-ledger`，目录 `circle-hub-w04-rulings-ledger`，从 hub-redesign 开出。
  - 等这些合并以后，由集成者开出并通知：`d03-p11-boundary`（同改 `contracts/src/pack.ts`、`hub/runs/packs/validate.ts`）；同一批写的 test-bed-ownership（`pack.ts`、`evaluate.ts`、`cli-admin.ts`）；`local-tools`（`script-distribution.md`，改 `validate.ts`）。
  - `hub/server/text.ts` 别的几件也在改，段落不同，按合并的先后对齐，不用等。
  - `w10-criterion-change` 同改 `contracts/src/submission.ts` 和 `submit.ts`，排在这一件后面。
- 可以改的路径（行号照现在的写，合并以后以函数为准）：
  - `contracts/src/pack.ts`（ledger@1，RequirementTemplate 的 `run_table`）、`contracts/src/submission.ts`（提交里的运行内检查）、`contracts/src/run.ts`（RequirementSummary 带出由谁判）、`contracts/README.md`（决定 8 里运行内检查那半句），照生成器重新生成 `contracts/generated/**`；
  - `hub/ports.ts`（LoadedWorkflow 带台账）、`hub/runs/packs/load.ts`、`validate.ts`；
  - `hub/runs/packs/ports.ts`：只改 `packSummary`；`hub/runs/engine/start.ts`：只改 `requirementSummary`。两处都把载入的台账传进去（第 2 条）；
  - `hub/runs/engine/submit.ts`（准入）、`evaluate.ts`（跑检查的那一段）、`terminals.ts`（判断不满足只收事实的要求项）、`claims.ts`（规则的写法、限定和判别力）、`lineage.ts`、`queries.ts`（第 7 条的查询）、`README.md`；
  - `hub/server/text.ts`（开始运行的答复写出由谁判）、`cli-admin.ts` 的 `pack` 命令加 `shapes`；
  - 对应的测试。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后，地址只用 192.0.2.0/24 和 2001:db8::/32；`git commit -s`）。所有者的规矩：
  - 未知只是过渡状态，写明缺的事实和下一步动作；
  - 枚举只来自生成的词表；
  - Hub 只核验，不生成内容，不调用模型：运行内的表是提交带来的声明，Hub 只用核心解释器跑它；
  - 核心里没有产品的字。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=1` 对 `contracts/**`、`hub/runs/**`、`hub/server/**`、`packs/**`（已发布的包不改照样过）。每条先写改前失败、改后通过的测试。

## 要做的

1. **台账**（W04 DEF、R[2]）：
   - 包文件 `ledger.json`（`ledger@1`，可选），每条一个已裁定的形状：要求项、解释器@版本、裁定于哪一版，可选的 `from`（让作者看见它的那次运行，`rec:` 引用）。
   - 发布校验：要求项存在，并声明了 `run_table: true`（W02 F[3]）；解释器已安装；同一形状不重复。声明了 `run_table` 却一条台账都没有的要求项给警告：它带来的表都会是未裁定。没有 ledger.json 的包和现在一样。
   - 测试：发布规则逐条正反例；现有的包不改，照样发布、照样读。
2. **开始运行时写出由谁判**（R[0]、P03）：
   - 要求项摘要加两个字段：这一项的规则@版本列表；可以带运行内的表时，台账里允许的解释器。答复文字照写。这样模型不为 Hub 按规则判的要求项写判断。
   - 摘要有两处在拼：`start.ts` 的 `requirementSummary`（start_run 的答复，也给 `hub/runs/engine/testing/workflows.ts` 用），和 `hub/runs/packs/ports.ts` 的 `packSummary`（list_task_packs）。`requirementSummary` 现在只拿到模板，两处都改成也拿载入的台账。
   - 两个字段都必填，没有就是空列表，两处都要填。
   - 测试：合约字段；两处给出的字段相同；`text.test.ts` 一条。
3. **运行内检查随提交交来**（W07 F[4]、C05 R[5]、W02 R[3]）：
   - 提交加可选的 `checks`，每项：要求项、解释器@版本、表（内联 JSON）、样例。来源类型是声明。
   - 样例指向本运行的条目：正例写一个检查应当支持的条目，反例写一个应当反驳的条目，各带期望（照 pack-sample@1 的 `expect`）。被判对象由 Hub 照默认的写法从条目构建，模型不写。
   - 只能加给声明了 `run_table` 的要求项，是多加一个检查，不替换、不放宽模板里的；加给别的要求项，整份不受理（SUBMISSION_SCHEMA_VIOLATION，指到那一项，T03 R[3]）。形状在台账里的，表还要合解释器的格式，不合同样整份不受理。
   - 测试：结构不对；要求项不允许；表的格式不对；样例指向不存在的条目；正常的受理。
4. **准入**（C05 R[5]）：
   - 形状在台账里的，Hub 在边界用同一个解释器跑样例：正例要支持，反例要反驳。
   - 至少一个样例来自作者之外：条目所在的源文件出自读取动作（外部系统），或由运行者以外的账号上传；运行者自己上传的算作者样例（B02 F[1]、F[2]）。
   - 准入记在这份提交自己的 `validate` 动作里，不另写一条：`detail.admission: [{requirement, interpreter, table_sha256, samples: [{item, expect, source_provenance, outcome}]}]`。
     - 原因：另写一条 validate 动作，会弄坏两处读全部 validate 动作的代码。一处是 `lineage.ts` 的 `authorOriginOf`：一条不带会话和模型的已受理动作，会让作者来源不完整，之后判这条血缘的独立运行全成独立性未知。另一处是 `submit.ts` 的 `roundsUsedOf`：同一提交摘要先见到的那条动作把摘要记成见过，真正校验的那条的修复键就被跳过了。
   - 测试：
     - 全过；正例没支持；反例没反驳；只有作者样例；
     - 一份带准入运行内检查的草稿，被 case-review-verify 复核时，独立性照样判得出；
     - 修复轮数照样正确。
5. **评估**：
   - 准入了的运行内检查和模板的检查一起跑，结论的规则写“运行内检查@<表的 sha256>”，只对本次运行成立（V01 R[7]）。
   - 只有作者样例或没准入的，结论加限定标记“以判断为前提”（`conditional_on_judgment`，C05 R[5]）。
   - 判别力（V01 F[0]、R[7]：判别力引用准入时的对照样例）：
     - 有作者以外样例、又准入了的，判别力记已确立，并引用这份提交的准入；
     - 别的记 `discrimination_not_established`。
     - 要求项声明了 `requires_discrimination` 的，后一种照它的规则不满足。
   - 测试：两种结论的字段；判别力两种各一；同一张表在别的运行里不算数。
6. **台账以外的形状**（R[1]、B07 R[8]）：
   - 运行内检查的解释器不在这个要求项的台账里：Hub 不跑它，运行不停；相关要求项记“判断”，加限定标记“判定形状未裁定”。模板检查给出的不通过、未完成、未核对照旧排在前面（V03 R[3] 的次序）。不发裁定请求。
   - 这个形状存成一条跨条目主张：限定标记是“判定形状未裁定”，data 是 `{requirement, interpreter}`。结果里照这条列出。
   - 只接受事实的要求项不收判断（V02 R[2]）：终态照记判断，满足状态记未满足（终态不符合期望）。现在 `meets()`（terminals.ts 271–280 行）让判断满足任何“支持”的期望，要分开。
   - 测试：未裁定形状的终态、限定和满足状态；模板检查照样跑出的事实不受影响。
7. **给包作者看**（R[2]）：
   - 管理员命令 `circle-hub pack shapes <任务包>`，列出这个包各版本运行里出现过的未裁定形状：要求项、解释器、次数、最近一次运行号，不带表的内容。
   - 读法：`queries.ts` 加一个只给管理员的查询，按运行锁定的包（`locks.pack`）找校验结果里第 6 条那种跨条目主张。
   - 作者把它写进下一版的 ledger.json，发布校验通过才生效。
   - 测试：命令输出；没有时写“没有未裁定的形状”；非管理员被拒。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
