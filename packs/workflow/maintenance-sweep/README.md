# packs/workflow/maintenance-sweep

Capability 4b of the architecture brief (section 6a): a fact-only workflow pack bound to no product line. Given an impact
view of two builds, it lists the cases of the earlier build that need maintenance. A removed command is a blocking
violation. A changed definition is an advisory violation: 结论文字写前 3 处字段差异，全部差异在数据里。`start_run` stores the
validation result; `submit_result` only adds model commentary.

The product name in the tests (`widget`) and the build names (`Rel_W_1_0_1`, `Rel_W_1_0_2`) are synthetic.

## Files

| Path | Content |
| --- | --- |
| `workflow.json` | input `impact` (`knowledge:impact`, one, required; the id asks for the slim cataloged view: `?catalog=commands@1&attached_fields=document,node,title` — changes counted among the command catalog's members, compared by syntax); parameter `ignore_fields`; `product: { catalogs: [] }` |
| `requirements.json` | `command_exists` and `command_unchanged`; both fact, item, static, bookkeeping |
| `checks.json` | `command_exists` is blocking and names its basis; `command_unchanged` is advisory. Both are `functions/check.ts` |
| `functions/sweep.ts` | which cases are items |
| `functions/diff.ts` | structural diff of definition JSON |
| `tables/codes.json` | the two violation codes, the refusals and the warnings |
| `samples/` | one positive and one negative sample of each check (author samples) |
| `examples/sweep.json` | a synthetic illustration. No verified run exists yet (T01 F[11]); the task page asks for examples, so this file says it is synthetic |

`pack.json` is the manifest (`pack-files.ts --write`). `pack-files.ts`, `functions/test-support.ts`, `test-hub.ts`, the tests and this README are not pack files.

## The answer

Version 1.8.0 requires a `hint` input `facets`: `knowledge:facets:<product>:<earlier build>?kind=case&by=commands`, matching the impact product and starting root. The null commands row counts unplaced cases; no row in a complete view means zero. The projection retains only `note.unplaced` and `note.unplaced_build` plus a sentence, never the facet rows. The client reads the bound facet source and relays a hint disclosure: N cases have no parsed command and were excluded from the sweep. This does not change the items, reasons or detail tables. The client skill shows at most one sample page with a continuation reference; bulk review goes to an integrator export.


Each item is one case of the earlier build, id `<document>:<node>`, sorted by id. A case on several maintenance paths is
one item. Reasons are sorted by path and carry only the index of the path in the run-level details table and `change`
(`removed` or `modified`) — since 1.3.0 the path string, the field differences and the tree references live once per
path in `note.details` (a cross-line sweep of 1,147 cases blew the check outputs past the sandbox limit before this
round; 1.2.0 had repeated the fields and references per item and per outcome). The case data (document, node, priority,
negative) is written once in `fields`; the title lives once in `label`.

A case is an item when the earlier build places it on a removed path, or on a modified path whose definition data
differ. An added path is not an item. A change only in entries of kind `behaviour` is not an item. A case that exists
only in the later build is not an item.

`maintenance-sweep.case.command_removed` is blocking. The statement and `data.fix` say：按替代命令改写这条用例，或者停用它.
`maintenance-sweep.case.command_changed` is advisory. 结论文字写前 3 处字段差异和"另有 M 处"（段落至多 200 字符，保证 2,096 个判定也在输出上限内），全部差异只在运行级详情里各写一份（`note.details` 的 `fields`），判定数据只带原因的详情序号和变更种类。Each difference is `path` (a JSON Pointer), `before` and `after`. A key that is absent on one side is distinct from JSON null: `absent` is
`before` or `after`, and the missing side's value is null. One ground per claim: the item's own location.

`ignore_fields` drops those names at the top level of each definition before the diff. A nested key of the same name is
still compared. Several definitions on one side are sorted by canonical JSON. Equal multisets are not a change; otherwise
they are compared as an array (`/0/...`). One definition on each side is compared as a value (`/help`, `/args/0/type`).

The run note claims nothing about cases the index does not hold only when sources were actually skipped: with
`skipped.from` above zero it says the earlier build's index lacks that many listed documents, and `command_exists` adds
an unknown cross-item claim (`missing_input`) naming them and the next step. A fully read scope with no maintenance
items is a deterministic empty support (巡检范围是空的), never an unconditional unknown. Unplaced counts remain hints in
the run note and the client reads the bound facet source to disclose them in its answer, never as validation claims. A
truncated view adds `integrity_unproven`. A bound view that names no catalog (or one other than `commands@1`) is refused
at projection with the fix spelled out; a view that names a definition digest it does not carry leaves that path a
missing fact on the note's detail row (`missing`), an unknown in the check, never a fabricated `/ null → null`
difference. Before those, `command_unchanged` leads with one cross-item fact: the whole command diff, one
line per changed path (path, change kind, earlier-build case count from `note.diff`, every changed path — added
paths listed and marked 不进范围； `note.details` still holds only the maintenance paths' field rows) — sorted, at most
200 lines, then 另有 M 条 and `note.diff` holds the full table; a statement longer than 1,400 characters continues in
a next claim (第 k 部分，共 m 部分), paths in order, so the answer's per-field clip never cuts a line off; a truncated
view says the whole count and that only the listed part follows. Its one ground is the impact view (`note.view`, the
bound `src:`). Since the answer shows
cross-item claims before items, the diff is visible however many items are paged away.

## Decisions

1. The pack names no product and no catalog, so a run must not pass `product`, `version` or `build`.
2. Violation codes carry the pack name (`maintenance-sweep.case.command_removed`, `maintenance-sweep.case.command_changed`). The engine rejects a pack-function code outside that namespace. The short names in the task page are the part after the pack id.
3. Case data is read as `document`, `node`, `title`, `priority` and `negative`, the same assumption as regression-scope. The cases index is owned by another pack.
4. A pair with no maintenance item is an empty projection plus a warning that says so. An empty item set is a legal answer (W01 R[3]):
   the run engine accepts an empty projection, stores its validation result with empty partitions and coverage complete
   at 0 of 0, and notes in the answer that there are no items carrying the pack's explanation.
5. The positive samples are a case whose reasons are neither a removal nor a definition diff. A well-formed projection does not emit such an item; the samples exist so each check has a support (C05 R[0]).

## How to test

```
node --test --test-concurrency=1 "packs/workflow/maintenance-sweep/**/*.test.ts"
npx tsc --noEmit
node packs/workflow/maintenance-sweep/pack-files.ts --check
```

The function tests build impact views by hand: a removed path with two cases, a modified signature, modified help text,
a behaviour-only change, both reasons on one case, `ignore_fields`, a clean pair, 5,000 cases, and order independence.
`publish.test.ts` and `production.test.ts` use a temporary PostgreSQL and are skipped where `sandbox-exec` is absent.
A skip is not a pass. The real knowledge reader test uses synthetic cases including one unplaced case in the earlier build.

## Limits

- A missing, malformed, duplicate, mismatched or truncated facet input refuses startup (`maintenance-sweep.facets_view`), with the missing complete count, the view notes and root reference for integrator repair; no automatic retry of the same root. Unplaced cases are a hint disclosure, not an unknown sweep verdict. K2 placement proposals are not implemented; the client shows at most one page of examples with a continuation reference; bulk review uses an integrator export.


- At most 10,000 check outcomes in one call (the engine's cap). The 5,000-case test calls the function directly.
- A run admits at most 4,000 maintenance items and about 6 MiB of projection output (`maintenance-sweep.too_large`, with
  the fix: bring the pair closer, crossing fewer version lines). The limit exists because a bigger sweep dies in the
  sandbox on memory (measured: 25,000 items took about 640 MB against the 256 MB limit). The pack reads the definition
  entries whole for the diff, so slimming the attached case entries is not its lever; `attached_fields` is not used.
- `ignore_fields` holds at most 40 names, each at most 80 characters.
- Warnings kept on a run are the first 100. An empty projection's warnings are kept and carried in the answer's gaps and parse action.
- A named definition entry that is missing from the view is not treated as “no difference”: the path stays a maintenance
  item and the warning names the digest.

## Needs from other packages

- If the impact view carried unplaced counts for each side, the second input would no longer be needed. A truncation-proof facet summary is pending in knowledge.


- **runs engine** (`hub/runs/engine/projection.ts`, W01 R[3]): done — empty item sets are accepted as legal answers, storing an empty validation result and carrying the projection's explanation.
- **product pack** (cases producer): confirm the case entry fields. The real-reader test uses a synthetic producer.
- **knowledge pack**: this pack only parses `impact-view@1`.

## 生成词表与包版本

maintenance-sweep@1.6.1 改用生成词表的类型及包内运行时快照。包内函数的运行时依赖仍只来自包内文件和已允许的依赖。functions/generated/vocabulary.ts 由 tools/gen-contracts.ts 按本包使用的轴生成，带“生成物，勿手改”文件头；它计入 pack.json 摘要。node tools/gen-contracts.ts --check 同时核对这些快照。词表更新导致包内字节变化时，必须升版并重签清单，不复用已发布版本。

终审复核：枚举及子集使用 contracts/generated 的生成类型；运行时快照仍由生成器核对，类型调整后已升版重签。

## Unplaced disclosure decision

The integration owner clarified that positive unplaced counts are hint disclosures with no support or refutation claims and truncated facets refuse startup; this supersedes the task page's earlier unknown outcomes. No vocabulary axis was added. Facet tests cover required binding, zero and positive counts, wrong roots and fields, and truncation refusal. The real knowledge reader test uses a synthetic producer with one unplaced case in the earlier build.

The bound facets are hints (A03 R[6]): zero and positive counts produce no support or refutation claim. Because run summaries omit projection groups, the skill explicitly reads the bound facet source before answering, then shows at most one sample page and its continuation reference; bulk review uses an integrator export. No core rendering change is needed.

## Client acceptance boundary

The scenario requires `caseCommandsUnplaced`: copy `totals.unplaced` from the independent `case-commands.ts` gold for the selected build (later for regression scope, earlier for maintenance sweep). After `start_run`, it reads the **bound** facets source via MCP `get_nodes`, follows every source page and automatically compares its null-row count with that independent count. Missing pages, skipped sources and truncated views fail this mandatory check. The live scenario rejects unplaced and unplacedRun because an export prepared before startup cannot describe the run under test. Numeric correctness is checked automatically; whether the real client follows SKILL, reads the hint and discloses it to the user is accepted by the integrator. No real-client run was performed in this worktree.

Review fix 1: binding a count hint never removes the standing index-coverage missing_input claim. It names the missing command-ownership facts and a bounded review/proposal action; with/without hint metadata yields identical claims.

Review fix 7, superseded by closure review: live scenarios validate caseCommandsUnplaced before startup, read this run's bound facets via MCP, and reject unplaced/unplacedRun. Integrator acceptance separately verifies the actual client disclosure.

Review fix 13: truncated facets retain their notes and request integrator diagnosis of deterministic row/byte/source-exclusion limits. Re-reading the same root is not a repair and the skill does not auto-retry it. The current implementation still reads the existing null commands row only; the future truncation-proof totals.empty interface is not invented or adopted in this branch.

收尾复核：客户端最多展示一页未归位样例，附继续引用；样例数不能与 N 比到相等，批量审阅交集成者导出。分面被截断时把 notes 及根引用交集成者定位原因，同一根不自动重试；修复实际预算或排除问题、取得完整视图后才重新启动。

skipped 非零不会仅因分面线索阻止运行；它必须与影响视图所选同根的计数一致。披露写“至少 N 个用例没有解析出命令（未归位）”，另有 K 份来源未读、其中用例不知道。既有未读来源的未知结论及补取动作保留；计数不一致时重新导出同一根的两份输入。零或正数都不产生支持或反驳主张。
