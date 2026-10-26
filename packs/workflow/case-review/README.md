# case-review: the draft review pack

The workflow pack of the draft review (brief section 6, steps 1-4 and 6): the drafting model reviews one KityMinder test mind
map with the team's method (the earlier skill `test-list-review`), the Hub judges what can be judged mechanically, and the
conclusion is left to the independent verification pack `case-review-verify`. Model elements T01 T02 W02 W03 W05 C03-C08 K01
K04. Everything product-specific comes from the product pack the run binds (names, catalogs); this pack names no product.

## The pack

| File | Content |
| --- | --- |
| `workflow.json` | input slot `subject` (role subject; `agile:mindmap` or an uploaded `application/json` KityMinder export); the run parameters below; product binding without a fixed line, catalog `commands@1`; projection `functions/projection.ts`, expected sources `functions/expected.ts` |
| `requirements.json` | `literal` (fact, item: checks structure, node_ids, tags), `catalog` (fact, item: cited_commands, command_claims; a negative case expects `core.catalog.param_out_of_range`, `param_type_mismatch` or `arity_mismatch`), `findings` (judgment, item: findings_quotes, command_claims, findings_sources; repair rows, two rounds, for `core.catalog.membership_contradicted`, `case-review.hint_only`, `case-review.location_missing`, `case-review.quote_missing`, `case-review.command_not_in_case`, `QUOTE_MISMATCH`), `level` (judgment, run) |
| `checks.json` | eight checks (table below); `case_commands` is listed by no requirement: the optional scan, off |
| `slots.schema.json` | item `findings`: codes the seven probe names, ranks critical, major, minor (with their level bands), evidence required (the check `findings_sources` asks for a verbatim quotation besides), at most 20; run `level`: code `level`, ranks P0-P7 with the brief's definitions, exactly one |
| `SKILL.md` | the drafter's procedure (about 4,000 characters): target, blocks and slices, the six evidence groups in order and how to read them, findings (location, verbatim quotation, command lines as the case writes them), severity bands, levels, submission with the context digest, repair, revision runs with `predecessor` and `reuse`, the mandatory case-review-report table view after every review (single block included), followed by short overall prose |
| `functions/` | the adapters (`projection.ts`, `expected.ts`, `subjects.ts`, `checks.ts`) on the pure functions (`project.ts`, `expected-sources.ts`, `subject.ts`, `lines.ts`, `tags.ts`, `template-coverage.ts`, `text.ts`, `common.ts`, `types.ts`) |
| `tables/` | the check tables, `codes.json` (every pack code with Chinese when/fix, the finding codes, bands and levels), the template tables |
| `samples/` | 23 samples (`pack-sample@1`, source author; 11 positive, 12 negative) written by `testing/samples.ts`: every check has positive and negative ones |
| `examples/` | a start_run and a submit_result, synthetic, with placeholders (the submission writes the context digest of each judged item and carries one item over with `reuse`) |

Not published (not pack paths): `api.ts` (the package surface and `node packs/workflow/case-review/api.ts check|sign|stage`),
`packaging.ts` (the shared packaging tool of every pack of this package), this README, the tests and `testing/`.

### Run parameters

