# case-compile 3.18.0

本地候选 3.18.0（2026-11-12 下午）：新增按声明形状取一格、多列精确等值或行序号选择，并用既有 H/I 和可读 G 参数在本条自动化用例里回填。动态值单列为命令模板，明确地址用途的运行时位置保留未知，原有静态检查不变。取值由独立执行侧组件负责；本次仅本地实现与合成检查，未部署。

3.17.3 的原有能力（2026-11-12 上午）：执行器关闭的动作由生成侧按手册和命令树改写为已开放的设备命令；手册允许指定名字时，同条创建、使用、查询和清理共用生成值。按所有者本人的决定，原始用例的否定结果采用字面或本条捕获值的 not_found 检查，不另立判定标准或发起评审员复核。原作者的明确声明、逐字引文、输出与捕获关系、执行器能力及场景保真检查保留。仅本地提交，尚未上线。

本地补丁版本 3.17.1（2026-11-12）：完整检查后收窄 case-writers 实际使用的状态接口类型，包内文件字节因此变化，按版本不可复用规则补升并重签；生成器和合成样例同步。本次不发布。

本地版本 3.17.0（2026-11-12）：加入产品声明的用例顺序及跨用例冲突核对、原始用例与手册冲突的第四种收口、逐条编写扩展、取值范围模块和统一措辞。自动化用例 Excel 的生成器同步为 case-compile@3.17.0。取值主张的 Hub 接收尚未实现；根 hooks 仅为未应用提案。本次只提交本地，不发布。

The client authors a plan for every case of the run and generates one XLSX for all of them. The Hub verifies the plans, independently interprets the core xlsx@1 model, and recomputes the exact artifact with the same generator. It calls no model and never emits an execution artifact itself. Synthetic acceptance proves these boundaries, not compatibility or success on a real runner/device.

## Frozen inputs and plan

subject is a KityMinder document; contract, inventory and profile are required published expected sources. Without `parameters.autoid` the run takes every case of the document that the rule takes, the author did not exclude and that carries an autoid of the profile's shape, one item each in document order (3.9.0); an autoid of another shape, a duplicate autoid or more cases than one dispatch takes refuse startup, and a case without an autoid is counted in the selection summary (3.9.6). With `autoid`, exactly that case; an absent or duplicate selection refuses startup. Items retain autoid, auto, priority, title and authored steps, each from its own node (a repeated node id takes the node's selector in the item id). Both child-step and case-body/one-leaf layouts preserve source text. Unsafe numeric identifiers cannot be reconstructed.

