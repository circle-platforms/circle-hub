# case-compile 2.4.1

The client authors one case plan and generates an XLSX. The Hub verifies the plan, independently interprets the core xlsx@1 model, and recomputes the exact artifact with the same generator. It calls no model and never emits an execution artifact itself. Synthetic acceptance proves these boundaries, not compatibility or success on a real runner/device.

## Frozen inputs and plan

subject is a KityMinder document; contract, inventory and profile are required published expected sources. Textual autoid selects exactly one case; absent/duplicate selections refuse startup. Items retain autoid, auto, priority, title and authored steps. Both child-step and case-body/one-leaf layouts preserve source text. Unsafe numeric identifiers cannot be reconstructed.

The original runner contract is not converted. Every original member except contract_sha256 participates in sorted compact UTF-8 identity; unknown status/dispatch/kind/authority values, unsafe/non-integer numbers and non-BMP keys refuse the whole contract. Enabled non-internal, non-candidate entries alone are callable. Default text is not copied or evaluated; redacted parameters cannot be submitted. Identity must equal the declaration and profile expectation.

runtime-profile@1 defines expected identity; workbook sheet/nine headers/identity marker/range/closing row/autoid shape; seat and host-method mappings; allowed combinations with parameter roles; device/host rejection lists; synthetic; required device_count from read-only precheck; optional fold_newlines pairs, default empty. Decision 35 considers every enabled pair; allowed contains only opened combinations with role coverage and any required explicit reviewed decision. External-format closed sets live in the pack's format tables. Dispatch must check the real current device count again.

Plan data is bucket, empty blocks, steps [{object,method,args,keywords}], expects [{text,quote,after}] and replacements [{case,bed}]. Args remain text; keywords may also be safe nonnegative integers because the runner converts digit keywords. Signatures enforce order, required/positional-only arguments, declared keywords and credential exclusion without defaults. Literal assertions are forbidden in steps: only expects supplies assertion text, with an original quotation and a one-based command after. Replacements are numeric one-to-one mappings, and slots contain final text. Device/host rejection lists, catalog@1, quote@1, address ownership and grounded expectations remain required checks. The bed/ prefix exposes test-bed predecessor allocations; unrelated runs cannot use them.

## G behavior and supported encoding

The authoritative behavior is the integrator's task-page annex, transcribed read-only from the runner with synthetic examples. Empty G becomes the string None, so zero arguments cannot be written as an empty cell. Ordinary LF input is one unsplit positional string unless the method is explicitly in fold_newlines; folded methods trim Python whitespace, remove LF/CR and then split. Ordinary plan values remain single-line; codec tests separately cover the broader reading behavior.

Outside paired single/double quotes, commas split fragments; unmatched quotes are ordinary characters. Inside a quote, backslash protects the next character from closing the quote but remains literal. Empty/space-only fragments disappear. Each fragment is trimmed with Python whitespace; matching outer quotes are removed once and the inside trimmed again. Equals is interpreted afterward: a key containing an internal ASCII space makes the fragment positional, otherwise it is a keyword. Decimal digit keywords become integers, duplicate keys overwrite; positional digits remain text. Literal assertions are unsplit original strings, including quoted text/newlines, and compare to the most recent ordinary result. All generated H/I cells are empty. Waiting is a single ASCII-digit duration.

encodeG always decodes its result and compares types and values. It names the violated rule for empty/edge-space/CR positionals, equals-to-keyword conversion, mixed quotes that require wrapping, quoted trailing backslash, non-single newline values, unknown keyword names, numeric text keywords, non-ASCII numeric keywords, out-of-range integers and invalid wait/assertion values. No Python, shell or expression evaluator is used. Fixed-seed tests roundtrip 500 supported values. Denial matching remains text matching, not a proof of arbitrary shell behavior.

## Deterministic file and independent reading

The Node-built-in-only generator emits six fixed OOXML members, ZIP32 STORE with its own CRC32, fixed DOS timestamps and member order. A is inline text, C is numeric 0/2 and never initialization 1. Other values are inline strings. Row order is identity, nine-column header, description, each step with its after expectations immediately following, blank row, configured closing row. The description contains plan_run and build, never a person. Exactly one textual autoid starts the case with nonempty E. Every assertion row is generated from expects. Register and certification-request cells remain empty.

Identity F records the generator id; G records a canonical recipe digest so a changed quote/replacement also changes bytes without copying source content. The workbook-level range points exactly to the header. Invalid XML values are refused rather than dropped; CR text is preserved. SpreadsheetML-looking _xHHHH_ sequences are refused with xstring_escape because literal inline and ST_Xstring readers disagree. The reference circle-packs 10-13 xlsx.mjs was read only for OOXML behavior: differences are STORE versus Deflate, strict fixed layout and subset, no hidden-row facility, exact identity/range, rejection of invalid characters and _xHHHH_ text, and accounted recipe metadata. No reference code or template bytes are imported.

The only ZIP/XML reader is the existing core xlsx@1 parser, unchanged here. readWorkbook consumes its structural model and independently scans all post-header E–I rows, including description/closing rows. It checks members, one visible sheet, inline strings/numeric C, no formulas or equals-prefixed cells, hidden rows, unique identity/header/range, exact original fields, signatures, one autoid, immediate assertions, empty registers, seat bounds and final closing row. It never calls the generator to parse input. Existing catalog@1 and quote@1 checks also serve workbook_verified. Only after semantic reading does the verifier regenerate and compare SHA-256 against the integrity-checked bound original bytes. A single changed ZIP timestamp byte fails even if the parsed model is identical.

