# 开运行后再绑定的前序结果（late binding）设计稿

基线：`wp/claude/t18-compile-flow` @ `456a1ce2b`，行号按当时的文件。所有者决定见进度文档决定 179。

## 0 要点

- 通用开关：输入槽 `from_runs` 加布尔 `after_start`。为真时，以 `{run}` 绑定（或按血缘缺省）的槽在 start_run 只冻结“哪个运行”，不冻结结果；显式 `rec:` 仍按今天冻结。
- 每次 submit_result 的核验、每次 `/run-export/<run>/late` 导出，Hub 重新取该运行最近一次受理的提交结果，交给工作流新声明的 `refresh` 函数（每次核验调一次），得到逐条目覆盖值 `item.late`。frozen 的 `items[].fields` 不动。
- 用到的结果引用和 refresh 输出摘要写进 `locks.late`，引用摘要也进主张的 `validity.bound`；重放按记录的引用重算。
- case-compile：开运行时所有条目标“重组待受理”；计划按提交那一刻取到的重组结果核对；还没受理的条目记 `unknown/awaiting_step`，不计修复轮。计划里的 `recomposition` 改按记录内容摘要 `record_sha256` 核对，不按整份结果的 `receipt` 核对：别的用例被受理会产生新结果，receipt 就变了。

## 1 改动清单

| 文件 | 位置 | 改动 |
|---|---|---|
| contracts/src/pack.ts | `RunResultSource` L606 | 加 `after_start: z.boolean().optional()` |
| 同上 | `WorkflowInput` L617–640 superRefine | after_start 要求 `role==='expected'`、`many===false`；改 L625 的 from_runs 描述 |
| 同上 | `WorkflowFile` L651–（projection L672 旁） | 新 `refresh: ItemRefreshRef.optional()`；superRefine：有 after_start 槽就必须声明 refresh，`reads` 只能列已声明的非晚绑定槽 |
| 同上 | `RunContext` L389 | 加 `late_inputs` |
| 同上 | `SubjectItem` L429 | 加 `late` |
| 同上 | ProjectionInput L740 后 | 新 `ItemRefreshInput` / `ItemRefreshOutput` |
| contracts/src/run.ts | `RunSummary` L160–200（input_defaults L195 旁） | 加 `late_inputs`（RunRecord 继承） |
| contracts/src/validation.ts | `Locks` L214–222 | 加 `late` |
| contracts/generated/* | — | `npm run gen:contracts` 重生，交合同负责人审 |
| hub/runs/engine/predecessor-defaults.ts | `latestSubmittedResult` L15–29 | 加 `{locked?:boolean}`；晚绑定用不加锁的读 |
| 同上 | from_runs 循环 L101–130、`acceptedOf` L54–61 | after_start 槽只核可见性和包号，不取结果、不因“没有已受理提交”拒绝；从 inputs 移出，返回 `late` 行 |
| hub/runs/engine/late-inputs.ts（新） | — | `resolveLateInputs`、`frozenReads`、`refreshItems`、`lateFromLocks` |
| hub/runs/engine/inputs.ts | `bindInputs` L71；rec 分支 L183–231 | 收 `late` 槽名，必需检查 L339–341 视为已给；把 rec 读取抽成 `recordInput()`（不 ingest）供 late-inputs 用 |
| hub/runs/engine/start.ts | L629–630、context L680–697、run 记录 L780–781 | 冻结 `late_inputs`；`context.late_inputs=[{slot,run}]` |
| hub/runs/engine/evaluate.ts | `EvaluationInput` L69–90；`runContextOf` L214；baseBound L316；context L325；`subjectItem` L346；locks L1215 | 见 3.3 |
| hub/runs/engine/exact.ts | `buildScope` L79–160（仿 L141） | 晚绑定运行的已受理结果进 `records`，角色取槽的 role |
| hub/runs/engine/submit.ts | `resultForObserver` L78–95；缓存 L216–221；`Basis`/base L291；`notAccepted` L420–437；`validate` L569–674（scope L579，input L637–650） | 见 3.2 |
| hub/runs/engine/recheck-effect.ts | L43 | 传 `late: lateFromLocks(result.body.locks.late)` |
| hub/runs/engine/service.ts | `exportRun` L156–167 旁 | 新 `exportLate` |
| hub/ports.ts | L319 | `exportLate?` |
| hub/server/run-export.ts | 路径解析 L88–92、L102；分支 L106–129 | 新 `GET /run-export/<run>/late` |
| hub/runs/packs/validate.ts | L548–551 | `functionEntry(workflow.refresh,'/refresh')`；只出事实的工作流（`isProduction`）声明 after_start 时报问题 `workflow.late_binding` |
| docs/compatibility.md、.en.md | History | 合同和导出路由的变化各记一行 |

## 2 数据形状

```ts
// pack.ts
RunResultSource = z.strictObject({ pack: PackId,
  after_start: z.boolean().optional().describe('true: start_run freezes the run id only; every evaluation and run export re-resolves its latest accepted submitted validation record, passes it to workflow.refresh and records the reference in locks.late. An explicit rec: binding stays frozen') });
ItemRefreshRef = PackFunctionRef.extend({ reads: z.array(Key).max(16) });   // frozen slots the function also needs
RunContext.late_inputs?: Array<{ slot: Key; run: RunId; reference?: rec (no #pointer); missing?: MissingFact }>; // {slot,run} only at projection
SubjectItem.late?: Record<string, unknown>;   // this evaluation's overlay; absent when the workflow declares no refresh
ItemRefreshInput  = { items: SubjectItem[] /*frozen*/, inputs: BoundInput[] /*reads, frozen*/,
                      late: Array<{ slot; run; input: BoundInput | null; missing?: MissingFact }>, parameters, context: RunContext };
