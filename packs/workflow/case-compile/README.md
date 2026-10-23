# case-compile 2.1

The client authors one case plan and generates an XLSX. The Hub verifies the plan, independently interprets the core xlsx@1 model, and recomputes the exact artifact with the same generator. It calls no model and never emits an execution artifact itself. Synthetic acceptance proves these boundaries, not compatibility or success on a real runner/device.

## Frozen inputs and plan

subject is a KityMinder document; contract, inventory and profile are required published expected sources. Textual autoid selects exactly one case; absent/duplicate selections refuse startup. Items retain autoid, auto, priority, title and authored steps. Both child-step and case-body/one-leaf layouts preserve source text. Unsafe numeric identifiers cannot be reconstructed.

The original runner contract is not converted. Every original member except contract_sha256 participates in sorted compact UTF-8 identity; unknown status/dispatch/kind/authority values, unsafe/non-integer numbers and non-BMP keys refuse the whole contract. Enabled non-internal, non-candidate entries alone are callable. Default text is not copied or evaluated; redacted parameters cannot be submitted. Identity must equal the declaration and profile expectation.

runtime-profile@1 defines expected identity; workbook sheet/nine headers/identity marker/range/closing row/autoid shape; seat and host-method mappings; allowed combinations with parameter roles; device/host rejection lists; synthetic; required device_count from read-only precheck; optional fold_newlines pairs, default empty. Decision 35 opens all contract-enabled pairs; this list configures mandatory parameter roles rather than a second authorization whitelist. External-format closed sets live in the pack's format tables. Dispatch must check the real current device count again.

Plan data is bucket, empty blocks, steps [{object,method,args,keywords}], expects [{text,quote,after}] and replacements [{case,bed}]. Args remain text; keywords may also be safe nonnegative integers because the runner converts digit keywords. Signatures enforce order, required/positional-only arguments, declared keywords and credential exclusion without defaults. Literal assertions are forbidden in steps: only expects supplies assertion text, with an original quotation and a one-based command after. Replacements are numeric one-to-one mappings, and slots contain final text. Device/host rejection lists, catalog@1, quote@1, address ownership and grounded expectations remain required checks. The bed/ prefix exposes test-bed predecessor allocations; unrelated runs cannot use them.

## G behavior and supported encoding

The authoritative behavior is the integrator's task-page annex, transcribed read-only from the runner with synthetic examples. Empty G becomes the string None, so zero arguments cannot be written as an empty cell. Ordinary LF input is one unsplit positional string unless the method is explicitly in fold_newlines; folded methods trim Python whitespace, remove LF/CR and then split. Ordinary plan values remain single-line; codec tests separately cover the broader reading behavior.

Outside paired single/double quotes, commas split fragments; unmatched quotes are ordinary characters. Inside a quote, backslash protects the next character from closing the quote but remains literal. Empty/space-only fragments disappear. Each fragment is trimmed with Python whitespace; matching outer quotes are removed once and the inside trimmed again. Equals is interpreted afterward: a key containing an internal ASCII space makes the fragment positional, otherwise it is a keyword. Decimal digit keywords become integers, duplicate keys overwrite; positional digits remain text. Literal assertions are unsplit original strings, including quoted text/newlines, and compare to the most recent ordinary result. All generated H/I cells are empty. Waiting is a single ASCII-digit duration.

encodeG always decodes its result and compares types and values. It names the violated rule for empty/edge-space/CR positionals, equals-to-keyword conversion, mixed quotes that require wrapping, quoted trailing backslash, non-single newline values, unknown keyword names, numeric text keywords, non-ASCII numeric keywords, out-of-range integers and invalid wait/assertion values. No Python, shell or expression evaluator is used. Fixed-seed tests roundtrip 500 supported values. Denial matching remains text matching, not a proof of arbitrary shell behavior.

## Deterministic file and independent reading

The Node-built-in-only generator emits six fixed OOXML members, ZIP32 STORE with its own CRC32, fixed DOS timestamps and member order. A is inline text, C is numeric 0/2 and never initialization 1. Other values are inline strings. Row order is identity, nine-column header, description, each step with its after expectations immediately following, blank row, configured closing row. The description contains plan_run and build, never a person. Exactly one textual autoid starts the case with nonempty E. Every assertion row is generated from expects. Register and certification-request cells remain empty.

Identity F records the generator id; G records a canonical recipe digest so a changed quote/replacement also changes bytes without copying source content. The workbook-level range points exactly to the header. Invalid XML values are refused rather than dropped; SpreadsheetML-looking escapes and CR text are preserved. The reference circle-packs 10-13 xlsx.mjs was read only for OOXML behavior: differences are STORE versus Deflate, strict fixed layout and subset, no hidden-row facility, exact identity/range, rejection of invalid characters and accounted recipe metadata. No reference code or template bytes are imported.

The only ZIP/XML reader is the existing core xlsx@1 parser, unchanged here. readWorkbook consumes its structural model and independently scans all post-header E–I rows, including description/closing rows. It checks members, one visible sheet, inline strings/numeric C, no formulas or equals-prefixed cells, hidden rows, unique identity/header/range, exact original fields, signatures, one autoid, immediate assertions, empty registers, seat bounds and final closing row. It never calls the generator to parse input. Existing catalog@1 and quote@1 checks also serve workbook_verified. Only after semantic reading does the verifier regenerate and compare SHA-256 against the integrity-checked bound original bytes. A single changed ZIP timestamp byte fails even if the parsed model is identical.

The support data is exactly {sha256,autoids,bed:{id,manifest_sha256},build,generator,plan_run}. manifest_sha256 is the raw bound inventory digest, not a re-encoded model hash. No workbook text/bytes are returned. The package checks description D against frozen plan_run; dispatch must compare data.plan_run with the verification run's own predecessor. The bundle's generator id is tied to the pack version by tests; uploaded stale generator identities are refused.

Limits are declared in tables/workbook-format.json: 2,048 rows, 32,767 characters per cell, 2 MiB frozen model, 8 MiB output. Exceeding them refuses rather than truncates. SHA integrity and synthetic checks do not certify actual runner behavior.

## Two runs and offline scripts

First reserve the bed, then start a plan run with that reservation predecessor and all original sources. Submit/repair until every plan requirement is satisfied. workbook_verified alone is missing_input; accepted is not shorthand for satisfied. Preserve the exact original submission, start_run summary, complete result and bound source bytes. If the client exposes only formatted summaries, request a raw structured export from the integrator instead of manufacturing proof. Source pagination must be complete; local source-byte SHA checks catch reformatting or incomplete copies.

Run normalize-mindmap.ts only for local exports needing the two declared transformations: remove two leading U+FFFF and convert a single array wrapper into root. It preserves element spelling, including long numeric literals, and prints before/after SHA plus client-normalization disclosure. Ordinary root documents retain their original bytes.

The offline generator accepts --run --result --submission --contract --profile --inventory --out. It checks the received-submission digest, accepted result, full single-item coverage, locked pack/root, every mandatory plan status and exact expected-source bytes, then reads the verified identity receipt. It writes a new private file and prints only digest/version/size. No environment or network is read and existing files are not overwritten.

Source scripts stay under scripts/. The current core pack path contract forbids publishing that directory, so pack-files stages identical bytes under permitted tools/ and records their hashes. Installation must preserve tools/, functions/, tables/ and requirements.json together. The script and checker import the same functions/generate.ts. Node 24 is required; no production dependencies beyond built-ins are added.

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
