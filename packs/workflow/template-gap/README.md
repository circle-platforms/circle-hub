# template-gap 1.2.0: declared and judged template categories

R1, owner ruling 2026-10-24, supersedes the previous keyword implementation. The Hub calls no model. Each document is one
item. `coverage` is a judgment requirement: original author `category_ids` or submitted per-case `CategoryJudgment` supplies
the semantic classification. Hub checks the generated shape, closed ids, source identity, raw quotation and case ownership,
then computes sets. `command_coverage` reports that conditional set calculation against complete producer identities.
The checks do not prove the semantic correctness or recall of a model classification. Independent review remains necessary.

## Declared scope and category policy

The 24 rows of `tables/template-v3.json` contain only id, label, group and model-readable description. They are a published
closed declaration, not a program. All 24 remain required by `template-v3-coverage.json`; the nine command-group categories
remain required per command identity. Descriptions, titles, steps, ancestors, test-type tags and expected text never select
categories. `category_ids` and `test_type_ids` are independent fields, per model 13. There is no Functional-to-functional mapping.

`casesOf` retains the existing structural `case_rule`: marked by default; tagged restricts the document scope. An author's
category_ids is read from the original case node's data, not from caller-added projected fields. Its nonempty array must
contain exact declaration ids. Wrong case, spaces, synonyms, unknown ids and malformed arrays are structural errors. Duplicate
ids are deduplicated. Absence is unclassified. A group's declarations are not inherited by cases. Nested cases own their text.

## Judgment submission and quotation identity

The existing submit_result item slot `coverage` is a SlotClaim list; each claim uses `text` for the statement and its data
object is the generated CategoryJudgment shape. A CategoryJudgment span counts absolute bytes of the retained original;
a `src:` reference's `:from-to` range instead counts UTF-8 bytes inside the selected fragment. When JSON escapes or double
encoding change the displayed text, the submitted quote must still match the original bytes. If the client cannot locate
the original span mechanically, classification remains unknown; the local byte-location tool below can prepare it.
It contains the exact case item id, category_id, QuoteEvidence and explicit ModelIdentity. The package bundles the generated
category-judgment@1 schema byte-for-byte; a test checks the copy against contracts/generated. A nonempty accepted claim supplies
classification for that case. An empty claim list supplies none. A document entirely classified by author fields can submit
coverage:[]; it does not need invented model judgments. A new run is no longer a wholly factual production run.

The mindmap-format local `tools/locate-quotes.ts` accepts the original UTF-8 file, the model produced by its
`tools/parse-model.ts`, and exact node/text candidates. It returns raw byte slices and absolute offsets without deciding a
category, model identity or case ownership; escaped and double-encoded JSON keep their original bytes. Zero and multiple
matches are left for the client to resolve. Both tools write new mode-0600 files rather than printing source text; their
output is a preparation aid and the normal Hub check remains authoritative. `SKILL.md` gives the commands.

`tools/prepare-claims.ts` assembles the locator's result into the existing `coverage` list without asking the model to repeat
its identity in every claim. Supply the explicit `model-identity@1` object once, or a saved start-run response/run record
containing `model_identity`. Supply choices as `[{"ordinal":1,"category_id":"audit_log","statement":"合成判断"}]`:
`ordinal` refers to a locator result. If it has several quotations, add the zero-based `quote_index`; zero quotations or an
ambiguous selection without an index is refused. Category ids are checked by exact equality against `template-v3.json`.
Run `node <template-gap>/tools/prepare-claims.ts --located <locator.json> --choices <choices.json> --identity <identity.json>
--out <coverage.json>`, then put the array in that document item's `slots.coverage`. The tool copies the chosen raw quote and
the declared identity; it does not classify text, decide which quote belongs to a case, or establish acceptance. Hub still
checks those facts. It creates a mode-0600 file without overwriting and prints counts only. The same output shape can be used
with old locked runs, and a different session must use its own explicitly declared identity.
The helper copies that declaration; it does not establish which session produced a claim.