ItemRefreshOutput = { items: Array<{ id: ItemId; late: Record<string, unknown> }>, warnings?: PackWarning[] };
// run.ts (RunSummary, so RunRecord too)
late_inputs?: Array<{ slot: string; run: RunId; defaulted?: true }>  // min(1); frozen at start
// validation.ts Locks
late?: { inputs: Array<{ slot; run; reference?: rec; missing?: MissingFact }>; refresh: Sha256 | null }
```

- 晚绑定的槽不进 `run.sources`，也不进 `input_defaults`；InputDefault 要求的“完整验证结果记录引用”保持不变。
- validate 动作的 `detail` 加 `late`（同 `locks.late.inputs`），供审计和缓存比对。
- 主张：`validity.bound` 加每个 `reference` 的摘要（只加记录摘要；refresh 输出由 pack 摘要、冻结输入和该记录共同决定，它的摘要只记在 locks 里用于重放核对）。
- 导出 `run-late@1`：`{schema, run, run_reference, resolved_at, late:{inputs, refresh}, items:[{id, late}]}`，带 `content-digest`。

## 3 行为

### 3.1 start_run
1. `defaultPredecessorInputs` 遇到 after_start 槽：`{run}`（或按血缘找到的运行）只做 `runById`、`canSeeRun`、`packIdOf` 三项检查，并拒绝自绑定；不调 `latestSubmittedResult`，没有已受理提交也照常开始。该槽从 inputs 删掉，返回 `late=[{slot,run,defaulted?}]`。显式 `{reference:'rec:…'}` 走原路径冻结。
2. `bindInputs` 不绑定这个槽，必需检查视为已给。
3. 投影看不到这个槽，只在 `context.late_inputs` 里看到 `{slot,run}`。条目字段因此与重组进度无关，`digest`、C08 R[4] 的沿用都保持稳定。
4. 运行记录冻结 `late_inputs`。

### 3.2 submit_result（锁 `submit:X` 内）
1. `resolveLateInputs(ctx, run, workflow, runner)`：逐槽读运行 Y，先核运行者当前能否看到 Y，再用不加锁的 `latestSubmittedResult(ctx, Y, {locked:false})` 取结果。有结果就写 `{slot,run,reference:'rec:<d>'}`。没有结果时写 `missing`：“运行 Y 还没有已受理提交”；Y 被取代时写“已被 Z 取代，不再受理”；Y 已放弃时写“已放弃”。
2. 缓存：`resultForObserver`（L78）和 `previous`（L220）只复用 `locks.late.inputs` 与本次逐字相同的旧结果；不同就重新核验。`roundsUsedOf` 按提交摘要计数，同一份提交因结果变化重核不另计轮。
3. `Basis` 带 `late`；`buildScope` 把 Y 的已受理结果加入可引用范围；`evaluate(input+{late})`。整份拒收时 `notAccepted` 同样写 `locks.late`。
4. `keepResult` 存储；action 的 detail 写 `late`。

### 3.3 evaluate（`runChecks`）
1. workflow 声明了 refresh：`frozenReads` 读 `refresh.reads` 指定的冻结槽。按 B03 R[0]，用运行者在开运行时的授权读，与 resolveCtx 相同（L362–391）。`late[i].reference` 用 `recordInput()` 读成 BoundInput：记录的 canonical JSON 经 json 解析器解析，meta 为 `{record,kind,schema,created_at,source}`，与开运行时的 rec 绑定逐字相同，不再 ingest。
2. 调一次沙箱 `refreshItems`，用 `ItemRefreshOutput` 校验：id 唯一，且必须是本运行的条目。算 `refresh=digestOf(output)`。沙箱不可用时按投影的做法重试一次；仍失败或输出不合式，每个 (条目, 检查) 都取 `builderFailure`，结果为 unknown/check_error（不计轮），`refresh=null`。
3. `subjectItem(it)` 带 `late: overlay.get(it.id)`；默认主体（L840–843）、run 主体（L727）同样带上。`context=runContextOf(run)+late_inputs(带 reference/missing)`。
4. baseBound（L316）加入各 reference 的摘要，crossBound（L1123）随之带上。locks（L1215）写 `late`。

### 3.4 导出
`/run-export/<run>/late` 与 `exportRun` 读者相同（运行者或管理员），走 3.2 第 1 步和 3.3 第 1–2 步，不写记录，只写调用日志。工作流没有晚绑定槽时回答 404，并写明原因“运行没有开运行后再绑定的输入”。`/run` 和 `/run-export/<run>` 不变；导出的结果自己带 `locks.late`。

### 3.5 并发
- 同一运行 X 的两次提交由 `submit:X` 串行，各自解析、各自记录，后一次可能看到更新的 Y 结果。X 的最新受理结果就是后者。
- Y 在 X 核验期间受理了新结果：X 已经记下解析时的引用，结果有效条件绑在旧摘要上，回执里写明用的是哪一份；下一次提交或导出取到新的。晚绑定读不拿 `submit:Y`，所以 X 不会等 Y 那几分钟的核验，也没有嵌套锁。记录是原子追加的，只会读到已提交的结果，不会读到半份。今天开运行时的 `latestSubmittedResult` 照旧加锁。
- 将来若改成加锁：只能晚绑定开始时已存在的运行，加锁顺序总是新先旧后，不成环。

### 3.6 重放与可复现
- `recheckEffectChecks`（L43）、以后任何重放都用 `lateFromLocks(locks.late)`，不再解析最新结果。重算 refresh 后比对 `locks.late.refresh`，不等就抛“重放的晚绑定覆盖与记录不符”。输入只有不可变的记录、冻结的 pack 摘要和 `parsers.forRun`，所以结果确定。
- 维护流程的重核（maintenance L220/L290/L409）经 submitResult 是新一次核验，取最新结果。
- 生产运行不支持晚绑定，由 validate.ts 拒绝，`productionEvaluationInput` 不用改。

## 4 case-compile 改动（版本 3.21.7 → 3.22.0；recompose 不改）

1. **workflow.json L112 起**：`recomposition_result.from_runs={"pack":"recompose","after_start":true}`，描述改为“写重组运行号；开运行只认运行，每次核对取它最近一次受理的结果”。加 `"refresh":{"module":"functions/refresh.ts","reads":["recomposition_run"]}`。
2. **project.ts**：L190–191 的 `recompositionRequested` 也认 `context.late_inputs` 里的 `recomposition_result`；L194 的检查也接受这种情况。L193–241 的子集核对（按冻结的 recompose 运行记录）不变，仍在开运行时拒绝。晚绑定时 L242/L258–259 不算 proof，条目写 `recomposition_late:{slot:'recomposition_result',run}`，不写 `recomposition`/`recomposition_problem`；summary 末尾加“；重组待受理”；`pipeline_note` 改为“本条重组记录由 Hub 每次核对时取，读运行目录 late.json”。显式 rec 绑定的路径不变。
3. **functions/refresh.ts（新，default export）**：对每个带 `recomposition_late` 的条目，用 `admittedRecomposition(run, late.input, context, source, node)` 求 proof（`source/node` 取 `item.location` 和 fields）。受理了就给 `{recomposition:{...proof, late:true, record_sha256}}`，没受理就给 `{recomposition_problem, recomposition_waiting:{run, result, state}}`。
4. **recomposition.ts**：`admittedRecomposition` L7–22 加 `record_sha256=sha256(canonicalJson(record))`（node:crypto，已有先例 cases.ts L6）。`recompositionGaps` L92：proof.late 时比 `use.record_sha256` 和 `case_id`，receipt 只披露、不比；冻结 proof 仍比 receipt。`recompositionProblem` L28 起加“待受理”的分支。`slots.schema.json` L1593 和 `slots.ts` L25：`recomposition.record_sha256`（64 位十六进制，可选）。
5. **subject.ts** L77：`recomposition = item.late?.recomposition ?? item.fields.recomposition ?? frozen.recomposition`，`recomposition_problem` 同理，另加 `recomposition_waiting`。
6. **checks.ts** `typedPrerequisites` L50–55：有 `recomposition_waiting` 时返回 `unknown`、`reason:'awaiting_step'`（不计轮，符合 W02 R[6]）。文字用 `refusalText`：
   - what：`用例 <autoid> 的重组记录还没有被 Hub 受理，这一条的计划先不核对`
   - place：`inputs.recomposition_result → 重组运行 <Y> 的条目 <recompose item id>（要求项 record）`
   - seen 取以下之一：`重组运行 <Y> 还没有已受理提交（核对于 <时刻>）`；`<Y> 最近受理的结果 rec:<前12位>… 里这一条的 record 要求项为 <未覆盖/未满足>`；`记录 status 为 partial`
   - allowed：`record 要求项已满足`、`记录 status 为 complete`
   - next：`等这一条在重组运行 <Y> 单条提交并被受理后，原样重交本计划，不用开新的计划运行；<Y> 已被 <Z> 取代时，用 open-compile 重开计划运行`
   计划已受理之后，重组又改了这一条的记录：`record_sha256` 不等，判 refute，并按 `recompositionGaps` 现有的格式写出应填的值。
7. **工具**：新 `functions/late.ts` 提供 `recompositionOf(item, late)`。改用它的有 submit-plans.ts L93、fidelity-brief.ts L45、cmd-select-plumb.ts L115、carry-plans.ts L193、rework-history.ts L391、authoring-brief.ts L171/254/638/659、task-brief.ts L582 和 check-plan.ts，check-plan 也读 `late.json`，这样本地核对和 Hub 一致。download-run.ts 末尾取 `/late`，写 `late.json`。新 `tools/refresh-late.ts`（及 .cli.json）覆盖写 `late.json`，并为刚受理的条目补写 `briefs/<序号>.md`。简报外壳里的 recomposition 预填 `record_sha256`。SKILL.md、agents/compile-writer.md 按 T18 B 写清每条用例的流水线：单条重组被受理 → refresh-late → 写手。

## 5 测试计划

- contracts/src/late-binding.test.ts：schema 规则（after_start 要求声明 refresh、只能是 expected、many 为 false、reads 合法）；`npm run verify:contracts`。
- hub/runs/engine/late-start.test.ts：没有已受理提交也能开运行，冻结 `late_inputs`，sources 里没有这个槽，投影只看到 `{slot,run}`；显式 rec 仍冻结；不可见或包号不符时拒绝；拒绝自绑定。
- hub/runs/engine/late-submit.test.ts：每次提交都取最新结果；`locks.late` 和 `bound` 带上摘要；结果没变时复用缓存，变了就重核；awaiting_step 不计轮；refresh 失败时为 check_error；scope 认 Y 的结果。
- hub/runs/engine/late-concurrency.test.ts：两次提交串行；X 核验中途 Y 受理新结果（钩子控制交错）；与导出并发不会死锁。
- hub/runs/engine/late-replay.test.ts：recheckEffectChecks 用记录的引用（Y 之后又受理了新结果）；refresh 摘要不符时抛错。
- hub/server/run-export-late.test.ts：形状、读者、404、content-digest。
- hub/runs/packs/validate.test.ts：refresh 函数入口；生产工作流声明 after_start 时报问题。
- tests/acceptance/62-late-binding.test.ts：合成的“阶段包（incremental）+ 消费包（after_start）”。条目 1 受理后提交，条目 1 核过、条目 2 awaiting；阶段包受理条目 2 后原样重交，两条都满足；`/late` 显示两条。
- case-compile：functions/refresh.test.ts、functions/recomposition-late.test.ts（record_sha256；receipt 变了不再误驳）、functions/checks 的待受理文字测试（五个部分都在）、tools/refresh-late.test.ts、tools/download-run.test.ts 补充 late.json、hub-parity.test.ts 加晚绑定（本地与 Hub 结论相同）、packs/workflow/case-compile/late-binding.test.ts（recompose 单条提交 → case-compile 同一份计划从待受理变为通过）。

## 6 风险与冲突

**和模型冲突，要经集成者改模型：**
- W06 DEF：“一次冻结的工作实例：冻结要求项、任务包版本、知识根摘要与输入”。晚绑定槽只冻结运行号。
- W06 F[5]：“input_defaults 冻结 Hub 缺省绑定的槽名、前驱运行与完整验证结果记录引用（无片段指针）”。晚绑定不写 input_defaults，另写 `late_inputs`。
- W06 R[6]：“没有已受理提交时拒绝开始，用现有缺输入拒绝码并点名槽，下一步是让前驱按回执改正重交，被受理后再开始复核”。这是直接冲突：T18 的 open-compile 要在重组运行刚开、还没有任何受理时就开计划运行。
- B03 R[0]：“Hub 自己评估一次运行时……按运行开始时的授权读这次运行冻结的输入（输入与期望来源、绑定的 Hub 记录、前驱的结果、锁定的根），不按运行者此刻的权限重查”。progress 决定 26（L426）说法相同：“Hub 自己评估运行时，按运行开始时的授权读冻结的输入”。晚绑定的记录不是冻结输入，本设计按运行者当前的权限读；读不到时按 D05 R[3] 的中性说法，写进 `missing`。
- W08 DEF“锁定版本与有效条件”：`locks.late` 是对它的扩展，不冲突，要写进模型。

**和 brief 冲突：** docs/hub-r4-architecture.md L186：“Idempotence: repeating `submit_result` for the same (run, submission digest) returns the stored result without re-running anything”。现在键变成（运行, 提交摘要, `locks.late`），晚绑定的结果变了就会重核。现有代码已经对会话、模型和过渡结果重核，偏离已有先例。

**和合同描述冲突：** pack.ts L625 写的是“The Hub replaces each run id with that run’s latest accepted submitted validation record”，要按 after_start 分两种情况重写。

**其他风险**
1. 用例 A 的计划受理之后，重组又改了 A：下一次提交 A 被驳。这是有意的，但写手要知道；合并工作簿的运行用显式 rec 绑定 `plan_result`/`recomposition_result` 冻结，汇合点之后不再漂移。
2. Y 被取代或放弃后，条目永远待受理。本设计只在文字里点明，不自动跟到后继运行（这是待决事项）。
3. 每次提交或导出要调一次沙箱，输入是重组运行记录加结果（与今天投影的输入同量）。64 条用例接近 `inputBytes` 32 MiB 时，refresh 会失败成 check_error；`reads` 只取需要的槽。
4. `SubjectItem`、`RunContext` 是严格对象，加字段需要所有 pack 函数忽略未知键（case-compile 不受影响），要在兼容性页记一行。