The original runner contract is not converted. Every original member except contract_sha256 participates in sorted compact UTF-8 identity; unknown status/dispatch/kind/authority values, unsafe/non-integer numbers and non-BMP keys refuse the whole contract. Object names are read from the key `e` (`name` stays accepted; both present and different refuses). Enabled non-internal, non-candidate entries alone are callable. Default text is not copied or evaluated; redacted parameters cannot be submitted. Identity must equal the declaration. A runtime-contract@2 document must declare `original` (the original contract's canonical identity and byte digest): the additions are a Hub-side deployment declaration, removing them recovers the original identity, and the pinned original identity — not the recomputed @2 digest — is what the profile expects, the workbook identity row carries and check-runtime-contract --expect checks. The parameter role `executor_return` marks a required parameter the executor fills with the previous step's return (the two-argument checkpoints' `result`); the profile check exempts it and the generator refuses to let the model write it.

runtime-profile@1 defines expected identity; workbook sheet/nine headers/identity marker/range/closing row/autoid shape; seat and host-method mappings; allowed combinations with parameter roles; device/host rejection lists; synthetic; required device_count from read-only precheck; optional fold_newlines pairs, default empty. Decision 35 considers every enabled pair; allowed contains only opened combinations with role coverage and any required explicit reviewed decision. External-format closed sets live in the pack's format tables. Dispatch must check the real current device count again.

For a flat plan, data is bucket, empty blocks, steps [{object,method,args,keywords}], expects [{text,quote,after}] and replacements [{case,bed}]. Args remain text; keywords may also be safe nonnegative integers because the runner converts digit keywords. Signatures enforce order, required/positional-only arguments, declared keywords and credential exclusion without defaults. Literal assertions are forbidden in steps: only expects supplies assertion text, with an original quotation and a one-based command after. Replacements are numeric one-to-one mappings, and slots contain final text. Device/host rejection lists, catalog@1, quote@1, address ownership and grounded expectations remain required checks. The bed/ prefix exposes test-bed predecessor allocations; unrelated runs cannot use them.

## G behavior and supported encoding

The authoritative behavior is the integrator's task-page annex, transcribed read-only from the runner with synthetic examples. Empty G becomes the string None, so zero arguments cannot be written as an empty cell. Ordinary LF input is one unsplit positional string unless the method is explicitly in fold_newlines; folded methods trim Python whitespace, remove LF/CR and then split. Ordinary plan values remain single-line; codec tests separately cover the broader reading behavior.

Outside paired single/double quotes, commas split fragments; unmatched quotes are ordinary characters. Inside a quote, backslash protects the next character from closing the quote but remains literal. Empty/space-only fragments disappear. Each fragment is trimmed with Python whitespace; matching outer quotes are removed once and the inside trimmed again. Equals is interpreted afterward: a key containing an internal ASCII space makes the fragment positional, otherwise it is a keyword. Decimal digit keywords become integers, duplicate keys overwrite; positional digits remain text. Literal assertions are unsplit original strings, including quoted text/newlines, and compare to the most recent ordinary result. Legacy flat plans leave H/I empty; block plans follow the declared register rules below. Waiting is a single ASCII-digit duration.

encodeG always decodes its result and compares types and values. It names the violated rule for empty/edge-space/CR positionals, equals-to-keyword conversion, mixed quotes that require wrapping, quoted trailing backslash, non-single newline values, unknown keyword names, numeric text keywords, non-ASCII numeric keywords, out-of-range integers and invalid wait/assertion values. No Python, shell or expression evaluator is used. Fixed-seed tests roundtrip 500 supported values. Denial matching remains text matching, not a proof of arbitrary shell behavior.

## Deterministic file and independent reading

The Node-built-in-only generator fills the runner's own template, which the run's profile carries as `workbook.template` (`{sha256, xlsx_base64}`): every member but the worksheet keeps its bytes, and the worksheet keeps its notes, lists, drop-downs and column widths. Output is ZIP32 STORE with its own CRC32, fixed DOS timestamps and the template's member order. A is inline text, C is numeric, 0 on the description row and counting up from 2 inside each case, never initialization 1. Other values are inline strings. Row order is identity, nine-column header, description, then for each case in item order its steps, each with its after expectations immediately following, and a blank row, then the configured closing row. The description contains plan_run and build, never a person. Each case starts at the row of its textual autoid, with nonempty E. Every assertion row is generated from expects. Legacy register cells and all certification-request cells remain empty; block register cells are verified under the explicit runtime capability.

Identity F records the generator id; G records a canonical recipe digest so a changed quote/replacement also changes bytes without copying source content. The workbook-level range points exactly to the header. Invalid XML values are refused rather than dropped; CR text is preserved. SpreadsheetML-looking _xHHHH_ sequences are refused with xstring_escape because literal inline and ST_Xstring readers disagree. The reference circle-packs 10-13 xlsx.mjs was read only for OOXML behavior: differences are STORE versus Deflate, strict fixed layout and subset, no hidden-row facility, exact identity/range, rejection of invalid characters and _xHHHH_ text, and accounted recipe metadata. No reference code or template bytes are imported.

The only ZIP/XML reader is the existing core xlsx@1 parser, unchanged here. readWorkbook consumes its structural model and independently scans all post-header E–I rows, including description/closing rows. It checks members, one visible sheet, inline strings/numeric C, no formulas or equals-prefixed cells, hidden rows, unique identity/header/range, exact original fields, signatures, one autoid per case in item order, immediate assertions, empty legacy registers and block registers scoped to their case, seat bounds and final closing row. It never calls the generator to parse input. Existing catalog@1 and quote@1 checks also serve workbook_verified. Only after semantic reading does the verifier regenerate and compare SHA-256 against the integrity-checked bound original bytes. A single changed ZIP timestamp byte fails even if the parsed model is identical.

The support data is exactly {sha256,autoids,bed:{id,manifest_sha256},build,generator,plan_run}. manifest_sha256 is the raw bound inventory digest, not a re-encoded model hash. No workbook text/bytes are returned. The package checks description D against frozen plan_run; dispatch must compare data.plan_run with the verification run's own predecessor. The bundle's generator id is tied to the pack version by tests; uploaded stale generator identities are refused.

Limits are declared in tables/workbook-format.json: 2,048 rows, 32,767 characters per cell, 2 MiB frozen model, 8 MiB output; policies/dispatch.json caps one run at `max_items` (64) cases, checked when the run starts. Exceeding them refuses rather than truncates, and the refusal names the split the workflow offers: several uploaded documents, or one autoid per run. SHA integrity and synthetic checks do not certify actual runner behavior.

## Two runs and offline scripts

First reserve the bed, then start a plan run with that reservation predecessor and all original sources. Submit/repair until every plan requirement is satisfied. workbook_verified alone is missing_input; accepted is not shorthand for satisfied. Preserve the exact original submission, start_run summary, complete result and bound source bytes. If the client exposes only formatted summaries, request a raw structured export from the integrator instead of manufacturing proof. Source pagination must be complete; local source-byte SHA checks catch reformatting or incomplete copies.

Run normalize-mindmap.ts only for local exports needing the declared transformations: remove the KityMinder export head (U+FFFF then U+FEFF, bytes EF BF BF EF BB BF, which every real local export carries; since 3.8.8) or two leading U+FFFF, and convert a single array wrapper into root. It preserves element spelling, including long numeric literals, and prints before/after SHA plus client-normalization disclosure. Ordinary root documents retain their original bytes.

The offline generator accepts --run --result --submission --contract --profile --inventory --out. It checks the received-submission digest, accepted result, full coverage of every item of the run, locked pack/root, every mandatory plan status and exact expected-source bytes, then reads the verified identity receipt. It writes a new private file and prints only digest/version/size (and, when cases were placed last for the state their commands leave behind, which ones: `moved_tail`). No environment or network is read and existing files are not overwritten.

Source and published scripts both live under tools/, exactly as pack.json declares; staging copies those paths without namespace mapping. Installation must preserve tools/, functions/, tables/ and requirements.json together. The script and checker import the same functions/generate.ts. Node 24 is required; no production dependencies beyond built-ins are added.

Upload the exact generated file. The second start_run binds workbook by its uploaded src: reference, uses the same sources/build, and sets predecessor, plan_run and (for several cases) plan_result to the satisfied plan run. Resubmit the unchanged slots of every case. Fixing slots requires regeneration and a new successor because inputs are frozen. Every required check must then be satisfied before handoff. SKILL.md drives missing-input continuation through generation/upload, never reports missing input as success, and retains the qualifications 按合成合约核对 / 按发布的运行器合约核对 and 不证明在真实设备上跑得通. Since 3.9.1 the Hub dispatches the verified run itself while the runner holds the whole bed (decision 105).

## Verification

```sh
node --test --test-concurrency=1 'packs/workflow/case-compile/**/*.test.ts'
npx tsc --noEmit
npm run verify:contracts
node packs/workflow/case-compile/pack-files.ts --check
node --test --test-concurrency=1 packs/workflow/case-review/packs.test.ts
```

Tests use synthetic contracts/profiles/resources and temporary loopback PostgreSQL. They exercise byte repeatability, core-parser reading, independent row reading, all required structural counterexamples, raw-byte mismatch, offline CLI provenance checks and published tools execution. Production tests prove plan-success/workbook-missing, script generation from that exact result, and all-satisfied successor verification with compact receipt data. Publishing checks all author samples in the real temporary registry. Missing sandbox-exec is a skip, never a pass.

The repository vocabulary scan has existing out-of-package matches in knowledge, submit and tools on this baseline. This package adds no exception/baseline or handwritten vocabulary axis. Real runner data, models, devices, persistent deployment, keys and owner configuration were not accessed.

## Local receipt

The final synthetic package run executed 195 tests: 195 passed, zero failures, zero skips. The real temporary-registry test passed all 54 author samples. The real-engine successor test validated the exact offline client recipe and original XLSX receipt. Type checking, generated-contract verification (68 files), manifest freshness and diff whitespace checks passed. The repository vocabulary command ran 16 tests: 15 passed and one failed on the existing eight matches in six files outside this package; case-compile adds none. No real runner, owner environment, credential store, persistent deployment or paid model was used.

Merged runtime review: decision 35 opens every enabled pair and every bed interface while retaining rejection/value/credential screening. Every supplied parameter needs a role; wait roles need max_wait_seconds. Masks, prefixes and non-IP tokens are not off-bed hosts. Unsupported numeric host notations and dynamic host shell syntax have repairable diagnostics. Assertion values are validated before generation; unsafe ids and failed frozen inputs retain pointers and next actions. Replacement sources must occur in authored case text or quotes and cannot chain.

Merge receipt: the runtime review's 19 red-before/green-after regressions are retained, and three semantic merge regressions cover integer keyword durations, assertion policy and decision-35 address use. The combined package ran 217 tests, all passed with zero skips; its temporary registry passed all 68 author samples. Type checking and manifest freshness passed. The core xlsx parser has the same Git blob identity before and after this merge; no new xlsx-parser changes were merged. Codec reading behavior remains broader than the accepted plan subset: assertion cell values must satisfy the runtime's single-line/no-placeholder policy before generation.

收尾复核：与参考 xlsx.mjs 一样不改写原文；本包另拒绝任何 _xHHHH_ 序列（xstring_escape），因为核心 ST_Xstring 解码和运行器的内联字面读取不能同时保持它。参数和期望在计划修复时就拒绝此类值，表名、范围名和其他单元格由生成器带固定原因拒绝。

执行行 D 一律写用例标题，不推断计划步骤与原始步骤的位置映射；拆分和重排不会冒充逐步原文。断言行 D 仍为经引文核对的 expects.text。

前置值被 contract_shape 驳回时，命令及引文 subject 返回通用 blocked 列表，逐条携带检查、指针和原驳回码。核心记 awaiting_step 的过渡未知，点名指针并要求修正后自动重核，不再伪造缺失的内部 phrases/quotes；修正后恢复原有解释器。不符合 blocked 形状的普通对象不被吞掉。

设计以 bac0083e 为准：不因派发标签直接全开或全关；tables/dispatch-roles.json 声明每种派发方式当前能由哪些角色完整核验。动作注册表与三参数检查点当前角色列表为空，配置不能把它们冒充 host_shell/device_cli（也不能用空参数映射绕过）；错误指到允许项及参数。草稿消费同一表，把这些组合列为“未开”，缺的事实和下一步取 missing/next：参数不是命令文字，G 规则与拒绝表核不了，case-compile 另写一页增加角色及检查。本分支不修改外部转换脚本。

allowed 是合约启用集合中、经角色和检查覆盖的已开放子集；其余组合未开。method_not_allowed 的模型修复是换用已开放组合，并保留 unassigned_parameters；param_unassigned 专指开放组合中无角色的参数，修复为去掉该参数或换组合。管理员扩展角色须另开页、重新发布并开始新运行，不能要求模型修改冻结配置。冻结输入无法重算（缺可核验的合约副本或运行环境配置）时，各检查记“在等某一步”：写明在等管理员按文档和指针修复并重新绑定、开始新运行重算，缺哪些文档一目了然；这是缺输入，不是检查出错。

主机文字中的 0.x 小数按选项值保留；非零开头的两段小数仍可能是 inet_aton 地址，因此不能区分用途时拒绝。模型可改用更小单位的整数或明确等待步骤；若确实是地址则改用规范四段点分。此处不证明任意 shell 参数的语义。

派发角色每行依据集成者对运行器机制的只读核对，详见 dispatch-roles.json 的 basis。cmd_primitive（设备和主机的 cmd_config/cmds_config）仅支持 device_cli、host_shell，继续做目录及各自拒绝表核验；checkpoint_two_argument 仅支持 literal_assertion，builtin_special_case 仅支持 wait。注册动作和三参数检查点没有可用角色。direct_method_call 参数可使用四角色，但内部动作未被拒绝表核过，必须集成者逐个只读审阅、显式在 allowed 项设 reviewed:true 才开放；零参数方法同样要求此显式决定。草稿应列待定并保留表中 missing/next，不从参数角色自动推断已审阅。reviewed 是配置作者的开通决定，不是 Hub 证明内部动作安全；模型不能修改冻结配置。

主机 shell 没有命令目录，只靠主机拒绝表和语法、地址核对；设备命令行另须通过锁定构建命令目录及设备拒绝表，不把 curl、ping 送入设备目录。

## 决定 40：运行环境草稿的交接接口

`tables/dispatch-roles.json` 是客户端转换器和本包解析器共用的声明，schema 为 `case-compile.dispatch-roles@1`，`dispatches` 每项字段如下。转换器只读该表，不按方法名猜角色，也不在脚本里另写一份允许表。

| 字段 | 含义 |
| --- | --- |
| dispatch | 原合约的派发方式，精确匹配，不转换合约格式 |
| roles | 本轮此派发方式允许配置的参数角色；空列表表示当前没有覆盖能力，不能开放 |
| requires_method_review | 参数角色之外，是否还要求逐个方法的人工开通决定 |
| missing | 草稿应原样保留的缺失事实；不适用时为 null |
| next | 草稿应原样保留的下一步动作；不适用时为 null |
| basis | 集成者只读核对的运行器派发机制依据，不是 Hub 执行观察 |

每行政策：direct_method_call 允许四类参数角色，但必须审阅内部动作；cmd_primitive 只允许 device_cli/host_shell；checkpoint_two_argument 只允许 literal_assertion；builtin_special_case 只允许 wait；execute_registry、checkpoint_v2_three_argument 的 roles 为空。执行类仍按各自检查：设备目录及设备拒绝表，或主机语法、地址与主机拒绝表。主机没有命令目录。

`tables/runtime-profile-format.json.method_review_field` 给出开通决定字段名，本版为 `reviewed`，落在 `allowed[i].reviewed`。只有布尔 true 表示显式审阅开通，不能从参数角色齐全、方法名称或派发启用状态推断。每个 direct_method_call 及每个零参数方法都要求它；本包在 `/allowed/<i>/reviewed` 指明缺失事实和动作。这个决定不解除 G 的可表达性、签名、拒绝表或地址限制；零参数步骤仍不能通过空 G 表示。

给 runtime-profile.ts 的草稿规则：

1. 只从原合约已启用、非内部、非认证候选的组合取方法；按 dispatch 找本表的行。未知派发方式由原合约格式核验整份拒绝，不能采用默认允许。
2. roles 为空的组合不放 allowed，单列到草稿 unopened，保留 object/method 及签名参数名，missing/next 取本表。事实是“这类参数不是命令文字，G 规则和拒绝表核不了”；下一步是 case-compile 另开任务页增加角色和检查。reviewed:true 也不能越过空角色表。
3. 角色尚未根据只读事实定下的拟提交参数列为待定，不猜。已经开放组合中未映射的可选参数不能提交；确需它时由集成者补角色、发布配置并新开运行。脱敏凭据参数始终不提交，不以角色映射打开。
4. 角色可覆盖但 requires_method_review 为 true，或签名没有参数时，另列“方法开通决定待定”，指向对应 reviewed 字段，不自动填 true。missing 写“方法内部的动作没被参数角色和拒绝表核过”；next 写“集成者逐个只读看过方法后明确决定，开则在 allowed 项设 reviewed:true，不开则列 unopened；重新发布后新开运行”。
5. --check 调本包 parseProfile 复核每个已配置角色和显式决定；允许集合必须是启用集合的已开放子集。未开步骤的模型修复是换用已开放组合；无角色可选参数的模型修复是去掉该参数或换组合，不是编辑冻结配置。

本包仅提供该表、校验及交接约定。实际草稿消费由 codex-e 在 hub-device-run 的 `scripts/real/convert/runtime-profile.ts` 按决定 40 接入；本分支未改那个工作树，也不代替集成者作人工开通决定。

决定 37：期望文字在地址替换后的引文中按上下文空白规则核对。一段 Unicode White_Space 两侧任一边是 Unicode East_Asian_Width W/F 字符时去掉，否则折成一个空格，两端空白去掉；空引文不匹配。大小写、标点、字符宽度和 Unicode 规范化形式仍须一致，`set 10 0` 不等于 `set 100`。G 的单行/取值限制及工作簿原字节核验保持独立。

`expected_quotes` 继续声明核心 `quote@1`，核对引文与绑定的原始来源。`expected_sources` 还要比较地址替换后的临时文字；该文字不是绑定来源，不能伪造引用交给 `quote@1`。因此包内 `functions/quote.ts` 独立执行相同规则，沙箱不导入 hub/refs 或 hub/rules。`functions/quote-width.ts` 的 Unicode 17.0.0 W/F 数据（保留 Unicode License V3、规范数据地址及摘要）和 `testing/quote-vectors.json` 的 29 条共享向量取自 refs-diagnostics 的 51b1810c3594d69d27502f2b6e5f87591097f263，用 git show 只读取得，没有合入该分支。向量测试、端到端期望检查及沙箱发布正反样例共同核验；核心更新规则时须同步重新比对这份包内实现和快照。

独立 compile-check 核对要求每项 Hub 状态存在且确定：未知不算一致，缺状态或缺结论都是差异；报告 position_comparisons 保留逐检查的已比位置、未定标记和差异，不因旁边有未知而跳过已知反驳的位置。未知的缺失事实和下一步随核对结果返回。

2.3.5 兼容不限时预订：冻结租约的 until 为 null 时，本血缘分配的地址仍可用；其他用户的地址仍拒绝。
只改变租约期限的解释和相应合成输入，不改变命令、规格或真实自动化测试环境判断。独立合成测试装配显式提供空作业端口，
其私有数据库没有派发服务；真实服务仍由 Hub 装配接上实际只读作业记录。生成器版本标记随包升版，
工作簿正反样例由合成原件重新生成、解析和计算摘要；没有手改字节摘要。

2.4.0 在 requirements.json 声明唯一的 `submit_verified_workbook` 效果行：只许本运行全部必需要求项满足后的单用例工作簿；次数 1，预留时长取冻结执行器的 max_run_ms，期限为开跑后 24 小时。通用参数由 `dispatch_policy` 用同一工作簿核验函数和 `policies/dispatch.json` 在编译与派发前两次核对，参数中没有部署工具名和字段。当前仍由管理员命令代 Hub 触发，submit_result 不发效果。

合主线前的合成验证（643f7613 基线）：真实发布边界的 96 个作者样例全部通过；包测试 284 个中 279 过、5 个失败，失败均为基线 643f7613 同样可复现的 LayerResult 缺 missing/exit。验收 28 已加入旧冻结版本缺效果行时零提交的断言，并适配边界拒绝的结构化结果；其 7 个用例目前都先被旧 booking 夹具的 hours 参数拒收，尚未走到派发，待 trunk-fixes-4 合入再核，不记成通过。

合入 trunk-fixes-4 后，包测试 284 项与 96 个发布作者样例通过，场景 28 完整复跑 7 项通过，类型、合约生成和包清单检查通过。场景同时钉住一次预算的固定拒绝码、原作业继续冻结、另一核验运行不能越过冻结，以及具名对账后的后续派发。

生成前回执可以明确列出 workbook_verified 的 missing_input；客户端只在这一项是当前唯一条目的未核对缺输入、且其余必需计划要求项全部满足时生成。其他错误、检查失败、确定反驳或别的条目不能借此放行；生成后仍须上传原字节并开后继核验运行。

## R5 typed-address remediation in progress

Owner ruling R5 (2026-10-24) replaces the historical deny-word and address-appearance policies described above.
The legacy signature reader proves object/method identity, signature kind and required/default fields only; its
parsed methods currently carry no validated type/effect authority. Local profile roles and reviewed flags cannot
supply that authority. Missing authority leaves checks unknown with missing_input, stops client generation and
prevents an existing workbook from acquiring a support receipt or dispatch parameters. Hub binds the actual named
recovery recipient and deadline; the pack does not invent account IDs or timestamps.

The internal replacement helper accepts explicit exact spans only (UTF-16 indexes into the unchanged string).
It never discovers spans by scanning prose. The caller must obtain them from a validated typed binding and retain
its original reference identity; this helper alone does not establish that authority. No spans means no rewrite.
Signature binding is separate from the POSIX command lexer: a G-encodable ordinary literal is not automatically
shell text. Only a declared command role invokes that lexer, on the original glyphs without NFKC conversion.

The original synthetic pre-R5 workbook is retained unchanged in testing/legacy-untyped-workbook.json, including its
source revision and byte digest. It is an unverified historical fixture, never a new typed release. Model M4/M5,
R4 complete command grammar and the R7 expected-source identity remain integration prerequisites. No new vocabulary
values or wire type/effect schema are guessed here. The full package examples, generated vocabulary, manifest and
new version will be migrated and verified after the integrator supplies the frozen model commit. Legacy positive
samples are not evidence of completed remediation and this work-in-progress tree is not a publishable release.

## R5：runtime-contract@2

新合约沿用原始签名、完整性字段和 canonical 摘要计算，schema 精确为 runtime-contract@2，并新增 types、roles、effects 三个以 id 为键的闭集对象；effects[id] 可声明 allowed_programs（{program, address_prefix?}），放行声明程序的静态主机命令。types[id] 包含 declaration（共享 DeclaredParameterType，catalog_type 必填），可声明 address_kind（共享 TypedAddressValue 的 kind）、数值/长度上下界、values 或 literal；roles[id] 包含来源 source，地址用途须显式给 bed_member 布尔值；effects[id] 包含 source、roles、每计划调用预算 budget，以及按需明确的完整 commands、allowed_literals、command_roles（signature、零基 position、role）。每个启用条目的 typed_authority 给 source、parameters[name]={type,role} 和 effects id 列表。allowed 项的 unsupplied 列出永不传入的可选参数：这些名字不计入个数，也不要求类型和角色；授权里若仍写了它们，照常接受。计划写入这些参数则拒绝。必需参数不能列入该名单。来源均为结构化 Ground 引用，作为合约作者声明保留，不冒充设备观察。合约身份仍覆盖全部字段。旧合约只核原身份，authority=null，一律未核对并阻止生成、回读受理与派发。

设备命令由 Hub 提供锁定根的完整 commands@1 目录，复用 FAMX 的同一套精确语法从计划命令解析出 CommandIdentity，不要求自然语言用例或模型预先提供身份。逐词核路径，参数按树声明类型完整消费；不接受缩写、前缀、散文抽取或文本折叠。case_index 若有 data.command_identities，则从相同知识根按 document/node 精确取出，并额外核计划身份一致；畸形声明记未知。模型额外交身份时也核一致，不能代替原生目录。身份比较忽略 raw 的展示差异，但逐参数重核 raw 与 parsed 一致；显式替换仅改变已声明地址参数，保持根、签名和类型出处。普通字符串和期望正文不扫描地址；掩码/前缀按其声明语法核验，不按网络形状猜用途。替换源必须来自冻结类型化参数，目标须在自动化测试环境/本血缘租约中。

派发允许集合来自方法、角色闭集、完整命令/字面效果允许集合及预算。denied 字段和拒绝词表已经退役；host_shell 另保留已声明的静态 POSIX 子集语法限制（无扩展、管道或重定向）。同一检查用于计划、客户端生成、独立工作簿回读和派发前重核；工作簿生成器升至 @3，旧记录不改写，新合约须重新绑定后生成新运行及新制品。缺事实时由当前运行者请求合约发布管理员补声明或绑定命令索引，按 Hub 具名补证请求继续。本次续接未运行验证。

新合成样例见 examples/runtime-contract-v2.json、runtime-profile-v2.json 和 command-identities-v2.json；类型/角色/效果引用逐字对应 typed-authority-source.json 的实际摘要，命令签名对应 command-tree-v2.xml 的实际摘要。它们是示例资源，不是已执行或已验证的结果；旧合约与旧工作簿夹具字节保留。

## W10 第二步：冻结的已受理判据声明（3.0.2）

`expected_grounded` 现在也认本次运行冻结的已受理判据声明（W10、B03 R[0]、决定 35 第 58 项）：

- 声明由 Hub 在开新修订时冻结进 RunContext（`accepted_criteria`，全文加 `declaration`/`review` 的 `rec:` 引用与复核人账号）。包只读这些字段，按条目身份精确取本条目的声明，不扫任何正文。
- 期望可以逐字取自新判据：`expects[i].quote.reference` 精确等于冻结声明的 `declaration`，`quote.text` 与冻结的 `new` 逐字相等（客户端的副本不算数，包比对冻结字节），`text` 是 `new` 的精确片段（同一 `quoteMatches`，只折叠引文空白）。三者有一处不符按 `expect_not_in_criterion` 退回该条，不整份拒收。
- 没有冻结声明、声明属于别的条目、或引用不是任何冻结声明时，规则与之前完全一样：期望必须逐字出自它自己引的来源（`expect_not_in_quote`）。
- 引文的引用是 `rec:`（记录引用，也就是判据声明的写法）而本次运行没有冻结这条声明时，没有可比对的冻结字节：按 `expect_not_in_criterion` 退回该条，并写明缺的事实（本运行冻结的声明）和下一步（由作者以外的账号复核接受后以本运行为前驱开新修订，或改回逐字出自期望来源的引文）。判定只看引用声明的方案，不读任何正文。
- 新判据的引文（声明的 `grounds`）由 `expected_quotes`（quote@1）在本次运行自己的边界上重核（B03 R[3]）：`quoteSubject` 把这类期望的引文换成声明的 grounds，来源没有绑定到本次运行就是未知加补读出口，不当已通过。
- 支持的结论写出声明、复核结果与复核人账号，`data.accepted_criteria` 带同样的引用，便于回执和运行页显示。

测试：`functions/criterion-grounding.test.ts` 七条，用包已发布的 runtime-contract@2 样例（合约、配置、命令身份）作类型化夹具，改前（主线 `d5aa4a68`）整个文件因缺 `criteriaOf` 加载失败，改后七条全过；覆盖冻结声明逐字接地并写出声明/复核/复核人、未冻结或属于别条目的引用不接地、客户端副本与冻结字节不符按 `expect_not_in_criterion` 退回、同一条目里引文接地与判据接地并存、grounds 交 quote@1 在本次边界重核、以及缺 grounds/新判据/复核身份的声明不可用。

未做（下一步）：整链合成验收“用例的期望和手册对不上 → 作者提交声明 → 作者以外的账号开复核运行接受 → 新修订通过；未接受时照旧不通过”还没有写；它要 case-compile 与 criterion-review 两个包在同一张合成自动化测试环境上跑通，而 R5 的类型化夹具迁移尚未完成（本包 303 条里 128 条在主线就失败，原因是旧夹具的 profile/contract 不合 runtime-contract@2）。缺的事实：可跑通整链的类型化夹具与验收自动化测试环境；下一步：R5 负责人完成夹具迁移后补这条验收。本次未运行该场景，不宣称已证明。

## runtime-contract@2 夹具迁移（3.1.3）

常规测试显式声明参数类型、角色闭集、效果预算、来源引用和冻结 CommandIdentity；旧合约只由具名 legacy 夹具覆盖，仍应返回未核对并阻止生成或派发。修改命令文字不会自动补身份或授权。地址测试按声明的位置和用途核验，普通文字不扫描；期望引文按原文逐字核对，不沿用旧空白折叠或隐式地址替换。

工作簿夹具和支持回执钉原合约身份，@2 增补摘要单独保留。客户端从已受理运行提取生成输入时，读取 commands_known 的锁根语法回执（含完整计划命令、相关签名与原生类型出处）；生成器和独立回读复用相同语法核验，不能用模型自报身份或目录替代回执。发布样例覆盖七项检查，另有显式地址成员和效果预算的正反例；历史未类型化工作簿的字节与摘要不改写。全部资源和合约均为合成数据。

计划命令目录读取（3.2.1）：`catalog_select` 从冻结合约与 profile 的 device_cli 参数角色取完整命令行；Hub 在构建 subject 前沿锁定树的精确令牌路径取所需签名，各项检查共用一次选择，不把整棵目录作为检查来源。路径上的祖先签名保留以核歧义，完整语法仍必须消费全部参数，不能用缩写、前缀或散文抽取补出命令。目录读取超出界限或失败时记缺失与拆分/修复出口，禁止退回全目录读取。生成器和独立工作簿回读继续使用同一份选中语法回执。

计划身份可选声明（3.2.2）：plan 的 command_identities 通常省略，默认样例和客户端指令都不要求模型构造原生类型值。只从 steps 的设备命令行及锁定目录解析身份。模型主动交声明时，commands_known 核其结构和完整身份集合，一致才受理；错误提示允许删除可选声明重交。模型声明不进入 contract_shape、地址和期望的共同前置校验；用例本身的明确身份声明仍单独核一致。合成 Hub 回归在没有用例身份槽和模型身份声明时完成计划、客户端工作簿生成、后继回读并满足全部要求项。

显式模型期望（3.3.0）：expects 可写 `{text, quote, after, basis:"model_judgment", rationale}`。basis 来自生成合约 expectation_basis 闭集，rationale 必须非空。quote 的引用必须完全等于本次被判对象中该用例期望节点的冻结引用，其文字逐字来自该节点；标题、步骤、其他用例、外部来源和判据 rec: 均不能代替。期望节点身份由现有用例结构解析在投影时固定，不按词语或标记猜类别。text 由模型选择设备可观察的检查文字，仍须满足单行、profile/原合约取值规则和 after 指向设备或主机步骤；Hub 不判断选择是否正确。省略 basis 时仍执行原来的引文片段规则，W10 的 expected 来源和独立复核规则不变。

Hub 按检查声明的 judgment_sources，从本条目原始提交的精确槽位指针记录模型主张，绑定真实提交声明的模型、提交摘要及记录；basis、rationale、quote、text、after 一并保留。机械核验仍是事实，模型选择单独记判断，expected_grounded 显示“满足（判断）”，并标“以判断为前提”。工作簿字节逐行回读保持机械事实；生成配方摘要绑定完整期望形状及冻结期望节点。派发冻结相关必需项中的模型前提，设备 PASS/FAIL、各轮和回注结果继承限定及原判断；旧或无效前提不能被静默丢弃成无限定放行。Hub 不调用模型。

## 声明范围、逆操作与作者命令义务

`runtime-contract@2.effects[id].command_scope` 是锁定命令树路径前缀的闭集，例如 `/commands/demo/pool` 与 `/commands/no/demo/pool`。按完整路径段匹配；`pool` 不覆盖 `poolish`。`commands` 可以省略；同时声明时与范围取交集，显式空数组仍是不允许。没有两种声明时设备 CLI 不获授权。所有命令先由原有锁定语法完整解析为唯一 CommandIdentity，参数类型、原始角色、地址用途、bed_member 和预算继续逐项核对。见 `examples/runtime-contract-scope.json`。

产品包的 `command_policy` 随知识组成冻结，再随运行传入检查；不是模型槽位，也不读取后来换版的产品声明。`read_only` 只取声明的路径范围；其余设备命令须有规则映射的逆操作。规则映射 source_prefix 到 inverse_prefix，保留剩余路径与前导参数；`leading_parameters` 可明确给出数量，省略时须由已完整解析的逆签名唯一确定。缺规则或有歧义时保持未知并请求产品作者补声明；规则推出的逆路径不在锁定树里时也一样，那条清理没有计划写得出。清理是 steps 的末尾连续段，显式 `cleanup:true`，同设备按主段改动的逆序对应；逆操作本身也必须通过锁定树、合约范围、类型和角色核验。目录只取计划实际命令、冻结作者片段和它们按产品规则推出的逆命令的路径，沿确切的边走，不展开整个 `/commands`；推出的命令放不下时一条也不取，这时逆路径存在性由计划中完整解析的清理命令证明。

作者片段按原有完整行语法解析，不截散文。出现次数按定义身份（来源根、完整路径、签名引用）计，不把参数值当成必须保留的文字；计划仍须独立核参数。可以改参数，不可以删命令：同一定义的执行次数至少等于作者次数，清理段不充数，缺失次数写入阻断结果的 `data.obligations` 并随结果留存。工作簿生成、独立核验、派发前检查共用这些边界。

容量来自冻结 profile 的显式 ordinal 与自动化测试环境同类型设备计数，不读对象名中的数字。设备座位还不超过冻结的预检设备数；主机映射若声明 ordinal，也按其类型计数核对。越界时投影整份拒绝，写明“框架取不到那台设备，整卷不跑”，没有部分工作簿。旧根缺产品规则时设备计划保持未知，需升级产品包并重新育苗，不能从命令文字猜只读/修改。

### 持久化通道：执行顺序与互斥组合

产品的 `command_policy` 可声明 `persistence_channels` 和 `forbidden_combinations`，以锁定命令树的路径和可选参数位置说明哪些命令留下状态、哪些命令不能同时使用；`source` 保留手册原文。没有声明时保持原有行为。本包不带产品的真实声明。

`functions/channels.ts` 按已解析的命令身份读规则。留下状态的用例排到自动化用例 Excel 最后，其余顺序保持；生成器、独立读取器和交付工具用同一顺序，并保留调整顺序的用例和依据。

`commands_known` 拒绝一个自动化用例同时含互斥命令；`generate-workbook.ts` 在写文件前检查跨用例冲突，`workbook_verified` 再拒绝两侧用例，说明用例、命令和手册依据。这份 Excel 不进入上机验证。

参考方法是 InfoTest `persistence.py` 的 `case_channels`、`order_volume`、`coexist_violations`；本实现按命令树结构读取。测试位于 `functions/channels.test.ts`、`tools/volume-order.test.ts` 和技能模块的 `command-policy.test.ts`。本次只执行第一个测试文件，5 项正确、0 项错误、0 项跳过。

### 公开线的互逆与触发核对（3.8.7）

3.8.7 采用公开仓库 case-compile 已有的三处修正（公开提交 ac95f6f6、ebfec96f、2dc82f3c；公开 main 上是 3.8.6，与本线改动合并后的公开快照是 3.8.7），上面两段已按它改写。命令树里的联合类型参数（例如 IPADDR 是 IPv4 或 IPv6）由产品包生成器发布成同一签名引用下的几个目录签名（编号 k.1、k.2），CommandIdentity 的签名引用仍是这一个。互逆对按参数位置跨这些展开逐一核对：没有哪个展开在该位置声明含这对值的枚举，该位置就不是互逆备选，命令照常走声明的前缀逆规则；每个展开都在该位置声明同一个枚举，才换成配对值；展开在这样的位置不一致，仍记未知（公开 issue #56，验收场景 28）。3.8.5 及以前，本线在条目的任意签名、任意位置找含该取值的枚举，可能把文本参数当成可互逆；一条命令有两处可互逆时退回前缀规则；`trigger_types` 的空数组等于全闭集，闭集外的类型被静默滤掉。

### Sibling switches and declared trigger narrowing

After the matched enum-parameter form, a declared inverse pair can name two complete sibling leaf paths of the same
locked parent. Both paths and the paired command with unchanged bound parameters must fully parse; a missing leaf
or ambiguous target is not guessed from prose. Ordinary prefix rules remain as declared.

The default trigger types are the package's closed router/client/server set. A published profile may narrow it with
`trigger_types`; an omitted field uses the default, while an explicit empty array declares no trigger types. Types
outside the package's closed trigger set are rejected rather than silently filtered. The reachability rules still
use the frozen bed interfaces and declared capability, not keyword inference or an observed connectivity claim.

### 联合类型参数与声明的互逆对（3.8.6）

命令树里的联合类型参数（例如 IPADDR 是 IPv4 或 IPv6）由产品包生成器发布成同一签名引用下的几个目录签名（编号 k.1、k.2），CommandIdentity 的签名引用仍是这一个。互逆对按参数位置跨这些展开逐一核对：没有哪个展开在该位置声明含这对值的枚举，该位置就不是互逆备选，命令照常走声明的前缀逆规则；每个展开都在该位置声明同一个枚举，才换成配对值；展开在这样的位置不一致，仍记未知。3.8.5 及以前把同一引用下参数不同的展开一律当作歧义，带地址参数的配置命令即使没有枚举也停在“声明的枚举互逆不能在同一签名中得到唯一完整身份”（issue #56，验收场景 28）。

## 块模型（R5 B1，先声明后实现）

计划仍由客户端模型写，Hub 只核结构、授权、引文与义务。`runtime.block_model` 与 `runtime.checkpoint_two_argument` 是 runtime-contract@2 加在 runtime 上的增补，恢复原合约身份时按这个闭集剥掉，不进入原合约的规范摘要。原合约 runtime 保留 `minimum_version`、`runner_source`、`runner_sha256` 和 `found_times_supported`。设备回显不在编译时解析：观察对象是一次调用的完整原文输出，不能从实际输出里反签期望。旧 `blocks:[] + steps + expects` 继续使用原规则；新计划用非空 blocks，steps/expects 留空，二者不能混写。唯一闭集正本是包声明 `tables/blocks-format.json`；槽位模式由本包生成器从它产生，代码不再维护另一份种类枚举。

| 块种类 | 第一版 | 语义 |
| --- | --- | --- |
| CONFIG | 启用 | 原名调用，保留完整命令解析、参数、角色与效果授权 |
| OBSERVE_ASSERT | 启用 | 一次声明会产原文的调用，配 1..n 条显式指向该输出的断言 |
| OBSERVE_ONLY | 启用 | 仅观察；不能凭它履约作者期望 |
| CAPTURE | 启用 | 将该次完整原文输出存入唯一命名寄存器 |
| CAPTURE_COMPARE | 启用 | 引用前序两个捕获，比较 same / differs，明确第二次输出身份 |
| EXPECT_FROM | 启用 | 新观察的期望取自前序寄存器，显式指向本次输出 |
| SLEEP | 启用 | 已授权 wait 调用及显式秒数，不产生可断言输出 |
| STEP | 启用 | 普通已授权调用；只有显式声明输出且合约确认的调用才是观察 |
| RESTORE_FROM | 启用但需执行器能力 | 改动前捕获、末尾按逆序恢复；关联原配置块，不把未知捕获值伪造为静态 CommandIdentity |
| OBSERVE_DIST | 暂缓 | 缺少已发布的区间/守恒派生规则与运行器执行声明；出口是补声明及配套合成正反例，不生成任意正则 |
| OBSERVE_MEMBER | 暂缓 | 缺少已发布的成员关系派生与执行声明；出口同上，不能从产品回显猜成员 |
| OBSERVE_EXIT | 暂缓 | 退出码与输出文字不是同一通道；缺受认证退出状态通道，不靠标记词猜成功。保留在统一闭集，使用时明确 unknown 与补能力出口 |

每块有唯一 id，调用仍写 object/method/args/keywords，设备和主机来自冻结 profile，不用产品名或命令词猜角色。CONFIG 与 STEP 不绕过现有原始合约、范围授权、地址与作者命令计次检查。cleanup 是显式末尾段，末尾恢复不计入“最后一次业务配置”。

| 断言族 | 输入与卷面终形 |
| --- | --- |
| found | 输入是 literal；使用正则型运行器时只写机械转义后的字面，不接收自由正则 |
| not_found | 静态 literal 同样转义；寄存器来源必须有运行器声明的字面否定方法，否则 unknown |
| abs_found | 原文字面搜索，不把元字符解释成正则 |
| found_times | literal 加正整数次数；仅在合约 found_times_supported=true 时使用，G 为转义字面、H 空、I 为次数 |

所有断言都有 output（块 id），不是暗指最后一行。一般断言紧跟其明确观察输出；捕获比较可由 I 指定已保存的第二次原文。H 在普通行是写寄存器，在检查点是期望来源；I 在检查点是实际值寄存器（计数检查点例外为次数），普通恢复行是原运行器声明的输入引用。模型不能自行把 G 中的寄存器名变成引用。

寄存器只存原文，不裁剪、不抽字段、不读词表。CAPTURE_COMPARE 的 same 以双向字面包含构造全值相等（两条 abs_found），differs 需要声明的全值字面不等方法；不能把单向包含当相等，也不能把未知原文交给正则型 not_found。EXPECT_FROM 的 found 在构造时统一归为 abs_found，生成与回读使用同一终形声明。该构造按合成运行器的 H/I 列声明核对，不含其他系统的源码或业务数据。

跨步机械门：寄存器必须先捕获后引用；断言必须指向已声明会产原文的观察；最后一次业务配置不晚于最后一次观察。寄存器和块 id 不重复；等待/配置不能冒充观察。缺运行器输出/寄存器能力声明记 unknown，前向引用、指错输出等结构矛盾记 refute。

恢复到捕获值要求 CAPTURE 在所关联配置之前、同一设备、清理段逆序且完整使用该寄存器。它只能经合约明确声明的 guarded restore 方法：运行器必须在发送前核验插值后完整命令的锁根语法、效果范围与参数角色。普通 cmd_config 的 `{}` 不能当作已知命令放行。现有运行器不具备该守卫时计划保留 unknown，并给执行器维护者补能力、重新发布合约/profile 的出口；不在核心增加设备语义，不默默打开真实执行器。

R03：每个新断言绑定期望身份、逐字 quote 与显式类型（字面/次数/捕获关系）。否定结果用 `not_found`，不另立判据；其它描述性期望不能直接当检查文字，需要模型提出类型化判据及理由，再以独立复核的 Hub 记录接入；上传的自述 review JSON 无效。复核阶段放在本目录的独立阶段声明中，复用现有只读前驱和账号独立核验；主包同时核绑定的复核运行快照与结果，防止拿无关前驱伪造独立性。既有 W10 期望来源角色规则不变。

W06：本用例全部期望节点有稳定引用身份；每条都映射到断言或显式 unmet（缺事实和下一步），遗漏是未履约，不能只核模型挑中的节点。unmet 不当作满足或可派发。W07：前置、因果边、交互应答者由模型显式声明（无此类前置也要明确空表），代码只核来源、引用图与顺序；缺声明 unknown，矛盾 refute，不通过搜索正文猜前置或应答者。

新运行器能力默认关闭，checkpoint_two_argument、寄存器 H/I、捕获恢复与 found_times 必须来自完整合约的结构字段及本轮 profile 允许组合。工作簿生成和独立回读都核 E/F/G/H/I、输出指向和寄存器定义使用关系；身份配方绑定原始块计划、全部作者期望及最终展开。旧计划不被强行套进新的块语言，不因此承诺它已有块级表达能力。

字面声明的结构依据：新块读取作者期望节点 data.assertion 中的 op/literal/count；原文没有这组明确声明时，`not_found` 按否定结果检查，其它算子保留 unknown，要求模型提出带引文的类型化判据并经独立复核，不通过词语判断“是不是描述性”。旧 flat 语言继续按其已发布的字面 text 规则，不宣称它已经具备块语言的判据能力。

复核阶段发布目录是本目录的 review/，id=case-compile-criterion-review；先用其 api.ts stage/publish 并分配给独立复核账号。作者提交判据后共享该运行的只读视图，复核者以原声明运行为 predecessor 绑定原提交和 evidence；主包绑定该复核的真实 run 快照与 validation 结果，核实际前驱相等及账号独立标记。此阶段不会修改旧 W10 或核心角色规则。

## 重组阶段（R5 B2）

重组独立于评审和编写：模型提交 recompose-record@1 三元契约、来源状态和四本账；工作包只核结构、全集、声明、来源及凭证。编写显式绑定重组的实际运行和已受理结果，不能用评审记录或原件 steps/expects 代替。旧 flat 计划路径保留。

四项实现口径：①现有全局词表没有等价的知识位置三值；局部工作语言闭集写在 tables/recompose-format.json，不借用含义不同的全局枚举。②R05 使用现有逐条提交、分区和追加记录：完整节点清单冻结，允许分片提交，每次从实际全集重算缺案，封批要求无遗漏、无重复且所有要求项满足；后版须以同一来源身份的旧运行作 predecessor，禁止跨来源冒接。③R03 接 B1 的 criteria/obligations：重组记录里每条期望的判断依据保持原件身份，可携 criterion_id，编写期仍由 B1 核算子、引文与独立判据复核，不把重组方法当设备事实。④只用 recompose-sources@1，废弃误拼的 recompute-sources@1；与仓库既有 schema 无冲突。

发布单元均在本目录：authority/（recompose-authority，产品声明凭证）、recompose/（recompose，独立重组）、adjudicate/（recompose-adjudication，对每条用例原句的独立裁定）。管理员一次性绑定实际产品包发布记录、发布授权和与清单 SHA 相等的 product.json；从产品生产器 params.recompose 中读 recompose-product@1 声明，再把已受理来源凭证分享给执行者。工作包没有默认规范来源排序，模型的 product-declared 字样不构成权威。普通执行者绑定可共享的真实 Hub 快照和结果，不需要管理员读所有原件。当前产品没有声明时，等待产品包作者补声明并重发。

节点资格由 compile-structure@1 声明：autoid 与原始 auto 值按完全相等闭集；未声明标记单独报告，不按标题或自然语言判断。深度由层级和声明参数核对；嵌套用例、没有任何子节点的用例和与结构不符的 compile_layout 保留为未判定条目。三种布局共用同一结构投影：用例自身动作+直接叶期望；标题/动作/叶期望；标题加动作树（步骤可一层套一层，动作下的叶子是它的期望，步骤旁的叶子是没有期望的动作）。优先级等于 precondition_priority 的叶子在三种布局里都是前置，落成没有期望的动作。值为空的 autoid、auto 键等于没有声明；编号、行和方括号定位是声明的语法，原文字节不改。没有作者定位的多动作/多期望不强配，未绑定的用例原句单列并给作者补定位出口。

覆盖分母是结构投影得出的用例原句全集，不采信模型 author_atoms 自报；mapped/unmapped 由代码与全集双向比。原文账只存用例原句的逐字内容，释义另留说明。改写项的 action 为声明操作，commands 为完整命令行，按锁定树比较定义身份及次数；等价理由附声明引用。实际参数变化按产品声明的语义角色核 load_bearing，未能机械判定的语义由独立裁定提出且带逐字引文。具体化只接作者/规范来源/目录声明的值，缺来源或权限一律未知，点名产品包作者或重组者及提交前时点。

床无关按类型与来源判定：重组输入不读取 inventory；账本结构不允许物理床、座位或设备字段，具体化的来源闭集不含自动化测试环境，重组阶段 rebindings 为空。不会拿床名词表扫散文，也不会因作者原文地址恰好与某床相等就改写原文；散文是否带入物理语义由带引文的独立裁定披露。对两床运行同一产物，字节及结论必须一致。物理替换仅在编写阶段的类型化 replacements 与用例参数替换中执行。

孪生文件入库迁移：原示意中的占位引用、释义原文账、本机路径和自述裁定改成可核引用与合成凭证；四种预期状态不变。原 README 中的真实名扫描模式不作为数据复制。检查脚本改写为 TypeScript，使用已安装技能的解析接口，不恢复核心默认 KityMinder。

R05 首版采用单个冻结任务集合、逐案草稿和无损客户端汇总，不引入另一份可变本地权威账本。tools/seal-recompose.ts 接收 --run、--parts、--model、--out；parts 是实际提交导出的数组，按显式顺序选最新候选，不依赖墙钟。输出永远是 admitted:false 的草稿：已知原记录保持原样，尚未登记的目标也保留为空槽；真正的封批取决于 Hub 的完整集合和全部条目要求项。超出平台预算时保留预算出口，不能静默截断或让分片宣称整份来源完成。

完整交付回归还修复了 B1 的指纹边界：客户公共摘要没有私有裁定组，工作簿指纹改绑定两份不变的复核记录引用，服务端仍先完整核验原记录、账号与内容；不拿客户端自述当受理。新端到端覆盖重组、独立判据、摘要导出、生成和后继回读。

B2 所需平台机制仅有通用只读运行上下文（实际 run、predecessor、冻结 product_pack_digest）及默认关闭的 incremental_submissions。后者只让保留已有全部材料、首次填空槽且仅有 unknown 的要求项不计修复；删除、替换、换模型或真实违反仍沿用原预算。旧工作流默认不启用。公共运行摘要不暴露私有锁字段，历史记录不回填产品包摘要。

补充结构口径：标题/步骤布局把标题也保留为意图用例原句；未编号多行期望不切碎，编号与方括号标签按原样文字匹配，大小写或前导零不归一化。唯一层级父动作可以绑定无冲突的期望标签；存在冲突显式动作引用、多动作未定位或未知角色时单列未判定。span 是解析后文字的 UTF-16 代码单元位置；原始字节及解析器身份仍由 Hub 原件/引用机制保存。

legacy 兼容路径在条目字段中明确标为“未走重组阶段，不代表重组完成”。新客户端使用 pipeline=recomposed，缺真实重组凭证时全部后续核验保持未知，不允许拿 flat steps/expects 或评审回执冒充重组受理。

### 块调用的类型化地址核对

地址入口统一先用 readSlots 解析作者计划：原始 blocks 中步骤数组为空，也必须展开为同一套类型化调用。观察、配置、显式清理与 RESTORE_FROM 的已声明参数逐个进入现有角色、bed_member、床接口/本血缘租约与触发可达规则；完整命令按锁定目录解析后，其类型化地址参数也进入同一检查。位置保留 /data/blocks/<序号>/call/...，角色违规的首要位置同样落回对应块。普通文本与捕获原文不扫描，不按 VIP、方法名或文字推地址用途。

规范化只发生在解析产物上，作者输入与引用不改；非空块计划结构不合式时，不得被当成空地址计划。扁平 PlanSlots 沿用既有已校验入口，新增降阶分支只处理非空 blocks。冻结 profile 的设备序号容量检查在计划读取前就执行，超限仍拒绝整卷；块计划不能绕过。捕获原文在编译时未知时，仍依赖已声明的发送前语法、角色和效果守卫，不把未知原文猜成合法地址。

### 3.11.1: the auditor's rules and the long literals' lengths are in the brief; a tool merges the verdicts

Three things the first real audit showed (run 19). The session under audit typed the auditor's rules into each task description:
verbatim the first time, paraphrased the second, and by the third with sentences that named the verdict ("…判 preserved"); the
reference engine's auditor has fixed instructions the authoring side cannot touch. The rules are now part of the brief (and so of
its digest), and the task description is one fixed sentence that names the brief files. An auditor counted an expanded
253-character name as 249 and returned a false "changed"; the brief now states the measured length of every literal of 32
characters or more (`literal_lengths`, with the length of each dotted label). The model merged seventeen verdicts into the case
files by hand and one reached the Hub with the verdict of an earlier plan; `tools/fidelity-apply.ts` merges a verdict only when the
brief it answered is still the plan's, writes the digest itself and says before submitting what the Hub would send back.
`tools/fidelity-brief.ts` keeps one brief directory across repairs and lists only the briefs to audit: a brief and its verdict carry
the first eight digits of the brief's digest in their names, so an unchanged plan keeps its verdict, a changed plan gets a new brief
file, and nothing is overwritten or renamed. The Hub's check is unchanged apart from the brief's content.

### 3.11.2: the device method, the caret, and the wait, each the reference engine's way

Run 19 closed one case after three rounds on the same device answer: a command typed with the method for the other prompt, the
device's lone caret under its first word, read as the bed lacking a configuration; and the model spent 3550 seconds asleep in
guessed blocks, 13 minutes of them after the last job had ended. The reference engine has a mechanism for each, and none was here.

- **Method.** Its block compiler lowers every device configuration and observation to one method and leaves the model no
  choice (`main/case_compiler/blocks.py`); the bed's existing scripts send observations the same way. Step 2 of SKILL.md now says
  that a device step, configuration or observation, uses the method the runner contract declares for that device's output
  (`runtime.block_model.output_methods`). It is an instruction, not a check: the reference engine's generic step may still name
  any enabled method.
- **Caret.** Its one mechanical pre-judgement of a failed case is the device's syntax rejection
  (`fail_attribution.attribute_fail`: the command was not accepted, fix it first, later failures in the case mostly follow).
  `functions/delivery.ts syntaxRejections` reads it by position: a session line holding only a caret, the echoed command on the
  line directly above, the word under the caret (when the echo carries no prompt) and the prompt the command was typed at (when
  that line is within eight lines above). `tools/download-returns.ts` lists them per row as `syntax_rejected` in `index.json`,
  empty when the row's sessions have none, and counts them in its last line. Replayed over run 19's three failed dispatches it
  names that one case each round and nothing in the other twenty-one failed returns. The device's help at the caret position,
  which the reference engine also attaches, needs a device read the Hub does not have and is not ported.
- **Wait.** Its run tool returns when the bed has finished; the model makes one call. Here the Hub runs the job in its own
  process, sends the client nothing when it ends and asks for the submission to be repeated, and the skill's local tools had no
  way to wait. `tools/download-returns.ts --wait <seconds>` reads the Hub's job list every 20 seconds until every job of the
  run has ended, then writes the returns and prints the verdict counts; a read that fails on the way is tried again, a run that
  shows no job for five minutes is reported as not dispatched, and at the limit nothing is written. Started as a background
  command, the client tells the model when it exits. The Hub is unchanged.

### 3.11.3: a syntax rejection is not a defect candidate

Run 19 delivered one case as 声明与设备行为冲突（待仲裁） on the caret under a command typed at the wrong prompt: both quotes of its
candidate verified verbatim, so `closeFailed` took it. The reference engine does not: a lone caret is its grammar-layer fault named
by program, and a defect candidate "represents a signed expected-vs-device-actual product finding, not a grammar, environment,
transient, or engine fault" (`submit_attribution`); a product claim needs the author's scenario realized on the device, and a
command the device did not accept was not. `closeFailed` now refuses a candidate for a case whose last device output holds a
syntax rejection (`syntaxRejections`), naming the commands; the case goes on to its rounds and at the cap closes as the model not
finding a solution. The reference engine can still tell a wrong form from a command the build lacks, by asking the device for help
at the caret; without that read here, such a case is not claimed as a product finding.

### 3.12.0: a command's access level against the prompt its method sends at

The first of three items the owner handed over on 2026-11-10 from the statistics of runs 16 to 19: stop before dispatch what a
deterministic check can know. Thirteen commands in those runs were answered with a caret, all of them commands of one access
level typed with the method of the other prompt; the head, the argument count and the types were right each time, which is
what the locked-tree parse already checks. Three facts decide it, each with its owner:

- the locked tree's level for the command (`CatalogSignature.access`, from the product pack's parser);
- the runner contract's declaration, with evidence, of the levels the prompt of a method refuses
  (`refused_access`: `{ source, sha256, rows: [{ object, method, access: [level…] }] }`, a runtime-contract@2 addition that leaves
  the pinned identity alone; a row for a pair the contract does not enable is refused as stale);
