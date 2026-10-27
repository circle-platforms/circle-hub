# 任务：操作记录带设备与租约，设备上无租约的操作标"未授权"

依据：`docs/hub-r5-tests.md` T4-2（"操作记录带会话、设备、时间、原件"）、T4-3（"操作记录绑定租约"；"无租约操作 → 记录但标未授权"）；决定 73、74；`docs/hub-r5-test-map.md` 问题 12（本任务关掉它）。

现状（kimi 在 T5/T6 合成验收里查出）：B3、B4 交付的三种操作记录（`fed-observation@1`、`fed-procedure@1`、`fed-pitfall@1`）没有设备和租约字段；`hub/knowledge/feeding.ts` 的 `completeOperation` 只补对象、构建绑定、人、运行和时间；验收 43 号只能证明"租约 holder 与贡献指向同一运行"，不能证明记录绑定了租约。

## 要做的

1. **结构**：三种操作记录各加两个可选字段（在定义它们的契约文件里加；`contracts/generated` 只用 `npm run gen:contracts` 生成，并交出重新生成的文件）。
   - `device`：台架清单里的设备名（如 `apv0`），**客户端声明**，只是声明。
   - `lease`：**Hub 填**。记录者在采集该原件的时刻持有的、覆盖这台设备的租约键；没有则 `null`。
   - 与现有的 `binding`、`by`、`run`、`at`、`object` 一样，客户端提交里自带 `lease` 就整条拒绝，并写明"租约由 Hub 填写，删掉该字段后重交"。
2. **核对设备名**：运行绑定了台架清单（预订运行的清单摘要）时，`device` 必须是清单里的设备名，不在就拒绝并列出清单里的名字；运行没有绑定清单时只记声明，不拒绝。
3. **填租约**：`completeOperation` 里按记录者（原件的上传者）和原件的采集时刻，从租约记录里找他持有的、覆盖该设备的租约（租约取得、续租、释放、强制释放、接管都有记录，按时间重放；不要用"现在的租约表"推过去）。找到就把租约键写进 `lease`；找不到记 `null`。**只读租约记录，不改租约状态机。**
4. **无租约 → 标未授权，不拒绝**：声明了设备但 `lease` 为 `null` 的记录照常入层（它只是声明），但回执、`get_nodes` 的节点文本和 `list` 类显示都写"无租约（未授权）"，设备名和租约键（或这句话）一起显示；没有声明设备的记录不涉及租约，不显示这句话。Hub 管不了 Circle 自己的 SSH，所以只记录、只标注，**不阻止**操作。
5. **采集技能**：`operation-capture` 的提案加可选 `device`（字符串）；`SKILL.md`、`README` 写清：设备名取自台架清单，只是声明；租约由 Hub 填。B4 清单里已有的 `targets` 与此对齐，不另造第二套。
6. **版本和签名**：`knowledge-contribution` 升版本并重签，`CHANGELOG`/README 记一笔；`docs` 检查（清单摘要）通过。
7. **测试（全合成）**：
   - 声明设备 + 记录者当时持有覆盖该设备的租约 → `lease` 填上租约键，节点文本显示设备和租约键；
   - 声明设备 + 当时没有租约（租约已释放、或在采集之后才取得）→ `lease` 为 `null`，记录入层，显示"无租约（未授权）"；
   - 租约被别人接管后的采集、续租期内的采集（边界）；
   - 设备名不在清单 → 拒绝并列清单名；运行没绑清单 → 只记声明；
   - 客户端自带 `lease`/`device` 以外的 Hub 字段 → 拒绝；
   - 没声明设备的记录不显示租约相关文字；
   - 更新验收 43、44 号场景，**只做加法**（原有断言不放松），并把 `docs/hub-r5-test-map.md` 问题 12 改成已解决，写明改了什么。

## 分支、路径和规矩