| Parameter | Meaning |
| --- | --- |
| `stories`, `bugs` | defect-system ids to read instead of the ones found in the title and the folders above the document |
| `id_ranges`, `bare_ids` | how an id the title does not mark as story or bug is read (`id_ranges: { story?: {min?, max?}, bug?: {...} }`; `bare_ids` both, story, bug, skip) |
| `spec_search`, `strategy_search`, `history_search`, `max_terms` | the spec search (role expected), the test strategy documents (`manual:qa-search`, role hint, evidence group d) and the similar test lists (`agile:search`, role hint, evidence group e, the reviewed document left out) for the feature words of the title |
| `case_rule`, `case_priority`, `group_priority`, `precondition_priority` | which nodes are cases (marked, the default: tagged cases and the team template's marked cases; or tagged: restricted to tagged cases) |
| `block` | one subtree (a node id, or the node texts from the root down) |
| `slice` | `{ from, to }`: the cases from..to in document order (from 1, at most 100), inside the block when one is given |

The workflow format allows lowercase parameter names only, so the run names are the snake_case forms of the names the pure
functions read (`caseRule`, `idRanges`, ...); the adapters map them, and every message and fix the functions give says the
workflow name (`workflowNames` in `functions/common.ts`).

### Checks

| Check | Interpreter or function | Applies, subject | Judges | Tier | Listed by |
| --- | --- | --- | --- | --- | --- |
| `structure` | structure@1 `tables/structure.json` | run, `structureSubject` | subject | blocking | literal |
| `node_ids` | structure@1 `tables/structure-node-ids.json` | run, `structureSubject` | subject | advisory | literal |
| `tags` | `functions/checks.ts#tagSpelling` (code `case-review.tag_variant`) | run, `structureSubject` | subject | advisory | literal |
| `cited_commands` | catalog@1 `tables/cited-commands.json`, catalog `commands@1`, `required` | item, `commandSubject` (`phrases`) | subject | blocking (negative cases advisory) | catalog |
| `command_claims` | catalog@1 `tables/command-claims.json`, catalog `commands@1` | item, `commandSubject` (`claims`) | artifact under verification | blocking | catalog, findings |
| `findings_quotes` | quote@1 `tables/findings-quotes.json` | item, default subject | artifact under verification | blocking | findings |
| `findings_sources` | `functions/checks.ts#findingSources` | item, default subject | artifact under verification | blocking | findings |
| `case_commands` | catalog@1 `tables/catalog.json` | item, `scanSubject` | subject | advisory | none (optional, off) |

`commandSubject` splits what the findings of one item say about commands. A command with `present` is a statement that it
exists (true) or does not (false), judged as a membership claim (`claims`). A command without `present` must be a command
line the case writes (`lines.ts quotedFromCase`): it occurs in one line of the case (title, steps, expected results,
preconditions, or the text of the case's own fragment as the boundary resolved it) in the form the catalog check matches
(NFKC, case folded, white space collapsed), as whole words, with no argument cut off or added. Only such lines are
`phrases`: they belong to the target, so `cited_commands` judges the subject: a refutation is a fact about the case
(attributed to its author), never sent back to the model, and on a negative case the expected refutation. Every other cited
line is `unquoted`: a statement of the model, which no catalog table reads and `findings_sources` sends back for repair
(`case-review.command_not_in_case`). So a mistyped or invented line (the boundary resolves a command by its catalog head,
engine decision 9) never becomes a fact about the case, and another case's line never meets or fakes a negative case's
expectation. A statement that contradicts the catalog is the model's error: `command_claims` judges the artifact under
verification and the findings requirement sends it back for repair. A negative case whose findings quote no command line of
its own falls back to the case's own lines; negative_commands reports a missing-command advisory refutation when no line starts with a catalog head
instead of failing the expectation.

`findingSources` refutes a finding without a location (`case-review.location_missing`), one without a verbatim quotation
(`case-review.quote_missing`: a ground is a reference the boundary only resolves, a quotation is checked verbatim; brief
section 6: every claim carries a location and quotation), one whose cited evidence all resolves into hint sources
(`case-review.hint_only`, A03 R[6]: a historical test list or a test strategy never grounds a statement about the product),
and every command line it cites without `present` that the case does not write (`case-review.command_not_in_case`). All four
are repair rows of `findings`. `tagSpelling` (check `tags`) reports a category tag written unlike the usual spelling of its
category in the same document (`case-review.tag_variant`, advisory), naming the tag, its category and the usual spelling.

### The adapters

- `projection.ts` (ProjectionInput -> ProjectionOutput): the subject slot's parsed model through `projectItems`; the document
  id is the agile id of an external input, else the meta id, else the root node's id. The whole document is projected without
  the sandbox output limit and only the run's part is bounded by it (`case-review.too_large` when that part exceeds 8 MiB), so
  a block of a document whose whole projection is larger still projects. `block` restricts the items to one subtree, `slice`
  to the cases from..to in document order (inside the block). More than 100 cases is refused (`case-review.too_many_cases`,
  see Deviations) with a fix that leads, within the 500 characters the server shows, with one run per part, the worst verdict
  over the parts and the slices that reach every case; then the group blocks: every block of at most 100 cases when the list
  fits, else the outermost groups with their case counts (a group of more than 100 is marked to split further, and a block
  refusal lists its own blocks). A group of more than 100 cases with cases outside its subgroups, and cases in no group, are
  reviewed by slices, never by editing the target. `block_not_found`, `block_ambiguous`, `no_case` (an empty block) and
  `slice_invalid` are refusals with fixes too. Every item has a summary of at most 200 characters (the last two path labels,
  tags, negative, priority, steps, preconditions, the first expected result). Groups: the document (with the block and the
  slice), every group node with its case count (with a slice, the groups its cases sit in), the pack identities
  (`unnumbered`).
- `expected.ts` (ExpectedSourcesInput -> ExpectedSourcesOutput): `expectedSources` over the title and the folders of the
  subject's meta (`ancestors`, or `folders`), the product names of `context.names` left out of the search terms; every id it
  finds is an expected source; with the same terms, the test strategy search `manual:qa-search:<terms>` (`strategy_search`)
  and the history search `agile:search:<terms>+!<document id>` (`history_search`; the reviewed agile document matches its
  own title and is left out, an upload has no agile id) are hints.
- `subjects.ts`: `structureSubject` (RunSubjectInput -> `{ subjects }`), `commandSubject` and `scanSubject` (ItemSubjectInput);
  `lines.ts`: the lines of a case and `quotedFromCase`.
- `checks.ts`: `findingSources` over the default item subject and `tagSpelling` over the structure subjects (PackCheckInput).

## The projection (W01)


Measured on the 51 sampled real documents (counts only, no content; 47 plain maps with priorities, one map in a second node
format, three without any priority): 2,712 nodes carry tags, and 3,033 untagged nodes outside every tagged case carry priority
2, have children and hold no tagged node and no other priority-2 node. Those are cases written without tags: 1,780 have a
priority-3 precondition and a step, 1,022 a single expected leaf, 197 a step; 2,372 carry a degree and 172 an `autoid`.
11 maps contain only such cases. The brief's rule (a case is a tagged node) therefore misses about half of the real cases;
the owner decided the unified rule on 2026-10-22 (docs/hub-r4-tasks/union-case-rule.md):

- **Case rule** (run parameter `case_rule`, `caseRule` inside project.ts). `marked` (default):
  recognizes tagged nodes as well as untagged nodes outside every case that carry the case priority (`case_priority`, default 2),
  have children and hold no tagged node and no node with the case priority (the team template's case marker). Such a case has
  `tags: []` and `negative: null` (unknown); the literal check reports its missing tag. `tagged` (restrictive switch): restricts
  cases to nodes whose `resource` is a non-empty array. Under `tagged`, untagged candidate nodes are not items and not groups:
  the warning `case-review.untagged_cases` gives their count and the selectors of the first 20, and the `no_case` refusal names
  their count and offers removing the restriction or setting `case_rule: marked` as the fix. On the sample: `tagged` projects
  37 of 51 documents (2,706 cases), `marked` 48 of 51 (6,045 cases); the three left have no priority at all.
- **Tagged group node.** A tagged node with the group priority (`group_priority`, default 1, `null` turns the rule off) that
  holds tagged nodes or nodes with the case priority is a group: all 8 tagged priority-1 nodes in the sample hold cases (121
  of the 124 nested cases sit below them). One `case-review.tagged_group` warning names the node.
- A case's text is the title. Item id `<documentId>:<data.id>`, label the title with white space collapsed, location
  `{ parser: 'kityminder@1', selector }`; the Hub core adds the source digest and forms the `src:` URI. The selector is
  `n/<data.id>` (percent-encoded exactly like `hub/refs`) when the id occurs once among all nodes, else the position selector
  `i/...`; the tests check that every selector equals the parser's own selector.
- The **children** of a case: a leaf is an expected result; a leaf with the precondition priority (`precondition_priority`,
  default 3, `null` turns it off) is a precondition; a child with children is a **step** (priority 20 occurs only on steps in
  the sample), and the leaves below it are its expected results. `fields.expected` lists every expected result in document
  order, `fields.steps` keeps `{ text, expected }` per step, `fields.expectedCount` counts all of them even when a list is
  clipped.
- A **group** is any other node with a `priority` member outside every case; groups are listed with their case counts (no
  path), they are not items. A case below another case is an item of its own (`fields.nested`, warning `case-review.nested_case`).
- Fields: `document, nodeId, path` (ancestor texts from the root), `title, priority` (as written: `20` stays 20, missing is
  null), `degree` (`"null"` and null are null), `tags` (as written), `tagsNormalized, expected, expectedCount, steps,
  preconditions, autoid, automated` (autoid present or `auto` is YES), `negative` (canonical tag Negative; null when no tag is
  non-blank), `hasNote, nested`.
- **Identity** (W01 R[2]). Item numbering counts cases only. A case keeps `<documentId>:<id>` when its id occurs on no other
  case. Every copy of an id shared by several cases gets `#1`, `#2`, ... in document order (never an id another node really
  has); a missing id, or one that would make the item id longer than 200 characters, gives `<documentId>:@<node index>`. These
  pack identities are listed in `unnumbered`: the Hub must not carry them across revisions. So a pasted copy never takes the
  plain identity of the case it was copied from. One summary warning per document and code (`node_id_duplicate`,
  `node_id_missing`, `node_id_unusable`); `tables/structure-node-ids.json` judges the numbering per case.
- **Document ids** may not contain a colon, white space or control characters (`case-review.invalid_input`): the colon
  separates the document from the node in an item id, so ids of two documents can never collide.
- **Refusals** (W01 R[3], `project.ts`): `case-review.no_case` when a document has no case under the rule;
  `case-review.too_large` when the JSON result would exceed `limits.outputBytes` (default 8 MiB, the sandbox default; measured
  exactly as the sandbox does, UTF-8 bytes of `JSON.stringify`; an in-process caller may pass no limit, as the run adapter
  does, which then bounds its own part); malformed input is `case-review.invalid_input`. In a run the adapter's 100-item
  refusal comes first.
- **Warnings**: per-node warnings (nested cases, tagged group nodes) are capped at 100; summaries per document (untagged cases,
  numbering, malformed structure, depth, clipping) are kept apart from that budget, so a full budget never hides them.
  `case-review.warnings_clipped` counts what was dropped, per code.
- Passes over the visited nodes (walk with an explicit stack, flags from the leaves up, roles, items) keep a document linear
  in its size. Hostile models are survived: invalid child indexes, cycles and shared children (`case-review.model_malformed`),
  more than 200 levels (`case-review.depth_limit`), texts over 4,000 code points and lists over 100 entries (clipped, with
  warnings, counts kept).

## Tables

| Table | Kind | Tier | Content |
| --- | --- | --- | --- |
| `structure.json` | structure@1 | blocking | non-empty title, priority 1-3, at least one non-blank tag, at least one expected result and none blank, no two cases with the same title, steps, expected results and preconditions under one (document, path) |
| `structure-node-ids.json` | structure@1 | advisory | every case has a node id, unique among the cases of a document (W01 R[2]) |
| `cited-commands.json` | catalog@1 | blocking, negative advisory | the command lines the findings quote (`$.phrases`, required); scope resolved; negative flag `/negative` |
| `command-claims.json` | catalog@1 | blocking | the membership statements of the findings (`$.claims[*]`) |
| `findings-quotes.json` | quote@1 | blocking | quotations of the findings verbatim in their fragments |
| `catalog.json` | catalog@1 | advisory | the optional scan of the case's own lines (`$.commands`), scope resolved, negative flag |
| `template-v3-coverage.json`, `template-v3.json` | coverage@1, `case-review.template@2` | advisory | the template coverage of `template-coverage.ts`; no check of this pack uses them (the template gap check is the pack `template-gap`) |
| `codes.json` | `case-review.codes@1` | | refusals, warnings and check codes with Chinese when and fix; finding codes, bands, levels |

Every core table passes the contract shape and the interpreter's admission, names its origin, and a blocking one names its
basis by a requirement of the brief. The membership tables of the finding codes and ranks are gone: the slot schema's closed
sets refuse another code or rank at the boundary.

Duplicates are keyed by (document, path) as the group and the title plus the content (steps, expected results and
preconditions in the matching form) as the key: on the sample a title-only key refuted 20 cases, 18 of them variants that
differ in their steps or expected results; the content key refutes the 2 identical ones. Several expected results are not a
literal issue (the former "exactly one" rule refuted 15% of the sampled cases).

## Tags


`normalizeTag` folds a tag (NFKC, lower case, brackets and quotes removed at both ends even when unbalanced, inner spaces, `-`
and `_` removed, one suffix such as `test` or `测试` removed) and looks it up in `TAG_SPELLINGS` (author-written from the spellings
in the sample: Function, function, Functional, [Function], [Functional, 功能, Configure, configuration, 配置, Integration,
Negative, negative, 负向, Stress, 压力, Compatibility, ...). Unknown tags (release-specific ones like `20260301ADD`, also
`Boundary`) keep canonical null; no spelling maps to two categories.

The spelling check compares spellings inside one document: the usual spelling of a category is the most frequent one (a tie
goes to the canonical name, else to the spelling seen first), and tags written otherwise are reported by the pack function
`tagSpelling` as `case-review.tag_variant` (advisory), with the tag, its category and the usual spelling in the statement
(the structure table it replaces could only say that a list had too many entries). A document that writes
every category one way is never reported, whichever spelling it uses. On the sample the former check against the canonical
spelling fired on 1,526 of 2,714 cases (56%); no sampled document mixes spellings of one category, so the new check reports none.

## Expected sources


`expectedSources` reads the document title (`title`, else the mind-map root text) and the folder labels above the document
(`ancestors`, nearest first) and returns external object ids: `plm:story:<id>`, `plm:bug:<id>` and one
`manual:spec-search:<terms>` with the feature words of the title (terms joined by `+`; white space, `@`, `%`, `+` and controls
percent-encoded). Every id passes the contract's `ExternalObjectId`. `basis` says for each id where it was read and why
(Chinese), for the run record.

Kinds. Only a word right before the number names its kind: `bug`, `缺陷` → bug; `story`, `需求` → story (the word next to the
number wins: `bug to case-需求...` is a story). `bug to case` (and its spellings) names a document type and `PLM` the system,
so the numbers after them are unmarked, like a number at the start of a title. Measured on the 3,724 sampled tree labels: all
54 ids marked `需求`/`story` lie between 10,000 and 22,000; 282 of 1,412 ids after `bug to case` and 215 of 949 unmarked ids lie
in that range too, while 732 unmarked ids lie at 50,000 or more; 584 of 595 ids after a bare `bug` lie at 50,000 or more. An
unmarked id therefore takes the kind whose range alone contains it when the ranges of the defect system are given
(run parameter `id_ranges: { story?: { min?, max? }, bug?: { min?, max? } }`; a kind without a range covers every id; the product
pack should supply them). Otherwise `bare_ids` decides: `both` (default: a story and a bug are read, the read of the
one that does not exist reports it unavailable, and one `case-review.id_kind_unknown` warning lists the ids), `story`, `bug`
or `skip`. When both records exist (stories and bugs are numbered separately), one of them may be unrelated to the document:
the reason of both bindings, the warning and SKILL.md tell the model to check the record's title before citing it and to name
the kind with `stories` or `bugs` (see Deviations). Explicit `stories` / `bugs` replace the ids found in titles. Release-train labels (`NNN：3.2.1-...`),
years, dates, version numbers and markers inside words (`debug`, `history`) are not ids.

Search terms: Han runs are split at multi-character function words (`支持`, `测试`, `以及`, ...) and at the conjunctions `和`,
`与`, `及`, `或` only when two Han characters or more stand on each side; `的` and positional characters (`后`, `时`, `在`, `对`,
`下`, `中`) never split, because they are parts of common words (`目的地址`, `后端`, `时间`, `在线`). `功能` and `检查` stay inside
longer runs (`健康检查`) and are dropped only alone. A last segment of exactly three Han characters after a dash or underscore
is left out as the author's name (of the 16 such endings among the 2,206 sampled document labels, 15 read as personal names
when the 9 distinct endings were inspected by hand; one is a feature phrase). Product names
given in `product.names` are left out, also when fused with a version; `spec_search: false` drops the search; `max_terms` (1-16,
default 8).

## Template coverage

The exported templateCoverage utility is not wired into checks.json. Its known repository callers are the template utility
and table/sandbox tests and template-gap parity tests. R1 affects historical direct calls and the active template-gap copy;
it does not establish that case-review literal, catalog or level checks consumed the old matcher.

The descriptive template table has only id, label, group and description. Required scope lives in template-v3-coverage.json
(the six test types here); explicit user skips require a known id and a nonempty reason. No keyword, prefix, synonym or tag
matching is performed. The utility reads category_ids only from bound original inputs at the item's exact node, not from
caller-added projected fields. Missing declarations are unclassified and prevent asserting unseen categories as missing.
Invalid declarations are structural errors. Counts are complete; sorted display evidence is capped at 50 ids.

Model classification is accepted through template-gap's generated CategoryJudgment slot and Hub source/quote checks. This
legacy pure utility cannot resolve accepted-result records, so it refuses caller-supplied judgments and points to that workflow.
It never treats a reference supplied by a caller as proof of acceptance. Author categories and test_type_ids are independent.
Old results remain immutable; the integrator appends legacy_keyword_rules annotations for affected direct calls and records
the new model/pack/root/run lineage when re-producing. No real results were read or re-produced for this change.

## Fixtures (`tests/fixtures/mindmaps`)


All content is invented; the structure follows the real documents (12-character base-36 ids, millisecond `created`, key order
`id, created, text, ...`, wrapper `template`, `theme`, `version` 1.4.43, the platform's double encoding with `", "` separators and
`\u` escapes). Commands come from the synthetic command tree of `hub/refs/fixtures`; addresses are in 192.0.2.0/24 and
2001:db8::/32.

| File | Content |
| --- | --- |
| `review-150.km.json` | 172 nodes, 64 tagged cases, 3 untagged cases, 19 groups: simple, step and precondition forms; 10 negative cases (out of range, wrong type); no and two expected results; a vague and a copied, contradicting expected result; a CLI case written for WebUI and a WebUI case in CLI wording; repeated titles under IPv4/IPv6; an exact duplicate among siblings and a reused title whose variants differ in their steps; a nested case; a tag on a group node that holds two cases; untagged cases in the simple and the precondition-and-step form, one automated; inconsistent tags and release tags; priority 20 on a step, and an injected priority-20 typo on a case; a missing priority; degree "null"; a group with priority null; two automated cases; a note; two cases sharing one id |
| `review-150.double.json` | the same document double-encoded (a JSON string) |
| `review-150.agile-response.json` | the same as a `get_case_data` answer `{ code: 1000, msg, data }` |
| `tiny.km.json` | 4 nodes, one case |
| `untagged.km.json` | 11 nodes, three cases without tags (refused under `tagged`, projected under `marked`) |
| `outline.km.json` | an outline without tags and without the case priority (no case under either rule) |
| `template.km.json` | a template map in the structure of the team template, every category shown |
| `largeDocument()` | about 3,000 nodes, built at test time (`compactText(largeDocument())` gives the bytes; about 400 KB, so not stored) |

After changing `documents.ts`, run `node tests/fixtures/mindmaps/write.ts`; `fixtures.test.ts` fails while the files differ.

## How to test

```
node --test "packs/workflow/case-review/**/*.test.ts"
node --test "packs/workflow/case-review-verify/**/*.test.ts"     # includes the end-to-end run of both packs
npx tsc --noEmit
```

`functions/*.test.ts` test the pure functions and the adapters (against the contract shapes, in process and in the Hub
sandbox), `packs.test.ts` stages every pack of this package and runs the real validator and publish check of the pack
registry, checks that the sample files are what `testing/samples.ts` writes, that the examples are a start_run and a
submit_result of the contract once their placeholders are filled in, and that no vocabulary axis is written by hand in the
code of this package (a scan of every non-test TypeScript file under the owned paths; subsets derived with `Extract<>` or
`.extract()` pass). The end-to-end test
(`packs/workflow/case-review-verify/end-to-end.test.ts`) publishes the packs in the real registry on a temporary PostgreSQL,
syncs the products through the real connectors and knowledge service and runs the draft and the verification through the
real runs engine. Regenerate the samples with `node packs/workflow/case-review/testing/samples.ts write` and sign the
manifest with `node packs/workflow/case-review/api.ts sign`.

## Decisions

1. **Case rule**: `marked` is the default (owner decided on 2026-10-22; projects both tagged cases and the team template's marked
   cases); `case_rule: tagged` restricts to tagged cases.
2. **Steps and preconditions**: a case's leaves are its expected results, its children with children are steps and a
   priority-3 leaf is a precondition (43% of the sampled tagged cases use steps).
3. **The open questions of the earlier round are decided**: no canonical tag spelling is mandated (the spelling check is per
   document); manual text is behaviour (the product pack); per-command template categories are reported but not counted
   missing; the template evidence is sorted by item id so that the coverage of a document does not depend on the order of its
   cases.
4. **Negative cases** expect `param_out_of_range`, `param_type_mismatch` or `arity_mismatch`: a wrong type or a missing
   argument tests the same input validation.
5. **The literal requirement lists the advisory checks too** (node ids, tag spelling): an advisory refutation is still a
   violation of the requirement in the engine (shown at advisory tier); the tag spelling is the brief's "inconsistent field
   format".
6. **Repair, two rounds**, for what the model can correct: a contradicted command statement, a hint-only finding, a finding
   without location, a finding without a verbatim quotation, a cited command line the case does not write, a quotation the
   quote check refutes (the boundary normally refuses that whole submission first).
7. **Large documents**: at most 100 items a run; the fix of the refusal names the slices that reach every case and the group
   blocks with their case counts; the overall verdict is the worst of the parts (SKILL.md of both packs).
8. **A finding needs a verbatim quotation**: the slot's `evidence` flag accepts a ground alone, and a ground is only a
   reference that resolves; the brief asks for verbatim quotations with references, and the verification pack asks the same of
   its statements.
9. **A command line cited without `present` is the case's own line**: only a line the case writes is judged as part of the
   target; anything else is sent back to the model, so the Hub never records a model's line as a fact charged to the case
   author.

## Deviations from the brief

- **`findings` is a judgment, not an independent judgment.** The brief's requirement templates name `findings` an
  independent judgment. A draft has no predecessor, and an independent judgment without one is never satisfied (A04 R[5]; the
  engine's decision 18 and its open question 1): every draft result would show `unsatisfied (independence_unknown)` for every
  handled item. The drafter signs nothing either way: the conclusion is the verification pack's `verification` and `final`,
  independent judgments of the predecessor, from another session and model. The owner decides.
- **A target of more than 100 cases is refused as a whole** (`case-review.too_many_cases`), although W01 R[3] reserves a whole
  refusal for a source whose structure cannot be projected. A tool result of more than about 50,000 characters never reaches
  the model (measured on the real client), so a run of more than about 100 items cannot be read, and the method splits large
  targets into blocks (brief section 6, step 7). Because a refused start_run binds nothing, the fix carries what is needed to
  reach every case: the slices (`slice={"from":1,"to":100}`, ...; at most ⌈n/100⌉ runs) and the group blocks with their case
  counts, the slices first so that they stay within the part of a fix the server shows. The owner decides whether to keep the
  refusal or to start a run of the first part instead.
- **Unmarked ids are bound as both kinds with role expected** until `id_ranges` are supplied (`bare_ids: both`). Binding the
  kind no marker or range establishes as a hint would refuse a finding grounded in the right record as hint-only; the risk
  that the other record is unrelated is stated instead (binding reasons, the `id_kind_unknown` warning, SKILL.md), and
  `stories` / `bugs` bind exactly one kind.
- **Level data.** The brief asks for `data` (justification, evidence-gap list) on the level claim. A cross-item entry of a
  submission (`CrossItemJudgment`, contracts/src/submission.ts) has no `data` and the engine does not check run-level slot
  data, so the justification and the evidence gaps are written in the statement (SKILL.md gives the form) and the slot
  declaration carries no data schema. See Needs.
- **Parameter names** are snake_case (`case_rule`, `id_ranges`, `group_priority`, ...): `workflow@1` refuses camelCase names.
- **The optional scan** (`case_commands`) is declared and sampled but listed by no requirement, so it never runs in a run of
  this version; enabling it means a pack version that lists it (the registry warns `checks.unused`). A parameter cannot switch
  a check on, and the brief keeps it out of the default pack.
- **Template coverage** is not a check of this pack (the owner made it an optional hint and the pack `template-gap` delivers
  it); its function and tables stay here, tested, for the later capability.

## Limits

- A negative case with no cited line uses its own text lines. If none starts with a catalog command head, negative_commands reports an advisory refutation; it does not accept the missing command as unknown.
- A cited command line counts as the case's own only when it occurs in one line of the case (a step written over two nodes is
  two lines); shorthand the model expands is the model's statement and goes back for repair.
- A finding can only say that a command exists or not, or quote a command line; a command named in the text of a finding is
  not checked.
- The level and the findings are judgments: the Hub checks their form, their evidence and the facts beside them, not their
  truth.
- Output is about 800-880 bytes per case on the sample (the path is repeated in every item, as the brief's item fields ask):
  roughly 10,000 cases fit in the sandbox's default 8 MiB. `projectItems` alone refuses above `limits.outputBytes` with
  `case-review.too_large` (tested in the real sandbox with 16,000 cases) instead of failing with a sandbox error; in a run the
  adapter projects the whole document without that limit (the parser admits at most 100,000 nodes and 16 MiB) and bounds only
  the run's part of at most 100 cases.
- The six test types are shown by tags only, so an untagged case (`caseRule: marked`) shows no test type.
- Template coverage is per document, not per CLI command, and keyword coverage is a heuristic: a group named after a category
  counts as evidence for every case in it.
- A second node format seen once in the sample (`ctype`, `resource_list`, `part0`-`part4`, mostly empty `resource`) is not read
  specially; under `marked` its priority-2 nodes in the case form are projected.
- Intermediate nodes below a step (step → sub-step → expected, 6 cases in the sample) are not listed; their leaves are.
- Search terms come from fixed word lists, not a dictionary; the trailing-name rule drops a three-character feature word that
  ends a title after a dash (1 of 16 such endings in the sample).

## Needs from other packages

- **contracts** (`contracts/src/submission.ts`, `contracts/src/pack.ts`): an optional `data` member on `CrossItemJudgment`
  (and on `CrossItemFact`), checked by the engine against the run-level `SlotDeclaration.data`, so a run-level judgment can
  carry the machine-readable parts the brief names (the level's justification and evidence gaps, the verifier's level
  challenge, the expected result of a suggestion). Until then they live in the statement.
- **contracts / runs-engine**: a way for a check to be optional per run (a run parameter that lists extra checks, or a
  requirement marked off by default), so the case-text scan can be switched on without another pack version.
- **runs-engine** (optional): resolve a command without `present` only verbatim (in the item's fragment or the statement's
  quotations, T04 R[5] first step) instead of falling back to its catalog head; the pack now refutes a line the case does not
  write, but its resolution still names a catalog entry.
- **template-gap owner**: the agile document id in `packs/workflow/template-gap/pack.test.ts` (line 88) and
  `functions/project.test.ts` (lines 381-382) is the one a reviewer of this package identified as the id of a real document
  (this package's tests use invented ids now); an invented id keeps real data out of Git.
- **runs-engine**: outcomes of a check listed only by a run-level requirement are recorded as cross-item facts and never
  routed through an error table; this pack therefore routes its run-wide problems through item-level requirements (the
  verification pack attaches them to the first handled item). A routing for run-level requirements would remove the
  workaround.
- **integrator**: confirm the projection (case count and groups) of a real document with `scripts/real`; real documents are
  not in the repository.

## Open questions

1. **Case rule default** (`tagged` or `marked`): decided by the owner on 2026-10-22 (docs/hub-r4-tasks/union-case-rule.md).
   The default is unified across packs to `marked`; `tagged` remains available as a restrictive switch.
2. **Id kinds**: the product pack should supply `id_ranges` (the sample suggests stories below 50,000 and bugs from 50,000);
   until then unmarked ids are read as both kinds.
3. **`findings` of the draft**: `judgment` (as now, so that a draft can be satisfied) or the brief's `independent_judgment`
   (never satisfied without a predecessor)? See Deviations.
4. **More than 100 cases**: keep the whole refusal with the slices and blocks in its fix, or start a run of the first part?
   See Deviations.

## 生成词表与包版本

case-review@1.0.4 改用生成词表的类型及包内运行时快照。包内函数的运行时依赖仍只来自包内文件和已允许的依赖。functions/generated/vocabulary.ts 由 tools/gen-contracts.ts 按本包使用的轴生成，带“生成物，勿手改”文件头；它计入 pack.json 摘要。node tools/gen-contracts.ts --check 同时核对这些快照。词表更新导致包内字节变化时，必须升版并重签清单，不复用已发布版本。

### 全仓词表扫描的收尾记录

02a0066e 已将原 K2 清单的 6 处命中全部改为生成词表约束，均已修复：

| 文件 | 原命中 | 修复依据 |
| --- | --- | --- |
| hub/knowledge/lists.ts | memoAction 的 action_result | 生成类型 |
| hub/knowledge/test-support.ts | placement | 生成类型 |
| hub/knowledge/test-support.ts | read_tier | 生成类型 |
| hub/knowledge/views.ts | DEFAULT_CHANGED_KINDS 的 entry_kind | 从生成 ENTRY_KIND 派生 |
| hub/runs/engine/submit.ts | action 的 acceptance | 生成类型 |
| hub/server/tools.ts | call_result | 生成类型 |

原收尾记录的 1,188 项中 1 项扫描失败、1 项环境反向分支跳过，是上述修复前的历史结果，不能用作当前阻塞依据。
02a0066e 后复核的 packs.test.ts 为 17/17 通过；本轮扩展扫描和自测后为 19/19 通过，全仓扫描通过且未增加债务基线。
本轮还修复字符串标签表与无类型比较链的漏扫，边界见下节。编号范围的 min/max 是结构字段，不属于 measure 轴。

本轮验证命令均仅用合成数据，node --test 的并发为 1；真实系统未运行。类型检查 npx tsc --noEmit、
node tools/gen-contracts.ts --check 通过，生成检查核对 65 份核心生成物和声明的包快照。
本轮两组串行回归分别为 381/381 和 235/235 通过，均零失败、零跳过；两组重复包含 2 项片段词表测试。
第一组覆盖四个改动包、全仓扫描、词表生成器、回答文本、片段解释器与真实引擎的合成引用；
第二组覆盖全部 contracts 测试与本 README 的过期阻塞回归。这些结果不代替真实系统验收。

```sh
node --test --test-concurrency=1 packs/workflow/case-review/packs.test.ts tools/gen-contracts.pack-vocabulary.test.ts \
  "packs/workflow/maintenance-sweep/**/*.test.ts" "packs/workflow/regression-scope/**/*.test.ts" \
  "packs/workflow/test-bed/**/*.test.ts" "packs/workflow/defect-to-case/**/*.test.ts" \
  hub/server/text.test.ts hub/server/claims.test.ts hub/rules/interpreters/quote.grades.test.ts \
  hub/runs/engine/quote-fragments.test.ts contracts/src/fragment-read.test.ts
node --test --test-concurrency=1 "contracts/**/*.test.ts" packs/workflow/case-review/readme.test.ts
```

### 词表扫描语义边界（收尾复核）

对象仅扫描键为轴代码、值为字符串标签的映射，不把结构字段当轴；显式 Record 或 satisfies 检查的映射放行。
比较链在同一表达式上比较同轴两个以上代码即检查，包括子集；已有生成轴类型或 Extract 子集约束的业务分支放行。
扫描使用 TypeScript 类型信息追踪这些约束，手写联合类型仍由原有扫描检查，不能用手写类型逃避检测。
CHANGE_KIND 的值与标签随包快照生成，两包不再手抄标签；固定查重预算的出口和完整性片段分级另有定向回归。

决定 41 扫描补充：标签表只在上下文类型明确约束了键时豁免，包括生成轴的 Record、映射类型、别名及声明的结构类型；Record<string, string> 没有限定键，不豁免。比较值须是生成轴或 Extract 子集，或声明结构类型的 keyof；类型参数使用其约束，轴类型与 string 的联合不算受约束。结构不按 run/item/min/max 的名字或路径豁免；CLI 命令说明表显式声明结构类型。

比较链同时检查 ===/== 与 ||、!==/!= 与 &&；结构键的运行时验证使用满足 Record<keyof IdRange, boolean> 的字段表，不按字段名字豁免。相关包函数变动均升补丁版并重签。

### 合并前历史验证（不代表当前阻塞）

本轮 9 条复核的最终验证（全部合成，node --test --test-concurrency=1）：

| 范围 | 测试 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: | ---: |
| hub/runs、hub/rules、hub/records、defect-to-case | 659 | 658 | 0 | 1 |
| 片段轴/生成器、case-location、两评审包 functions、CLI | 368 | 368 | 0 | 0 |
| maintenance-sweep、test-bed | 144 | 144 | 0 | 0 |
| case-review/packs.test.ts（含全仓扫描） | 17 | 16 | 1 | 0 |

合计 1,188 项，1,186 通过、1 失败、1 跳过。该历史轮次唯一失败是当时 K2 的 6 处扫描命中，未加任何基线或例外；相关类型修复已在上节记录完成，本次合并另行复跑，不沿用此历史阻塞。跳过项为本机没有 sandbox-exec 时默认拒绝运行的反向环境测试，本机具备 sandbox-exec，不能将它计作通过。npx tsc --noEmit、node tools/gen-contracts.ts --check 均通过；未做真实系统验收。每条问题的改前失败日志、全量测试日志留在 Git 外。


评审最后一步（决定 35，集成者 2026-10-23）：不分块也开 case-review-report，target 与各块一致，precondition_priority 沿用初评。
按终稿包说明逐页读取并原样贴出 review_tables，再写简短评审意见、等级理由和证据缺口，不逐条转录发现或另写建议。

评审最后一步照终稿包的容量协议：放不下整表时依据冻结字符边界标明部分、已贴范围，并给权威运行页与完整记录，不能静默截断。

本包的跳过不是完成：handling=skipped 必须附 reason，列入待续做清单，按回执继续本条目或以当前运行为前驱续做；不能因跳过而省略发现、处置、结论或等级。缺判定时按修正说明补齐并重交；初评缺等级、报告缺块或有未交付条目时先修复所列块或条目，再用新回执重开后续运行。

标签按 resource-tags@1 的精确原文闭集读取，保留 resource 原值。闭集外是提示档结构违规“未声明的标签”；大小写、全半角与同义词不相等。非法声明不进入正反向比例分母。此版本替代旧关键词规则，历史结果不改写；应以新包重产新根与新运行。本次续接按所有者指令未运行验证。

R6（所有者 2026-10-24）：声明 famx-directory@1，产品根精确等于产品 names 成员；版本层为三位字母数字码（至少一位数字）、冒号、完整 dotted version，下一层为同版本加列车后缀，再下一层为非空单目录段模块（允许“测试/bug/回归”等字面内容）。不从正文版本或活动词推断层级。缺层、重名或语法外写明缺失身份，下一步由包作者补语法或作者调整目录后重产。famx-id-fields@1 只接受整字段 bug:编号列表 或 story:编号列表（逗号分隔非零十进制），不从标题散文抽取；未声明须作者补字段或模型逐字引用。famx-assets@1 只识别完整 Rel_FAMX/FAMY_数字构建名加 _command-tree.xml、_bugs-fixed.json、_mib.txt/mib/my 或声明的镜像扩展名，其余保留原链接但不认角色。版本线前导零与末尾 .0 按 U24 同线，构建 id 不变。页面只认完整声明的 mainline/platform、patch数字 或 customer_标识结构；无兜底客户类。旧关键词结果原样保留，新包重产新根并沿原运行建立血缘。本次未运行验证。

## R4 的命令引用边界（1.1.0）

所有者 2026-10-24 严格规则：finding 的命令引用必须与本用例的一条完整原文行逐字符相等；不做 NFKC、大小写/空白折叠，不从提示符、中文说明或标点中裁短。这里只证明引用在用例中，命令及参数是否成立仍由锁定构建的 typed catalog 核验。原 1.0.9 的 command_not_in_case/命令目录判据属于旧规则范围；旧运行不改写，新包的新运行另保留血缘。未涉及的类别、含糊期望等由各整改任务负责。

R3：含糊期望不再由词表或生产器布尔决定。case-review 逐用例提交全部期望叶子的逐字引文及判断，由 Hub 核验身份、路径和引文；不可读原件保持未知并补读。quality-board 仅接 Hub 绑定的同根、同原件、已受理且有效的 case-review 记录；重复回执去重，同原件相互冲突的判断单计冲突并留在未判断中，不挑最后一句。含糊率分母仅为已判断数；零分母显示未判断并补评审，不能显示 0% 或判阈值通过。资源类型比例另按精确声明分母计算。旧结果不改写，新版本须重产新根和评审后再开看板。本次续接未运行验证。

## R2 发布样例修正（1.1.19）

`tags_variant` 保留输入原文 `Functional`、`function`，三条均期望 `case-review.tag_variant` 的提示档结构违规。闭集仅声明 `functional`；变体不能通过归一化或同义映射变成有效声明。正例 `tags_consistent` 使用闭集原文。

`sources_cited_line` 逐字引用原步骤 `health interval pool1 30`，维持支持；另加反例 `sources_cited_line_variant`，引用 `Health  Interval pool1 30`，期望 `case-review.command_not_in_case`。大小写和空白差异不能冒充原文证据。这是 R4 的引用边界，和 R2 的标签闭集分别核验。样例由 `testing/samples.ts` 重生成，并按新版本重签；不修改旧运行结果。

## 可执行槽 Schema 修正（1.1.20）

槽声明仅保留 Hub 可执行的结构约束，去掉 pattern、patternProperties、format。摘要、引用解析、原件身份、路径及逐字引文仍由现有受理边界核验，槽位收到字符串不表示身份已核对。case-review 的 expected_quality 继续逐字核对冻结原件与全部期望叶子；knowledge-contribution 从权威 ContributionInput Schema 生成受限槽投影，不修改权威受理合约。生成器按 Schema 结构遍历，名为 pattern 或 format 的普通字段不会被误删。case-review-verify 与 quality-board 槽声明未发现这些关键字，无须升版。

期望来源（U19/U20 与 famx-id-fields@1，所有者 2026-10-24）：只绑定作者显式声明的身份——运行参数 `stories`/`bugs`，或标题/上级目录里整段的 `bug:<编号列表>`、`story:<编号列表>` 字段；散文里的编号、标记词、错拼、补零、全角一律不读。关键词检索连候选来源也禁止：不再产出 `manual:spec-search`、`manual:qa-search` 或 `agile:search` 之类的检索读法，检索结果不作输入也不作查全依据。没有声明编号时不绑定来源，并写明缺的事实与下一步（作者补参数或字段，或由模型提交逐字引文经 Hub 核验）。

R3 补充（验收恢复）：空的可选 expected_quality 槽位表示尚未判断，保持未知并给补交判断及全部叶子逐字引文的出口；沿用旧槽位也执行同一规则。缺判断不冒充肯定判断，也不当成伪造引文反驳。非空主张仍完整核原件、数量、位置和逐字引文。