- the plan's step, which names the object and the method.

`functions/plan-commands.ts accessRefusal` refuses a device command only when all three are there and the level is in the
method's row; the message names the level, the method and the device methods of the same object without that refusal. A
signature without a level, a method without a row and a level the row does not list are not checked: only refusals with
evidence are declared (the same commands' level typed at the other prompt was accepted every time, and two more levels of
the tree have no evidence either way), and nothing is read from a method's name. The refusal is a plan error
(`method_forbidden`), not a missing fact. The reference engine has no such check because its compiler leaves the model no
choice of method; SKILL.md step 2 states that rule for authoring since 3.11.2, and this makes it mechanical.

### 3.12.1: "the repair rounds were used up" is the run's counter, not a reason on one requirement

Since 3.11.0 a case that never went to the bed closes as the model not finding a solution when the Hub left its plan without an
accepted version after the repair rounds, as the reference engine closes a case whose authored attempts were all refused at its
cap. `missingFactOf` read that from a requirement layer whose reason is `repair_exhausted`. The Hub writes that reason on a
requirement that has no repair rounds of its own (the plan slot) the first time an item is handed in as skipped: in run 20 a case
declared skipped in the first submission, with both rounds unused, already carried it, and would have closed without one authored
attempt. The tool now also requires the result's own counter (`rounds.used` not below `rounds.max`); a case handed in as skipped
while rounds are left goes back to authoring, as the reference engine's rule says of a written claim.

