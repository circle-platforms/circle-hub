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
| allowed | [{object, method, parameters:{parameterName:role}}], subset of the enabled contract |
| denied | device and host command rejection lists |

Parameter roles and external manifest values live only in `tables/runtime-profile-format.json`. Role mappings must reference signature parameters; credential parameters cannot be assigned roles. Device CLI roles require seats and host shell roles require host-method mappings. Natural-language registry and three-argument checkpoint dispatches are closed this round. All profile problems are reported together with pointers. Source/profile identity changes require a new run.

## Restricted slots and checks

`slots.schema.json` publishes the complete nested shapes. A single plan claim carries `bucket`, empty `blocks`, explicit `steps: [{object,method,args,keywords}]`, `expects: [{text,quote,after}]`, and `replacements: [{case,bed}]`. Argument values are text. literal_assertion calls are forbidden in steps (assertion_in_steps): assertions must be authored in expects with a quotation and after; task 2 alone generates assertion rows immediately after the referenced command step. Unknown fields and the retired params/plan_json shapes are refused. Binding uses original parameter order/kinds, never expands defaults, rejects extra or duplicate values, enforces required and positional-only arguments, and rejects credential-marked parameters. Variadic positional arguments follow the signature; undeclared keyword names remain forbidden even with a variadic keyword parameter.

All explicit values are single-line final text, without edge whitespace, a leading equals sign, {} or {0}. Device CLI values are sent to catalog@1 and the profile's device rejection list; host shell values use its host rejection list. Denial matching is deterministic text matching, not execution or a proof of arbitrary shell behavior. The published profile and allowed combinations remain the owner's authorization boundary.

Every literal address in args, keywords and final expected text is checked, including extra invalid arguments. It must be a manifest interface or an unexpired address held by this lineage. Device CLI additionally permits only its mapped seat's own interfaces, lineage allocations and server interfaces. The workflow declares context leases and prefix bed/, so test-bed reservation predecessors expose their allocations; unrelated runs cannot use them. The independent manifest parser retains drift tests against test-bed for bed-name syntax, required services/reserved arrays, numeric service address comparison, address ownership and reserved-range containment.

Replacements are a one-to-one numeric address mapping and targets must be on the bed. The integrator confirmed that slots contain final execution text: Hub refuses leftover source addresses, never rewrites steps. Original quote text stays unchanged for quote@1; expected text must be an exact fragment of the quote after deterministic address substitution. after is one-based and points to a device CLI or host shell step, never a wait/assertion. At least one expectation is required. Supporting conclusions disclose the replacement table. Model-repairable codes in tables/codes.json have repair rows with two rounds.

## Runner G behavior and workbook boundary

G is a cell interpreted according to the original dispatch behavior, not a new typed protocol. Direct method calls use positional/keyword text separated by commas with balanced quoting; an empty cell means zero arguments. A comma inside a value must remain protected by matching quotes. Some command primitives consume the entire single-line cell without splitting, while other primitives use balanced-quote comma arguments; multi-command cells are closed this round. A literal checkpoint uses G as the literal expected value with previous-result semantics when the register cells are empty. Waiting uses the numeric-seconds cell. The natural-language registry and the three-argument occurrence checkpoint are not opened here. g_syntax/h_semantics/i_semantics are explanatory text, not a grammar to execute or evaluate.

Header text, sheet/marker/range names, closing row and autoid shape belong to the published profile. No real values are hardcoded here. Backslash handling, nested quoting and numeric decoding have no complete specification in the currently authorized material; this pack does not guess those rules. Before task 2 writes a codec, the integrator will read the runner parser and publish a behavioral specification with synthetic examples in the task-2 page, without copying code. Task 2 must then implement client workbook generation and an independent reader using those confirmed rules. This version neither writes nor verifies XLSX bytes and cannot authorize dispatch. The integrator explicitly approved removal of the old Hub-side exec-plan@1 generator and plan_deterministic requirement.

## Conclusions and handoff

Every pack-owned conclusion says 按合成合约核对 or 按发布的运行器合约核对 according to profile.synthetic, identifies the runtime and first 12 digest characters, and says 不证明在真实设备上跑得通. A supporting contract_shape outcome exposes data.runtime_version and data.contract_sha256 for task 2. A rejected plan has no identity support receipt. Generic catalog@1 and quote@1 conclusions keep their core wording and do not establish device execution.

The client skill automatically follows repair receipts; missing or inconsistent frozen facts require corrected source documents and a new run. First bring every required plan check to satisfied; only then use the task-2 client script and workbook-verification flow. That implementation and all real contract/profile publication, device actions and dispatch remain outside this task, pending the owner's design-section-6 answers.

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

## Workbook extension in progress

The existing core xlsx@1 parser remains the sole ZIP/XML reader. This pack declares a local structural model contract and will apply the generator subset in its independent semantic reader. The subset's member paths, external cell type values, bounds and generator identity live in tables/workbook-format.json. Parsed container bytes are never reparsed here; recomputed bytes will be compared with the integrity-checked bound original's SHA-256.

The integrator's task-page annex now supplies the G behavior: empty G means the string None, unpaired quotes are ordinary characters, escapes are retained, outer quoting precedes keyword recognition, digit keywords become integers, and duplicate keys overwrite on read. The encoder refuses non-roundtrippable values with a named rule; assertion cells are unsplit and wait durations use ASCII digits. Fixed-seed tests roundtrip 500 supported values. The approved compatible extension permits safe nonnegative integer keywords; ordinary plan values remain single-line. Profiles now require device_count from read-only precheck and may list fold_newlines combinations explicitly (default empty). Dispatch must recheck the actual count.

The client writer uses six fixed OOXML members in table order, ZIP32 STORE with a self-computed CRC32, fixed DOS timestamps, inline strings and numeric statement cells. It emits identity/header/description rows, each step and its immediately following expects, a blank row and the configured closing row. A remains text, C never requests initialization, and H/I remain empty. Identity-row F carries the generator id and G a canonical recipe digest, so changed quotations/replacements also change bytes without embedding source content. The 10-13 circle-packs writer was read only as an OOXML behavior reference: this implementation uses STORE instead of Deflate, rejects invalid XML characters instead of dropping them, preserves escaped SpreadsheetML-looking text, allows no hidden rows, and fixes the execution layout/identity and range from the profile. No reference code is imported or copied into this pack. Generation tests validate the result through the existing core parser, including CRC, member order, offsets and exact repeatability.
