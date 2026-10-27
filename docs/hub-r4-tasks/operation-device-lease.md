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
