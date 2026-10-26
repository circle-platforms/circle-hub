# case-review-verify: the independent verification pack

The workflow pack of brief section 6, step 5 (the earlier skill `review-verifier`): another session with another declared
model verifies a draft of `case-review`, item by item, looks for what the draft missed with the seven probes only, challenges
the draft level and gives the verdict PASS, PARTIAL or FAIL with the final level. The verification is a second run in the
draft's lineage (`predecessor` = the draft run); its input is the draft's validation result handed over by its Hub record
reference (`rec:`), so the receiver inherits the items and references, not the judgments, and re-checks on its own boundary.
Model elements A04 (independence), W02 W03 W05, C05 (checks with samples), T02.

## The pack

| File | Content |
| --- | --- |
| `workflow.json` | inputs `target` (role subject: the same mind map, `agile:mindmap` or `application/json`) and `draft` (role artifact under verification: the draft's validation result as `rec:<digest>`, parsed with json@1); the expected-source parameters and case-rule parameters (`case_rule`, `case_priority`, `group_priority`, `precondition_priority`) of the draft pack, inherited from the predecessor by default; catalog `commands@1`; projection `functions/projection.ts`, expected sources `functions/expected.ts` |
| `requirements.json` | `verification` (item, independent judgment, independent of the predecessor, accepts the declared independence; checks dispositions, command_claims and verdict; repair rows, two rounds, for every pack check code and `core.catalog.membership_contradicted`), `suggestions` (run, judgment, not required), `final` (run, independent judgment; check verdict) |
| `checks.json` | `dispositions` (item, `functions/verify.ts#dispositionsCheck`), `command_claims` (item, catalog@1 `tables/command-claims.json` over `functions/subjects.ts#claimSubject`, catalog `commands@1`) and `verdict` (run, `functions/verify.ts#verdictCheck`), all blocking on the artifact under verification |
| `slots.schema.json` | item `verification`: codes verified, refuted, partial, new_finding; ranks critical, major, minor; evidence required; data `{ finding?: string, probe?: one of the seven }`; run `suggestions` (code suggestion, ranks critical, major, minor) and `final` (codes PASS, PARTIAL, FAIL; ranks P0-P7; exactly one) |
| `SKILL.md` | the verifier's procedure (about 2,900 characters): the "break the draft" stance, starting the run, reading the draft findings, the dispositions (no item with a draft finding skipped), the seven probes, unfamiliar commands and command statements, the level challenge, the verdict rules, blocks and slices, the report |
| `functions/projection.ts`, `expected.ts`, `verify.ts`, `subjects.ts` | this pack's functions |
| `functions/expected-sources.ts`, `text.ts`, `types.ts`, `common.ts` | copies of the draft pack's modules (a pack imports only inside itself); `common.ts` differs only in the pack name; a test keeps them equal |
| `tables/codes.json`, `tables/command-claims.json` | every code the functions give, with Chinese when and fix; the catalog table of the verifier's command statements |
| `samples/` | 24 samples (10 positive, 14 negative) written by `testing/samples.ts`; every check has positive and negative ones |
| `examples/` | a start_run and a submit_result, synthetic, with placeholders |

Not published: `api.ts`, this README, the tests and `testing/` (the samples generator and the end-to-end bed).

## The projection

`projection.ts` reads the draft's validation result (the record `{ kind: validation_result, body }` the `rec:` reference
binds, or a validation result bound below a record, whose pointer the references then carry) and the target:

- the items are the draft's items of every partition, located in the target by the selectors of their draft locations, in
  the target's document order; the target must be the very source the draft judged: a draft location in another source is
  `case-review-verify.target_mismatch`, an item whose node the target lacks `draft_item_missing`;
- `fields.draft_findings` lists the item's draft findings (the model's judgment claims of the draft requirement `findings`,
  never the Hub's facts), each with `reference` (`rec:<record>#/partitions/<p>/<n>/requirements/<r>/claims/<c>`, the value a
  disposition's `data.finding` must name), code, rank, text, location, quotations and commands from the claim's resolutions;
  `fields.draft_level` and the group `{ kind: draft_level, reference, rank, text }` carry the draft level (the run-level
  judgment of `level`); the group `{ kind: draft }` names the record, the draft run and the counts;
