# case-review: functions, tables and fixtures

The deterministic part of the `case-review` workflow pack (T01 F[8], C03, C04): the projection of KityMinder test mind maps into
items (W01), the subjects the core interpreters judge, the expected sources a run binds, the template coverage, the tables of the
requirements (W02) and the synthetic fixtures. The other pack files (`pack.json`, `requirements.json`, `SKILL.md`,
`slots.schema.json`, `checks.json`, `knowledge.json`) belong to the packs integrator and are not here.

## What is here

| Path | Content |
| --- | --- |
| `functions/types.ts` | input and output types of every function (type-only imports of `hub/refs` and `contracts`, erased at run time) |
| `functions/project.ts` | `projectItems({ documents: [{ slot, documentId, model }], parameters?, limits? })` → `{ items, groups, unnumbered, warnings }` or `{ error, warnings }` |
| `functions/tags.ts` | `normalizeTag(tag)` → `{ canonical, raw }`; `canonicalTags`, `isNegative`; default export `{ tags }` → normalized list |
| `functions/subject.ts` | `toStructureSubject(item)`, `toStructureSubjects(items)`, `toCatalogSubject(item, phrases)`; default export `{ items, commands?, parameters? }` → `{ subjects, catalog, warnings }` |
| `functions/expected-sources.ts` | `expectedSources({ documents, product, parameters })` → `{ external, basis, warnings }`; `extractIds`, `featureTerms`, `specSearchId` |
| `functions/template-coverage.ts` | `templateCoverage({ items, template, skipped? })` → coverage facts per template category |
| `functions/common.ts`, `functions/text.ts` | warning collector, refusals, totality guard; white space, clipping, UTF-8 length, selector segment encoding |
| `tables/*.json` | the tables of the requirements (below), the template categories and the pack codes |
| `../../../tests/fixtures/mindmaps/` | synthetic mind maps, their builder (`documents.ts`), the writer (`write.ts`) and `index.ts` for other packages |

Every function module has `export default function (input: unknown): unknown`, is pure (no I/O, clock or randomness), imports
only modules inside the pack at run time, never throws (a guard turns an unexpected exception into `case-review.internal_error`)
and returns only JSON. `tables.test.ts` checks the imports and runs each default export in the Hub sandbox (`callPackFunction`,
macOS `sandbox-exec`) and compares the output with the in-process result.

## The projection (W01)

Measured on the 51 sampled real documents (counts only, no content; 47 plain maps with priorities, one map in a second node
format, three without any priority): 2,712 nodes carry tags, and 3,033 untagged nodes outside every tagged case carry priority
2, have children and hold no tagged node and no other priority-2 node. Those are cases written without tags: 1,780 have a
priority-3 precondition and a step, 1,022 a single expected leaf, 197 a step; 2,372 carry a degree and 172 an `autoid`.
11 maps contain only such cases. The brief's rule (a case is a tagged node) therefore misses about half of the real cases,
and the owner has to decide the rule (open question 1). Until then:

