# case-compile 2.0

This workflow verifies one authored case plan against the original runner function contract, a published runtime profile, a bed manifest, the locked build's command catalog and original quotations. It generates no plan artifact, calls no model and touches no device. Synthetic acceptance proves these checks, not runner or device compatibility.

## Inputs and identity

`subject` is the reviewed KityMinder case document. `contract`, `inventory` and `profile` are required expected sources (`doc:doc`). `parameters.autoid` is required text and selects exactly one case; absent, malformed or duplicate matches refuse startup with a recovery action. Items preserve autoid, auto and priority as text. Identifiers above 2^53 must arrive as strings; unsafe numeric values cannot be reconstructed. Both child-operation and case-body/one-leaf-expectation layouts preserve authored text.

The runner contract retains its original schema and fields. `runtime-contract.ts` validates complete, unique objects and combinations, signature consistency, object/entry states, dispatch, parameter kinds and status authority. Closed values are read from `tables/runtime-contract-format.json`, including the five fixed authorities and receipt-digest form. Unknown values refuse the entire document with JSON pointers. Only enabled, non-internal and non-candidate entries enter the callable set. The pack does not add parameter types, ranges, address roles or command flags to that contract.

The identity is SHA-256 of sorted compact UTF-8 JSON, without escaping non-ASCII text and omitting only contract_sha256. Every other original field, including disabled entries, metadata and certification, remains covered. The result must match the declared digest and the profile's expected digest/version. Non-integer or unsafe JavaScript numbers and non-BMP keys refuse the whole contract because exact original identity cannot be proved. Defaults are never copied or evaluated; a parameter marked with the format's redaction default cannot appear in a plan.

## Runtime profile shape

`runtime-profile@1` is defined by this pack. All names and workbook literals come from deployment data, never executable code. The examples use invented names and documentation addresses.

| Field | Shape |
| --- | --- |
| synthetic | required boolean, controls qualification only |
| runtime | minimum_version and contract_sha256, both equal the verified original contract |
| bed | one manifest bed name |
| workbook | sheet, nine distinct header strings, identity_marker, range_name, nine-cell closing_row, anchored autoid_pattern |
| seats | [{object, device, ordinal}], unique runner objects, DUT devices and nonnegative gateway ordinals |
| hosts | [{object, method, device}], enabled combinations mapped to manifest test hosts |
| allowed | [{object, method, parameters:{parameterName:role}}], role metadata for enabled calls, not a second authorization whitelist (decision 35) |
| denied | device and host command rejection lists |

Parameter roles and external manifest values live only in `tables/runtime-profile-format.json`. Role mappings must reference signature parameters; credential parameters cannot be assigned roles. Device CLI roles require seats and host shell roles require host-method mappings. Decision 35 opens all contract-enabled combinations; parameter roles, signature/value screening and rejection tables still apply. All profile problems are reported together with pointers. Source/profile identity changes require a new run.

## Restricted slots and checks

`slots.schema.json` publishes the complete nested shapes. A single plan claim carries `bucket`, empty `blocks`, explicit `steps: [{object,method,args,keywords}]`, `expects: [{text,quote,after}]`, and `replacements: [{case,bed}]`. Argument values are text. literal_assertion calls are forbidden in steps (assertion_in_steps): assertions must be authored in expects with a quotation and after; task 2 alone generates assertion rows immediately after the referenced command step. Unknown fields and the retired params/plan_json shapes are refused. Binding uses original parameter order/kinds, never expands defaults, rejects extra or duplicate values, enforces required and positional-only arguments, and rejects credential-marked parameters. Variadic positional arguments follow the signature; undeclared keyword names remain forbidden even with a variadic keyword parameter.

All explicit values are single-line final text, without edge whitespace, a leading equals sign, {} or {0}. Device CLI values are sent to catalog@1 and the profile's device rejection list; host shell values use its host rejection list. Denial matching is deterministic text matching, not execution or a proof of arbitrary shell behavior. The enabled contract is the method authorization boundary; profile entries assign mandatory parameter roles and rejection/wait settings rather than narrowing enabled methods.