- the summary of an item (at most 200 characters) lists its draft findings by code and rank, the draft partition and the path;
- refusals: `invalid_input`, `draft_invalid` (not a validation result, no record digest, a result of another workflow pack
  than `case-review` (its `locks.pack`), items that are no mind-map nodes, no items), `draft_not_accepted` (nothing to verify),
  `too_many_items` (more than 100), `internal_error`; a draft without a level is refused (`draft_level_missing`):
  its reviewer must supply the level and a new accepted receipt before verification can start.

`expected.ts` binds the evidence of the target again with the draft pack's rules (the stories and bugs of the title and the
folders and the spec search as expected sources; the test strategy search and the similar test lists, the target left out,
as hints), so the verifier can cite it on its own boundary; pass the draft's parameters.

## The checks

- `dispositions` (default item subject): every draft finding of the item gets exactly one disposition (verified, refuted or
  partial) naming its reference (`disposition_missing`, `disposition_duplicate`); a disposition names a draft finding of this
  item (`finding_unknown`); every statement has a location and a quotation (`location_missing`, `quote_missing`); a new
  finding names its probe (`probe_missing`).
- `command_claims` (catalog@1 over `claimSubject`: the statements of the verifier's slot record whose commands carry
  `present`): a statement that a command exists or does not, against the locked build's catalog. The verifier who says an
  existing command does not exist (or the reverse) has made the error, so the check judges the artifact under verification
  and `verification` sends `core.catalog.membership_contradicted` back for repair (scenario 3; FAIL exists for inverted
  product semantics, so this run's own statements about the product are checked like the draft's).
- `verdict` (default run subject: the items with their slot records and the cross-item entries): PASS is refused when a
  draft finding is refuted (`pass_with_refuted`), a new finding is listed (`pass_with_new_finding`), the final level differs
  from the draft level (`pass_level_changed`) or a draft finding of any item has no disposition (`pass_with_unverified`: a
  skipped or uncovered item disposes of none), and it needs a quotation of the verifier's own into the target
  (`pass_without_evidence`): a quotation whose reference lies in the target, other than the draft's own quotations of it.
  FAIL needs a refuted draft finding that the draft itself ranked major or critical (`fail_without_major_refutation`).
  PARTIAL needs a new finding, a refuted or partly correct draft finding, or a level change (`partial_without_change`). So
  every verifier has a consistent verdict: refuting only minor findings with the level kept is a PARTIAL. Without a verdict,
  or without a draft level to compare where the rule needs one, the check refutes with verdict_missing or level_missing and a repair action; a draft without a level cannot start verification.
  The verdict check appends the case rule summary line (`用例规则：...`) to its statement and includes `{ case_rule, marked_only }` in its `data`.

Independence (A04): the requirements `verification` and `final` are independent of the predecessor and accept the
independence the client declares (A04 R[4]): a submission from a session of the draft's lineage, or from a declared model of
the same family (names that share a word), is not independent and leaves the requirement unsatisfied; another session with
another model satisfies it, marked "independence declared by the client".

## How to test

```
node --test "packs/workflow/case-review-verify/**/*.test.ts"
```