- **Case rule** (`parameters.caseRule`). `tagged` (default, the brief): a case is a node whose `resource` is a non-empty array.
  `marked`: also an untagged node outside every case that carries the case priority (`casePriority`, default 2), has children
  and holds no tagged node and no node with the case priority (the team template's case marker). Such a case has `tags: []`
  and `negative: null` (unknown); the literal check reports its missing tag. Under `tagged` these nodes are not items and not
  groups: the warning `case-review.untagged_cases` gives their count and the selectors of the first 20, and the `no_case`
  refusal names their count and offers `caseRule: marked` as the fix. On the sample: `tagged` projects 37 of 51 documents
  (2,706 cases), `marked` 48 of 51 (6,045 cases); the three left have no priority at all.
- **Tagged group node.** A tagged node with the group priority (`groupPriority`, default 1, `null` turns the rule off) that
  holds tagged nodes or nodes with the case priority is a group: all 8 tagged priority-1 nodes in the sample hold cases (121
  of the 124 nested cases sit below them). One `case-review.tagged_group` warning names the node.
- A case's text is the title. Item id `<documentId>:<data.id>`, label the title with white space collapsed, location
  `{ parser: 'kityminder@1', selector }`; the Hub core adds the source digest and forms the `src:` URI. The selector is
  `n/<data.id>` (percent-encoded exactly like `hub/refs`) when the id occurs once among all nodes, else the position selector
  `i/...`; the tests check that every selector equals the parser's own selector.
- The **children** of a case: a leaf is an expected result; a leaf with the precondition priority (`preconditionPriority`,
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
- **Refusals** (W01 R[3]): `case-review.no_case` when a document has no case under the rule; `case-review.too_large` when the
  JSON result would exceed `limits.outputBytes` (default 8 MiB, the sandbox default; measured exactly as the sandbox does, UTF-8
  bytes of `JSON.stringify`); malformed input is `case-review.invalid_input`.
- **Warnings**: per-node warnings (nested cases, tagged group nodes) are capped at 100; summaries per document (untagged cases,
  numbering, malformed structure, depth, clipping) are kept apart from that budget, so a full budget never hides them.
  `case-review.warnings_clipped` counts what was dropped, per code.
- Passes over the visited nodes (walk with an explicit stack, flags from the leaves up, roles, items) keep a document linear
  in its size. Hostile models are survived: invalid child indexes, cycles and shared children (`case-review.model_malformed`),
  more than 200 levels (`case-review.depth_limit`), texts over 4,000 code points and lists over 100 entries (clipped, with
  warnings, counts kept).

## Subjects and tables

| Table | Kind | Tier | Subject | Requirement |
| --- | --- | --- | --- | --- |
| `structure.json` | structure@1 | blocking | `{ subjects }` (nodes `$.subjects[*]`) | literal: non-empty title, priority 1-3, at least one non-blank tag, at least one expected result and none blank, no two cases with the same title, steps, expected results and preconditions under one (document, path) |
| `structure-node-ids.json` | structure@1 | advisory | `{ subjects }` | literal, numbering (W01 R[2]): every case has an id, unique among the cases of a document |
| `tags.json` | structure@1 | advisory | `{ subjects }` | literal, inconsistent field formats: a category tag written differently from the usual spelling of its category in the same document (`tagVariants`) |
| `catalog.json` | catalog@1 | advisory, off by default | one element of `catalog` (only when `scanCaseCommands` is true) | optional scan of the case texts for command phrases; on a negative case `param_out_of_range`, `param_type_mismatch` and `arity_mismatch` are the expected refutations |
| `findings-catalog.json` | catalog@1 | blocking | an item submission (`item`, `slots`) | catalog: every command a finding cites (`present: true`) exists with fitting arguments; a statement that it does not exist (`present: false`) agrees with the catalog |
| `findings-codes.json`, `findings-ranks.json` | membership@1 | blocking | an item submission | findings: codes are the seven probe names, ranks critical, major, minor |
| `findings-quotes.json` | quote@1 | blocking | an item submission | findings: quotations verbatim in what their references resolve to |
| `template-v3-coverage.json` | coverage@1 | advisory | the output of `template-coverage.ts` (cross-item) | template gap check: required categories covered, skips with a reason |
| `template-v3.json` | `case-review.template@1` (pack table) | | read by `template-coverage.ts` | the categories of template v3, author-written |
| `codes.json` | `case-review.codes@1` (pack declaration) | | | refusal and warning codes with Chinese `when`/`fix`; the finding codes, ranks (with their level bands) and the levels P0-P7 with the brief's definitions |

Every core table passes the contract shape (`TABLE_SCHEMAS`) and the interpreter's `validateTable`, names its `origin`, and a
blocking table names its `basis` by a requirement of the brief (`literal`, `catalog`, `findings`). The tests run the real
`structure@1`, `membership@1`, `catalog@1` and `coverage@1` interpreters on subjects built from the fixtures and check the exact
findings.

Duplicates are keyed by (document, path) as the group and the title plus `content` (steps, expected results and preconditions
in the matching form) as the key. On the sample a title-only key refuted 20 cases in 2 documents, 18 of them variants that
differ in their steps or expected results (a short label reused for select, delete and edit); the content key refutes the 2
that are identical. Several expected results are not a literal issue: the former "exactly one" rule refuted 416 sampled cases
(15%) in 16 documents, 123 of them cases with several steps.

The scan of the case texts (`catalog.json`) is advisory and off unless the run parameter `scanCaseCommands` is true: without
it, `subject.ts` returns an empty `catalog` list, so the table judges nothing.

## Tags

`normalizeTag` folds a tag (NFKC, lower case, brackets and quotes removed at both ends even when unbalanced, inner spaces, `-`
and `_` removed, one suffix such as `test` or `测试` removed) and looks it up in `TAG_SPELLINGS` (author-written from the spellings
in the sample: Function, function, Functional, [Function], [Functional, 功能, Configure, configuration, 配置, Integration,
Negative, negative, 负向, Stress, 压力, Compatibility, ...). Unknown tags (release-specific ones like `20260301ADD`, also
`Boundary`) keep canonical null; no spelling maps to two categories.

The spelling check compares spellings inside one document: the usual spelling of a category is the most frequent one (a tie
goes to the canonical name, else to the spelling seen first), and tags written otherwise are reported. A document that writes
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
(`parameters.idRanges: { story?: { min?, max? }, bug?: { min?, max? } }`; a kind without a range covers every id; the product
pack should supply them). Otherwise `parameters.bareIds` decides: `both` (default: a story and a bug are read, the read of the
one that does not exist reports it unavailable, and one `case-review.id_kind_unknown` warning lists the ids), `story`, `bug`
or `skip`. Explicit `parameters.stories` / `bugs` replace the ids found in titles. Release-train labels (`NNN：3.2.1-...`),
years, dates, version numbers and markers inside words (`debug`, `history`) are not ids.

Search terms: Han runs are split at multi-character function words (`支持`, `测试`, `以及`, ...) and at the conjunctions `和`,
`与`, `及`, `或` only when two Han characters or more stand on each side; `的` and positional characters (`后`, `时`, `在`, `对`,
`下`, `中`) never split, because they are parts of common words (`目的地址`, `后端`, `时间`, `在线`). `功能` and `检查` stay inside
longer runs (`健康检查`) and are dropped only alone. A last segment of exactly three Han characters after a dash or underscore
is left out as the author's name (of the 16 such endings among the 2,206 sampled document labels, 15 read as personal names
when the 9 distinct endings were inspected by hand; one is a feature phrase). Product names
given in `product.names` are left out, also when fused with a version; `specSearch: false` drops the search; `maxTerms` (1-16,
default 8).

## Template coverage

`tables/template-v3.json` lists 24 categories (author-written from the description of the team template, not copied from it):
the six test types by canonical tag; per command add, delete, modify, query, show at maximum configuration, no and clear
commands, operation log and audit log; configuration sync, save, restore and clear; upgrade new→newer, old→new and new→old;
security; database. A category is shown by a canonical tag or by literal keywords (`contains`, `prefixes`, `equals`) in the
texts it names, compared in the matching form with arrows written as `->`; a keyword with a space at an end only matches at
word boundaries (" add " does not match "address"). The template is admitted like a table (C04 R[0]): a closed shape, an
origin, literal keywords only; anything else is `case-review.template_invalid`. Output: `required`, `covered`, `missing`,
`skipped` (declared skips with a reason) and per category `present`, `count` and up to 50 item ids as evidence.

Only the six test types are required. With all 24 required, every sampled document missed 8 to 23 categories (median 19) and
four categories matched in none, because whether a per-command or per-feature category applies needs the commands of the
feature, and their real wording is often a product command (which a workflow pack cannot name). They are reported (present,
count, evidence) but not counted missing; the sampled documents now miss 0 to 6 categories (median 3).

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
npx tsc --noEmit
```

The tests import `hub/refs/api.ts` (the real parser builds the models the functions receive) and `hub/rules/api.ts` (the real
interpreters judge the tables; the sandbox runs are skipped where `sandbox-exec` is unavailable). The functions themselves
import neither.

## Decisions and deviations from the brief

1. **Case rule.** The brief defines a case by tags (and a priority). About half of the real cases have no tags (counts above),
   so the default stays the brief's rule, and `caseRule: marked` projects the untagged cases by the team template's marker.
   Choosing the default is the owner's decision (open question 1).
2. **Steps and preconditions.** The brief says a case's children are its expected results. In the sample, 1,162 of 2,714 tagged
   cases (43%) use case → step → expected, often with a priority-3 leaf precondition, and template v3 writes upgrade cases that
   way. The projection reads leaves as expected results, steps as steps and priority-3 leaves as preconditions; the simple form
   is unchanged.
3. **Case without priority.** A tagged case without a priority (6 in the sample) is projected and the literal check reports
   the missing priority instead of the case silently disappearing.
4. **Negative override.** The brief names `core.catalog.param_out_of_range` as the expected refutation of a negative case;
   `catalog.json` also expects `param_type_mismatch` and `arity_mismatch`, because a negative case with a wrong type or a
   missing argument tests the same input validation.
5. **Pack identities** (W01 R[2]) are declared in the output member `unnumbered`, not in item fields, because the Hub core
   never interprets `fields` (`ItemProjection`).
6. **Two subject shapes.** `structure@1` needs the list (`nodes: $.subjects[*]`) to see duplicates and spelling consistency;
   `membership@1` and `catalog@1` read `item` and `location` from the subject root, so they judge one subject each.
7. **Outputs carry more than asked:** refusals come with `warnings`; `expectedSources` returns `basis` beside `external`;
   groups carry their case counts; `unnumbered`. Additional tables: `findings-quotes.json`, `findings-catalog.json`,
   `structure-node-ids.json`, `tags.json`, `template-v3-coverage.json`, `codes.json`.
8. **The large fixture is generated**, not stored (about 400 KB of JSON).

Corrected in this round (they contradicted the brief): the finding codes and ranks are now exactly the brief's probe names and
critical, major, minor (an earlier design's seven codes and high, medium, low were removed); the tables name the `literal`
requirement instead of `structure`; the scan of the case texts is advisory and off by default; the "exactly one expected
result" rule is gone.

## Limits

- Output is about 800-880 bytes per case on the sample (the path is repeated in every item, as the brief's item fields ask):
  roughly 10,000 cases fit in the sandbox's default 8 MiB. Above `limits.outputBytes` the projection refuses with
  `case-review.too_large` (tested in the real sandbox with 16,000 cases) instead of failing with a sandbox error.
- The six test types are shown by tags only, so an untagged case (`caseRule: marked`) shows no test type.
- Template coverage is per document, not per CLI command, and keyword coverage is a heuristic: a group named after a category
  counts as evidence for every case in it.
- A second node format seen once in the sample (`ctype`, `resource_list`, `part0`-`part4`, mostly empty `resource`) is not read
  specially; under `marked` its priority-2 nodes in the case form are projected.
- Intermediate nodes below a step (step → sub-step → expected, 6 cases in the sample) are not listed; their leaves are.
- Search terms come from fixed word lists, not a dictionary; the trailing-name rule drops a three-character feature word that
  ends a title after a dash (1 of 16 such endings in the sample).

## Needs from other packages

- **runs**: call `projectItems` with the documents of the judged slot, the frozen run parameters and
  `limits: { outputBytes }` equal to the sandbox output limit of the call; form `src:<sha256>/kityminder@1/<selector>` from each
  location; never carry the ids listed in `unnumbered` across revisions; treat `{ error }` as the start_run refusal (code,
  message, fix) and keep `warnings` with the run. Build subjects with the default export of `subject.ts` and the frozen run
  parameters (`subjects` for `structure.json`, `structure-node-ids.json` and `tags.json`; `catalog[i]` for `catalog.json`, empty
  unless `scanCaseCommands` is true), the item submission for the findings tables, and the output of `template-coverage.ts` for
  `template-v3-coverage.json` as a cross-item fact. Pass the frozen run parameters to `expectedSources` too.
- **packs integrator** (`checks.json`, `slots.schema.json`, `knowledge.json`, `requirements.json`): the findings tables assume
  the slot shape `findings: [{ code, rank, statement, quotes: [{ text, reference }], commands?: [{ command, present }] }]`, with
  `code` one of the seven probe names and `rank` the severity band critical, major or minor (`tables/codes.json`); every command
  a finding cites goes in `commands` with `present: true`, a statement that a command does not exist with `present: false`.
  The draft level is a cross-item judgment whose `rank` is one of `codes.json` `levels` (P0-P7). Declare the run parameters
  `caseRule` (tagged, marked), `casePriority`, `groupPriority`, `preconditionPriority`, `scanCaseCommands` (default false),
  `stories`, `bugs`, `idRanges`, `bareIds`, `specSearch`, `maxTerms`; the catalog tables name the knowledge catalog `commands`;
  register the pack codes of `tables/codes.json` when the pack is published.
- **product pack**: `idRanges`, the id ranges of stories and bugs in the defect system, as a run parameter; the phrase
  extraction (`extractCommands` in `packs/product/apv`) → the `commands` map (item id → phrases) for `subject.ts` when the scan is on.
- **connectors (agile, PLM and manual system packs)**: pass each document's listed `title` and the labels of its folders
  (`ancestors`, top down) to `expectedSources`; resolve `plm:story:<id>`, `plm:bug:<id>` (an id that does not exist is
  unavailable, never an error) and `manual:spec-search:<terms>` (terms joined by `+`, percent-encoded).

## Open questions

1. **Case rule**: should untagged nodes with priority 2 and children be cases by default (`caseRule: marked`)? On the sample
   that turns 2,706 cases in 37 documents into 6,045 in 48, and the literal check then reports a missing tag on 3,339 cases.
2. **Expected results with steps** (decision 2): confirm that a case's expected results are the leaves of its subtree and that
   a priority-3 leaf is a precondition, or amend the brief.
3. **Id kinds**: confirm that the product pack supplies `idRanges` (the sample suggests stories below 50,000 and bugs from
   50,000); until then unmarked ids are read as both kinds.
4. **Tag spelling**: is a canonical spelling mandated? If so, a table against the canonical set can be added back next to the
   within-document check.
5. **Per-command coverage**: should the template coverage check each command found in the catalog for its add, delete,
   modify, query, no and clear cases, and which categories are required for which kind of document? That needs the product
   pack's phrase extraction.