The frozen context holds the bound source digest and parser model. The function read declaration obtains the original subject
text through the existing permission/integrity boundary. SHA-256 of its UTF-8 bytes must equal the bound original digest before
raw offsets are used. Transformed text is an evidence gap requiring an original-byte reading path; it is never silently accepted.
The source-quotes scanner retains ECMA-404 JSON token locations after JSON.parse validates the syntax. It handles ordinary and
double-encoded KityMinder documents and maps spans back to the original bytes. The selector must resolve within the same case;
the byte span must belong to that selected node or its descendants' text, and to the same nearest case boundary. Ancestors,
siblings, nested cases, borrowed identical text, absent references, wrong digests/parsers/spans and modified quotations fail.
NUL/invalid-surrogate replacement cannot establish exact original quotation evidence. No Unicode, case or whitespace folding
is used. The earlier case-local verifier remains a mechanical text/ownership helper, never a category classifier.

Fresh claims are checked in the current submission. Their judgments are linked to the accepted validation record through the
normal result/slot lineage. Caller-supplied AcceptedCategoryJudgment references are not trusted as acceptance and do not bypass
these checks. Subsequent consumers must resolve the actual accepted result; a self-referential receipt is not fabricated.

## Coverage, completeness and recovery

The client reads the package inputs and requirements with `list_task_packs` and the slot schema from the `start_run`
receipt or its run record. Index examples include `command_tree_root` so that the consumer can check the identities'
declared tree source. Feeding may still be in progress; an empty interim list is not an empty completed corpus. These
are guidance changes and do not change the category or coverage rules.

An index entry without an explicit `command_tree_root` cannot establish a complete command identity, even if its
identity and signature agree with each other. Such cases remain unknown and name the missing source and re-read exit;
an explicitly declared source must match each identity. Existing records remain unchanged.

First classify each case, then aggregate in the frozen declared scope. Fields disclose classification_status, classifications,
unclassified, scope_complete, category counts/evidence, missing and skipped separately. A display evidence list is capped at
20 ids; counts and membership use all cases. No unclassified case is counted as a missing category. Missing/unchecked scope
blocks a missing-category claim. Existing observed categories may still be disclosed with their source and limitations.

The client follows SKILL.md: read the unclassified cases, judge with raw quotes, submit, repair rejected evidence and resubmit.
A missing original triggers re-read; failure to obtain the required fact after the stated bounded action is a design gap for
the maintainer before the final report. Check unknowns name missing facts and an actionable next step; the existing engine
binds a named exit by reason. They are not converted into support, refutation or a completed classification.

## Complete command identity and index revision

Bind case_index to the locked root/product and exact agile-document only set, requesting document,node,commands,
command_identities,title,path_labels. Uploads have no agile identity and remain not_indexed. Headers and ordered path_labels
must equal the current case revision exactly; changed or unmatched cases cannot contribute stale memberships. A shared graph
retains headers/ancestors without copying them per case. A step edit that expands the producer's scan scope requires a complete
per-case revision contract first; the current header contract cannot prove those extended inputs unchanged.

Per the integrator's R1/R4 handoff, data.commands stays a path string list and must equal the paths derived from
command_identities. R4's producer supplies CommandIdentity objects. Groups compare model 13 identityRules.command: locked tree
root, full path, exact signature and typed parameters by declared position/name, type declaration and canonical parsed value.
Raw parameter spelling and role evidence are retained annotations. Path equality alone cannot merge distinct identities.
Old roots without command_identities are missing complete identity evidence, even when commands exists; re-produce with the
new producer, re-read the index and start a new run. Truncation, skipped sources, unmatched revisions, missing identities and
unclassified cases preserve known observations and block unsupported shortfalls/full-coverage claims.

skipped contains exact category, the user's verbatim reason, optional document and optional complete CommandIdentity command.
A command skip matches only that identity; a path string is invalid. Document skips apply to all identities of that document.
Unknown, overlapping or inapplicable targets refuse start_run. Explicit skipped categories remain separate from unclassified.

## Consumers, history and new lineage

Affected active requirements: template-gap coverage and command_coverage. case-review's templateCoverage utility is exported
but absent from that pack's checks; its old direct-call results are affected, not its literal/catalog/level checks. The utility
now reads exact author labels from bound originals and directs model judgment acceptance to this workflow.

No historical run, result, source or root is overwritten. The integrator performs authorized real re-production with the new
pack/model/root/run lineage, and appends legacy_keyword_rules annotations naming affected fields and old/new rules. Development
uses synthetic originals and scripted claims only. This version is signed locally, not published or deployed.

