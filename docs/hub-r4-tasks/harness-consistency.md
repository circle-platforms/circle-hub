# 任务：按通用 harness 方式修正运行答复、维护、动态结论、读取复用与名字纠错

## 来源与基线

- 所有者 2026-11-15 给出的第 25～29 项：同一句话在一次答复里重复；每分钟维护多写记录；上机结论没有进入要求项；每个作业重复全部设备读取；`start_run` 的名字错误不直接给可用名字。目标和通用 harness 一致，同时适配现有 Hub。
- 基线 `origin/main` 的 `b90b04f6e8`。决定 136②、145 已把公开 `main` 定为唯一代码线并封存旧生产线；根 `AGENTS.md` 第 11 行仍写 `hub-redesign`，属于未同步的旧说明，本任务不扩大范围改它，交集成者另行同步。
- 分支 `wp/kimi/harness-consistency`，独立工作树；只作本机签署提交，不推送、不建 PR、不部署，不触碰真实系统或设备。

## 调研与适配决定

- [OpenAI Agents SDK 的结果与恢复](https://openai.github.io/openai-agents-python/results/)按“已拥有的那一次出现”防止重放重复追加，不按内容删掉本来不同的消息。Hub 同样只对同一结果出现、同一派发进展或同一修复说明在渲染层去重；不同条目、不同作业及 `structuredContent` 的原始事实不删。
- [LangGraph 的故障恢复](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance)要求稳定幂等键、恢复时跳过已完成单元、只重试可重试失败。Hub 维护轮继续以追加游标和到期计划驱动，稳定后不得因自己的写入反复产生新记录；真实故障的有限恢复不变。
- [Anthropic 的长运行 harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)要求端到端验证后更新要求状态，不能只写进展总结。Hub 已有 `dispatch@1` 动态层汇总，本任务把实际可派发包的要求项接入该层，不在 Hub 增加模型或生成结论。
- 通用执行器复用已完成且可核验的读取，但必须绑定输入身份。适配为：预订观察只在同一运行血缘、同一执行器定义与清单、同一设备集合且 Hub 围栏未变时作为基线复用；复用必须留下原观察引用，缺失或不匹配就回退到现有的完整只读预检。远端租约、最终围栏、前状态、请求查空、输入重新核验和效果边界仍逐作业执行，不把旧观察冒充当前设备事实。
- [MCP 工具错误](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)应给模型可自我纠正的反馈。未知工作流名直接在原错误中列出当前调用者可见的少量名字，近似名字用有界编辑距离只在唯一高置信匹配时优先；权限隐藏规则不变，绝不列出他人的私人包。

## 可改路径

- `docs/hub-r4-tasks/harness-consistency.md`
- `docs/compatibility.md`
- `docs/compatibility.en.md`
- `hub/runs/**`
- `hub/dispatch/**`
- `hub/server/**`
- `packs/workflow/case-compile/**`
- `packs/workflow/bed-install/**`
- `packs/workflow/test-bed/**`
- `tests/acceptance/**`
- `tests/fixtures/**`（仅现有包版本或验收确实需要的合成夹具）

不新增依赖，不改合约模型、记录迁移、生成词表、Circle、`foundation/` 或 `references/`。若实现证明必须改这些范围，先停下并在本页记录，不擅自扩大。

## 验收目标

1. 同一结果出现或同一派发下一步在一次文本答复中只说一次；不同条目的同文本发现仍各留一次，结构化回答逐字节保持原有事实。
2. 增量维护在首轮吸收既有工作以后，无输入变化、无到期事项的连续两轮新增业务记录为零；新增派发事件、到期和故障恢复仍会被处理。
3. 可派发要求项声明并产生 `dynamic` 层；相同静态提交在派发前后给出可区分的动态终态、要求项状态和汇总；不通过不冒充通过，未知不冒充失败。
4. 合成“预订后连续两个作业”按读取调用计数证明复用，且定义、设备、血缘或围栏变化会重新完整读取；没有真实设备访问。
5. 名字拼错在第一次 `start_run` 错误文本与结构化 `fix` 中给出可见正确名字；无匹配给完整短名单，越权和他人私人包仍保持中性。
6. 每条先补能复现旧行为的失败测试，再修实现；运行类型、合约、受影响包和跨包验收，记录实际通过、失败与跳过，不把未运行说成通过。

## 验证记录

均使用 Node 24.17、临时 PostgreSQL、回环桩和合成夹具；没有真实设备、真实业务系统、模型密钥或部署访问。

- `npx tsc --noEmit`：通过。
- `npm run verify:contracts`：185 个生成文件与模型一致。
- `npm run test:docs`：392 项通过，0 失败、0 跳过。
- `node tools/prepare-packs.ts packs/workflow/case-compile packs/workflow/bed-install`：两个包清单重新生成成功；随后包清单与发布检查通过。
- `node --test --test-concurrency=1 hub/server/text.test.ts hub/dispatch/accepted.test.ts hub/dispatch/note-dedup.test.ts hub/dispatch/device-observations.test.ts hub/dispatch/effect-integration.test.ts hub/runs/engine/start.test.ts hub/runs/engine/maintenance-pass.test.ts hub/runs/engine/maintenance-incremental.test.ts hub/runs/engine/dispatch-results.test.ts`：158 项通过，0 失败、0 跳过。覆盖共享答复去重、名称纠错、稳定维护幂等、动态汇总、完整复用和失效回退。
- `node --test hub/runs/engine/dispatch-results.test.ts`：3 项通过，直接比较派发前后汇总。
- `node --test hub/dispatch/accepted.test.ts hub/dispatch/note-dedup.test.ts`：14 项通过。
- `node --test hub/dispatch/device-observations.test.ts`：5 项通过；两轮只发两次实际效果，设备探针调用为 0，定义变化后完整读取为 4 次。
- `node --test --test-name-pattern='unchanged source recovery|held source request' hub/runs/engine/maintenance-incremental.test.ts`：2 项通过；同一恢复不再每轮追加，新采集证据可触发有界新尝试。
- `node --test --test-name-pattern='misspelled pack|unknown pack' hub/runs/engine/start.test.ts`：2 项通过。
- `node --test --test-name-pattern='dynamic requirement opens|dynamic-only requirement' hub/dispatch/effect-integration.test.ts`：2 项通过；静态通过可首开，动态-only 不能首开，动态结果决定后续放行。
- `node --test packs/workflow/case-compile/tools/scripts.test.ts`：13 项通过；客户端只放行生成前缺输入和动态待上机，其他错误仍拒绝。
- `node --test --test-concurrency=1 packs/workflow/case-compile/pack.test.ts packs/workflow/case-compile/publish.test.ts packs/workflow/bed-install/pack.test.ts`：17 项通过，含发布作者样例和暂存包校验。
- 完整派发组 `node --test --test-concurrency=1 "hub/dispatch/**/*.test.ts"`：402/404 通过；两个要求重复“下一步”的旧断言按新目标修正后，`accepted.test.ts` 与去重专项 14 项复查通过。
- 完整包组 `node --test --test-concurrency=1 "packs/workflow/case-compile/**/*.test.ts" "packs/workflow/bed-install/**/*.test.ts"`：586 项中 580 通过、6 失败、0 跳过。6 项均为下方基线也复现的 xlsx 沙箱 `ERR_ACCESS_DENIED`，没有将失败计为通过。

### 基线已有、未归入本次通过项的问题

- 设备验收 `tests/acceptance/28-device-run.test.ts` 与 `58-bed-install.test.ts` 在本机进入构建站索引时返回 `SOURCE_MALFORMED`，没有生成知识根，场景因此失败或取消。原基线工作树 `b90b04f6e8` 的 58 场景单独复跑也因缺少同一构建根失败，所以不是本次动态层引入；没有改连接器或构建站夹具来掩盖。
- 包组的 xlsx 解析路径在本机沙箱中报 `ERR_ACCESS_DENIED`（`package_json_reader`）。原基线的 `production.test.ts` 同一用例复跑也有同样错误，因此不是本次改动引入；没有放宽沙箱或增加依赖。完整包组的实际通过/失败计数见最终验证输出，失败不记通过。
- 全量 `npm run test:unit`、全量 `npm run test:acceptance`、参考归档检查和真实设备验收未运行；本任务按风险运行受影响包与场景，不把未运行说成通过。