Every literal address in args, keywords and final expected text is checked, including extra invalid arguments. It must be a manifest interface or an unexpired address held by this lineage. Decision 35 permits every device interface of this bed and lineage allocations in device CLI. The workflow declares context leases and prefix bed/, so test-bed reservation predecessors expose their allocations; unrelated runs cannot use them. The independent manifest parser retains drift tests against test-bed for bed-name syntax, required services/reserved arrays, numeric service address comparison, address ownership and reserved-range containment.

Replacements are a one-to-one numeric address mapping and targets must be on the bed. The integrator confirmed that slots contain final execution text: Hub refuses leftover source addresses, never rewrites steps. Original quote text stays unchanged for quote@1; expected text must be an exact fragment of the quote after deterministic address substitution. after is one-based and points to a device CLI or host shell step, never a wait/assertion. At least one expectation is required. Supporting conclusions disclose the replacement table. Model-repairable codes in tables/codes.json have repair rows with two rounds.

## Runner G behavior and workbook boundary

G is a cell interpreted according to the original dispatch behavior, not a new typed protocol. Direct method calls use positional/keyword text separated by commas with balanced quoting; an empty G cell becomes the positional string None; zero-value calls cannot be expressed. A comma inside a value must remain protected by matching quotes. Ordinary single-line G is split at commas outside paired quotes; only LF-containing values are passed whole, except explicitly configured newline-folding methods. Multi-command cells are closed this round. A literal checkpoint uses G as the literal expected value with previous-result semantics when the register cells are empty. Waiting uses the numeric-seconds cell. The natural-language registry and the three-argument occurrence checkpoint are not opened here. g_syntax/h_semantics/i_semantics are explanatory text, not a grammar to execute or evaluate.

Header text, sheet/marker/range names, closing row and autoid shape belong to the published profile. No real values are hardcoded here. The integrator's task-2 annex now defines escape retention, paired/unpaired quote behavior, keyword conversion and LF folding. That published behavior governs the client codec; the plan additionally rejects malformed quoting, trailing escapes and unsupported cell values through repairable codes. Task 2 must then implement client workbook generation and an independent reader using those confirmed rules. This version neither writes nor verifies XLSX bytes and cannot authorize dispatch. The integrator explicitly approved removal of the old Hub-side exec-plan@1 generator and plan_deterministic requirement.

## Conclusions and handoff

Every pack-owned conclusion says 按合成合约核对 or 按发布的运行器合约核对 according to profile.synthetic, identifies the runtime and first 12 digest characters, and says 不证明在真实设备上跑得通. A supporting contract_shape outcome exposes data.runtime_version and data.contract_sha256 for task 2. A rejected plan has no identity support receipt. Generic catalog@1 and quote@1 conclusions keep their core wording and do not establish device execution.

The client skill automatically follows repair receipts; missing or inconsistent frozen facts require corrected source documents and a new run. First bring every required plan check to satisfied; only then use the task-2 client script and workbook-verification flow. Workbook implementation and all real contract/profile publication, device actions and dispatch remain outside this runtime-fix scope; the integrator handles real integration under decision 35.

## How to test

```sh
node --test --test-concurrency=1 'packs/workflow/case-compile/**/*.test.ts'
npx tsc --noEmit
node packs/workflow/case-compile/pack-files.ts --check
node --test --test-concurrency=1 packs/workflow/case-review/packs.test.ts
```

Function tests cover original identity, changed and stale contracts, unsupported values, profiles, both case layouts, textual ids, signature/value rules, address replacement, denied commands and grounded expectations. Positive/negative author samples cover every requested plan rule; testing/samples.ts rewrites only these synthetic fixtures. Publishing and production tests use a real temporary loopback PostgreSQL and the real registry/engine. Production includes actual test-bed address allocation followed by a compile predecessor and an unrelated-run negative control. Missing sandbox-exec is a skip, never a pass.