The support data is exactly {sha256,autoids,bed:{id,manifest_sha256},build,generator,plan_run}. manifest_sha256 is the raw bound inventory digest, not a re-encoded model hash. No workbook text/bytes are returned. The package checks description D against frozen plan_run; dispatch must compare data.plan_run with the verification run's own predecessor. The bundle's generator id is tied to the pack version by tests; uploaded stale generator identities are refused.

Limits are declared in tables/workbook-format.json: 2,048 rows, 32,767 characters per cell, 2 MiB frozen model, 8 MiB output. Exceeding them refuses rather than truncates. SHA integrity and synthetic checks do not certify actual runner behavior.

## Two runs and offline scripts

First reserve the bed, then start a plan run with that reservation predecessor and all original sources. Submit/repair until every plan requirement is satisfied. workbook_verified alone is missing_input; accepted is not shorthand for satisfied. Preserve the exact original submission, start_run summary, complete result and bound source bytes. If the client exposes only formatted summaries, request a raw structured export from the integrator instead of manufacturing proof. Source pagination must be complete; local source-byte SHA checks catch reformatting or incomplete copies.

Run normalize-mindmap.ts only for local exports needing the two declared transformations: remove two leading U+FFFF and convert a single array wrapper into root. It preserves element spelling, including long numeric literals, and prints before/after SHA plus client-normalization disclosure. Ordinary root documents retain their original bytes.

The offline generator accepts --run --result --submission --contract --profile --inventory --out. It checks the received-submission digest, accepted result, full single-item coverage, locked pack/root, every mandatory plan status and exact expected-source bytes, then reads the verified identity receipt. It writes a new private file and prints only digest/version/size. No environment or network is read and existing files are not overwritten.

Source and published scripts both live under tools/, exactly as pack.json declares; staging copies those paths without namespace mapping. Installation must preserve tools/, functions/, tables/ and requirements.json together. The script and checker import the same functions/generate.ts. Node 24 is required; no production dependencies beyond built-ins are added.

Upload the exact generated file. The second start_run binds workbook by its uploaded src: reference, uses the same sources/build, and sets both predecessor and plan_run to the satisfied plan run. Resubmit the unchanged slots. Fixing slots requires regeneration and a new successor because inputs are frozen. Every required check must then be satisfied before handoff. SKILL.md drives missing-input continuation through generation/upload, never reports missing input as success, and retains the qualifications 按合成合约核对 / 按发布的运行器合约核对 and 不证明在真实设备上跑得通. Real dispatch remains the integrator's operation after the owner's design-section-6 answers.

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
只改变租约期限的解释和相应合成输入，不改变命令、规格或真实台架判断。独立合成测试装配显式提供空作业端口，
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

新合约沿用原始签名、完整性字段和 canonical 摘要计算，schema 精确为 runtime-contract@2，并新增 types、roles、effects 三个以 id 为键的闭集对象。types[id] 包含 declaration（共享 DeclaredParameterType，catalog_type 必填），可声明 address_kind（共享 TypedAddressValue 的 kind）、数值/长度上下界、values 或 literal；roles[id] 包含来源 source，地址用途须显式给 bed_member 布尔值；effects[id] 包含 source、roles、每计划调用预算 budget，以及按需明确的完整 commands、allowed_literals、command_roles（signature、零基 position、role）。每个启用条目的 typed_authority 给 source、parameters[name]={type,role} 和 effects id 列表。来源均为结构化 Ground 引用，作为合约作者声明保留，不冒充设备观察。合约身份仍覆盖全部字段。旧合约只核原身份，authority=null，一律未核对并阻止生成、回读受理与派发。

设备命令计划额外交 command_identities；case_index 从相同知识根按 document/node 精确取 data.command_identities，完整命令原文须与身份的路径及参数 raw 一致。身份比较忽略 raw 的展示差异，但逐参数重核 raw 与 parsed 一致；显式替换仅改变已声明地址参数，保持根、签名和类型出处。普通字符串和期望正文不扫描地址；掩码/前缀按其声明语法核验，不按网络形状猜用途。替换源必须来自冻结类型化参数，目标须在台架/本血缘租约中。

派发允许集合来自方法、角色闭集、完整命令/字面效果允许集合及预算。denied 字段和拒绝词表已经退役；host_shell 另保留已声明的静态 POSIX 子集语法限制（无扩展、管道或重定向）。同一检查用于计划、客户端生成、独立工作簿回读和派发前重核；工作簿生成器升至 @3，旧记录不改写，新合约须重绑后生成新运行及新制品。缺事实时由当前运行者请求合约发布管理员补声明或绑定命令索引，按 Hub 具名补证请求继续。本次续接未运行验证。

新合成样例见 examples/runtime-contract-v2.json、runtime-profile-v2.json 和 command-identities-v2.json；类型/角色/效果引用逐字对应 typed-authority-source.json 的实际摘要，命令签名对应 command-tree-v2.xml 的实际摘要。它们是示例资源，不是已执行或已验证的结果；旧合约与旧工作簿夹具字节保留。