### 3.12.2: a dropped pass is reworked like a failure, and a declared skip is never an authored attempt

Run 20 delivered twelve cases and showed three places where the closing rules let a case end short of the reference engine's.

- **A pass the pass review drops goes back to its author.** The reference engine downgrades a pass whose log carries an
  execution-failure marker its assertions do not read when it reads the verdict (`tools/device/batch_tools.py`: `broken`,
  subtype `errored`), and `compile_engine/nodes.py` `author_redispatch_disposition` sends failed, contradicted and
  broken-errored cases back to the author under the one round cap. Here the review ran only when the delivery was assembled
  and the closing rules looked at failed cases only: a case passed twice by the runner's word, was dropped at the end, was left
  out of the pass volume and handed over as 上机没有结论 after two authored versions. Now `closeFailed` treats a case whose
  latest verdict is a dropped pass as it treats a failure (three rounds, or a verbatim defect candidate), a round is a distinct
  plan that failed or whose pass was dropped, and `tools/download-returns.ts` applies the same review when it writes the returns:
  such a row is listed as `no_verdict` with `runner_verdict` and `pass_review` (where, line), and the printed verdict counts use
  it. Both tools read the markers and the assertions through one function (`passReviewInputs` in `tools/generate-workbook.ts`).
  A plan run that cannot be read leaves its passes as the runner reported them and says they were not reviewed. Replayed over
  run 20's own files, the case is listed as no verdict when its second dispatch is read, an hour and a dispatch earlier.
