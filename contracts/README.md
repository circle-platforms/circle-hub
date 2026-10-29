# contracts

The shared vocabulary, codes and shapes of the Hub. Every other package depends on this one; it depends on nothing but `zod`.
Import from `contracts/api.ts` (it re-exports `contracts/src/index.ts`).

## The single-source rule

Two files are the only sources:

| Source | Holds | Owner |
| --- | --- | --- |
| `contracts/model.json` | the cause model: 73 elements, 72 vocabulary axes, protocol codes, reference forms, record kinds, pack file names, display order, `version` | the model author; changes go through the integrator |
| `contracts/codes.json` | core violation codes `core.<interpreter>.<name>` with Chinese `when` and `fix` | contracts |

`tools/gen-contracts.ts` turns them, together with the zod shapes in `contracts/src`, into `contracts/generated`:

| Generated file | Content |
| --- | --- |
| `vocabulary.ts` | per axis: `NAME` (codes), type `Name`, `NAME_LABEL`, `NameSchema` (zod enum), `isName`; `AXES`, `labelOf(axis, code)`, `axisLabel(axis)` |
| `protocol.ts` | `PROTOCOL_CODES`, `CORE_VIOLATION_CODES`, `REFERENCE_FORMS`, `RECORD_KINDS`, `PACK_FILE_PATHS`, `DISPLAY_ORDER`, `MODEL_VERSION` |
| `tools.json` | the six MCP tools: name, title, description, input and output JSON Schema (2020-12), annotations from `annotationsFor` |
| `schemas/<name>.v<major>.schema.json` | JSON Schema of every shape in `SCHEMA_REGISTRY` |

Read the model with `node tools/show-element.ts B01 w08` (ids are case-insensitive), `--list`, `--vocab [axis ...]`, `--pending`.

## What must never be hand-written

- Anything under `contracts/generated/`. Edit a source and regenerate.
- An enumeration of a vocabulary axis, or one of its labels, anywhere in the repository: use `NameSchema`, `NAME`, the type `Name`, `isName` and `labelOf`. A subset is written as `NameSchema.extract([...])`, which the compiler checks. Per-value behaviour is a table typed `satisfies Record<Name, ...>`, so a new value does not compile until it is placed (`URI_TAIL`, `PartitionItem`, the terminal rules, the effect reach of `annotationsFor`).
- A protocol code, a core violation code or a record kind: use `PROTOCOL_CODES`, `CORE_VIOLATION_CODES`, `RECORD_KINDS`. A missing code is added to `model.json` (protocol) or `codes.json` (core) on request. Pack codes are not registered here; they live under the pack name (`<pack>.<code>`) and are registered when the pack is published.
- MCP annotations: derive them with `annotationsFor`.
- JSON Schemas of tools or records, and reference URI patterns: use `ReferenceUri`, `Ground`, `referenceUriOf(...)`, `TreePath`, `ExternalObjectId`.

## Editing `contracts/model.json`

Only on the model author's decision. The generator refuses (exit 2, every problem listed) unless:

- each vocabulary axis has a snake_case `axis`, a `label`, an `owner` that is an element id of the model, and a non-empty `values` list of `{ code, label }` with snake_case codes and labels unique within the axis; no two axes render the same generated name, and no axis renders a name that `protocol.ts` or a module of the barrel (`contracts/src/index.ts`, `export *`) already exports;
- labels, `when`, `fix`, forms and display order entries are text without C0 or C1 controls or line separators (U+2028, U+2029); an axis label never contains `*/` (it is written into a doc comment);
- `formatProposals.references` lists exactly the schemes of the `reference_scheme` axis, in the same order, each with a `form`; every scheme needs a grammar in `contracts/src/reference.ts` (`URI_TAIL`), and every partition an item shape in `contracts/src/validation.ts` (`PartitionItem`), or loading fails;
- protocol codes are unique UPPER_SNAKE_CASE with Chinese `when` and `fix`;
- record kinds are unique snake_case; `packFiles` and `displayOrder` are non-empty arrays; pack file paths are unique; display order entries are non-empty.

Bump `version` when the meaning of anything changes; it is generated as `MODEL_VERSION`.

## Editing `contracts/codes.json`

One entry per core interpreter result: `{ "code": "core.<interpreter>.<name>", "interpreter": "<interpreter>", "when": "…", "fix": "…" }`.
Codes are unique and snake_case, `interpreter` equals the middle segment of the code, `when` and `fix` are Chinese (they are shown to the model and the user).

## Regenerating

```
npm run gen:contracts       # node tools/gen-contracts.ts: writes changed files, removes stale ones
npm run verify:contracts    # node tools/gen-contracts.ts --check: writes nothing
```

Exit status: 0 current; 1 drift found by `--check` (every missing, out-of-date with the first differing line, and stale file is listed); 2 invalid input (invalid sources, a `contracts/src` that fails to load, a name two barrel modules both export, a schema key registered twice or not `name@major`, a tool schema that is not a zod object, a shape JSON Schema cannot represent; every problem listed); 3 the files could not be written (one line: another run holds the lock, or the I/O error).

`contracts/src` is loaded against the freshly rendered `vocabulary.ts` and `protocol.ts` (served from memory), so a single run converges after a vocabulary change. Every call of `generate()` loads `contracts/src` as a fresh module graph (each module URL carries a tag of the call), so a second call in the same process sees changed sources. The root is resolved to its real path first, so a root reached through a symbolic link works. Output is deterministic: same sources, same bytes (tested across two fresh processes).