## Decisions and deviations

1. **Required policy:** all 24 categories here; case-review's legacy utility requires the six declared test types only.
5. **Structural case rule:** removing children can change a tagged group into a case. No category is inferred from its tag.
6. **Evidence scope:** same nearest case boundary; citations establish presence, never semantic truth.
7. **Complete identities:** opaque complete producer identities, no command parser or text classifier in this workflow.
13. **Migration:** generated M1 interfaces from hub-redesign 5a9eb7bf; no local model fields or private status axes.

## Needs from other packages

- R2 writes the independent author fields and exact test-type rules; R4 produces full command identities and canonical parsed
  values. This package consumes the shared generated contracts directly, without importing implementation branches.
- R9 freezes independent category answers and rebuilds client/gold scenarios; it must not import this classifier as its oracle.
- StartRunOutput and PackError retain their existing generic boundaries. The older quadratic arrow matcher was removed from
  template classification, rather than optimized into another semantic heuristic. coverage@1 remains a policy format and the
  legacy exported subject utility; active coverage uses a function to preserve completeness and judgment provenance.
- 期望过渡未知样例的合约缺口：keep transitional examples paired with their recovery while the publication contract requires
  deterministic positive/negative samples. No new sample interface is invented. kb-unversioned is the historical cross-package
  follow-up name; the existing unversioned-root route must be read explicitly, never substituted for the locked case index.

## Open questions

4. Independent semantic recall is established by R9 annotations and review, not by quotation checks.
5. Real deployment counts and legacy annotations belong to the integrator's authorized read/re-production run.
6. An unavailable exact byte view is a concrete interface gap; do not accept normalized offsets or endlessly retry it.
7. Expanded producer scan inputs require their full revision identity before acceptance by this consumer.

1. **已定（决定 35 第 19 项）**：24 个类别全部必选，另按命令核验 9 个类别。
2. A tagged priority-1 node: a group while it holds cases (now, case-review), always a group, or always a case (the brief)?
3. Number copies of a shared id and id-less cases by their content instead of document order, in both packs?
4. Name an upload by something its order does not change (its root id, or a digest of an order-free form)?
5. `* → unknown` (the brief) or no row (this pack)? Decided on 2026-10-22 (Decision 6): the engine unifies `unknown` routing to keep refutations as `violation` with attribution `unattributed` (记未知保留反驳，归责待定). With or without the row, a gap is a violation and status is unsatisfied.
6. **Count untagged cases by default**: decided by the owner on 2026-10-22 (docs/hub-r4-tasks/union-case-rule.md). The default
   case_rule is unified to marked across all packs (template-gap, case-review, case-review-verify), counting untagged candidate
   nodes as cases with `tags: []`; `tagged` remains available as a restrictive parameter.
7. Is 20 evidence ids per category enough for the console?

Deletion-only stale rows are disclosed as orphaned keys, excluded from current command membership and never treated as missing facts.
Command skips on orphan-only commands refuse; skips on unmatched current revisions remain visible as pending_skips until sync and rerun.

标签按 resource-tags@1 的精确原文闭集读取，保留 resource 原值。闭集外是提示档结构违规“未声明的标签”；大小写、全半角与同义词不相等。非法声明不进入正反向比例分母。此版本替代旧关键词规则，历史结果不改写；应以新包重产新根与新运行。本次续接按所有者指令未运行验证。

R1/R4 衔接：索引所属知识根仍按运行 context.root 核对；CommandIdentity.tree_root 单独绑定其签名的命令树来源根（src 摘要或 tree 根），不把包含用例自身的知识根写进自身身份。原文提供 command_tree_root 时必须一致，缺命令树的显式 null 保持缺完整身份。路径集合只取完整身份。类别与 resource 测试类型分别核对；未分类时也披露已覆盖集合，不把未见类别记为缺口。两份共享接口快照统一由 tools/gen-contracts.ts 生成。本次续接未运行验证。

### Feeding-backed case indexes

An index can cite either a tree entry with its `tree:` reference or a feeding projection with a complete `rec:` reference
whose digest is the index entry. `data.object`, when present, is the shared content identity; distinct source records may
name the same object. The index still needs the document, node, title, ancestor labels and complete command identities;
older feeding records without them remain unknown until a root-bound re-read supplies the missing fields.
