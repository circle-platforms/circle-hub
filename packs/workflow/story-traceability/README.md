# 需求追溯矩阵

独立工作流包 story-traceability（版本以 `pack.json` 为准）。按任务页 gold-trace 第 5 条实现；Hub 仅分发和核验，用户给出的需求编号是主路径。编号精确数字规范化，需求号只连接 stories 键，不读取 defects。按请求编号分别核对覆盖范围：已列出的连接给确定事实，部分明细给条目下限；只有没有连接且覆盖范围无法证明的编号才拒绝；无连接是锁定知识根完整需求号索引覆盖内的确定事实，不推出未索引用例不存在。PLM 未返回仍是条目，状态和阶段各自保留原样，不定义已交付。

可选构建路径由 PLM 资源 settings.build_story_field 指定真实顶层编号数组，配合 build 槽和 build_id。字段名属于管理员部署数据，不是用户参数。缺配置或字段时拒绝并向用户索取编号。范围依据在事实数据用 provenance_type 的 observed，用户范围用 declared；摘要通过生成的 labelOf 显示标签。主路径优先，避免混合两种范围。一个条目最多一份一致 PLM 详情；批次冲突拒绝，不采用最后写入。

## 1.0.15：结构化遗漏事实

索引读取的 Hub 元数据以 `index_excluded_entries` 记录本页因扫描而排除的条目数，`index_view_sha256` 绑定对应视图原件。只有摘要相等的非负整数才用于判断；不再检查说明文字。该数不覆盖其他来源缺失、分页或逐键截断，它们仍分别按原有结构字段处理。旧视图没有该事实且自身截断时，已知连接只报下限、写缺失事实和重读动作；未截断视图和不相关的明确逐键截断仍按其结构核对。视图原件字节不改，历史运行不改。

## 决定与限制

完整视图中的连接与无连接都交付支持事实，并给出知识根、视图引用、条目数与键数；无连接不是全局无用例。部分视图中的已知连接仍可交付，拒绝仅点名无法判断的编号。错误保留来源说明，并说明 only= 原文匹配的限制和可执行的补充动作，不要求靠同步消除固定上限。Hub 不自动同步、不重试、不调用模型，也不声称已经自动衔接外部动作。

索引的 `key_space_complete` 由 Hub 根据冻结视图的原始键范围、分页、来源范围及已知未完成的用例投影计算。只有明确为 true 才能证明该视图中未列出的键不存在；字段缺失的旧视图保持未知。已列出的连接仍可报告，条目不完整时为下限。该字段不把只按原文匹配的 `only=` 扩成规范化编号检索，也不证明未观察或未索引的外部用例不存在。


视图瘦身后没有原始 stories 字段，按知识索引键作为连接证据；字段存在但不含需求号（包括空数组）则反驳。引用保留 PLM JSON 位置及用例树引用。统计按 PLM 原样状态分组，返回但字段缺失用 fields_absent 记录，status 缺失单独计数、不作为未知状态；显式 null 与数字、布尔、字符串均原样保留。应答未包含的编号请用户确认，不推断需求不存在。原始构建列表按原件保留，只有 PLM 配置投影给出的范围可用。每运行最多 8000 条和 5 MiB 投影预算；用户声明范围超限可显式分批，构建范围超限须保留来源由维护人提供分块核对，或用户明确给出编号另开声明范围运行。

## 验证

`node --test --test-concurrency=1 packs/workflow/story-traceability/**/*.test.ts packs/workflow/story-traceability/*.test.ts`

`node packs/workflow/story-traceability/pack-files.ts --write` 重新签名清单；`--check` 校验；`--stage <目录>` 准备可发布目录。包内正反样例为合成作者样例，不等于真实验收。发布及临时 PostgreSQL 生产运行端到端仅测试合成读取器。`npx tsc --noEmit` 检查类型。

## Needs from other packages