- **A declared skip is never an authored attempt.** 3.12.1 asked for the run's round counter beside the `repair_exhausted`
  mark; the counter is the run's, and in run 20 the other item of the plan run used a round while the case was declared
  skipped in every submission. The Hub's record tells them apart (the skipped item's entry carries `skip_reason`, its other
  requirements the reason `declared_skip`), and `missingFactOf` now reads that: only an item handed in as an authored plan
  and refused until the rounds were used up closes as the model not finding a solution.
- **The refusals say what to look at.** When no dispatch counts as a whole-volume pass because the review dropped a pass, the
  refusal names the case and the line; a notes file that is not valid JSON is named with the place and the text around it
  (it was answered with the shared reader's sentence for a run input, which told the model to export something).

### 3.12.3: two answers given when the model hands something in

Both come from run 20 and follow the reference engine's timing and words.

- `tools/submit-plans.ts` states the closing rule under the Hub's receipt for every case handed in as skipped, as the reference
  engine answers a case's exit when it is filed ("a free-text claim that the bed lacks data, certificates, topology, or a
  helper is not a terminal credential. Continue authoring the case as written"). The receipt calls the plan slot of a skipped
  item "修复轮数用完" with no round used; the model read that as settled and left the case out for the whole run, and the rule
  reached it only when the delivery was assembled.
- The message for a configuration command whose inverse is not in the locked tree carries the reference engine's two ways out
  (`mechanical_case_gate.py`, `missing_teardown`): an equivalent construction with an object-scoped teardown first, the gap
  reported only when there is none. It said only that the product pack's author has to declare the inverse, and two cases
  stopped there, one of them on a command the model had put in place of the author's.

### 3.12.4: a command the author named stays in the plan, even when the author wrote no arguments

"可以改参数，不可以删命令" counted only author lines that parse as a whole command of the locked tree. An author's line that is
a bare command, or a command followed by a description, parsed as nothing and left no obligation: in run 20 a case's author
wrote a two-word command with no arguments, the plan sent a neighbouring command of the same family in its place, the audit
model judged the step preserved, and the case closed on a missing fact that only the replacement lacked. The reference engine
reads the author's procedure on command heads (`mechanical_case_gate.py`, `author_procedure_coverage`): its resolver answers on
the longest command head whatever the arguments, and an occurrence whose first argument is a description is counted on the head
alone ("adaptation may rewrite a command's arguments, never remove the command").

`namedCommand` (`functions/command-obligations.ts`) finds, for an author's line that is no whole command, the longest command
of the locked tree whose words start the line, when nothing follows or what follows is not ASCII. The plan owes that many
commands of the same path beyond the occurrences the author wrote out in full; a command of another path does not serve.
Two differences from the reference engine, both on the lenient side: a bare head is counted on the command alone (the
reference engine holds it to an occurrence written out in the adapted steps), and an occurrence with a literal first argument
that does not parse as a whole stays uncounted (the reference engine also compares that argument). The Hub's catalog selection
already reads the author's lines along exact tree edges, so the named command's entry is in the catalog the check receives.
Replayed over run 20: none of the 53 accepted case plans has such a line; the one case that replaced the author's command is
refused.

### 3.16.0: device command lines through the declared device methods, a read window for a long command

Run 23, case 16 (a configuration sync between two units), dispatches 3 and 4. The plan configured the peer unit with the
configuration method and later observed it with the enable method. While the sync ran, the device moved the peer's session out
of configuration mode by itself ("***System is busy. No longer in config mode. ***"). The runner's enable method keeps its own
record of the mode and, believing it was still in configuration mode, sent `exit` first; at the enable prompt that logs the
session out (lib/apv/apv.py cmd_enable; the same `exit` ended a manual session at that prompt). Every later command on the
peer timed out, the case's own cleanup of the peer and the runner's cleanup of it were never sent (the runner's cleanup runs over
the same session, so no cleanup rule could have reached the device), and the peer kept its HA and sync settings twice. The
configuration method does not have this problem: when its output shows the enable prompt it takes configuration mode back and
sends the command again. The plan also waited a fixed 120 seconds after the sync command while the sync took about 165.

The reference never leaves this choice to the writer: its block compiler lowers every device configuration and observation to
the configuration method (main/case_compiler/blocks.py, "观测走 cmd_config"; the bed's own scripts call it 217,600 times against
9 calls of the enable method, all `no page`), and it gives a long device step an explicit read window on that method only
(`timeout_s`). The contract already says the same for the block form: its device output methods are the configuration methods.
Now a flat plan follows that declaration (`functions/plan-commands.ts deviceMethodRefusal`): a device command line sent with a
method the contract does not declare for that object's output is refused before dispatch, naming the declared methods the bed
profile allows for device command lines there. A contract without that declaration is not checked. SKILL.md says to use those
methods and to give a long device command its read window (the method's `timeout`, within the profile's `max_wait_seconds`)
instead of a guessed wait. The closing procedure says that a device whose session was lost mid-case did not get its cleanup,
that the batch note names it, and that, as the reference's bed check does on residue, the next volume waits until the bed is
checked and the user is told.

The bed's cleanup script is not changed. Its rule for HA (`clear ha all`, with no `ha off` before it) is refused while the unit
is still in its domain, which matters only on a live session when the plan left HA on; a plan's own cleanup turns HA off, and the
device's refusal is listed by program since 3.15.0.

### 3.15.0: a parameter's value within the manual's statement, authored negatives, commands the device refused

Run 23, one mind map, three dispatches. One case configured a host name with a character the manual's row for that
parameter excludes; the device answered "format error" and its verdict line each time, the case was reworked twice without
changing the name, and it was heading for a defect candidate. The row was not in the locked root (the product pack dropped
block-style table cells, fixed in the product pack 1.7.49) and nothing put a parameter's row beside its command. Another case
kept the author's negative outcome as a sentence in `text`, which the runner searches for word by word, failed on it twice,
and then passed by dropping the check, which the Hub accepted because the expectation still had assertions.

What the reference does, and what this version carries over:

- **The value domain beside the command.** The reference hands its writer, for each argument position, the tree's contract
  and "the value domain in the vendor's own words" from the manual (`lang_query kind=param`); its program rejects on type,
  arity, integer range and closed enumerations and leaves a string's characters to the writer's judgement of that text. The
  authoring brief now lists under each command the manual rows that state its parameters, word for word with their
  references (`functions/authoring-brief.ts parameterRows`; the rows carry `data.parameter` from the product pack). SKILL.md
  says a value must lie within that statement; a step of the author that needs a value outside it while expecting success is
  a conflict between the author and the manual and goes to the user (the reference settles such conflicts before a device
  is touched); a case that tests an invalid input keeps it; and a value only the device produces at run time is not copied
  from an earlier return (reference: "never copy whatever the device happens to show right now").
- **An authored negative is a polarity.** The reference: "a natural-language negative outcome signs semantic polarity, not
  its sentence as a literal device-output token… do not grep the author sentence", and an expectation's polarity is
  found or not_found. SKILL.md no longer offers a "judgement by description" (the runner has none): a negative outcome is a
  `not_found` assertion of the block form, and the check is not dropped. The closing procedure carries the reference's rule
  for a fix, "fixing a case keeps the signed expectations and authored scope".
- **A command the device refused to execute is named by program.** The reference keeps one authority for a device's CLI
  errors (the caret, and the device's one verdict line for a command that fails to execute) and gives the next writer the
  lines of the last run that carry one, with the directive that the fault is in the case's own command sequence.
  `tools/download-returns.ts` now lists them per row as `execution_refused` in `index.json` (session, command, prompt, the
  device's reply up to the declared line; `functions/delivery.ts executionRefusals`), from the failure lines the plan run's
  contract declares, the same lines the pass review reads. Over the three returns of run 23 it names the refused host name
  with the device's reason, the sync command refused for a missing peer entry, and the two key files that did not exist.
  The closing procedure says what to do with them, that a failure repeating after a fix that reached the volume falsifies
  the direction (reference: re-failed after a recompile), and that a refusal of what the manual's statement excludes is a
  conflict between the author and the manual, not a defect candidate.
- The closing procedure says the pass volume is handed in from the same plan directory (the submission tool already leaves
  out the items a run excludes); in run 23 the model had a subagent copy fifteen plan files one by one first.

Not done here, and the owner's to decide. A hook file of the skill's own that refuses a subagent's question (a client
that runs skill hooks arms `hooks.json` beside SKILL.md) was written and tested, but `hooks.json` at a pack's root is not a
place the pack contract lets a pack keep a file, so shipping it needs that contract changed first; the rule stays in the
skill text (3.14.3) and in the acceptance home's guard. And a program check of a string value against a typed domain (length, characters).
The reference has none, and reading the manual's sentence by pattern is not allowed in this repository; the designed way is
a model's typed claim with the manual's row quoted, verified and kept for the build, which a program then applies.

### 3.14.3: when the user is asked

In run 23 a subagent that reworked one case put three questions to the user through the client's question tool: which form
of a command to write (the main session's task text named a form the locked tree does not have), which of two strings the
task text gave, and which fragment of a name to assert on. All three were answerable from the locked tree, the manual and the
files of the run; the owner: "这几个问题看起来都不应该是问用户的，全是自己理解的有问题，应该和infotest一致".

The reference engine gives its ask-the-user tool to the lead agent alone: the definitions of its writer, attributor,
recomposer and fidelity auditor list no such tool, and what they cannot settle goes back to the engine
(`compile_report_underdetermined`, `engine_gap`). The tool's own text reserves it for an answer that changes what happens
next and that no source settles (an ambiguous request, a device verdict that needs a human call, a mind map that lacks a
field no manual or precedent supplies) and tells the agent to pick the obvious option and say so where there is a
conventional default or a fact it can verify itself. SKILL.md now carries that rule as one paragraph, and says a subagent
never asks: what it cannot settle goes into its report to the main agent (budget 9210). The acceptance home's tool guard
refuses the question tool for a subagent's session with the same instruction; that guard is not part of the pack.

### 3.14.2: one writer per case, all sent out together

The prompt of every run since 17 asks for "每条用例的计划编写……各交给一个子代理去做", and the main session has grouped the
cases each time. In run 22 six writers shared sixteen cases and the one that held six took twenty minutes; case 03 went to
nobody. In run 23 the first wave was three writers for nine cases; two finished after 6 and 12 minutes, the one that held
cases 02 and 03 was still working after 47, the main session waited for it, and the other eight cases had not been started.
A brief makes one case cheaper to write; it does not decide how many cases are written at once.

The reference engine fans its writers out in code: one brief and one writer per case, all at once up to a ceiling
(`compile_engine/nodes.py` `_fanout_pool_size(len(_briefs_by_aid))`, `fanout_ceiling.py` `bounded_fanout`), so a hard case
does not hold the others. Here the client's model does the sending out, so the rule is a sentence of SKILL step 2: a writer
gets one case and its brief, all writers go out together, no case shares a writer and no batch waits for another (budget
9060). Nothing else changes.

### 3.14.1: the brief ends with the envelope of the case's plan file

The Hub takes a plan as one statement in a list, `{text, quotes, data}`; `slots.schema.json` describes only `data`, and the
one place that shows the whole file is `examples/submit-result.json`, which the skill text never named. A writer learnt the
shape from a refusal: run 21's first plan submission had 162 schema violations; in run 22 the main session wrote its own
template with the plan slot as an object and `bucket` beside `data`, fourteen plans copied it and all fourteen were refused,
and its `bucket` was the words of the skill sentence instead of the bed the run's profile selects. In run 23 the main session
spent six minutes before it started any writer reading the schema and searching `run.json` for `bucket`, item ids and receipts.

The reference engine hands its writer the envelope's field-level schema (`lang_query` docs `blocks_schema`, section
`mechanical_case_envelope`). Each brief now ends with the envelope of that case's plan file (`planEnvelope`): the item id,
`handling`, the one statement with the case's expected sentences and their references as `quotes`, and in `data` the bed of
the run's bound profile as `bucket`, the empty `blocks`, `replacements`, `steps` and `expects`, and `recomposition` with the
receipt, the case id and one entry per expectation slot. Everything filled in is an identity copied from the frozen run;
the statement's text, the steps, the expectations and each slot's assertions are the writer's and are left empty, and the
Hub refuses an empty text, no expectation and an empty assertion list, so an unfilled envelope cannot pass as a plan. A
test holds the envelope to the outer keys of the pack's example and to the keys the plan schema requires. SKILL step 2 says
the brief ends with it (budget 9020).

### 3.14.0: each case's authoring brief comes with the run

With the root on local disk a search costs nothing, but each search is still a reply of the model. Run 22 made no `get_nodes`
call, and its six plan writers spent 78% of their model time (49 of 63 minutes) in 208 replies that only searched, about 14
seconds each: 91 searches for commands in `knowledge/commands.txt` (the commands the case's recomposition record already
names, their inverse and read-only forms, their neighbours), the rest for the plan format, the bed and the manual. A writer wrote
its first file 4 to 13 minutes after it started, and every rework round starts fresh writers that search again.

The reference implementation does this before a writer starts: its engine builds each case's brief in code
(`compile_engine/briefs.py` `build_brief`) and binds the recompose stage's command grounding to it, and the writer's rule is
"Reuse sealed recompose grounding before querying" (`agents/compile-worker.md`): read it first, query only what it does not
carry. `tools/download-run.ts` now writes `briefs/<index>.md` beside `items/` and `knowledge/` for every item that carries a
recomposition record (`functions/authoring-brief.ts`; `tools/authoring-brief.ts` writes them for a directory downloaded
before). A brief holds facts only, taken by structure:

- the commands the record names: tree references anywhere in the record, and the command lines of its rewrites and of the
  author's own lines followed word by word down the tree; each with its entries exactly as `knowledge/commands.txt` has them,
  reference line included;
- the inverse the product declares for each (`command_policy` of the run, in the cleanup check's own order: a declared pair
  of sibling words such as `… on` and `… off` first, else the inverse rule with the longest prefix and its leading
  parameters), with that command's entries, or the statement that the path the rule gives is not in the locked tree;
- the command the same words lead to below each declared read-only prefix, when there is one;
- the syntax line of each sibling under the same parent (40 at most) and where the parent's block starts in the text file;
- the other nodes the record references (manual sections): quoted when short, otherwise the file, line and length.

It states no judgement and writes no plan content; what it does not hold is searched for in `knowledge/` as before. SKILL
step 2 names the file (two sentences, budget 8980). A brief that cannot be written is reported in the download's answer and
does not fail the download. On run 22's seventeen items the briefs take 0.2 seconds and are 1 to 22 KB each. The
recomposition stage's download is unchanged: its items are what a record is made from.

### 3.13.0: the knowledge root comes with the run, once, and is read locally

The design model has three knowledge interactions for a run (D06 R[2]: lock the root, fetch the subtree, verify the references
at delivery) and says how the second goes (K05: "按包声明一次批量取回子树，Circle 按摘要缓存"; under a digest the content does
not change, so it is not checked against the Hub piece by piece). The flow read the root page by page instead: run 21 made 126
`get_nodes` calls in its first two hours, 97 of them command-tree subtrees and 23 manual pages, each about two minutes on the
Hub's side, for a root whose every entry exports in under three seconds.

`tools/download-run.ts` (module `hub-client` of `run-tools` 1.0.2, shared with the recomposition stage, now 1.1.3) asks
`GET /run-export/<run>/knowledge` once and writes the locked root under `knowledge/`: `nodes.jsonl` (the Hub's answer byte for
byte, checked against its digest), one text file per top-level node of the root (`# <path>`, its children, each entry's
statement word for word followed by its reference) and `index.json`. SKILL step 2 names the folder; a quote is copied from
those files with the reference under it, and the Hub verifies it at submission as before. A run that locked no root, a reader
who may not read it and a Hub without the route leave `knowledge` null and nothing else changes. What the root does not hold
(back-references, contributions, feeding) is still read from the Hub.

### 3.11.0: the reference engine's scenario fidelity, audit and effects first

Requirement `scenario_kept` (check `scenario_fidelity`, `functions/fidelity.ts`) ports the audit half of InfoTest's scenario
fidelity (`main/case_compiler/scenario_fidelity.py`: `build_scenario_fidelity_brief`, `parse_scenario_fidelity_result`).
`tools/fidelity-brief.ts` computes, from the plan run's frozen recomposition record and the plan as it will be submitted (length
placeholders expanded first, as `tools/submit-plans.ts` does), a brief that lists every authored action with its adaptation, the
expectations and the plan's steps without the model's own descriptions. A fresh session judges each action once as preserved,
changed or unrealized (`tools/fidelity.md`, the reference engine's auditor rules), and the verdict travels in `data.fidelity`. The
Hub recomputes the brief and checks only what is mechanical: the verdict answers this very brief (its digest), decides every action
exactly once from the closed set, and a preserved action cites plan steps; changed, unrealized and a preserved action that cites no
step go back to authoring, as in the reference engine. Who judged is the procedure's concern, not a check (owner, 2026-11-09). There
is no step-structure layer yet, so the mechanical comparison is unavailable and every action is audited, which is what the reference
engine does for a case without that layer. In run 17 a case whose author wrote a TCP query was planned with a UDP query and passed
every check. Not ported yet: the step structure (recompose) and the mechanical comparison, the license override that needs the
comparison, counting a fidelity rejection as an authored round, and the scenario line of the delivery report.

The same version adds the reference engine's round-cap closing for a case never dispatched: when the latest plan run that holds
it and has an accepted result shows its plan without an accepted version after the repair rounds were used up
(`repair_exhausted`), it closes as 模型未找到解决方案, as the reference engine closes a case whose authored attempts were all refused
at its round cap. A plan run opened but never answered is skipped in that lookup. In run 18 the model declined to plan a case in
three submissions, the Hub recorded the spent repair rounds, and 3.10.15 refused the delivery because it knew only the
missing-fact exit.

### 3.10.15: a case never dispatched closes only on a fact the Hub recorded missing

`closeUnrun` in `functions/delivery.ts` ports the first of the reference engine's exits for a case it could not compile
(`tools/device/verifiability_tool.py` `_credential_gates`): an exit is certified only by what the engine's own checks recorded, and
a written claim that the bed lacks data, topology or a helper sends the case back ("Continue authoring the case as written"). A case
that never went to the bed now closes only when, in the latest plan run of the compilation that holds it, the Hub's latest accepted
result leaves a requirement of its plan (not the workbook's) pending on a data gap with a request to a named audience; it is reported
as 缺少 Hub 点名的事实（待补齐） with that plan run and the Hub's words. Any other case never dispatched refuses the delivery. In run 17
two cases were left out before any plan of them was submitted and closed on the model's notes, which said the locked tree had no
branch for their commands; the tree had both. The skill now says every case is written and submitted as authored, and that the
length placeholders take any length (`{{domain:N}}`): the example `{{domain:253}}` read as the only length allowed.

### 3.10.14: back to the reference engine for the pass review and for words a device generates

The owner had both 3.10.12 additions that went beyond InfoTest taken back (2026-11-09). The pass review reads only the run log of a
pass, as the reference engine does (it fetches device sessions only for failures); the Hub again saves device sessions only for
rows that did not pass, so a run's job records and the downloads of a delivery shrink with it. `PICK` and the runtime addition
`checkpoint_match_register` are gone: the reference engine's runner has no check point that keeps what it matched, and patching
the bed's shared framework for it broke the runner's start-up check in run 16. A value a device generates is used as the
reference engine uses it, with `CAPTURE`, `EXPECT_FROM` and `CAPTURE_COMPARE`; a case that needs more is closed by the closing rules.
`tools/assemble-delivery.ts` also skips a verification run whose jobs all ended before anything went to the bed (not
dispatched): in run 16 a Hub fault stopped a job in its pre-dispatch probe, the cases were verified again under a new run, and the
lineage walk refused the delivery because the stopped run had no verdicts.

### 3.10.13: one volume for every pass, the device's words on disk, plain words

`assemble` refuses a delivery while any case whose latest verdict is a pass is outside the latest volume that passed whole, as the
reference engine ships only a volume that ran its passes together; the left-out state (上机没有结论 for a pass) is gone. Run 15 ran
fourteen passes together, reran one of them alone, and that one-case volume became the only delivered case.
`tools/download-returns.ts` writes a verification run's device return, every saved run log and device session, each checked against
its digest, with an index of verdicts and files, so the model copies the device's words for its notes from files; in run 15 it read
them only through tool answers that were cut short and could not copy a line. The owner had the jargon replaced with plain words
across the repository (用例原句 for atoms, 用例参数替换 for the rebinding ledger, and so on); the recompose stages move to 1.1.2
together and mindmap-format to 1.0.22 for it.

### 3.10.12: the pass review and words picked at run time

Decision 164. `tools/assemble-delivery.ts` reviews every pass as the reference engine does (`tools/device/batch_tools.py`
single-case verdict downgrade, markers from its domain grammar's `exec_failure_markers`): a pass whose log or device sessions
carry a line with a declared execution-failure marker that none of the case's own assertion texts is part of becomes no verdict,
with the session and the line in the report. The markers are a runtime-contract@2 addition (`exec_failure_markers`: source,
digest, lines). The reference engine scans only the log of a pass, having fetched device sessions only for failures; this
runner's log holds only the commands it sent, so the gateway (0.4.7) returns, and the Hub saves, the sessions of every case and
the review reads them too. A pass dispatched before that has no sessions and is counted as not reviewed. (Withdrawn in 3.10.14.)

`PICK` takes a word from a captured output into one quoted `"{}"` of the call that follows (a key file name a device generates,
say). The runner keeps the part its last regex check point matched in `check_point.matched` (runtime addition
`checkpoint_match_register`, naming the runner source that does it and its digest); the generator writes a `found` check point on
the captured register right before the call and puts `check_point.matched` in the call's input column. The pattern is built from
an escaped literal and a fixed word class, `starts_with` (the word beginning with the literal) or `after` (the word after it), so
no author regex runs. Without the declaration a PICK plan stays unknown with the maintainer's next step. (Withdrawn in 3.10.14.)

### 3.10.11: a failed case closes by the reference engine's rules

`functions/delivery.ts` `closeFailed` closes a case that failed on the bed as InfoTest's engine does (`compile_engine/remedies.py`
with `max_rounds` 3, `terminal_outcomes.py` and `render.py`; `tools/device/fail_attribution.py` and `verifiability_tool.py`). It
goes back to authoring until three authored versions of it failed; the tool counts, per case, the distinct plans of it among its
failed dispatches, so a rerun of the same plan is not a round. Before that it closes only as a product-defect candidate
(`defect_candidate`: `repro`, `expected` verbatim from the author's expectation, `actual` verbatim from its last device output),
reported as “声明与设备行为冲突（待仲裁）”. At the cap it closes as “模型未找到解决方案”, and its judged paragraphs are reported as
the model's own account. A written judgement that the bed lacks a prerequisite, that the product is at fault or that the cause is
undetermined is not a terminal credential, as in the reference engine ("A free-text claim that the bed lacks data, certificates,
topology, or a helper is not a terminal credential. Continue authoring the case as written."); `tools/delivery.md` no longer says
that such cases are not reworked. In run 14 one case failed in four authored rounds, each time on the device's refusal of a step its
own plan wrote, and was delivered as 上机未通过 on the model's judgement that the bed lacked a prerequisite.

Not ported yet: of the reference engine's exits for a case it could not compile, only the missing fact the Hub recorded is ported
(3.10.15); a command-tree refusal bound to an expectation (no CLI equivalent), a refusal by the shared-bed procedure, an author's
address the bed cannot reach and a contradiction between two authored surfaces are not. A case whose latest dispatch gave no verdict
is not rerun up to three times before it closes as a platform limit.

### 3.10.10: one plan directory for every run of the batch

`tools/submit-plans.ts` reads the run's items from the Hub (`GET /run-export/<run>/run`) and submits only the case files of those
items, naming the ones it leaves out, so a final verification that excludes cases takes the same directory and each passed plan
reaches it byte for byte, as the reference engine composes a volume from sealed cases. It also reads each file strictly and names
the file, the position and the text around a JSON or UTF-8 error. In run 14 the model copied sixteen plans by hand for its final
verification, dropped a closing brace in all of them, and was told only "不是完整的 UTF-8 JSON".

### 3.10.9: a recomposition refusal that names its condition

`functions/recomposition.ts` `recompositionProblem` walks the admission conditions in order and the projection freezes the first
one that fails on the case (`recomposition_problem`); the plan checks quote it. In run 13 the old single sentence ("缺可受理的独立
重组记录……核对方") made the model wait for a reviewer when it had bound one result record in both slots.

### 3.10.8: three rules from the reference engine

Compared rule by rule with InfoTest after run 12 (decision 163). `bed_addresses` refuses an asserted query sent from a host with
no interface on the target's segment (`driver_no_path`, after InfoTest `driver_no_declared_path`; the inventory declares no
routes, an author-written target no host reaches is disclosed). `expected_grounded` refuses an expected text that is part of the
command whose output it reads (`assertion_in_command`, after `assertion_matches_command_echo`: the runner's window starts with
the echo). The delivery notes take `evidence`, the device's own words copied from the case's last runner log or session, and
`tools/assemble-delivery.ts` refuses notes whose evidence is missing or not verbatim (after InfoTest's attribution check).

### 3.10.7: literals of a set length

A plan writes a literal the author gives by length as a placeholder: `{{domain:N}}`, `{{domain:N|prefix}}`,
`{{domain:N|prefix|suffix}}`, `{{name:N}}` (decision 162). `tools/submit-plans.ts` expands it with `functions/length-literals.ts`
before sending: a domain name is filled with labels of at most 63 characters to exactly N, the fixed parts kept verbatim, a name
without dots; the same placeholder always gives the same literal. The expanded case is written back to its file, so the file is
what the Hub receives, and each expansion is reported with its length and label lengths. A model miscounts long runs of
characters; the reference engine generates such literals from the stated length too.

The same release fixes the unsuccessful volume of `tools/assemble-delivery.ts`: cases that last failed in different dispatches
(one in the whole-volume dispatch, another only after a rework) go in each with the plan it last ran, merged by
`generateWorkbookSet(inputs, { merged: true })`, whose description row names every plan run; the default path and its bytes
are unchanged. The pass volume is the latest dispatch that passed whole after which none of its cases failed; a later dispatch may try
other cases or rerun its cases if they pass again, and a case whose latest verdict is a pass but which was left out of it is reported as not delivered (with no
pass volume at all, such a pass is refused: it was never final-verified). Run 12 stopped on both: the tool asked for one dispatch holding all
ten cases not passed, and a rerun of them would then have stood after the final verification.

The tool no longer trusts the list of runs it is given: `--runs` names at least the final verification, and every
verification run of the same compilation (plan runs under the same booking bound to the same recomposition result, read through
the Hub's `GET /run-export/<run>/successors`) is taken in start order; the ones added are printed as `added_runs`. In run 12 the
model named two of nine and the report said “上机 1 次” for cases that ran five times. The tool also prints `reply`, the
answer for the person (directory, counts, paths), which `tools/delivery.md` has the model give verbatim.

### 3.10.6: the delivery directory

`tools/assemble-delivery.ts` ends a run as InfoTest's engine does (decision 161): `case.xlsx` is the pass volume, regenerated
from the plan run of the final verification and refused unless it is byte for byte the workbook that verification dispatched and
every item of it passed; `unsuccessful_cases.xlsx` holds the cases with a plan that did not pass, from the plan of the latest
dispatch that held them all; `delivery_report.md`, `unsuccessful_cases.md` and `delivery.json` account for every case of the
document. Verdicts come from the Hub's `GET /run-export/<run>/jobs`; the model writes only how each case not delivered was
judged and its fix or trade-off. `tools/delivery.md` holds the closing steps (at most two rework rounds, a final verification of
the pass volume, the answer with counts and paths only), so SKILL.md only points to it.

### 3.10.5: the run on disk before the plans

`tools/download-run.ts` (module `hub-client` of `run-tools` 1.0.1, decision 160) writes the run record, one file per item and the
original bytes of every bound source right after `start_run`, each checked against its digest. Step 2 tells the model to read
these files: in the last real run it read 83 items one `get_nodes` call each. `recompose` 1.1.1 ships the same tool, and the
three recompose stages move to 1.1.1 together, since a stage takes as predecessor only a run of its own pack at that version.

### 3.10.4: no paging of the device return

The Hub now answers a source whole, so step 9 no longer tells the model to page.

### 3.10.3: read what the device said, whole

A finished job's answer names one device return: every case's verdict, then the log and device sessions of each case that did
not pass, word for word. Step 9 reads all of it before attributing. The Hub picks, groups and interprets nothing, as InfoTest
passes device output through whole (03 section 26.5). In a real run the model read logs only, which hold the commands sent and
not the device's replies, and wrote "no error" where the device had answered `Failed to execute the command`.

### 3.10.2: a case that cannot be written yet does not hold the others back

`parameters.exclude` leaves named cases out of a whole-document run. The plan run and the verification run take the same list,
each autoid must name a case the rule takes, and it does not go with `autoid`. InfoTest and CES isolate such a case and go on. A
real run needed it: a case whose command takes a name generated at run time cannot be planned, and one such case kept the other
16 from a workbook. The final report has to say which cases were left out, what is missing and what comes next.

### 3.10.1: attribution in InfoTest's order, assertions that can tell failure from success

The first real run with recomposition blamed the product for nine timed-out queries: the plans never configured the listener,
a sentence the locked manual has. Step 9 now follows the layers of InfoTest's attributor: version, whether the configuration
took effect, the other cases, and only then environment or product, with what a product claim has to show. A plan problem is
rerun at least once before it goes to the user. Five statistics cases passed that run on the plan's own names, so the skill now
asks for an observation that a failed feature would not produce. Both are skill text: what InfoTest leaves to its models stays
with the model.

### 3.10.0: a whole mind map goes through recomposition (decision 155)

Recomposition is connected. The stage now takes the same cases as compilation, one item per case with an autoid; other nodes
stay disclosed in the group, so a map with 270 unnumbered nodes no longer has 270 items that can never finish.

The threshold follows InfoTest, where 21 of 34 cases were `underdetermined` and still compiled. Settling needs no independent
ruling, and `underdetermined`, `missing_prerequisite`, `record.unknowns` and a `missing` method go on to the writer instead of
leaving the case unknown. `conflict` still waits for a person. `recompose-authority` and `recompose-adjudication` stay optional:
bound or named, they are checked as before; unbound, a record may claim no governing source. Verbatim atoms, the atom set and
command identities are checked as before. A record may cite the locked tree (`tree:<root>/...`).

Each case takes its own record: the projection looks it up by source and node and freezes it in `fields.recomposition`, where
the writer reads it. `plan.recomposition.slots` must give every expectation slot an assertion, which also closes, for this
pipeline, the gap that a flat plan needed only one expectation. The rebinding ledger is no longer checked: `replacements` has
its own typed check. A whole mind map with no record is refused unless `parameters.pipeline` says `legacy`.

`recompose/tools/submit-records.ts` fills what the projection already knows (atoms, spans, the original ledger, coverage), as
InfoTest's `fill_mechanical_fields` does; the model writes only what takes judgment. The method text in `recompose/SKILL.md`
follows the rules of the CES `mindmap-recompose` skill, in this pack's fields, with no product content.

`tools/files.ts` and the Hub calls of `fetch-run.ts` and `submit-plans.ts` moved to the module `hub-client` of the skill
`run-tools`, which `recompose` needs too.

### 3.10.0: writing a workbook and reading commands come from skills

`zip-store`, `workbook-template`, `g-syntax` and `xlsx-model` moved to the module `workbook-writer` of the skill
`runner-workbook`; `command-policy` and the command grammar moved to the module `command-check` of `command-tools`. They are
embedded as generated files. What reads a plan stays here: `generate.ts` (a plan into rows), `workbook.ts`, `plan-commands.ts`
and `command-obligations.ts`. The writer's family is this runner's workbook: it serves every product on this runner, not any
Excel file. The commands themselves stay the model's: `command-check` parses and derives, it does not write commands.

### 3.10.0: the structural reading comes from the skill mindmap-format

The structural projection moved to the module `case-structure` of `mindmap-format` (decision 154) and is embedded here and in
`recompose` as generated files; change it in the skill, never here. The copies in `recompose-authority` and
`recompose-adjudication` were never imported and are gone. `tables/compile-structure.json` is now the module's `policy.json`.
After a version change run `testing/refresh-workbook-samples.ts`: the generator's name is written into the workbook samples.

### 3.9.22: a run freezes the cells that hold something

The runner's template formats 5,000 rows, so the parsed workbook grew to 4 MB and made up most of what every check of a run carries. On a 17-case run the checks took twice as long, and the dispatch boundary twice stopped with `SANDBOX_UNAVAILABLE` while the Hub's main thread was held up. A run now freezes the model without its empty cells, 120 KB for that workbook. The reader needs only cells that hold something, a hidden row stays so it can still be refused, and the byte comparison covers everything else.

### 3.9.21: the workbook is the runner's template with rows filled in

Until now this pack wrote its own small workbook: a header on row 2, none of the template's notes, lists or drop-downs, and C at 2 on every row. The runner read it, so nothing failed, and the reader here shared the generator's format, so nothing showed it. People open these files, and the reference compiler clones the template.

- The profile carries the template as `workbook.template`, so the pack stays free of product text and the Hub recomputes the same bytes. Without one, generation stops and says so; there is no fallback layout.
- Generation edits only the worksheet: the rows below the header, and the generator and recipe cells beside the identity on row 1. The header row comes from the template's defined range, and A1 to C1 must match this run's contract.
- Rows follow the reference: the description row reads `Author         : <generator>`, then the plan run and the build. Id and priority stand only on a case's first row, priority is `P1` as the reference writes it, C counts up inside each case, a checkpoint has no description, and a blank row closes each case.
- A plan step may carry `description`, one line for column D. The mind-map path stays on a case's first row, before that step's description.
- The closing row may name a call, which is how the reference writes its sentinel. The runner does not execute the last case, and the reader does not count it as an execution.
- The independent reader takes the header row, the members and the relationships from the template, and still compares the rows with the plan. `max_rows` and `max_model_bytes` follow the template's 5,000 rows.

### 3.9.20: a cleanup the tree cannot send is the product's to declare

A product's generic rule puts `no` in front of a command, and for many commands that path does not exist: `sync to` has a rollback
instead, and one `no record <name>` removes every record type. The check still asked the plan for the missing path, so no plan
could pass and the model went looking for a cause that was not there.

- The catalog selection reads each command's line under the product's rule along with the plan, along exact tree edges, so a path
  the catalog does not hold is one the locked tree does not have. All of those lines or none: when they do not fit the selection's
  128 lines, the check keeps the earlier wording.
- Such a command is now `unknown`, names the path and sends the next step to the product author, who declares the real inverse in
  `inverse_rules` and seeds again. A cleanup the tree can send but the plan left out stays the plan's to write.
- A cleanup step that undoes nothing now says which line it is, and that the runner covers the device's other configuration, so
  the step can simply go.

### 3.9.19: the tree decides a node's role, and declared host programs

Real mind maps are not only the two layouts the reference's documents name. The reference's readers never refuse a shape: a leaf
beside a step is a step no expectation follows, and it delivered such cases on the device. This pack refused them, so a whole
mind map could end with no atoms and no way out, because a declared `compile_layout` cannot contradict the tree and recompose
reads the same projection. Nothing here reads a word:

- `steps_tree_expectations`: under a title, a node with children is an action, a chain of steps reads in order, a leaf under an
  action is its expectation and a leaf beside a step is an action no expectation follows. This goes past the reference, which stops
  two levels down and takes the second step of a chain for an expectation.
- `precondition_priority` (3, as in `case-review`) in `tables/compile-structure.json`: such a leaf is a precondition in every
  layout, carried as an action no expectation follows. A case body with one used to demand it as an expectation.
- A key with no value declares nothing: a group node exported with `autoid: null` is no case, so its cases are no longer nested.
- A case that stays undetermined says why in the item summary of the `start_run` answer.
- `allowed_programs` on a contract effect: a host line may be a declared program with static arguments, besides a full literal.
  `hasShellDynamicSyntax` still refuses expansion, separators and redirection. `address_prefix` names the arguments that are
  addresses; they must parse and are checked against the environment like any declared address. A contract without the field
  behaves as before, and an older pack ignores it.

- Catalog data crosses a check subject as sealed text (`sealed`, `opened` in `functions/text.ts`). The evaluator reads every
  reference-like string in a subject against one budget per submission (256 references, 16 MiB), and catalog entries carry two
  or more each, so a submission of about fifteen cases stopped with `未校验（中断）` and read some 250 MB for nothing. Nothing
  quotes those references. The content is unchanged, so recipe digests stay.
- `tools/submit-plans.ts`: a run takes one complete submission, and five cases already took 27 KB of tool arguments, so a whole mind
  map did not fit in one model message. The model writes one file per case and the tool sends them as that one submission. It
  decides nothing. A repaired case is rewritten alone, and several writers can each own their files.

The stage packs recompose, recompose-authority and recompose-adjudication move to 1.0.4 because they copy the projection.

### 3.9.18: the integration line's 3.8.9–3.9.17 on main

The private integration line published case-compile 3.8.7–3.9.17 while main stood at 3.8.6. This release brings those
changes to main on top of main's own 3.8.6 fixes (union-typed inverse alternatives, declared trigger narrowing), which the
integration line had already taken in 3.8.7. 3.9.18 is above every version either line published. The sections below
describe what came in; the references to the read-only reference implementation (SyntheticReference) and its compile skill
name behaviour, not code: nothing of theirs is copied, imported or run.

### 3.8.9: union-typed optional arguments bind positionally

The shared command grammar (`functions/generated/command-grammar.ts`, regenerated from `contracts/src/command-grammar.ts`) gave a
line no identity when an optional argument of a union type (IPADDR published as IPv4 and IPv6 alternatives) was omitted: in the
alternative whose type at that position rejected the given address, the address skipped the position and bound one later, so
a removal command with a name and an address had two identities and its cleanup could not be checked. The expansions of one
declared signature now bind as the declared signature does, the given arguments at the earliest positions; identities of
different declared signatures still make a line ambiguous (`contracts/src/command-grammar-union.test.ts`).

### 3.8.10: an unlabeled expectation under several actions binds to the step (decision 103)

An expectation with no `step_ref`, no bracket label and no number, under a step whose several actions precede it, binds to
those actions as one step instead of staying unbound, as the reference implementation handles it. The authoring model splits
it into verbatim clauses of the expectation node and asserts each after the plan operation it observes; that placement is a
model judgment, and the Hub still checks every quote against the expectation's original bytes. An explicit `step_ref`, label
or number that matches no action, or several, still leaves the expectation unbound.

### 3.8.11: declared confirmations, net-effect cleanup and declared text shapes (decision 104)

Three generic rules a case that loads a certificate on a device needs.

- **Declared confirmations.** A product's command-policy@1 may declare `confirmations` (`command_prefix`, `prompt`, `answer`).
  A device command under a declared prefix must pass the declared prompt as its runner prompt (the parameter whose declared
  type is `runner_prompt`, role `runner_option`), and the very next step, on the same object and method and in the same
  section, must carry exactly the declared answer as its only value. That step is dialogue: it is not parsed against the
  catalog, needs no catalog entry and has no cleanup obligation (`confirmationSteps` in `functions/plan-commands.ts`). A
  declared command without its prompt or answer, a runner prompt on any other device command, and an answer that follows
  nothing are refused, since a missing answer leaves the device waiting inside the dialogue.
- **Net-effect cleanup.** Only what is alive at the end is torn down. An execution step that is exactly the declared inverse
  of a still-live earlier one on the same device (delete, then re-create) undoes it, and neither needs cleanup; every other
  configuration stays live and needs its own cleanup in reverse order (`functions/command-obligations.ts`). The bed's
  pre/post check still decides whether the bed was restored.
- **Declared text shapes.** A runtime-contract@2 type of catalog type `string` may declare `pattern`, one anchored expression
  the whole value must match (`functions/typed-contract.ts`), for names the runner splices into device lines.

Test: `functions/confirmations.test.ts` with the synthetic fixture `testing/confirmations.ts`.

### 3.9.0–3.9.1: one run and one workbook for the whole document (decisions 104, 105)

A user converts a whole mind map for a version, not one case at a time. Without `parameters.autoid` the run takes every case
of the document that has a textual autoid of the configured shape and is not excluded by the author, in document order, one
item each; duplicate autoids refuse startup, and a recomposed pipeline stays one case per run. With `autoid`, exactly that
case, as before.

- **One workbook.** `generateWorkbookSet` writes one identity row, header and description, then each case's rows in item
  order, each followed by a blank row, then the closing row; the runner begins a case at every A-column autoid row. The
  identity recipe digest covers the ordered list of the cases' recipes; one case keeps exactly the single-case bytes. The
  independent reader (`readWorkbook`) walks the case blocks in the same order, and a block plan and a flat plan cannot share
  a workbook.
- **Verification against every accepted plan.** The verification run binds `plan_result` (a `from_runs` input: the plan run
  id, which the Hub replaces with that run's latest accepted result). The projection freezes, in item order, every case's
  accepted plan (the model's judgment claim on the plan slot) and commands_known catalog receipt (`plan_set` in the run
  group). Each item's `workbook_verified` check requires its resubmitted plan to equal its frozen plan and regenerates the
  whole workbook from the frozen set; all items return the same support data, whose `autoids` lists every case.
- **Dispatch.** `policies/dispatch.json` binds 1 to `max_items` (64) distinct autoids; the Hub's dispatch proof accepts a
  verification run of several items when it names one dispatched id per item.
- **Client.** `tools/fetch-run.ts --hub <address> --run <run> --out <directory>` reads the user's token from standard input
  only and fetches from the Hub's `/run-export/<run>` the run, its latest accepted result and that result's submission, and
  from `/run-export/<run>/sources/<sha256>` the bound contract, profile and inventory, checking each against the digest the
  run bound. Every original is fetched and checked before anything is written, a failed write removes what the call wrote,
  and nothing is overwritten. A Hub that cannot be reached is reported as unreachable with its cause, one that does not
  answer within 120 s as such, and only an answer that does not parse as UTF-8 JSON as malformed. A secret placeholder the
  client did not fill is answered with `/secrets HUB_TOKEN` and never sent. `tools/generate-workbook.ts` generates the whole
  workbook when every case's plan requirements are satisfied (only the workbook may still be missing) and produces nothing
  otherwise. Once the verification run is accepted with every requirement satisfied while the runner holds the executor's
  bed keys, the Hub dispatches the workbook itself (decision 105) and the answer's `派发` line names the job; repeating the
  same submission byte for byte reads its progress and the result reference.

Tests: `functions/whole-mindmap.test.ts`, `tools/fetch-run.test.ts`, the whole-mind-map case of acceptance scenario 28.

### 3.9.2: promoted certification candidates (decision 104)

A runner contract may mark device methods as certification candidates (device certified through a device receipt set, with a
final-contract release replay still required). case-compile never enables a candidate by itself. A runtime-contract@2
document may now declare `promotions` (`object`, `method`, `status_authority`, `reason`), an addition removed with the
others when the original identity is recovered: a candidate is enabled only when a promotion names it with exactly the
device receipt set the original entry records and the entry carries typed authority. A promotion of anything else refuses
the whole contract. The release replay is the dispatch of a workbook that uses the method; its result is judged as any
other. Test: `functions/promotions.test.ts`.

### 3.9.3–3.9.7: verdicts from the vocabulary, the whole bed, rework, each case's own identity

- The verdict of a cleanup problem narrows the generated `Verdict` with `Extract` instead of a handwritten union.
- The contract and profile inputs name their default documents (`doc:doc:runner-contract`, `doc:doc:runtime-profile`) as
  the inventory input already did (`doc:doc:bed-topology`).
- Step 1 of `SKILL.md` books the whole bed (`need.devices` with every device of the inventory), because the executor's
  target is the whole bed and a partial booking would be refused only at dispatch.
- The Hub's dispatch result names, for every row that did not pass, its log and its device sessions as sources the runner
  reads (`evidence`). Step 9 says what follows a run with failures: read that evidence, attribute each failure (plan,
  expectation, product or environment), never copy device output into an expectation, change only the failed cases and
  keep every passed plan as it ran, then run the whole mind map again until every case passes or the remaining failures go
  to the user with their evidence. Step 3 says that `after` points at the step whose output the expectation reads.
- Local commands name the skill directory and write every command with the installed script's full path, so a client guard
  that runs only `node` with a full path admits them (`scripts/real/circle-home.test.ts`).
- A pasted case keeps the node id of the case it was copied from. The earlier extraction is now found by selector alone, and
  an item id uses the node's selector where the node id repeats in the document; a unique node id keeps
  `<document>:<node id>`.
- A whole-document run refuses with `autoid_invalid` when a case's autoid does not match the profile's shape, naming up to
  ten cases by selector and quoted autoid with the fix; a case without an autoid is still not compiled and is counted.
- The independent reader keeps registers per case, reset at every row that starts a case, as the runner does; within a case
  a name is still captured once.
- More than `max_items` (64) selectable cases refuse the start with `too_many_cases` and the split the workflow offers
  (several uploaded documents, or one autoid per run) instead of failing at `dispatch_policy` after the work.
- In Chinese text the bed is 自动化测试环境 (decision 110); identifiers and behaviour are unchanged. The recompose stage
  packs carry two of the renamed messages, so they moved together.

### 3.9.8: the runner's own cleanup (decision 112)

Before every case after the first and at the end of a workbook the runner clears each of its device objects by prefix rules
applied to every command line the object sent, first hit in source order. A runtime-contract@2 document may declare that
cleanup as the closed addition `cleanup`: `source` (the runner path), `sha256` (the file bytes), `objects` (1–16 contract
objects the runner clears) and `rules` (1–512, each 1–16 single-line `prefixes` and an optional source `line`). The clear
commands themselves are never declared: many are module-wide and are not a teardown a case may copy. Like the other
additions it is removed when the original identity is recovered; a `sha256` that differs from the original contract's
`source_hashes` entry for the same path refuses the contract.

A live configuration command on a listed object whose line starts with a declared prefix needs no inverse in the case; every
other one still needs its declared inverse in the cleanup segment, in reverse order, and an explicit inverse of a covered
command is still accepted. The contract check's support statement says how many commands the runner's cleanup discharges,
which rule and prefix covers each, and whether the original contract records the same digest for the source (otherwise the
digest is the Hub-side declaration only and the bytes on the jumphost are unchecked).

### 3.9.9: device commands by the locked command tree, except the destructive ones (decision 114)

A runner contract that lists command subtrees in `command_scope` stopped a defect reproduction whose commands were outside
them, and the only way on was a maintainer revising the contract. The reference implementation allows every device command
the command grammar knows and bans only the commands that take a shared environment's device down or wipe it with its
management access.

- runtime-contract@2 gets the closed addition `destructive`: `source`, `sha256`, and at least one of `exact`, `prefixes`
  (paths under `/commands` of the locked command tree) and `segments` (path segments, anywhere in the path). It is matched
  on the resolved command identity's path, never on wording.
- A device CLI effect that declares no `command_scope` and no `commands` now authorises every command the locked tree
  resolves, except the destructive ones, when the contract declares `destructive`; without it, device commands stay
  refused and the refusal says so. A declared scope still narrows, and a destructive command is refused inside it too.
- A command address whose position has no declared role must be an address of the environment, a lineage lease or a
  replacement (bed member); a declared role without `bed_member` is still a gap.
- The contract-shape support says how commands were authorised (the declaration's source and digest and what it bans).
- SKILL step 2: the same rule; a fact only a maintainer can supply goes to that maintainer as an evidence request, and the
  user is told which request the run waits on, never asked to choose for the maintainer.

### 3.9.10: the author's own addresses stay (decision 115)

The reference implementation refuses an unreachable address only when the compiling model made it up; one the author wrote
is kept and disclosed.

- `bed_addresses`: the author's addresses are the address parameters of the case's own command lines, parsed by the locked
  command tree (no text scan). A plan address off the environment or in a blind segment is kept and disclosed when it is one
  of them, refused otherwise; the support says which addresses were kept. A declared role with `bed_member: false` is still
  not checked; a position without a declared use is checked like a member.
- A replacement may replace any address of the author's commands, not only one from the case index; any other source is a
  plan error (`replacement_invalid`, naming the source and the author's addresses), no longer a missing fact for a maintainer.
- An inverse that parses with several leading-parameter counts accepts the plan's own cleanup when it is one of them, and
  otherwise lists every valid form; it no longer waits for a product declaration.

### 3.9.11–3.9.13: cleanup per device, attribution from the echo, one booking (decisions 118, 119)

- Reverse order binds within one device only: each device's live configurations, latest first, take that device's cleanup
  steps; the order between devices is free. An explicit inverse of a configuration the runner's own cleanup covers is
  accepted wherever it stands on its device. A left-over cleanup step that is the declared inverse of a live configuration
  of the same device is named as out of reverse order, with the configuration it undoes.
- SKILL step 9: a command or configuration the device echo names is read in the locked command tree and the manual before
  the plan changes; an inference the echo does not explain is a judgment with a written prediction (V08), a read-only
  observation before the command under test tells it apart next time, and a miss changes the hypothesis instead of
  repeating the change.
- SKILL steps 1 and 9: step 1 keeps a whole-bed booking already held (for instance from installing a build), step 9 reruns
  under it, and once every job has an end the booking is released with test-bed release. The confirmation rule no longer
  quotes one product's command, prompt and answer as examples.

### 3.9.16: the case's mind-map path on its first row, consistent examples, an everyday description (issues #144, #130, #143)

- Column D of each case's first row (the autoid row) is the case's place in the mind map: the texts of the nodes from the
  root to the case, verbatim, joined by `>` (`AAA>BBB>CCC`); the case's other execution rows keep the case title. The path is
  projected at start (`fields.path`), carried into the frozen plan set and the recipe digest, and read back by the
  independent reader. Column D is free text for the runner (it logs it and shows the first row's as the case description;
  whether a row executes is decided by other columns). A path text that the generator subset refuses (a leading `=`, a
  control character, `_xHHHH_`) refuses generation as any cell does.
- The examples are derived from `examples/case-mindmap.json` by `node testing/examples.ts --write`; `examples.test.ts`
  fails when they drift. `start-run.json` names placeholders for product and build.
- The skill and pack descriptions say in everyday words what the pack does: compile a whole test mind map into an
  automation-case Excel workbook and run it on the automation test environment.

### 3.9.17: an uploaded mind map is named by its root node (owner's decision)

- Without an agile document id (an uploaded file) and without a parser meta id, the document id, the first part of every
  item id `<document>:<node>`, is now the root node's id; until 3.9.16 it was the first case's node id. A tree whose root
  carries no id is named `tree-<sha256>`: the SHA-256 of the canonical JSON of the whole tree reduced to each node's text
  and its children in order (`rootDocumentId` in `functions/cases.ts`). The same texts and shape give the same id on every
  run, and any change of a text or of the shape gives another.
- Runs started before keep the item ids recorded with them; records are append-only and nothing is rewritten. The example
  item is now `fixture-document:fixture-case`.

The stage packs recompose, recompose-authority and recompose-adjudication moved to 1.0.3 with 3.9.18 (the integration
line's 1.0.2 and main's 1.0.1 hold different bytes): `functions/recompose-evidence.ts` accepts stage evidence of exactly that
version, so the pin moves with them (in the parent, the three copies, `testing/recompose.ts` and the recompose samples).

## Case writers

`tools/case-writers/` is a Circle extension for one writer per case, started together. Copy the folder into the chosen Circle home's `extensions/` directory and reload extensions; installation is an operator action and was not performed here. The optional `max_parallel` setting limits concurrent writers.

The extension gets the task tool from `model_call` middleware because Circle has no documented extension call for starting a subagent. Local tests use scripted writers and do not establish installed-client behavior. The owner must decide whether to keep this client interface or wait for a public subagent API. No Hub model calls are introduced.

## Authored negative outcomes

The owner's 2026-11-12 morning decision requires a query after deletion and a block-form `not_found` check for an authored absence or lack of residue, without a new criterion or criterion review. SKILL.md, the closing procedure and each authoring brief now state that instruction. The block check follows the explicit operator for literals and earlier captures, never words in the author's sentence. Dynamic values use `CAPTURE` and then `EXPECT_FROM/not_found` in the same case, with a declared literal-negation method; old device output is not copied. Source quotations, expectation coverage, authored literal declarations and the separate scenario-fidelity check remain required. The integrator updates the package version and generated manifests after merging.

## Generating without a closed executor action

The owner's 2026-11-12 11:10 correction leaves closed executor actions closed. Writers must first use the build's manual and command tree to express the same authored effect through an already allowed device command method; a closed action alone is no reason to exclude a case. SKILL.md and each authoring brief now give that instruction. No runner contract, environment profile or executor definition changes here.

When the manual permits naming an object, the existing `{{name:N|prefix|suffix}}` expansion provides the same concrete name to its creation, use, query and cleanup within one case. Both fidelity-brief and submit-plans expand the case file before Hub verification. This does not extract device-generated filenames: `CAPTURE/EXPECT_FROM` only supplies assertion operands, and `RESTORE_FROM` remains a guarded restore operation. A value the device names itself still needs an already declared same-case extraction and use channel; that capability is not added or claimed here. No existing device state or previous execution output supplies a name.

## Structural cell selection

SELECT_CELL consumes an earlier raw capture, declares literal table separation and either a row ordinal or several exact column equalities, and saves one cell as text. The new executor declaration identifies cell_methods, cell_inputs and cell_text output. Its G arguments are readable where-column conditions and fixed scalar options; there is no encoded selection payload. The package checks shape and same-case ordering, while the executor selects the row at execution time.

Only a previously selected cell supplies an ordinary input_register template. Static command words and static arguments still use the locked catalog; runtime arguments are recorded separately as command_templates without invented concrete values. Existing raw captures and guarded restoration retain their own semantics. The integrator owns the next package version and publication manifest. This change does not establish a device outcome or a deployed capability.

A runtime cell at an address position already constrained to the environment retains an unknown scope result until its concrete value is available. Concrete addresses, author-kept addresses and plain text templates keep their existing treatment.
