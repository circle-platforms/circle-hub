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