- 分支和工作树：`operation-device-lease`，目录 `kimi-trees/operation-device-lease`（在主目录下，集成者已从 hub-redesign 开出，依赖已链接）。
- 可以改的路径：定义三种操作记录的契约文件及其重新生成的 `contracts/generated/**`；`hub/knowledge/feeding*.ts`、`hub/knowledge/operation-records*.ts`、读侧节点文本所在的文件及其测试；`packs/workflow/knowledge-contribution/**`；`tests/acceptance/` 的 43、44 号场景；`docs/hub-r5-test-map.md`。读租约记录要用到的 `hub/dispatch` 或租约模块只通过它们的 `api.ts` 调用，不改。别的路径要改先在回报里说明理由。
- 回执与列表必须携带同一状态，因此另允许：`contracts/src/validation.ts` 的结构化回执字段、`hub/knowledge/contributions.ts` 的索引与视图说明、`hub/runs/engine/submit.ts` 的回执填充和 `hub/server/text.ts` 的回执文本；不改它们的旧行为。
- 复核发现同字节多次采集会丢失具体采集时刻，因此另允许 `contracts/src/run.ts`、`contracts/src/tools.ts`、`hub/runs/engine/inputs.ts`、`hub/runs/engine/predecessor-defaults.ts` 与 `hub/server/tools.ts` 接通已有 `SourceBinding.artifact` 的可选输入/回执，及 `tests/acceptance/support/operation-acceptance.ts` 的对应夹具。普通 src 调用不变；旧采集清单缺 artifact 时明确拒绝新整合，不猜采集时刻。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰线上 Hub、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；`git commit -s`，只暂存明确的路径）。所有者的规矩：未知只能是过渡状态，写明缺的事实和下一步动作；不用关键词匹配做判断；枚举只来自 `contracts/generated`，不自造词（本任务不需要新词表项；如果你觉得需要，先报告，不要自己加）。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=2` 对你改的路径、`tests/acceptance/*.test.ts`、`.github/checks/*.test.ts`；合入前合并最新 hub-redesign 再跑一遍相关部分并报计数（按现行规则：新进提交没碰你的包时不必重跑无关全量）。

完成后在终端里回报：提交号、各项测试数量、改了哪些路径、没做完或拿不准的地方。

## 独立复核的九项处理

1. **连续区间**：采集时刻是客户端声明，Hub 收到时刻取原件记录 `created_at`。只有同一租约连续覆盖整段才填写；区间内取得、释放、接管、到期或历史不完整均写 `lease_unconfirmed`，不是确认有租约或无租约。上传链传 `captured_at`，不改写 Hub 的收到时刻。
2. **采集身份**：操作身份包含具体 `source.artifact`、`device`、`bed`；显式 `captured_at` 也进入上传去重键。不同采集或设备不得复用第一条记录，只有同一次采集的重复提交才幂等。原错误地复用无设备记录的测试期望已按此行为更正。
3. **完整床与设备**：`lease` 是 `bed/<床>/<设备>` 资源键，`lease_id` 另存 `lse_…`。清单唯一匹配可补床；不能从唯一持租候选反推床。缺床身份保留未确认原因和下一步。
4. **时间与损坏边界**：边界同毫秒、缺 `keys`、结构或时刻不一致均为未能确认。租约动作记录使用租约服务自身时钟；只读查询不修改租约状态机。缺 `keys` 的历史不能被精确键过滤吞掉。
5. **两侧脱敏**：Circle 提案在 `start_run` 前扫描 `device`、`bed`；Hub 在原始 submission 持久化前用现有 `credential-scan@2` 检查三种操作结构的新字段。扫描不靠产品或敏感词名单。
6. **两个租约身份**：回执、节点和列表同时显示资源键与记录身份；关联索引使用 `lease_id`。旧的无设备路径不增加这些字段。
7. **有界历史**：`LeaseService.history` 只取窗口前最近一条和窗口内有界记录，另有上限和缺 `keys` 检查。新动作按 `lease.key` 索引，旧动作按记录内容回退；3000 条历史的测试直接断言不全量加载。
8. **冻结旧包**：从提交 `886d9f4c8a04630fcb70257becbec0589684500c` 提取 `knowledge-contribution@1.3.0` 作为测试夹具，断言运行锁其清单摘要；无设备/租约字段的旧提交、读取和重复回执保持不变。
9. **声明级边界**：端到端复现证实 `client_captured` 上传可被另一工作流当作 `src:` 输入。现在非回注工作流在输入绑定边界拒绝这类 `src:` 与 `rec:` 来源，测试使用真实的 case-review 调用链；不扩大为其他通用判断改写。

## 本轮新增路径及理由

- `contracts/model.json` 与生成文件：三种操作结构是模型中的正式形状，补 `bed`、`lease_id`、`lease_unconfirmed` 并重新定义 `lease` 为资源键；没有新增枚举。
- `hub/leases/service.ts`、`hub/leases/history.test.ts`：按精确设备键和时间窗口只读历史，动作时钟与资源键索引必须在这里产生。
- `hub/records/artifacts.ts` 及测试：显式采集时刻是采集身份的一部分，不能在底层上传去重时丢失。
- `hub/knowledge/context.ts`、`service.ts`、`declaration-grade.ts`：注入只读租约端口，并在提交边界复用现有扫描器。
- `hub/server/assemble/hub.ts`：创建知识服务前接入同一个 LeaseService。
- `hub/runs/engine/inputs.ts`、`tests/acceptance/45-r5-capture-boundary.test.ts`：关闭复核发现的跨工作流声明级输入通道。
- `tests/acceptance/43-r5-t4-3-change.test.ts`：既有场景只做资源键与记录身份的加法；44 号没有设备声明的旧断言保持。

包版本为 `knowledge-contribution@1.3.3`。全部验证仍只使用合成数据、回环服务与临时 PostgreSQL；不证明真实设备上的授权效果，也不合入或推送本分支。

## 第二轮独立复核处理

1. 原件新增可选 `captured_at_declared`，仅上传方显式提供 `captured_at` 时为真；普通上传与历史记录仍可缺少该字段。缺声明的设备记录保留，租约未知并给出重新采集上传的出口。其他持有人的租约到期也先判区间变化，不能提前判无租约。
2. `completeOperation` 先核定原件，再把其 `artifact` 与完整床/设备放入身份计算；省略可选字段和清单推导床身份均有同字节反例与同次幂等测试。
3. 非字符串目标在原始提交前拒绝；Hub 扫描用索引迭代代替展开 push，限制 1024 层和 20 万节点，18 万项不再抛 RangeError。Circle 另按当前令牌文件精确拒绝裸 token；敏感值不写错误或日志。
4. 收到后、提交前释放/接管/回收/批量强制释放的旧场景已补回：变化在 Hub 收到之后，不推翻已完成的连续区间证明。收到之前的区间变化仍标未知。
5. 规模测试改为真实数据库 `query` 调用与返回行数，覆盖 3000 条旧索引历史、精确设备键和 32 行截断；不再统计未使用的 `findMany`。这里证明的是实际查询次数和返回规模，不把静态 SQL 文本当成业务正确性。
6. `operation-records-upgrade.test.ts` 由冻结 Hub 代码持久化旧运行与回执，再由当前代码读取和重放，不调用升级后的 `start_run`；运行集合、结果集合和回注视图保持不变。`45-r5-capture-boundary.test.ts` 另持久化已绑定捕获原件的旧普通运行，验证提交拒绝。`submit.ts` 在新提交求值前按实际 artifact 出处执行同一边界，含无固定 artifact 的历史绑定；`evaluate.ts`、`exact.ts` 同时核对 `src:` 及树片段的底层出处，回注包自身豁免。
7. 包升为 `knowledge-contribution@1.3.4` 并重签。新增 `declaration-grade.test.ts` 覆盖宽度、深度和非字符串，现有签名检查继续覆盖包内脚本及安装文件。

## 第三轮独立复核处理

1. **声明级预取与旧来源**：`exact.ts` 预取命中只在非 grounds 使用时直接返回，作为根据始终重新核权；`exact.ts`、`evaluate.ts` 对缺 artifact 的旧绑定通过实际原件读取确定出处。`captured-ground.test.ts` 分别验证预取后作根据仍拒绝，以及 evaluate 对旧绑定缺记录号的拒绝。
2. **令牌任意子串与轮换**：device/bed 任一位置包含当前令牌都拒绝，`start_run`、`submit_result` 前重新读取令牌文件。测试覆盖前后缀、大小写变体及轮换后已开运行的再次拒绝；错误输出不含令牌。
3. **采集时间表达与出口**：缺声明时操作记录省略 `at`，另存 `received_at` 和 `captured_at_declared=false`，有设备的读侧说明「采集时间未声明（取自上传时刻）」；无设备旧文本与冻结旧记录不变。同元数据旧记录保持幂等且来源未知，带新采集时刻的新原件获得新身份，不回填历史。
4. **租约时间与可见性**：`#change` 在行锁取得后取动作时间。`time-order.test.ts` 用 gated 事务证明先锁后取时，晚提交动作不会倒填较早历史。
5. **内存与历史规模**：扫描遍历字段时先计宽度，不再先 `Object.entries` 展开父容器；深度上限 1024、总节点上限 20 万保持不变。历史测试旁路执行 EXPLAIN ANALYZE，断言 6 次实际查询和 6 份计划、有限返回行及过滤行数，不再把未调用的接口当扫描证据。
6. 包升为 `knowledge-contribution@1.3.5` 并重签。真实全量未完成前不宣称全绿，也不合入主线。

## WIP 交接（2026-10-27）

按所有者要求停止最终全量，合并 `hub-redesign@768ff328`；自动合并无冲突，保留主线树苗优先的根解析和本分支租约接线。四个复核点均有实现及定向反例，但独立复核尚未确认关闭，仍按 GitHub issue 的已知阻断交接。`LeaseService.#change` 的锁顺序反例不宣称证明所有租约调用方无并发风险。交接版包升至 `knowledge-contribution@1.3.6` 并重签，仅补 README 的 WIP 边界；最终全量不再运行，不能把定向通过解释为全量全绿。