The repository vocabulary scan currently has eight existing matches in six files outside case-compile (knowledge, submit and tools). This package adds no match, exception or baseline. Generated vocabulary types are imported as types; runtime external-format sets come from the pack format tables.

## Needs from other packages

- Integrator: supply the complete G behavioral specification (backslashes, nested quotes and numeric decoding) before task 2 writes its codec.
- Task 2: deterministic client workbook generation, independent parsing/recomputation, and the workbook verification requirement; use verified identity receipts and the raw bound profile/contract, not defaults invented by this pack.
- Integration/owner: published real contract identity, runtime profile, current gateway topology and allowed combinations; none were read or tested here.
- K2/core owners: resolve the existing vocabulary scan matches. No out-of-scope files were edited.

## Local verification receipt

2026-10-23: `node --test --test-concurrency=1 'packs/workflow/case-compile/**/*.test.ts'` ran 119 tests: 119 passed, zero failures and zero skips. The real temporary-registry check passed all 52 author samples. The real-engine tests proved predecessor address visibility, the unrelated-run negative control, complete-schema repair messages and two-round repair exhaustion using only synthetic resources. `npx tsc --noEmit`, `npm run verify:contracts` (68 generated files), `pack-files.ts --check` and `git diff --check` passed. The whole-repository vocabulary command ran 16 tests: 15 passed and the scan failed on the eight pre-existing out-of-package matches described above; case-compile had zero matches. No real runner, device, deployment, model endpoint or owner environment was used.

Review 14: the task-page runner annex governs G behavior, including empty-cell None, retained escapes, keyword conversion after outer-quote removal and wait int conversion. No default or unsplit single-line primitive behavior is inferred from names.

Review 16: only successfully parsed IP tokens enter address membership checks. MAC/time/invalid numeric tokens do not become off-bed facts. Dotted-quad version strings are lexically ambiguous with IPv4; this generic layer cannot infer their meaning from prose, so a typed catalog/profile and explicit data context are needed to disambiguate them. No DNS or target probe is performed by the pack.

Review 18 / Needs: every unsafe numeric autoid has its flat-model pointer and original selector in refusal diagnostics. Re-export source ids as text; a core-owner lossless numeric parser is needed if textual export is unavailable. Rounded values are never used to reconstruct an id.

Decision 35 supersedes the earlier method subset and own-seat-only policy: every enabled pair is authorized, while supplied values without explicit profile roles refuse as configuration gaps. All bed interfaces and lineage allocations are permitted; off-bed source addresses require declared replacements. Rejection tables and credential/value checks remain enforced. Wait roles require an explicit max_wait_seconds bound.

Review completion: supplied role-less parameters fail closed in both signature and address checks; waits require profile bounds; quote/escape defects have repairable value codes; host expansion is unsupported rather than evaluated; failed subject construction cannot become empty-list success. quote@1 has no required option on this baseline, so an explicit missing-field sentinel produces missing_input without fabricating quote text. Every review regression was observed failing before its fix and passing afterward using synthetic inputs only.

Runtime review receipt: 19 numbered synthetic regressions each failed before the corresponding fix and passed afterward. The full runtime package ran 138 tests, all passed with zero skips; the real temporary registry passed all 66 author samples. Type checking and manifest freshness passed. No real contract, device or owner environment was used. The subsequent workbook merge must retain its own file/codec checks and the runtime role/value/address fixes together.

设计以 bac0083e 为准：不因派发标签直接全开或全关；tables/dispatch-roles.json 声明每种派发方式当前能由哪些角色完整核验。动作注册表与三参数检查点当前角色列表为空，配置不能把它们冒充 host_shell/device_cli（也不能用空参数映射绕过）；错误指到允许项及参数。草稿消费同一表，把这些组合列为“未开”，缺的事实和下一步取 missing/next：参数不是命令文字，G 规则与拒绝表核不了，case-compile 另写一页增加角色及检查。本分支不修改外部转换脚本。