`functions/verify.test.ts`: the projection on a synthetic validation result (checked against `validation@1`) and a parsed
mind map, every refusal (a result of another pack included), the expected sources, the checks against `check-outcome@1` (a
PASS's own quotation, PARTIAL on a refuted minor finding, FAIL by the draft's rank, PASS with an undisposed finding of a
skipped item), the command statements' subject, the copies of the draft pack's modules, the declared codes, the functions in
the Hub sandbox. `end-to-end.test.ts`: the whole chain on the real packages (see the
draft pack's README) including the scenarios of brief section 9: a non-verbatim quotation keeps the whole submission out
(2, 16), a contradicted command statement goes to repair (3), a negative case's out-of-range command is the expected
refutation at advisory tier (4), the verification from the draft's own session and model is not independent (14), a PASS
that refutes a draft finding is sent back with a fix and a consistent PARTIAL from another session and model is accepted
(15), in a second verification of the same draft the verifier's statement that an existing command does not exist goes to
repair (3), a PASS that copies the draft's locations and quotes only the story is refused, a PASS with a skipped case that
holds a draft finding is refused, and refuting only a minor finding is a consistent PARTIAL, and the second product
reviewed by the same workflow pack (8). The samples cover the rest of scenario 15 (PASS without evidence of its own, with a
location only, with a copied quotation, FAIL without a refuted major point, PARTIAL without a change).

## Decisions

1. **Dispositions carry a rank**: the severity the verifier assigns (the slot declares ranks, so every statement carries
   one); "is the severity reasonable" is answered by it.
2. **New findings** use the code `new_finding` and name their probe in `data.probe`: the brief lists `new_finding` as a code
   and asks for the finding codes on new findings; a statement has one code.
3. **Run-wide verdict problems are reported on the first handled item** and the verdict check is listed by the item-level
   requirement `verification` as well as by `final`: the engine routes refutations through the error table of item-level
   requirements only, and the brief wants an inconsistent verdict refused with a fix.
4. **The target must be byte-identical to the draft's subject**: the draft's locations and quotations point into that
   source; a changed document is verified by a new draft.
5. **`suggestions` is not required** (a verifier may have none); `final` is.
6. Both independence requirements accept the declared independence: the Hub can only compare sessions and declared models,
   and without accepting the declaration no verification could ever be satisfied (A04 R[4], R[5]).
7. **A PASS's own check of the target is a quotation**: a location or a ground is a reference anyone can copy from the item
   list (every disposition must carry a location in the target anyway), and the boundary only resolves it; a quotation is
   checked verbatim against the fragment it cites, so it shows that the verifier read the target. A copy of the draft's own
   quotation (same fragment, same text, white space aside) shows nothing of the verifier's, so it does not count either.
8. **FAIL rests on the draft's rank of the refuted finding**: a major factual error is an error in what the draft itself
   ranked major or critical; the rank the verifier gives its refutation says how much the refutation matters to the report,
   not how wrong the draft was, and a verifier could otherwise make any refutation a FAIL.
9. **PARTIAL accepts a refuted or partly correct finding**: otherwise a verifier who refutes only minor findings and keeps
   the level had no consistent verdict (PASS refused with a refutation, FAIL without a major one, PARTIAL without a change).
10. **Every draft finding is disposed of before a PASS**, on skipped items too: the method checks every draft finding, and a
    skipped item would otherwise hide a finding from the verdict.

## Deviations from the brief

- **Predecessor required at start_run** cannot be declared: `workflow@1` has no such field and the engine starts a run
  without a predecessor (its independence is then unknown and the requirements stay unsatisfied, A04 R[5]). SKILL.md tells
  the verifier to give it. See Needs.
- **The level challenge and the expected result of a suggestion** are written in the statements: cross-item entries carry no
  `data` (see the draft pack's README).
- **"A PASS needs an evidence reference of its own that resolves in the target"** is judged by the run-level verdict check
  over the canonical slot records (a reference there resolved at the boundary, or the whole submission was not accepted),
  not over the `ResolvedEvidence` of an item subject: an item check does not see the verdict, which is a cross-item entry. It
  is read strictly (decision 7): only a quotation into the target that is not the draft's own counts, not a location or a
  ground.
- **Groups reach the checks through the item fields**: a check function gets no `context.groups` (only subject builders get
  the run context), and the run subject builder gets no slot records or cross-item entries; the verdict check therefore uses
  the default run subject and reads the draft level from `fields.draft_level`.

## Limits

- Only drafts of `case-review` are understood (requirement keys `findings` and `level`, kityminder locations); a result of
  another pack is refused (`draft_invalid`).
- A block of a large document is verified as its own pair of runs; the overall verdict across blocks (the worst one) and
  the Chinese report are computed and checked by `case-review-report` after every review, including a single block.
- The verifier reads the full draft findings through `get_nodes` on the run record's item fields or `resolve_reference` on
  their references; the item lines show only codes and ranks.

## Needs from other packages

- **contracts / runs-engine**: a workflow declaration that a predecessor is required (for example `predecessor: required`
  in `workflow@1`), so that start_run refuses a verification without one instead of starting a run that can never be
  independent.
- **runs-engine**: the run context (with `groups`) in the input of check functions, not only of subject builders; and the
  slot records and cross-item entries in `RunSubjectInput`, so a run subject builder can see what it judges.
- **contracts**: `data` on cross-item entries (see the draft pack's README).

## 生成词表与包版本

case-review-verify@1.0.4 改用生成词表的类型及包内运行时快照。包内函数的运行时依赖仍只来自包内文件和已允许的依赖。functions/generated/vocabulary.ts 由 tools/gen-contracts.ts 按本包使用的轴生成，带“生成物，勿手改”文件头；它计入 pack.json 摘要。node tools/gen-contracts.ts --check 同时核对这些快照。词表更新导致包内字节变化时，必须升版并重签清单，不复用已发布版本。

编号范围的 min/max 是 JSON 对象键，不属于 measure 轴；直接读取经校验的输入字段，不携带 measure 快照。

## 1.1.0：建议落点和终稿视图

每次评审最后都开终稿运行，单块也一样。建议的三段式检查由终稿包移到本包：
补、因为、期望三段都有内容，至少一条根据指向目标脑图中的用例或测试子项；不能只引期望来源。
suggestion_targets 是判待判定产物的运行级阻断检查，挂在第一个已处理条目，保留 /cross_item/<k> 指针；
verification 路由两轮修复，suggestions 同时列出这项检查。

初评已受理结果中，qualifier 为 fact、source_role 为 subject、warrant 为 function，且静态层明确归责 author_input 的反驳，
以完整原声明、原层结果和原 rec: 引用放进投影的 draft_source_facts。处置检查的支持事实把它们原样保存在
data.source_facts 并列原引用为根据；不重判、不改生产者或归责。终稿据此单列“Hub 核对”。
没有这样的反驳时明确保存空列表；缺少此字段的旧复核结果不能当作“没有 Hub 问题”，需用新版复核后重开终稿。

每条源反驳单独检查 statement.data.expected：即使同要求项的静态层归责 author_input，expected:true 的期望结果也不进入初评事实快照或 Hub 缺陷栏；整层归责不能替代逐条判定。

本包的跳过不是完成：handling=skipped 必须附 reason，列入待续做清单，按回执继续本条目或以当前运行为前驱续做；不能因跳过而省略发现、处置、结论或等级。缺判定时按修正说明补齐并重交；初评缺等级、报告缺块或有未交付条目时先修复所列块或条目，再用新回执重开后续运行。

## Predecessor result default

The `draft` slot explicitly declares `default_from_predecessor: {pack: "case-review"}`. A verifier may omit it when supplying `predecessor`; the Hub binds that run's newest accepted submitted validation record and discloses the frozen `input_defaults` provenance in both the start reply and run record. Newer refusals or system deliveries do not replace the eligible submitted result. No accepted submission refuses start with the existing schema code and a concrete resubmit-then-review action. Explicit draft references retain the package's existing validation, including `draft_invalid` and `draft_not_accepted`. This adds no read or predecessor authority. Other artifact slots opt in separately; the compiler's binary workbook slot is unchanged.

R6（所有者 2026-10-24）：声明 famx-directory@1，产品根精确等于产品 names 成员；版本层为三位字母数字码（至少一位数字）、冒号、完整 dotted version，下一层为同版本加列车后缀，再下一层为非空单目录段模块（允许“测试/bug/回归”等字面内容）。不从正文版本或活动词推断层级。缺层、重名或语法外写明缺失身份，下一步由包作者补语法或作者调整目录后重产。famx-id-fields@1 只接受整字段 bug:编号列表 或 story:编号列表（逗号分隔非零十进制），不从标题散文抽取；未声明须作者补字段或模型逐字引用。famx-assets@1 只识别完整 Rel_FAMX/FAMY_数字构建名加 _command-tree.xml、_bugs-fixed.json、_mib.txt/mib/my 或声明的镜像扩展名，其余保留原链接但不认角色。版本线前导零与末尾 .0 按 U24 同线，构建 id 不变。页面只认完整声明的 mainline/platform、patch数字 或 customer_标识结构；无兜底客户类。旧关键词结果原样保留，新包重产新根并沿原运行建立血缘。本次未运行验证。

期望来源（U19/U20 与 famx-id-fields@1，所有者 2026-10-24）：只绑定作者显式声明的身份——运行参数 `stories`/`bugs`，或标题/上级目录里整段的 `bug:<编号列表>`、`story:<编号列表>` 字段；散文里的编号、标记词、错拼、补零、全角一律不读。关键词检索连候选来源也禁止：不再产出 `manual:spec-search`、`manual:qa-search` 或 `agile:search` 之类的检索读法，检索结果不作输入也不作查全依据。没有声明编号时不绑定来源，并写明缺的事实与下一步（作者补参数或字段，或由模型提交逐字引文经 Hub 核验）。

端到端夹具整改：两轮显式传 stories/bugs，模型单独声明 model-identity@1；空的可选 expected_quality 表示未判断，只向声明该槽位的包提交。标签变体保留为提示档违规，不做同义映射。目录缺零参数结构声明时，缺项仍未知且带出口，不能把目录未读到升级成不存在。合成缓存与原件未被改写来换取通过。