需要集成者注册 scripts/real/accept/story-traceability.ts 场景，本分支不改 accept-circle.ts。真实 PLM 需求状态、阶段和构建需求字段由集成者核实后配置；目前无新词表轴需求。客户端必须执行 SKILL 的后续动作，用户不能触发管理员知识同步。发布、分配、部署和真实验收由集成者执行。


独立答案脚本 `scripts/real/gold/trace-stories.ts` 只读需求编号清单、PLM 原件、脑图、敏捷树和显式文档清单；不导入 Hub 或包的运行代码。参数为 `--stories <文件> --plm <文件>… --cases-dir <目录> --tree <文件> --docs <文件> --product <产品> --build <构建> --out <文件>`。空文档清单或漏导出的文档不作为通过。场景核对逐需求展示的用例、原样状态和阶段及运行计数，诊断只写序号、计数和摘要。

需求独立答案在 trace-stories.ts 内独立提取标题、目录中的需求号，保留非零编号的原文零前缀，再按编号身份规范化连接。它不改变共享 case-location 的提取规则，不使用数字占位。合法脑图的无用例节点状态用共享 caseNodesOf 在调用 caseGold 前确定，不依赖共享错误类或猜测错误消息。

复核 5：文档清单中没有用例节点的合法脑图计入 documents_without_cases，不影响其他文档连接；先按解析后的节点规则确定没有用例再跳过，坏脑图仍整份拒绝。终端只增加无用例文档个数。

复核 6：只有在成功应答的 unread 中列出的编号才计没返回；不可读或未绑定的详情批次单列 plm_unavailable，不能伪称已收到应答。构建路径已自动尝试详情读取，失败记录由客户端与管理员核对；验收拒绝详情来源未读到的运行。

复核 7：范围依据只用 provenance_type 代码，expected_sources 只比较 observed，不依赖显示文案。包内标签快照由 testing/generate-vocabulary.ts 从 contracts/generated 生成，--check 和回归测试校验未漂移；不手写词表、不改全局生成器。buildsProject 的旧 scope_note 字段在这里不再驱动逻辑，其清理由 plm-fields 分支处理，避免修改同一函数。

复核 8（本分支部分）：build_id 与应答记录编号都去首尾空白和前导零再比较；缺构建记录、没有可用数组和空数组分别拒绝。投影未提供原始字段名时不猜字段名。buildsProject 的需求数组元素已在 plm-fields 修复：验证与输出都从去首尾空白的文字规范化、去前导零，去重后排序，原件保留原样。

复核 9：独立答案只接受 code 为数值 1000 且 data 为数组的 PLM 原件信封。裸数组、Hub 的 stories/unread 投影、无 code 或失败 code 都拒绝，避免把投影结果当作独立输入核对自身。


复核 3（plm-fields，1.0.2）：build_id 必须在 PLM content 中唯一选中记录，原始 name 必须与 cases 视图的构建名在 NFKC、去首尾空白后逐字相同；不做大小写或版本形状推断。异名会在回执列出 PLM 和视图的两个名字，下一步重绑同名的 cases 视图后重开运行。运行上下文若明确指向另一根或产品也拒绝。当前不按跨名称族别名推断，工作流继续不绑定产品线。

核心依赖（集成者确认）：需要给不绑定产品线的工作流提供按名字查构建别名的只读接口，证明对应的构建和知识根。当前核心拒绝这类工作流的 product/build 参数，无法取得可用的 context.builds；接口完成后，本包再改成按别名核对。在此之前不同名称必须拒绝，不能临时按字符串形状、名称族替换或调用方提供的别名表认定相同。

选中的构建身份只在 groups[0].selected_build 冻结一次：编号、原始 name、JSON 引用、cases 构建与根。每行和主张只保留 {id,name}；其他原始标量留在 plm:builds content，不复制到派生结果。陈述前缀只写构建编号及 name 前 40 字，完整引用留在 grounds。详情未读到时，修复动作位于用例明细之前，不被明细裁剪吞掉。