A write holds `contracts/generated/.gen-contracts.lock` (the writer's pid) and replaces each file by renaming a complete sibling copy over it: a reader never sees a partly written file, and two runs never interleave. A lock whose process has ended is taken over; a lock held by a running process stops the write with exit status 3. `--check` takes no lock.

## Registering a shape from another package

Four stub files belong to other packages. Each exports `schemas: Record<string, z.ZodType>`; `contracts/src/index.ts` merges them into `SCHEMA_REGISTRY`.

| Stub | Owner |
| --- | --- |
| `contracts/src/pack.ts` | runs (pack files: requirements, slots, checks, knowledge declaration, ...) |
| `contracts/src/knowledge.ts` | knowledge |
| `contracts/src/resources.ts` | connectors |
| `contracts/src/tables.ts` | rules |

Rules for a stub:

- Keys are `name@major`: lowercase letters, digits, `_` or `-`, then `@` and an integer without leading zeros (`SchemaId`). The file becomes `schemas/<name>.v<major>.schema.json`. A key used twice, in any two files, stops the generator with both files named.
- Import only `zod`, `contracts/generated/*.ts` and other `contracts/src` modules, never `hub/**`.
- Every vocabulary value comes from a generated `NameSchema`; every reference is `ReferenceUri`, `Ground` (a claim's or an outcome's grounds) or `referenceUriOf(...)`; ids use `idOf`.
- Objects are `z.strictObject`; open bags (slots, fields, data, parameters, structure) are `z.record`. A free-text field that may be long gets `.max(n, { abort: true })` before any pattern: a grouped pattern overflows the regular expression stack on megabytes and throws instead of failing.
- Shapes must be representable in JSON Schema (no transforms, dates, bigints or custom types). JSON Schema is generated with zod `io: 'output'`: objects are closed (`additionalProperties: false`) and fields with defaults are required. Rules a pattern cannot say are refinements; list them in your README (see Limits).
- After a change run `npm run gen:contracts` and hand the regenerated files in with your change. Do not edit `index.ts` or `contracts/generated`; ask here instead.

## Decisions

1. **Partitioned manifest.** `ValidationResult.partitions` holds one array per partition (keys generated from the `partition` axis), as `formatProposals.response` proposes. A partition is cited as `rec:<digest>#/partitions/<partition>` and an item as `rec:<digest>#/partitions/<partition>/<n>` (B03 F[3], the example `rec:c3d9…#/partitions/delivered/2`; V05 R[6] binds a partition as a run input). Each partition has its own item shape (`PartitionItem`, V05 F[0]-F[3]): a rejected item needs `code`, a quarantined or incomplete one `reason`, a delivered one has neither. Disjointness (V05 R[0]) is not structural: it is a refinement of `Partitions` (an item listed twice, in one or two partitions, is refused); that the union equals the run's item set is checked by runs, which knows the items. Counts are derived from the partitions and never stored (W08 R[0]): `partitionCountsOf(partitions)` gives them, keys generated from the partition axis plus `unknown` (items with an unchecked, no-verdict or not-run terminal, V03 R[4]). This answers model question 5 in favour of the proposal.
2. **Layer terminals.** Attribution hangs on each layer terminal (V04): `LayerResult.attribution`, never on pass or judgment (V04 R[1]). A violation or a fail needs `code`; an unchecked, no-verdict, not-run or incomplete terminal needs `reason` (V03 R[4], W07 R[2]-R[3], W02 R[5]); a pass has neither. A requirement lists each layer once and gives `unsatisfied_reason` exactly when it is unsatisfied (V03 F[2]).
3. **Reference URIs** follow `REFERENCE_FORMS` exactly:
   - `src:<sha256>` or `src:<sha256>/<parser>@<major>/<selector>`, the selector possibly ending in `:<from>-<to>` with from < to; parser names are at most 64 characters, majors and range bounds have no leading zeros;
   - `tree:<root>/` (the root) or `tree:<root>/<seg>/<seg>...`, optionally ending in `@<entry>`; no empty segment, no trailing slash;
   - `entry:<sha256>`; `rec:<sha256>` or `rec:<sha256>#<JSON Pointer>` (`~0`, `~1` escapes).
   Raw characters never allowed: `%` unless it starts an escape `%XX` with upper-case hex; the structural character of each part (`/` and `:` in a selector, `/` and `@` in a path, `#` in a pointer); every control, format or space character (`\p{Cc}`, `\p{Cf}`, `\p{Z}`, which hub/refs percent-encodes) and unpaired surrogates. The published patterns name the BMP ones as explicit ranges (no `\p{}`, no lookaround); astral format characters, unpaired surrogates and the range order are refinements. At most `MAX_REFERENCE_LENGTH` (8192) characters, checked before any pattern. The object form (`Reference`) holds the same canonical text in `selector`, `path` and `pointer`; `TreePath` is the canonical path. These shapes accept everything the refs formatter emits; refs' parser is stricter (canonical spelling only: no escape where none is needed, valid UTF-8, at most 256 segments). An external object id never uses a reference scheme as its system and contains no control, format or space character.
4. **Grounds.** A claim's grounds (`Claim.grounds`, `CrossItemSubmission.grounds`, the referents of `resolve_reference` and of `ValueResolution`) are `Ground` = `src`, `tree` or `rec`. A knowledge entry is never a ground on its own: it is cited by its tree address `tree:<root>/<path>@<entry>` (B01 R[5], B03 F[2]); `entry:` stays a valid `ReferenceUri` elsewhere.
5. **Strict objects.** Every object of the contracts is `z.strictObject` (inputs, outputs, records, references): an unknown or misspelled key is an issue with a path, never dropped, and server-side validation matches the closed published schemas clients enforce.
6. **Ids** are the prefix, `_`, and a lowercase Crockford ULID (no i, l, o, u; first character 0-7). `TraceId` refuses the all-zero id (W3C). `IsoTime` is UTC with `Z`. `SchemaId` and `Versioned` majors have no leading zeros (`claim@01` and `claim@1` cannot both exist). Published patterns use no lookaround and no `\p{}` (some MCP clients translate schemas for providers without them): such rules are zod refinements.
7. **Runs.** `RunSummary` carries `sources` (`SourceBinding`: reference, role, slot, external identity with revision, media type, label; P02, A03, T04 R[4]), `target_basis` (W06 F[6]; model question 4) and `slots` (`SlotSchema`: the pack's `slots.schema.json` as JSON Schema 2020-12 with its SHA-256, so the model and the client can fill and check slots, T01 F[3], W05). Items may carry a Hub-computed `digest` (the item fingerprint) and `reuse`, the `rec:` reference to give back to carry an unchanged item over (C08 R[4], W07 F[6], acceptance scenario 10). `RunRecord` (`run@1`) adds: `runner` (absent only when the Hub itself executes a standing obligation: host `hub` requires trigger `standing_obligation`, W06 F[0]-F[1]), `host`, `trigger`, `configurer` (W09 F[1]; required for event, schedule and standing obligation triggers), frozen `parameters`, `policy`, `executors` (registry digest, W06 F[7]), and `client_key` with `request_digest` (SHA-256 of the RFC 8785 canonical JSON of the start_run arguments the key was bound to, so the same key with other arguments is IDEMPOTENCY_MISMATCH, D05 R[4]) and `client_key_expires_at`, the three together. Phase is never stored (W06 R[2]).
8. **Submissions.** `items` are a discriminated union on `handling`: a handled item gives `slots` or `reuse` (not both), a skipped one only a non-blank `reason` (W07 F[2]). An item is declared once. `cross_item` is optional (W07 F[3]) and a union on `nature`: a fact needs at least one ground and has no premises; a judgment may rest on earlier entries through `premises`, `/cross_item/<n>` with n below its own index and without leading zeros (acceptance scenario 5). In-run checks (W07 F[4]) are declared inline data in `checks`: a requirement allowing `run_table`, a core interpreter, a table and bound item samples. W04 ledger rulings determine whether the Hub executes the shape; admission evidence is recorded on the submission’s existing validate action. Criterion changes (W07 F[5], W10) are optional `criterion_changes`, each naming an item, bound expected criterion, assertion, verbatim old value, new value and nonempty quoted grounds. Resolution and quotes are whole-submission boundaries; a source-role mismatch refuses only that declaration. Accepted declarations create judgment requests and never change the original run’s checks. Independent account review and a subsequent revision are required before freezing the accepted references. A submission is stored exactly as received: as `submission@1` when the arguments parse, as `submission-received@1` (any arguments object) when they do not (W07, B05 R[3]); with strict objects and no defaults a parsed submission equals the raw arguments.
9. **Claims.** `Statement.reason` for an unknown verdict (V01 R[2]), `Statement.rank` (V02 F[4]), `Qualifier.collected_at` (B01 F[3], A05). `Claim.pointer` locates the claim in the submission or the checked subject; `Claim.resolutions` lists each exact value with the model's text, its resolution and its referents side by side (W08, T04 R[1], display rule 4): resolved has at least one referent, ambiguous at least two, unresolved none.
10. **Validation result items.** `carried_over` (a `rec:` reference) records that the Hub carried an item over from the predecessor fragment after checking that the item and the cited content are unchanged (C08 R[4]); it tells "reused" from "re-judged" (acceptance scenario 10). A not-accepted result has no partitions, no cross-item claims and at least one error (V05 R[5], W08 R[1]); `rounds.used` never exceeds `rounds.max`; coverage that is complete examined everything, and examined never exceeds total (A05 R[1]).
11. **Tools.** Every answer conforms to its output schema, a protocol error included: an error is the envelope plus the tool's empty shape, never an invented run id, lock or digest (D05 R[3], T03 R[3]). `Envelope`: an error names at least one code, and a receipt is `accepted` exactly when `call_result` is ok (D05 R[1]). `submit_result` answers `{ envelope, acceptance, result?, counts? }`: `result` is the stored `validation@1` body (absent when no run you may use was found, for example an unknown, unavailable or malformed run id), `counts` are given exactly when the submission was accepted and equal `partitionCountsOf(result.partitions)`; the envelope `trace` is this call's, `result.trace` that of the call that produced it (a repeated submission returns the stored result, D05 R[5]). `resolve_reference` gives `resolution` exactly when ok; an error has no referents. `start_run` carries `run` exactly when ok. `upload_file` returns `reference` = `src:<sha256>` with `sha256` and `size` exactly when accepted. `get_nodes` echoes `root`; every node carries `reference` = `tree:<root><path>` and every entry `tree:<root><path>@<entry>`, to cite verbatim; node, child and requested paths are `TreePath`; text is given only for a model-readable source (D06 F[3]); `level` is a plain string until model question 1 is answered. `upload_file.file_path` is base64 content (`contentEncoding: base64`, pattern `^[A-Za-z0-9+/]*={0,2}$`, length divisible by four, at most `MAX_UPLOAD_BASE64_LENGTH` for `MAX_UPLOAD_BYTES` = 16 MiB, the earlier implementation's source cap); zod's `base64` is not used because it publishes `format: base64`, which JSON Schema 2020-12 does not define. Descriptions name no product, system, command or customer.
12. **Annotations** follow D03 R[6] completely: external writes are destructive unless `reversible`, an external read is read-only only with `readOnlyEnforced`, `idempotent` only where repetition is unconditionally deduplicated. The effect classes are placed by a table typed `satisfies Record<EffectClass, ...>`; a value it does not know (one the vocabulary gained before the table) gets the most conservative hints (`readOnlyHint: false, destructiveHint: true, openWorldHint: true`), so no client auto-approves it. `start_run` is declared `readsExternal`, so `tools.json` shows it open-world, which is what milestone-1 callers see; a server that knows a caller's packs passes the caller's own `readsExternal` (D06 F[2]). A call that makes the Hub dispatch passes the widest effect class it may dispatch (D06 R[4]).
13. **Record envelope.** `id` is a `RecordId`; `schema` is a `SchemaId`, the registered body shape (`validation@1` for a `validation_result`, as W08 names it); `provenance` holds the provenance type (A01). Wherever contracts say `provenance` they mean the A01 type; the origin of a read (B02 F[1]) is the external object identity, `external` in `SourceBinding` and in the source artifact body.

## Limits

- Shapes for effects, dispositions, leases, hypothesis sets, in-run checks, control-interval details and executor registries are not written yet; their vocabulary is generated.
- W10 declarations are in `submission@1`; judgment requests have a generated `request@1` schema, with optional declaration position for historical readers.
- Bodies of `source_artifact`, `authorization`, `action` and `call_log` records are defined by the records package (`hub/records`) and have no generated JSON Schema.
- Rules only zod checks (refinements; a validator that reads only the published JSON Schema, such as an MCP client's, accepts these): the order of a byte range; astral format characters and unpaired surrogates in references and external ids; an item, a requirement or a layer listed twice; premises that do not point to an earlier entry; slots beside reuse; the presence rules of decisions 2, 10 and 11 (codes, reasons, attribution, unsatisfied reasons, result, counts, run, resolution, references, receipt and call result agreeing, node and entry references equal to root and path); rounds and coverage consistency; the base64 length rule. `tool-shapes.test.ts` names each of them case by case. The SDK's default validator is draft-07 Ajv: it ignores `prefixItems` (the tuple of `SrcReference.range`).
- A local path made only of base64 characters, with a length divisible by four, passes as base64; the server can only notice that the bytes do not parse.
- Shapes with refinements cannot be `.pick`ed or `.omit`ted (zod 4 throws); build derived objects from `.shape`, and use `.safeExtend` to override a key.
- `tools.json` is about 250 KB: the four partition item shapes each inline the requirement and claim shapes, and the reference patterns spell out the never-raw ranges. The input schemas models see are about 6 KB each.

## Notes for other packages

- **server**: an MCP SDK `McpServer` rejects arguments that fail the registered zod input schema before the handler runs (now also for any unknown key, since inputs are strict: answer -32602 is fine for the five other tools). A submission must still reach the Hub, be stored as received and get `SUBMISSION_SCHEMA_VIOLATION` with paths and rounds left (W07, T03 R[3], W08 R[1]): register `submit_result` with a permissive input schema, list the schema of `tools.json`, and validate with `SubmitResultInput` inside; map each zod issue path to a JSON Pointer (an unknown key comes as an `unrecognized_keys` issue at the parent path with `keys: ['slot']`; append the key to point at `/items/0/slot`). Store the raw arguments: as `submission@1` when they parse, as `submission-received@1` otherwise. Answer an unknown, unavailable or malformed run with `{ call_result: 'error', acceptance: 'not_accepted', errors: [...], trace }` and no `result`; fill `counts` with `partitionCountsOf`. Register the output schemas: their refinements catch a server answer that would mislead (for example counts that do not match). The streamable HTTP transport refuses bodies over `maxRequestBodySize` (SDK default 4 MiB): to take uploads up to `MAX_UPLOAD_BYTES`, set it to at least `MAX_UPLOAD_BASE64_LENGTH` plus the JSON-RPC envelope. Zod issue messages are English diagnostics for models (like the schema descriptions); the Chinese text users see comes from `PROTOCOL_CODES` and `CORE_VIOLATION_CODES` (`when`, `fix`), with the issue path as `path`.
- **refs**: format URIs to the grammar in decision 3; `ReferenceUri` rejects anything else. `MAX_REFERENCE_LENGTH` is exported here (8192, the same as yours). Pointers into a validation result now go through `partitions`: `#/partitions/delivered/0/requirements/0/claims/0`, not `#/items/...` (your resolve tests use the old layout in synthetic bodies).
- **records**: `RecordEnvelope.schema` accepts any `SchemaId` (hyphens and digits included); record ids must use the ULID alphabet (yours do). `submission-received@1` is registered for submissions that do not parse.
- **runs**: `run@1` is `RunRecord` here; ask for changes rather than defining a second run body. Until model question 8 is answered, name an item the submission does not cover (W07 R[3]) with `core.coverage.shortfall` and the `item`: it is what the coverage@1 interpreter gives for the run's item set against the submission's declarations, its `when` and `fix` say exactly that ("补上缺的成员，或写明跳过的理由"), and it is not a whole-rejection code; the item goes to `incomplete` with reason `not_covered`. Until model question 9 is answered, refuse a `reuse` that is not the `reuse` start_run offered for that item with `SUBMISSION_SCHEMA_VIOLATION` at `/items/<n>/reuse` (the offer was computed from unchanged digests and frozen with the run), and set `carried_over` on the items you carried over.
- **knowledge**: emit `level` as an English code, never a Chinese label, until model question 1 is answered. `get_nodes` needs the root, each node's and child's canonical path, and per node and entry the tree reference (`tree:<root><path>`, `…@<entry>`); never offer `entry:` as something to cite.
- **packs**: `ItemProjection`, like every shape, is strict; `ExternalObjectId` refuses raw control, format and space characters (your selector encoder already escapes them; your external-id encoder does not escape format characters such as U+200B).

## Needs from other packages

- **hub-unknown-exits (codex-b), review item 5:** connect reason selectors in terminals.ts routeOf and evaluate.ts routing,
  and make repairRounds match the reachable routes. Currently reasons do not route but may raise the repair budget;
  contract/publication validation is not a substitute for that runtime work. Define and test exact-code/reason/wildcard
  precedence there. This repair intentionally does not edit terminals.ts or any unknown producer.

- **records**: `hub/records/store.ts` accepts only `/^[a-z_]+@[0-9]+$/` as a schema name, so storing a body registered as `catalog-entry@1`, `check-outcome@1`, `run-summary@1`, `pack-summary@1` or `submission-received@1` throws `schema must be name@major`. Please validate schema names with contracts' `SchemaId` (which also refuses leading-zero majors).
- **rules**: `CheckOutcome.grounds` in `contracts/src/tables.ts` should be `z.array(Ground)` (import it from `./reference.ts`), so an outcome never rests on a bare `entry:` (B01 R[5]); `JsonPointer` can be imported from `./common.ts` instead of declared twice; give `JsonPath` its `.max(512, { abort: true })` and `JsonPointer` a length cap the same way, since their patterns overflow on megabytes. Then run `npm run gen:contracts` or ask here.
- **rules, refs, packs, records**: the reference grammar is tighter (decision 3) and every shape is strict (decision 5); please rerun your tests against this version. The contracts owner ran only `contracts/**` tests.

## Model questions

1. **K01 R[2]: node position labels have no axis.** Answered 2026-10-22 by the integrator: the model has the axis `node_level` owned by K01 (`trunk` 干, `branch` 枝, `leaf` 叶), and `K01 R[1]` the axis `change_kind` (`added` 新增, `removed` 删除, `modified` 修改), and `K02 R[3]` has the axis `entry_kind` (`definition` 定义, `behaviour` 行为, `case` 用例, `defect` 缺陷, `observation` 观察). `level` is `NodeLevelSchema` and the stored entry kinds, the catalog declaration's `entry_kind` and the `get_nodes` entries are `EntryKindSchema`; a producer's output keeps `kind` as a string because the knowledge package checks it against the axis one entry at a time (one wrong entry is refused and reported, the rest of the output stays). The catalog declaration of a product pack also gained the optional `producer`, so that a catalog can be limited to the entries of one producer.
2. **C04 R[1]: the eight table semantics have no axis.** "只用八种表语义：成员、映射、模式、前缀/范围/阈值、目录匹配、结构、覆盖、逐字引用" is a closed set that checks.json (T01 F[4]) and in-run checks (C05 R[5]) must name. Today `codes.json` names six interpreters in English by hand and the rules package keys its tables `structure@1`, `catalog@1`, `membership@1`, `pattern@1`, `range@1`, `coverage@1`, `quote@1` (mapping has none). Proposal: an axis owned by C04 with the eight codes and their labels; the generator then checks every `interpreter` against it.
3. **B01 F[2] against C08: a target cannot be a producer.** B01 F[2] lists four warrant forms (规则@版本 / 模型@确切配置 / 人 / 目标@版本) and A01 R[0] writes 目标@版本 for what a target computed, but `producer_kind` has only function, model and human. A claim on a target's self-report cannot state its producer kind. Milestone 1 has no such claim.
4. **W06 F[6]: the basis of the run target has no axis.** "各带依据（声明 / 按规则选定 / 设备回显）和确认它们的观察". Contracts record it as `target_basis: Claim[]` with 声明 → provenance `declared`, 按规则选定 → `projected` (A01 R[1]), 设备回显 → `observed`, the rule or the account in the warrant and the observations read as grounds. Please confirm the mapping or add an axis.
5. **formatProposals.response: `partitions` as four arrays.** Answered by following the proposal (decision 1): a partition must be citable as a record reference target (B03 F[3], V05 R[6]), which per-item partition fields cannot give. Please confirm.
6. **formatProposals.packFiles: two paths in one entry.** The path `samples/positive/、samples/negative/` is copied into `PACK_FILE_PATHS` as one string that is not a path. Proposal: two entries, `samples/positive/` and `samples/negative/` (T02). Contracts did not split it.
7. **formatProposals.recordStructure says `schema = kind@版本`, W08 names the body `validation@1`.** The kind is `validation_result`. Contracts follow the element: `schema` is the registered body shape, not the kind. The proposal's sentence could say so.
8. **W07 R[3]: no code names an item the submission does not cover.** The rule keeps the submission accepted, names the item in `errors` and counts it toward repair rounds, but every entry of `protocolCodes` is a whole-rejection or protocol code (`SUBMISSION_SCHEMA_VIOLATION` says "T03 整份不受理之一") and the reason `not_covered` is not a code. Proposal: a protocol code `ITEM_NOT_COVERED` (when "提交没有给出该条目的处理声明和槽位记录（W07 R[3]），该条目记未完成，整份仍受理", fix "给出该条目的处理声明：已处理并附槽位记录，或跳过并写明理由"). Interim: `core.coverage.shortfall` (notes for runs).
9. **C08 R[4]: refusing a carry-over, and marking one.** No code or reason refuses a `reuse` whose item or cited content changed (within a run the Hub only offers `reuse` for unchanged items, so the case is a reuse that was not offered), and `qualifier_mark` has `no_reuse` but no mark for a carried-over judgment. Proposal: say whether a wrong `reuse` is a structure violation (`SUBMISSION_SCHEMA_VIOLATION`, the interim) or makes the item uncovered (W07 R[3]); and add a mark such as `carried_over` (沿用) for claims taken from the predecessor record, whose judge and model configuration come from that record.

## How to test

```
node --test "contracts/**/*.test.ts"
node tools/gen-contracts.ts --check
npx tsc --noEmit
```

The first test of `generator.test.ts` fails whenever a source or a registered shape changed without `npm run gen:contracts`: that is the drift check, not a flaky test. The tests cover: every axis generated with labels (`vocabulary.test.ts`); the generated files current and deterministic across fresh processes, a second in-process generation seeing changed sources, a root reached through a symbolic link, `--check` naming every drifting file, bad input reported (labels, name clashes with the barrel, a scheme without grammar, malformed format proposals), the lock and write failures with exit status 3 (`generator.test.ts`, on a temporary copy, including a type check of axes named `record` and `readonly`); the D06 annotation table and the conservative default (`annotations.test.ts`); valid and invalid references, URIs, grounds, external ids, input bindings, claims and value resolutions, submissions, validation results, envelopes, ids, runs and records, with a negative case per rule (`shapes.test.ts`); every tool's input and output, success and error answers, against zod and against `tools.json` through the SDK's Ajv validator, refinement-only cases named (`tool-shapes.test.ts`); the record schemas against the same validator, formats limited to 2020-12, compilation without warnings (`published.test.ts`); `tools.json` structure and the literal D06 annotations (`tools.test.ts`); protocol and core codes (`codes.test.ts`); the element viewer (`show-element.test.ts`). Synthetic examples live in `contracts/src/fixtures.ts` (test support, not part of the API).


`LinkDeclaration` selects exactly one of `field` (a string or string-list data property) and `alternatives_field` (a list of
strict `{primary: string, alternatives: nonempty string[]}` groups). Alternative groups require generated `link_match`
`exact`: an eligible exact primary wins; only when absent are the expanded alternatives checked individually, against the
same namespace, kind, normalization and producer restrictions. Counts describe the effective checked spellings, grouped
by rule and normalized literal; identical spellings under different rules remain separate groups. Group structure is
validated when the reader evaluates producer data; malformed data is an entry diagnostic, never a whole-production error.
The declaration's cross-field requirements are runtime refinements, in addition to the generated schema properties.

`links-view@1.rule_diagnostics` reports unavailable target namespaces once per rule, with a generated reason and concrete
recovery action. Its `unchecked_literals` and the optional matching total count the unchecked candidate spellings, including
both primary and expanded spellings of an unresolved alternative group (deduplicated per entry); they are part of `literals`
and never part of drift counts. Rule diagnostics are separate from malformed source-entry diagnostics and carry no invented
entry reference. Prefix/rule filters apply to the unchecked totals as they do to checked source occurrences.

经集成者作为契约负责人授权，core.contribution.* 收录核心回注准入核对的十个码。codes.json 的历史 interpreter 字段在这里表示核心发出方 contribution，不表示新增已安装解释器；when/fix 只在核心登记。凭据拒绝沿用 CREDENTIAL_IN_UPLOAD。

## Unknown-sweep contract handoff

Model 10 owns the rules. `keep_unknown` stays the compatibility disposition code; its generated label is now 带期限的暂缓
(source: the model owner, 2026-10-24). The label does not implement scheduling: expiry, reconciliation and request creation
remain the consuming engine's work. Exit actions come from generated `exit_action`, including automatic reevaluation;
`keep_unknown` is not an exit action.

### Recovery fields (task item 3; input and history boundaries)

`CheckOutcome` with unknown requires top-level `missing` and `reason`; `data.missing` is not an alias. `exit` is optional
there: a package need not know the runner or publisher account. The Hub resolves the cause and binds its exit before
writing a new transitional `LayerResult`. New unchecked, incomplete, not_run and no_verdict layers require `missing` plus
`exit`. `gaps` retains additional independent causes with their own facts and exits. It supplements the primary cause.

`UnknownExit` uses generated `exit_action` and request_kind. Automatic actions have `audience: {hub:true}`; requests have a
named `{user: <Hub account id>}` or `{external: {mapping: <rec reference>, identity: <mapped identity>}}`, request_kind and
an absolute ISO due time. Roles such as “runner” or “admin” are not named recipients. The engine must verify mapping,
visibility and scheduling; the schema does not perform effects or authorize a recipient. A request kind is forbidden on
automatic actions. Dates are validated structurally, never against wall time when reading history.

`ValidationResult` is the new-write boundary. `StoredValidationResult` / `readStoredValidationResult` are read-only legacy
entry points: the latter returns `{result, notices}` with paths and “出口未写” / “缺失事实未写”, without backfilling either
field in the record. Consumers must switch history rendering to this reader; no historical records are rewritten here.
The new conditional requirements are also emitted in JSON Schema, not only Zod refinements. The generator's full-snapshot
symlink test writes the full snapshot to a temporary file for exact comparison and sizes its unexpected-output capture buffer from the serialized expected snapshot; no production or timeout limit is
changed. hub-unknown-exits must derive actions/create requests, preserve gaps, and use the strict writer after binding exits.

### Table absence and empty aggregates (task item 6)

The required flags describe a verified refutation (`core.structure.required_empty`, `data.missing`) attributed to whoever
provided the subject. They never convert a mandatory absent location into unknown. Optional absence is distinct from an
empty selected collection. `range@1` min/max thresholds accept `empty: refute|support`, omission meaning refute; count and sum
keep their defined empty numeric value and do not accept the min/max-only option. This is a table-format selector derived
from the generated verdict axis. The range interpreter executes the empty min/max decision with `data.empty: true`;
required-location attribution remains hub-retry-split's work. Complete catalog absence
is a refutation; an incomplete catalog needs its missing sources and recovery, not a fabricated complete scope. View scope
fields are deliberately left to the owner of views.ts.

### Cause routing and skipped work (task item 7)

ErrorHandlingRow selects exactly one `code` or generated `reason`; duplicate selectors are checked in separate namespaces.
The existing repair/max_rounds contract is unchanged. Static pack validation recognizes reason selectors without pretending
that a reason is an installed interpreter code. Runtime cause routing, repair exhaustion and B07 records remain
hub-unknown-exits's work. Skipped submissions may name remaining work/intent; their required reason is preserved in the
new result `skip_reason` field when the consumer projects it, rather than being lost behind the declared_skip code.

### Publication and check-work declarations (task item 5 and the limits part of item 10)

`PublishableRequirementsFile` is the strict new-publication guard: a static fact layer has a check, and a dynamic fact
layer names its P07 `observation` contract. Judgment-capable requirements are not forced to install a fact check. The base
`RequirementsFile` remains the frozen legacy-file reader. `hub/runs/packs/validate.ts` now uses the strict guard
at publication, preserving per-field checks/observation refusal paths; `load.ts` keeps the historical reader. These guards do not claim that a referenced observation has actually happened.

`CheckEntry.limits` has the sandbox's camel-case work controls (timeoutMs, memoryMb, outputBytes, logBytes, inputBytes).
Bounds are refused, not silently clamped; omission inherits service defaults. A source-only cross-check test anchors the
contract's capacities to the runtime sandbox constants without importing/executing the sandbox. These are check-work limits,
not P11 effect counts/durations. hub-retry-split must pass them into execution, split/retry work and attach actual recovery.

### Submission deadline and successor declarations (task item 8)

`StartRunInput.submission_due` carries a requested absolute deadline; `RunSummary` and the readable `RunRecord` preserve it
when recorded, with omission retained on history. `NewRunRecord` is the strict write boundary: a deadline is mandatory and
later than creation. It never derives a deadline from wall time on a historical read. The engine must bind policy/defaults
before that write and implement expiry/requests; adding this field alone schedules nothing.

`workflow@1.predecessor: required` is an explicit start constraint, separate from independent judgment. A Hub-hosted
event successor must name its predecessor and runner and contain only fact requirements; the original standing-obligation
reader remains supported. The service must prove the same runner and actual root-update event from records, not merely
trust these shape fields. `RequirementSummary.observation` exposes the declared dynamic observation identity when copied.
run.ts also changes in hub-read-absence; the integrator must retain both sets of optional historical fields when merging.

### Read absence and routing declarations (task item 9)

`ReadProjectionOutput` can return `artifacts: []` plus `absent: {code: SOURCE_ABSENT, system, object, observed_at, responses?}`.
It is an observation of a named object, not an error or a permission denial. Found content and incomplete lookup cannot be
mixed with whole-object absence; the JSON Schema repeats those constraints. The service must verify actual responses,
permission and timestamps and bind originals before treating it as observed (hub-read-absence's work).

Routes can declare finite pagination and same-origin redirect capacities. Each follow-up is a separately planned, allowed,
recorded request; the declaration does not enable a hidden transport follow. `ReadResourceRoutingSet` is the activation
boundary for registry-provided enabled/type/environment facts: different enabled resources cannot claim the same type in
the same environment. The registry must call it during activation/routing; this task does not alter a real resource.

### Catalog syntax and remaining ownership (task item 10)

The existing catalog table-language primitive list adds `hostname` and `ip_or_hostname`; they are external-format parameter
types, like the existing int/ipv4/enum syntax, not a new Hub vocabulary axis. `address_role` names a role from the bound
published runtime contract; the schema never invents a device role. Minimal parameter checks accept bounded ASCII DNS labels
(single labels, final dot and ASCII punycode spelling), IPv4/IPv6 or that host union; no DNS lookup, URL coercion or real device
operation happens. New branch tests include synthetic valid/invalid words and declared length bounds.

A raw scalar source `limit` is not accepted as a universal CatalogParam field. The source producer must interpret its own
format and emit existing semantic constraints: singleton numeric minimum=maximum, numeric ceiling maximum, enum member
values, or string length maxLength. hub-view-scope owns the FAMX command-tree translation, actual address-role mapping,
automatic credential acceptance/scanner pagination and validity evaluation. `not_evaluated` was already in model 10 and its
generated vocabulary on this baseline. Those runtime operations are not implemented by adding these contract declarations.

### Scope and rollout

Model/theory text for task items 1/2/4 and the high-level rules was already committed by the integrator in model 10; this
branch does not rewrite it. Besides the explicitly approved label/source note it changes shapes, generated files and tests.
The strict check-outcome boundary intentionally rejects a new unknown without top-level missing; engines/pack producers that
still emit the old form must migrate in the dependent tasks. Only history uses the permissive stored-result reader. No
runtime scheduler, re-evaluation loop, B07 persistence, deadline worker, real read or deployment is claimed by this task.

### Unchecked source constraints in catalogs

`CatalogParam.unchecked_constraints` preserves each uninterpreted source constraint's path, reason, missing fact,
next_action and optional source_value. It does not invent a generic restriction from an unknown source grammar.
After known parameter checks, a matching but unchecked signature yields unknown with top-level missing; exit stays
optional for Hub binding. An independently complete matching overload wins, omitted optional arguments without a
source default do not require a value constraint, and known native type violations remain independently refutable.
The parameter's diagnostic locator and recovery wording are excluded from catalog syntax comparisons.

History rendering is connected through `readStoredValidationResult` and `StoredPartitionItem`: `get_nodes` retains
counts, requirement states, problem lists and item blocks for legacy omissions. Missing recovery fields are disclosed as
“出口未写” and “缺失事实未写”, including partition/item pointers and paged results. Reading never backfills those fields
or changes stored bytes; current admission remains strict.

### Required vocabulary scan for contract changes

In addition to focused contract tests and generation checks, run:

```sh
node --test --test-concurrency=1 --test-name-pattern='uses generated axes' packs/workflow/case-review/packs.test.ts
```

The existing `.github/workflows/checks.yml` Unit tests job runs `npm run test:unit`; its `packs/**/*.test.ts` pattern
already includes this scan. No extra CI job or relaxed exception is needed. Review item 6's old dispatch comparisons are
fixed on this baseline. The narrow scan still reports unrelated lease_op comparisons in `hub/server/cli-admin.ts` and
`packs/workflow/test-bed/functions/check-bed.ts`; those remain visible failures, not exclusions or verified passes.
Their owners must fix the generated types; this branch does not edit the pack's unknown producers.

The check-work contract now names both `CHECK_LIMITS_MIN` and `CHECK_LIMITS_MAX`; source-only tests anchor each bound
to the independent sandbox protocol constants and reject values below the lower bound. `MappedIdentity` describes a
mapped external account; it deliberately has its own diagnostic instead of reusing the missing-fact field type.

W04 public RequirementSummary requires `rules` and `run_interpreters`. Historical persisted run@1 rows can omit both,
without defaults being inserted into their record bodies; supplying just one is invalid. The engine derives a read view
from the locked package when necessary. Missing locked declarations are explicitly unavailable and never become empty
rule lists. Public run-summary@1 remains strict and requires both arrays.


## Predecessor input defaults

`WorkflowInput.default_from_predecessor` explicitly declares `{pack: <workflow id>}`. Only artifact-under-verification inputs accepting `application/json` may declare it. Absent declarations never opt in; explicit bindings always win. The runtime selects only an accepted validation of a real predecessor submission, preserving the existing predecessor access and lineage guards. The optional declaration is also returned in input-slot summaries.

`RunSummary.input_defaults` freezes `{slot, predecessor, reference}` for every Hub-selected default. References name complete validation records without fragments; historical and explicitly bound runs omit this field. The record and tool reply use the same frozen facts. Cross-field declaration eligibility, unique defaulted slot names and the no-fragment requirement are runtime refinements beyond the generated JSON Schema; callers must still pass these checks.


## Model-owned shared interfaces

`contracts/model.json` → `formatProposals.sharedInterfaces` is the source of the shared keyword-remediation interfaces. `node tools/gen-contracts.ts` generates `contracts/generated/shared-interfaces.ts` (each `<Name>Schema` Zod validator and `type <Name>`) and the matching standalone JSON Schemas under `contracts/generated/schemas/`. Consumers import this generated module directly. These are reusable leaf interfaces, not new stored record kinds or new tool inputs; they are intentionally separate from `SCHEMA_REGISTRY`.

The source language is the closed `model-shape@1` structural subset listed in the model: strict objects, required fields, arrays, scalar types, bounds, literals, unions and exact references. Definition references point to earlier model definitions; vocabulary references resolve an existing axis or exact code; contract references use the generator's finite primitive binding set (including existing `CatalogParamType`). Unknown keys, expressions, imports, forward/cyclic references, duplicate ids or exported names, and nonclosed objects are refused. No source expression or free-text semantic pattern is evaluated. Add a primitive binding only for an already-owned structural contract, with tests.

- `CommandIdentity` carries the locked tree root, full path, signature reference and typed supplied parameters. Raw words alone are not an identity. The Hub must resolve the original tree and fully check the parse, including declaration/type/role agreement; shape validity is not command membership proof. Identity equality uses root/path/signature and the declared-order parameter position/name, exact type identity and canonical parsed value; `raw` text and role evidence are annotations, not duplicate-key inputs (see the model identityRules).
- `ExpectedQuoteIdentity` carries the original source SHA-256, parser@major, selector path and `SourceSpan`. The span uses original-source **bytes**, zero-based `offset` plus positive `length` (exclusive end); it is not a normalized-text or UTF-16 position. The boundary checks actual source bounds and verbatim quote ownership. `QuoteEvidence` pairs text with that identity.
- `DeclaredParameterType`, `DeclaredParameterRole`, `ParsedParameterValue`, `TypedAddressValue` and `TypedParameter` preserve declarations and parse results. Address syntax does not infer its purpose. Type/role membership, mask contiguity and agreement with the raw source remain explicit boundary checks. Missing type cannot be disguised as a verified typed value.
- `AuthoredCategoryFields` has independent `category_ids` and `test_type_ids`; the bound published pack supplies their exact closed ids. The shape neither maps aliases nor infers membership. Omitted fields and an empty labels object supply no classification evidence. `CategoryDeclaration`, `CategoryJudgment` and `AcceptedCategoryJudgment` distinguish author source, submitted model claim and its accepted-result reference; the Hub still verifies source ownership, exact ids, quotation and acceptance.
- `ModelIdentity` holds explicit `model_id` and `model_family_id`; the observed session remains separate. Evidence states and qualifier marks stay in the existing generated `vocabulary.ts`; they are not duplicated or renamed here.

Verification: `node --test "contracts/**/*.test.ts" "tools/gen-contracts*.test.ts"`, `npm run typecheck`, `npm run test:docs`, and `node tools/gen-contracts.ts --check`. Shared-interface examples are synthetic. JSON/Zod parity tests prove shape consistency, not source existence, accepted judgment truth, target behavior or deployed availability.

R7 增加生成词表 release_status（K02，fixed/known），CatalogParam.native_type 保存原始类型名、声明引用和 grammar；它是来源证据，不进入语法影响比较。catalog@1 的 strict_signatures 让成员主张必须完整匹配执行签名，目录菜单及缺参数命令头不算执行成员。

适用条件主张沿 document_output_kind.applicability_claim 与 ContributionInput 的受限载荷进入现有回注运行；admission 由 Hub 填写，客户端不得自报。ProducerInput.known_builds 与 tree_root 的构建记录/条件上下文冻结同一名册，生产器缓存键包含该输入。受控 ProducerOutput.incomplete 保留缺失事实与下一步，并产生具名、有期限的现有澄清请求。knowledge-contribution/slots.schema.json 由 gen-contracts 从单一 ContributionInput 与生成枚举产生，不手改。

knowledge-structure@1（方向 2）：模型定义 fed-case/fed-defect/fed-spec/fed-build/fed-note、version-binding、usage、feeding-offset、retraction 的封闭形状，生成于 shared-interfaces.ts，由 src/feeding.ts 注册。来源、运行目标、采集时间、派生命令解析和回注均不偷偷加入对象身份。具体身份投影见模型 knowledgeStructure.identity。source_structure 是生成的组成依据；binding_status/binding_basis 与 covers 关系也只从模型生成。模型判版本禁止，运行目标只形成 usage；来源结构和人的直接声明保留各自依据，冲突不覆盖。该步只建立合约，不表示已实现喂入存储或真实资源接入。

验收恢复接线：submission@1 增加可选 model_identity，直接使用已审定 model-identity@1。model 仍是显示文字；没有新字段的旧提交保持可读，族独立性保持未知。生成器重生 submission schema 与工具输入形状，不手改生成物。

决定 82：start_run 和运行记录可声明相同的 model_identity。提交没写身份、且 Hub 观察到的提交会话与运行开始会话相同时，评估可沿用该运行的声明；提交本身显式声明优先。不同或缺失会话及旧运行不会自动补造身份，原提交原样保存。