Closure review 1: projection refusals carry warnings: [] as projection-output@1 requires. Known input refusals are typed at their throw sites with their own corrective action; unexpected exceptions are pack defects, never guessed from message text. Production-start coverage verifies the original pack code, message and fix survive the engine boundary. Version 1.0.2 is re-signed.

## Closure review 2: per-requested-id coverage

A listed key supplies a determinate positive index fact even if cut or missing entry bodies. indexed_match_count counts
unique digest links; case_count remains readable bodies. Partial/cut/only views say at least N indexed entries and never
claim an absent story from an empty returned subset. Only requested ids without links need the complete global key
listing, no skipped source and no only filter to establish absence. Unrelated cuts do not refuse
a run whose requested facts are already determined. A refusal lists only undetermined ids. Counts cover those requested
identities; partial detail is stated as a lower bound rather than an impossible instruction to remove a fixed core cap.

### Needs from core and the traceability pack

Core index only= currently compares raw spellings before normalization; an empty filtered view cannot rule out aliases
such as 00021 versus 21. Core needs normalized-id filtering and per-key excluded-entry counts. The global count is now
declared in the read metadata, while key-space and source-scope completeness have their own structural fields.
Until then, narrowing by a verified raw key can recover a positive match; a narrowed miss is not proof of absence. The
refusal explicitly hands this missing capability to the core maintainer rather than asking a sync to remove hard limits.
The sibling workflow traceability must adopt the same bounded absence/positive-lower-bound decision; its check.ts still
uses missing_input for absent ids and is outside this task's edits. No package/runtime import crosses that boundary.
Version 1.0.3 is re-signed with these per-id semantics.

Closure B3: story-id extraction is local to trace-stories.ts. That fix removed story-specific edits to shared locations/cases; this merge now keeps the canonical mainline gold implementations and their published FAMX rules. The shared gold follows the published mainline FAMX identifier rule; the story-only extraction remains local. Notes-only documents are classified from parsed case nodes before extraction, never from exception text.

## Non-scalar PLM observations

Scalar status and stage retain their values; fields_absent, fields_nonscalar and an explicit null are separate facts.
A non-scalar field has a null placeholder plus its name in fields_nonscalar; its original JSON remains in the PLM original
response. It is excluded from scalar state groups, never inferred as a lifecycle state and never counted in the null group.
status_nonscalar and stage_nonscalar are top-level summary counts, not new vocabulary values. Counts are written before
the possibly long status list, in both summary data and the statement: PLM 返回的状态不是单个值的有 k 个，没有按状态计数.
A long-state regression checks that the non-scalar counts remain in the first 500 characters. The independent raw-input
gold and its checker use the same rule; a missing counter or an invented null group fails verification. Version 1.0.4.

Merged artifact 1.0.5 combines plm-fields selected-build identity verification with story-trace closure fixes; it is signed separately from the standalone story-trace 1.0.4 artifact.

1.0.6: compact build identity fixes the 1500-story/long-field amplification; a build-derived oversize refusal names its build and offers explicit declared ids or a maintainer-provided scoped split, never an impossible implicit batch.

Closure B1: absence uses the complete key listing, not entry totals or unrelated missing bodies. Each row keeps an exact
count unless its raw aliases are cut, keys/sources are incomplete, only is set, its own bodies are missing, or credential
exclusions may affect it. The earlier implementation used credential exclusion notes; 1.0.15 uses the structured global
count and remains conservative until per-key excluded counts exist. Undetermined ids can be
omitted to run the determinate remainder. Unrelated per-key cuts alone do not lower an uncut row count.

Integration with hub-redesign 956d65f1 keeps PLM 1.3.2 and story-traceability 1.0.8, the larger versions on the two sides.
Selected-build identity/size recovery, per-id index coverage, and non-scalar PLM observations are combined. The actual
PLM-to-workflow projection regression remains alongside signed-contract tests; neither relies solely on hand-written markers.
The story-only oracle keeps its own id extraction and uses the canonical independent case-node helper from mainline.
Both manifests are regenerated from the merged runtime bytes.
