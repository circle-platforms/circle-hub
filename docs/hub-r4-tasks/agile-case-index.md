# 任务：用例索引的收尾（能力 4 的前提）

产品包的 `cases` 生产器和敏捷平台包的目录树读取，已经写完第一版并经两位独立复核；复核找出的问题还没改。这个任务把它们改完、测完、提交。

- 分支和工作树：`hub-6c`，目录 `circle-hub-6c`（第一版未改前的状态已作为一个提交存在，`git log` 可见）
- 可以改的路径：`packs/product/famx/**`、`packs/system/agile-platform/**`、`tests/fixtures/case-index/**`、`tests/fixtures/README.md`；下面第 1 条决定要求的两处核心小改动：`contracts/src/product.ts`（及其测试）和 `hub/knowledge/lists.ts`（及其测试和 README）。别的路径不动。
- 先读：`AGENTS.md`、`docs/hub-r4-handoff.md`、`docs/hub-r4-architecture.md`（第 6、6a、8 节）、`packs/product/famx/README.md`、本页的“原始规格”和“复核发现”。
- 版本：`agile-platform` 升到 1.2.0，`famx` 升到 1.1.0，用 `node packs/workflow/case-review/packaging.ts sign <包名>` 重新签；已发布的版本不能改内容。**不要发布，不要部署，不要碰 7420 上的持久部署**，发布和重新同步由监督者做。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=2 "packs/product/famx/**/*.test.ts" "packs/system/agile-platform/**/*.test.ts" "hub/knowledge/**/*.test.ts" "contracts/**/*.test.ts"`；跳过的和 todo 的要如实报。

## 对有争议的几条，监督者的决定

1. **列表元素的身份**（复核 1、2 条，高）：产品包的生产器收到的列表元素没有外部标识，第一版靠位置推断，一批不完整就全错。决定：核心给每个列表元素带上它的外部标识（`external`），生产器按它对应文档，删掉按位置推断的做法和相关的“整批才可信”的限制。这是一处通用的小改动（`contracts/src/product.ts` 的列表元素形状、`hub/knowledge/lists.ts` 交给生产器的元素，各带测试），不涉及任何产品名。
2. **没有解析出命令的用例**（复核 3、4 条，高）：简报 6a.4 写的是“命令由代码解析，其余由类型化判断模型归位”。这一版不调用判断模型，但用例不能因此消失：每个用例都产生一个条目；解析出命令的放在命令节点下，没有解析出的按合约里已有的“未归位”写法（`path` 为空）产生，条目数据照样完整（有无期望、含糊期望、反向、缺陷编号、文档、模块等），这样质量看板和追溯矩阵能看到全部用例，回归范围只看放在命令节点下的。如果合约或知识包对没有路径的条目还没有可用的处理，先读 `contracts/src/product.ts` 和 `hub/knowledge` 里怎么写的，用已有的机制；确实没有再提出，不要自造新词。
3. **用例列表失败不拖垮命令树**（复核 5 条，高）：用例文档读不到的份数超过阈值时，整个根的生产失败，命令树也没了。决定：用例列表的跳过份额阈值放到 100%（不因此失败），已读和跳过的份数照旧在视图的 `skipped` 里如实报告。
4. 其余各条（中、低）：逐条对照代码核实，真的就改并补一个改前失败、改后通过的测试；复核说得不对或已经处理的，在 README 里写一句理由。版本线的先后不能按数字大小比（简报第 8 节：真实数据里编号较小的两条线是最新的线，编号更大的一条反而是较老的线之一），用同步计划里已有的发布火车或发布日期排序，或者只比同一族内可靠的部分，并写明。

## 第一版的实现报告（实现者自己写的）

Built the agile-case-index package; every owned test passes and the integration test runs for real (not skipped).

1. Agile system pack, version 1.1.0. New read `agile:tree:roots` (functions/agile.ts rootsPlan, rootsContent, rootsProject; system.json descriptions updated):
- It reads every root in settings.roots (the first 10) with one subtree request per root, plus the listing pages that give the roots' titles. A round never sends more than 4 requests, so at most 4 are in flight (shown against a slow stub with resource concurrency 16). It fits the connectors' 5 rounds.
- The first listing page is the original. The content is {roots:[{id,title}], documents:[{id,title,ancestors,root}], complete, unread?}. Ancestors run from the root title down, the same as the mind-map meta.
- The revision is the SHA-256 of the content, so equal trees give one revision and one stored content.
- A configured root id 'roots' is ignored. The mindmap and search reads are unchanged. No routes were added.

2. Sync plan, famx 1.1.0 (functions/cases-sync.ts, sync.ts additions):
- With option case_index (product.json sets it true) the plan fetches agile:tree:roots in round 1. It takes the documents under roots titled FAMX or FAMY and locates each one with locate.ts.
- Every build with its own command tree gets case_documents: the agile:mindmap ids of documents whose line is between min_line (default: a real line) and the build's line, sorted by id so new documents come last. It also gets case_tree = agile:tree:roots. Aliases list nothing.
- The note counts documents that are not listed, by reason: no version line, earlier than min_line, id the agile pack cannot read, filed twice, other roots.
- If the tree is missing, unreadable or incomplete, the plan lists no build at all. Producing then would replace roots with ones that silently lost their cases.

3. Producer `cases` (functions/cases.ts, cases-nodes.ts, cases-commands.ts, cases-rules.ts):
- Case nodes follow the case-review rule, tagged OR marked, each case once. A test checks they match case-review's own projection on every fixture and corpus map.
- Command phrases come from the case title and the labels above it via commands.ts. They are resolved against the build's catalog, built with produceCommandEntries. Resolution handles abbreviations (unique prefixes, never alone), `no` forms, and list numbers glued to a command.
- One entry per (case, resolved command), with the statement and data fields you specified. The fragment is the parser's selector for the case node, tagged with the element's digest; applicability is null.
- Cases with no phrase, or none that resolves, give no entry. Each batch ends with one warning line counting them by reason, with at most 20 examples.
- Scale: one sandboxed batch of 40 documents × 60 cases against a 4,000-command tree took about 0.2 s.

4. product.json: adds the `cases` producer. No catalog is declared over case entries; the other producers and catalogs are unchanged.

5. Fixtures in tests/fixtures/case-index:
- table.ts: 82 hand-written rows (47 must resolve, 35 must not), written before the resolver existed.
- catalog.ts: two invented command trees whose difference is known.
- corpus.ts: an agile listing of 23 roots, three of them configured, and 300 mind maps (4,411 cases). The truth of every document and case is recorded while the corpus is built, never computed by the code under test.
- Stub helpers for the tree read.

6. Tests: unit tests for every function, parity with the case-review projection, and metamorphic checks (another document id changes only its key; reordering cases changes nothing; a document twice doubles nothing; an entry depends only on its own document). Also hostile input, scale, the sandbox, and cases-integration.test.ts: real registry, connectors and knowledge. Its facet view (line, module), index view (document) and impact view between the two builds all equal the corpus truth.

Existing files I modified in my paths: packs/product/famx/{README.md, api.ts (new exports and a FUNCTIONS entry), functions/sync.ts, pack.json, product.json}; packs/system/agile-platform/{README.md, functions/agile.ts, pack.json, system.json}; tests/fixtures/README.md (one row added).

偏离简报的地方：
- The cases producer has a third input, folders (role case_tree -> agile:tree:roots), and params.batch: 40. Reason: product@1 hands list elements as {sha256, media_type, parser, model}, with no external id or meta, so the producer cannot tell which agile document an element is, nor its folders. Interim rule: it uses an element's own `external` when present (forward-compatible); otherwise it maps elements onto build.sources.case_documents by position, but only when the call holds its whole batch. Otherwise the document is null with a warning. This positional mapping relies on hub/knowledge cutting fixed-size consecutive batches; content-defined boundaries could mislabel documents (README Limits).
- The vague phrases: the case-review tables hold none, so VAGUE_EXPECTED (author-written) lives in packs/product/famx/functions/cases-rules.ts and is matched whole after folding. Blank expected texts are ignored; vague_expected is false when has_expected is false.
- agile:tree:roots: every response is stored, but the read's single `original` artifact is the first listing page, because the contract allows only one. The content also carries `complete` and `unread`.
- 'At most 4 requests in flight' is enforced as at most 4 requests per planner round. system@1 has no concurrency field; the resource's own limits are deployment data. Verified through the real connectors against a slow stub.
- Sync option case_index is off when the options do not set it; product.json sets it true. This keeps milestone-1 direct calls unchanged and gives deployments without the agile platform a way to switch the index off. While the agile tree is missing, unreadable or incomplete, the plan lists no build at all.
- Product roots are chosen by title: FAMX or FAMY, NFKC, case-insensitive, alone or before a non-word mark. Other configured roots are counted and ignored.
- stories/defects also take ids from the document's agile title and folder labels (for example a 'bug to case <id>' folder), not only from the case title and the labels above it.
- data.node is data.id when the parser addresses the node by it, else the position selector. The case-review item ids use #k or @n for duplicated or missing ids instead.
- Pack versions bumped to 1.1.0 (agile-platform, famx) because their content changed; pack.json re-signed; new exports and a FUNCTIONS entry added to packs/product/famx/api.ts.

需要别的包配合的地方：
- contracts + knowledge: add `external` (and the parsed `meta` artifact, as BoundInput has) to product@1 ProducerSlot for list elements, filled in hub/knowledge call.ts slotOf. Failing scenario today: a batch of 40 where one agile leaf answers get_case_data 1004 is handed to the producer as 39 elements; the producer cannot identify any of them, and their cases get document, line, train and module null. Until then hub/knowledge must keep fixed-size consecutive batches in list order.
- case-review: own a table of vague expected phrases; a test can then compare it with VAGUE_EXPECTED.
- knowledge: the cases producer's one-line-per-batch disclosure lands in composition warnings, of which only the first 200 are kept. A per-producer count summary in the production result would keep the totals for very large lists.
- integrator: per the instructions I did not run other owners' tests. Please run packs/workflow/case-review-verify/end-to-end.test.ts and packs/workflow/case-review/packs.test.ts. My static reading says the bed's famx builds get an empty case list (its agile roots are ORBIT/COMET, not product roots) and its assertions hold; packs.test.ts checks manifests and publish checks, which my integration test's registry publish already exercises.
- integrator: the first sync with famx 1.1.0 re-produces every own-tree build, and the deployment needs the agile resource with the product's two roots in settings.roots, or case_index set false; otherwise the sync lists no build.
- contracts/connectors (unchanged from before): a settings schema in system@1 so roots beyond 10 are refused when the resource is configured.

没定的问题：
- Owner: is the author-written vague phrase list right (正常, 成功, 符合预期, 显示正确, 设备正常, 操作成功, 生效, ok, pass, ...)? It is matched whole, not as a substring.
- Owner: commands are extracted from the case title and the labels above it only, as asked. About a third of the synthetic cases (roughly half of real ones) name none. Should steps also be scanned, accepting the noise the brief measured?
- Owner: while the agile tree cannot be read, the sync lists no build, so new build-site builds wait too. Is that preferable to producing roots without cases, which the views would read as absence?
- Owner: abbreviation rule (unique prefix of at least 2 letters, at least two command words when abbreviated, first-word abbreviations excluding English short words). Please confirm it matches the real CLI before the real-data check.
- Should unmarked ids in titles (31057-..., counted unclassified by ids.ts) also feed traceability? Today they are neither stories nor defects.
- If the agile resource ever serves several products, roots are filtered by title; confirm the real root titles are exactly the product names.

## 复核发现

两位复核者各自独立读了代码、写了探针；下面照原样列出，严重程度、位置、场景和建议都在。

### 复核一：保真与正确性

1. **high** `packs/product/famx/product.json`:44
   - 问题：The case list is now an input of the same production as the command tree. When a build's case list fails, the whole root fails with it. The trigger is more than maxSkippedShare (50%) of the listed documents being unusable. A failed root has no command catalog, so a milestone-1 review of a new build has no root to lock. This coupling is new in famx 1.1.0 and is not disclosed. The plan-level rule is the same kind of gate: it lists no build at all while agile:tree:roots is unreadable or incomplete, or while a deployment has no agile resource configured with both product roots. That rule is disclosed only as an open question.
   - 场景：Probe p5: a step '前置：user add tester password Synth3tic9x' is added to 180 of the 300 corpus documents. This is the credential scan's own documented example (a CLI command line); such lines are normal in CLI test steps. Those agile:mindmap reads fail. knowledge.syncProduct then reports both builds failed: '列表 cases.documents 列出的 230 份源文件有 138 份没有用上（读不到 138 份），超过 50%，这次不产出根'. currentRoot('famx','10.6.1') and the current root of the real line are null. With options {case_index:false} and the same documents, both roots are produced (p5b).
   - 建议：Do not let the case index gate the build root. Until hub/knowledge can isolate a failing optional list producer (drop its entries and record the gap in the composition and in the views' skipped field), ship product.json with case_index false, or produce the case entries separately. Write the request to knowledge in the README Needs section. State the coupling in the README until it is gone.

2. **high** `packs/product/famx/functions/cases.ts`:92
   - 问题：Positional identity only works when a call holds its whole batch. Whenever the Hub hands fewer elements (one document unreadable, refused by the credential scan or unparsable, a split, the byte cap), every other document of the batch gets document, line, train and module null. In that state the dedup key at line 185 (`${document ?? ''}\u0000${sha256}`) also merges distinct agile documents that have equal bytes. The README discloses the mechanism. It does not disclose how widely it spreads, that it is permanent while a listed document stays unreadable, or the merge.
   - 场景：Probe p7, the real sync: one listed document of an older real line answers 1004. In the 10.6.1 build, the index view keyed by document lists 184 documents instead of 222, 356 entries have line null, and the facet count for that line falls from 450 to 90. The views report skipped: 1, which hides that 38 more documents lost their attribution. With a per-document skip rate p, a batch of 40 is cut with probability 1-(1-p)^40: 55% at p=2%, 98.5% at p=10%. Probe p1: when 39 cut elements include template copies with identical bytes, 37 of them are discarded with the misleading warning '在这次调用里出现了不止一次'.
   - 建议：Give each element its identity inside its own content. Two options within the owned paths. (a) A lean agile read, for example agile:case:<id>: the case-data route only, no nested reads, and a content that wraps the KityMinder document with a wrapper member such as agile: {id}. kityminder@1 keeps such members in model.meta. The sync lists those ids, and the producer takes the id from model.meta and checks it against the batch. (b) Keep positional mapping only as a fallback. When the document is unknown, deduplicate by element position, never by digest alone. This also removes the dependence on fixed-size batches.

3. **high** `packs/product/famx/functions/cases.ts`:259
   - 问题：A case whose title and labels give no resolvable command produces no entry at all. Brief section 6a.4 asks for the opposite: 'commands resolved by code; the rest placed by the typed-judgment model'. produce.ts already hands path:null entries to the placer. The README lists this as a Limit, not as a deviation. Capability 6 (traceability, cases without expected results, vague results, negative share by version and module) is computed from these entries, so it covers only part of the cases, and the views cannot tell: skipped is 0 and there is no note. The only disclosure is one warning line per batch. The composition keeps the first 200 warnings, each cut at 1,000 characters, so for large builds the totals are lost.
   - 场景：Probe p11: a regression document 'bug to case 61001 WebUI 健康检查页面' has three WebUI cases (one negative, one whose expected result is '正常'). The producer returns 0 entries. An index view keyed by defects therefore has no 61001, and facets by module, has_expected, vague_expected and negative leave these cases out. This breaks the 6b acceptance rule that the traceability matrix equals an independent join of defects and case-document ids. Probe p9: in the synthetic 10.6.1 build, 1,281 of 3,360 listed cases (38%) are not in the index; the README estimates about half of real cases.
   - 建议：Emit these cases as entries with path null and data.commands [] so the typed-judgment model places them; without a model they stay unplaced but citable (K04 R[3]). Ask hub/knowledge either to count unplaced case entries in the facet and index views, or to record per-producer totals that the views report. List the change as a deviation from the brief until then.

4. **medium** `packs/product/famx/functions/cases.ts`:301
   - 问题：The statement leaves out the facts in data. The product@1 contract says ProducedEntry.statement 'carries everything data says (K02 R[4])'. The command-tree producer follows it; the case producer does not. K02 R[4] says the entry digest covers only the normalized statement. Today two variants of a case stay apart only because hub/knowledge also digests data.
   - 场景：Probe p4: the statement is '950001:c1 | widget health interval pool1 61'. Its data says negative true, tags [Negative], defects [61001], line 10.6.1, train 10.6.1-R1-2026/9, module 健康检查, expected_count 1, commands [/commands/widget/health/interval]. The command-tree entry's statement renders its signatures and help text. Under K02 R[4], the real-line and 10.6.1 variants of one case (different commands or line) would get one digest with two contents.
   - 建议：Render a deterministic multi-line statement from every data field (document:node, title, labels, priority, tags, negative, expected and step counts, vague flag, commands, stories, defects, line, train, module, autoid), as the command-tree producer does.

5. **medium** `packs/system/agile-platform/functions/agile.ts`:352
   - 问题：The case index reads every listed document through agile:mindmap. That read's plan asks for nested reads of every configured root's whole subtree in round 1. The case producer never uses the resulting meta: titles and folders come from agile:tree:roots. The connectors' nested cache does not merge concurrent misses, so each concurrent cold read downloads every root's subtree again, plus the listing pages that tree read needs to find the title. A document missing from a cached tree also refreshes all trees. The roots read itself is bounded at 4 requests a round, but this path multiplies load on the shared platform.
   - 场景：Probe p2, the integration setup: one sync with 230 listed documents and 3 configured roots sent 15 whole-subtree requests (3 for agile:tree:roots, then 12: four concurrent cold document reads × 3 roots) and 39 listing-page requests where 3 suffice. With the default limits (2 productions × 4 list reads), up to 8 cold reads each fetch every root's whole subtree (route cap 64 MB, 120 s). This happens at every sync start and again after each one-hour cache expiry.
   - 建议：Read case documents through a lean read with no nested reads, for example the agile:case read proposed for the identity finding. Alternatively, ask hub/connectors to merge concurrent nested reads of the same object into one.

6. **low** `packs/product/famx/functions/cases-commands.ts`:151
   - 问题：Texts reach extractCommands without NFKC normalization and without mapping Unicode white space or zero-width characters to plain spaces. Tokens stop at NBSP and U+3000, so commands that browser editors store this way are missed, or resolved to a shorter command. An argument value can also be taken for an abbreviated command word.
   - 场景：Probe p3: 'show health detail pool1' resolves to /commands/show/health instead of show health detail, a wrong attribution. 'show  health detail pool1' (two spaces as a browser stores them), 'widget pool add pool1', 'show　pools', 'ｓｈｏｗ ｐｏｏｌｓ' and 'show​ health detail pool1' resolve nothing and are counted as having no command phrase. 'show health\ndetail pool1' resolves to show health. 'show health de 查看名为 de 的池' resolves to show health detail.
   - 建议：For each text, apply NFKC and replace Unicode White_Space (isWhiteSpace in cases-rules.ts) and zero-width characters with a plain space before withoutListNumbers. Add these rows to tests/fixtures/case-index/table.ts.

7. **low** `packs/product/famx/functions/cases.ts`:258
   - 问题：data.node follows the parser's selector rule: the id must be unique among all nodes. case-review gives a case its <doc>:<id> identity when the id is unique among cases only. So a case whose id also appears on a non-case node has two different identities. The README deviation mentions only duplicated and missing ids.
   - 场景：Probe p6: an expected-result leaf copied from its case keeps the case's id k7. case-review names the case '950001:k7'; the case index files it as '950001:i/0/0'. A lookup by the review item id does not find it.
   - 建议：Key data.node by case-review's rule (an id unique among the document's case nodes), keeping the selector for the fragment. Otherwise, document this case in the deviation.

8. **low** `packs/product/famx/functions/cases-sync.ts`:160
   - 问题：The plan note counts documents with a located line as listed even when no listed build covers that line. Its 'repeated' count is always 0, because agile:tree:roots has already removed duplicates and the plan never sees that read's note. No document is named for any reason, so an administrator cannot find the unlisted ones.
   - 场景：Probe p8, builds of a real line and of 10.6.1: 35 documents (lines 10.6.2 and 10.7) are in no build's list. The note reads '按版本线（<最早的线> 起）列出 265 份，构建里共列出 360 份次，没有列出：上级目录里没有版本线 5 份、早于 <最早的线> 的 20 份、编号读不了 1 份' and does not mention them.
   - 建议：Count 'no listed build of its line or a later one' as its own reason. Carry the duplicate count in the agile:tree:roots content so the plan can report it. Give a few example document ids per reason.

9. **low** `packs/product/famx/functions/cases-sync.ts`:6
   - 问题：The code and README justify sorting by id, new documents last, as keeping the Hub's batches where they were. That gives no reuse: hub/knowledge memo keys include the whole build, list included, so any list change re-runs every batch of every affected build. In addition, MAX_CASE_DOCUMENTS cuts the newest documents first, which are the build's own line.
   - 场景：Probe p10: after one document with the largest id is added to line 10.6.1, the second sync re-produces the 10.6.1 build with calls made 9, reused 0. Before the change the existing 230 ids kept their positions.
   - 建议：Correct the rationale in the code and README. If reuse matters, ask knowledge to key list calls without the list; once elements carry their own identity, the producer no longer needs the list. When over the cap, cut the oldest lines first.

10. **low** `tests/fixtures/case-index/corpus.ts`:384
   - 问题：The shared fixture uses the real product's version lines (three of them), the real train label example from brief section 8 verbatim, and MIN_LINE set to a real line, documented as 'the product pack's default' (line 12). tests/fixtures/README says 'every name, number and text is invented' and that product-specific fixtures belong in packs/product/*/testing/. The shared agile fixture uses invented lines (7.1, 7.2).
   - 场景：Any reader of tests/fixtures/case-index sees the real line numbers of the FAMX/FAMY product and its default min line in a directory meant to be product-neutral.
   - 建议：Use invented lines in the shared corpus and pass min_line as a parameter, or move the corpus under packs/product/famx/testing/.

11. **low** `packs/system/agile-platform/functions/agile.ts`:265
   - 问题：The roots read reads at most ROOTS_PAGES (10) listing pages, although the five-round budget allows about 17 with two roots, and the single-root tree read goes up to 50 pages. A configured root listed after position 100 is never titled. The content is then always incomplete, and with case_index on the sync never lists any build.
   - 场景：The listing has total 150 and a product root sits at position 120. rootsContent leaves that root untitled, so complete is false. caseTree returns failed and planBuilds lists 0 builds on every sync until the configuration changes.
   - 建议：Read listing pages up to the round budget, or up to MAX_PAGES over the rounds. Alternatively, accept a configured root without a listed title, since the administrator configured it, and say so in a note.

12. **low** `packs/product/famx/functions/cases-sync.ts`:144
   - 问题：Documents are included when their line is numerically between min_line and the build's line. Brief section 8 says the two lowest-numbered real lines are the newest and a higher-numbered one is among the older ones, so numeric order is neither recency nor lineage. Neither the model nor the brief states this inclusion rule.
   - 场景：A build of the numerically larger but older real line lists every document of the newer line. A build of the newer line lists no document of the older one. Regression scope and maintenance sweeps between such builds attach case sets according to numbering, not lineage.
   - 建议：Ask the owner. Alternatives: a lineage table of version lines in the product pack, or listing only the build's own line plus declared ancestor lines.

### 复核二：稳健、安全、测试质量

1. **high** `packs/product/famx/functions/cases.ts`:93
   - 问题：Which document an element is gets inferred by position, and only when the call holds its whole batch. Whenever the Hub hands fewer elements, every other document in that batch loses its identity. This happens when an element is unreadable or unparsable, is over the byte cap, or is split off to isolate a failure. Those documents' cases still become entries, with document, line, train, module and the folder-derived ids all null. The views count them as data under null instead of as unknown.
   - 场景：I copied cases-integration into a scratch test and made the stub answer get_case_data 1004 for listed document 950031 (6th in batch 1 of the 10.6.1 build). The sync reports Rel_FAMX_10_6_1_12 produced with skipped 1. In knowledge:facets:famx:Rel_FAMX_10_6_1_12?kind=case&by=line,module, 360 cases of the other 39 documents sit in a {line:null, module:null} row, and two rows of the earliest line disappear. knowledge:index ...&key=document lists 184 of the 222 documents that have indexed cases. facets.skipped is 1, and the only note says one listed source went unused; nothing mentions the 38 documents that lost identity. No test exercises this path: the corpus's only unservable leaf ('bad id') is filtered out by AGILE_ID before listing, and the integration test asserts skipped === 0.
   - 建议：Do not run the index on real data until two things land: contracts adds `external` (and the parsed `meta`) to product@1 ProducerSlot for list elements, and hub/knowledge call.ts slotOf fills it from ParsedSource.external (already requested in Needs). Then remove the positional mapping, params.batch and the dependence on build.sources.case_documents. Also add an end-to-end case with one listed document that the platform cannot serve.

2. **high** `packs/product/famx/functions/cases.ts`:259
   - 问题：A case whose title and labels give no resolving command produces no entry at all. Brief 6a.4 says these cases are placed by the typed-judgment model, i.e. emitted with product@1 path null. This is not listed among the deviations. The only disclosure is a warning line per batch in the composition, and the composition keeps only 200 warnings. Every view of kind case therefore silently covers only the cases that name a command: skipped 0 and no note.
   - 场景：Corpus 10.6.1 build: 1,281 of the 3,360 cases in the 230 listed documents (38%) never reach a view. The README estimates about half of real cases. The facet total is 2,079 with skipped 0. A capability-6 page built on facet-view@1 would report 22.1% of cases without expected results and 26.4% negative; over all the documents' cases the figures are 22.8% and 25.0%. Such a page cannot learn the true denominator. The producer writes 2 warning lines per batch, so the 200 kept warnings cover only about 4,000 documents; after that even the composition-level disclosure is lost.
   - 建议：Emit these cases as entries with path null (same statement and data, commands []). The Hub's placer then places them under its calibrated threshold, or keeps them unplaced, citable and counted in counts.unplaced. Ask knowledge to report unplaced and refused entries of the requested kind in facet and index views, and to keep a per-producer count instead of relying on capped warnings. Otherwise, declare the drop as a deviation for the owner to accept.

3. **medium** `packs/product/famx/functions/sync.ts`:164
   - 问题：Any agile-side failure withholds every build of the product, and nothing reaches the sync's error fields. report.error is null and counts are 0/0/0; only the free-text plan note explains it. Several triggers never clear on their own: a wrong or rotated agile password (logins are not retried until an admin acts), a deleted configured root (subtree answers 1004), more than 10 configured roots, product roots listed after page 10 of the root listing (ROOTS_PAGES, agile.ts:240), and a failed listing page. With the knowledge package's skip threshold, a flaky platform during production also fails the whole build, command tree included.
   - 场景：cases-integration 'while the agile platform cannot be read': after setPassword + expireTokens, syncProduct returns builds [] and error null. A build released on the build site in the meantime gets no root, so runs keep locking the old root, while monitoring on report.error or counts.failed sees a healthy sync. The note's suggested remedy (case_index false) re-produces every root without its cases.
   - 建议：Report the withheld state as a failure. Either contracts adds an error/blocked field to sync-plan-output@1 that the knowledge sync copies into report.error, or the sync lists one failed entry per withheld build. Builds of lines before min_line can be listed regardless, since their case list is empty whatever the tree says. Whether a new build may be produced without cases remains the owner's open question.

4. **medium** `packs/system/agile-platform/functions/agile.ts`:212
   - 问题：An empty folder (a leaf with no children and no cases) is taken for a document. This is line 198 (`children.length === 0`) in the reported version; the current working tree has the same behaviour. caseTree then locates it by its ancestors and lists agile:mindmap:<folder id> for every build of its line and later lines, although get_case_data cannot serve a folder.
   - 场景：Probe on the current tree: I added an empty release-train folder for a new train of a real line (id 8999) and an empty module folder SSL (id 8998) under that line's folder. Both appear in the agile:tree:roots documents and land at positions 0 and 1 of a 10.6.1 build's case_documents. In production both reads fail and are skipped with retry on every sync, so every case view of every such build reports skipped > 0 ('unknown, not absent') permanently. Through the positional-identity finding above, the other 38 documents of batch 1 also lose their identity. In a living tree, trains and modules are created before their documents.
   - 建议：Since agile.test.ts now asserts that real cases lists are cumulative, mark leaves that no folder above them lists, for example with listed: false in the roots content. Have caseTree count those as empty folders in the note and never list them. Add an empty train folder and an empty module folder to tests/fixtures/case-index.

5. **medium** `tests/fixtures/case-index/corpus.ts`:440
   - 问题：The case-index corpus no longer mirrors the real platform. After the report, agile.ts and agile.test.ts were changed (11:44) to encode the real shapes: cases lists are cumulative with the root node listing every document, and the listing's total is a sibling of data. The corpus still lists only direct documents (`parent?.cases.push(leaf.id)`), and listingAnswer (index.ts:44) still puts total inside data. So the 300-document tests (roots.test.ts, cases-sync, cases, cases-integration) never exercise the real shapes. The reported agile.ts failed on both shapes. packs/system/agile-platform/README.md still says a document filed twice is listed 'at its first place'.
   - 场景：With cumulative lists, the reported documentsOf assigns each document to the topmost folder that lists it, giving ancestors [title, 030：…测试项目] with no line, so caseTree lists 0 documents. With a top-level total, the reported rootsPlan computes total = 10 from page 1 and never asks for page 2, where the corpus's configured roots are listed; the roots stay untitled, the tree is incomplete and no build is listed. The current corpus-based tests catch neither.
   - 建议：Generate the corpus trees with cumulative cases lists, including the root node, and the listing as {code, msg, data: [roots], total}. Re-run the roots, cases-sync, cases and integration tests on them. Update the agile README and tests/fixtures/README.md to the new rules.

6. **low** `packs/product/famx/functions/cases-commands.ts`:74
   - 问题：The hostile table misses three precision/recall gaps. (1) A two-letter upper-case acronym that is a unique prefix of a first word is accepted as an abbreviation. (2) Texts are not NFKC-normalised, so full-width spaces and letters from Chinese input methods yield no phrase, and the case is counted under the wrong reason ('no phrase'). (3) A second command separated from the first only by a space is swallowed as arguments of the first.
   - 场景：probe-resolver.ts, invented catalogs: 'AD user 登录认证' resolves to /commands/admin/user with a catalog containing admin user (AD meaning a directory service). '执行　show　health　pool1' (U+3000) and 'ｓｈｏｗ ｈｅａｌｔｈ' give 0 phrases. 'widget pool add pool1 50 show pools' gives only /commands/widget/pool/add.
   - 建议：In textCommands (line 151), apply NFKC to each text before withoutListNumbers; offsets only map phrases to texts within the normalised joined string, so this is safe. Accept a first-word abbreviation only when written in lower case, or with at least 3 letters. After resolving a phrase, rescan its leftover words for another head. Add these rows to table.ts.

7. **low** `packs/product/famx/functions/cases-sync.ts`:6
   - 问题：The comment and README say new documents come last 'so the Hub's consecutive batches of an earlier list stay as they were'. Reuse does not work that way: hub/knowledge/lists.ts memoKeyOf keys each call by the digest of the whole handed build, which includes sources.case_documents, and by the folders slot digest. Any change to a list re-runs every batch of that build.
   - 场景：One new document of the earliest listed line changes the list of every build of that line or later. The sync reports '来源列表变了' for each and recomputes all of their batches; no memo is reused. With --recheck, a folder renamed in any configured root, even another product's, changes agile:tree:roots and re-runs every batch of every build.
   - 建议：Correct the comment and README. Once list elements carry `external`, ask knowledge to key list-call memos without the list roles, since the producer would no longer need build.sources. Consider giving each document its own meta instead of the whole tree as the folders slot.

8. **low** `packs/product/famx/functions/cases-sync.ts`:167
   - 问题：Documents located on a line later than every listed build are in no build's list, yet the note counts them under '列出 N 份'. They are invisible in every view, and no reason category names them.
   - 场景：Integration fixture (builds of a real line and of 10.6.1): 265 located documents are reported as 列出, but the 35 documents of 10.6.2 and 10.7 are listed by no build and nothing in the note says so.
   - 建议：Count located documents whose line is later than every own-tree build the plan lists, per line, and report them as not listed for that reason.

9. **low** `packs/product/famx/functions/cases.ts`:258
   - 问题：data.node is the raw id when the parser addresses the node by id, and the position selector otherwise. A raw id that looks like a position selector therefore collides with another case in the same document.
   - 场景：probe-keys.ts: a document with a case whose data.id is 'i/1' (selector n/i%2F1) and an id-less case at position i/1 gives two entries keyed 5:i/1 ('5:i/1 | widget pool add p1' and '5:i/1 | widget pool delete p1'). The index by node merges two cases under one key.
   - 建议：Use the parser's canonical selector (n/<segment> or i/…) as `node`, or mark positional keys distinctly the way case-review does ('@').

10. **low** `packs/product/famx/functions/cases.test.ts`:230
   - 问题：Two assertions prove nothing. The metamorphic test 'another title in the agile tree without ids changes nothing' asserts only when its sample document has no ids, and the sample it picks has them. cases-sync.test.ts:133 asserts `indexOf(CASE_TREE_ID) < asked.length`, which is always true even at -1, so 'read in the first round' is not checked there.
   - 场景：probe-vacuous.ts: sample[0] is 950026 ('bug to case 61001 …'), whose cases carry defect 61001, so the `if` is false and the test passes without asserting anything.
   - 建议：Choose a sample document without ids, or assert the expected change in the ids when the title had some. Replace the tautology with a check that CASE_TREE_ID is in the round-1 fetch list.

## 复核者没有发现问题的地方（供参考）

- Case node rule: cases-nodes.ts matches the case-review projection under caseRule marked (tagged or marked cases, tagged groups, nested cases, precondition leaves, steps and expected counts). The only divergence is the identity key reported above.
- agile:tree:roots planning: at most 4 requests per round and at most 5 rounds, the first 10 roots only, only the allow-listed read routes roots and subtree (POST), no new route and no write route, failed requests never retried. The content, revision, complete and unread logic behaves as documented.
- No hosts, no addresses outside 192.0.2.0/24 and 2001:db8::/32, no credentials and no absolute paths in the new or changed files; the stub account is invented.
- Product names appear only in the product pack: isProductRoot uses PRODUCT_LINE.names, and the agile pack and the shared corpus take the names as a parameter.
- No hand-written vocabulary axis: the entry kind case comes from the generated EntryKind.
- Command resolution on the 82-row truth table and the documented rules (abbreviations, no forms, list numbers, prose and quotes) behaves as stated; none of the 35 must-not rows resolves a command.
- The sync lists no build while the tree is pending, failed, malformed or incomplete, as documented, and the note says why.
- Both pack manifests are current. No type errors in the reviewed files. The other owners' tests that consume these packs (case-review-verify end-to-end, case-review packs, the server's real test hub) pass.
- Read-only by construction: the agile pack still declares only its three POST read routes on literal paths, all marked read: true, with no write route and no new nested reads. The roots read sends at most 4 requests per round and 20 per read (the slow-stub test passes).
- Hosts, credentials, absolute paths and real content: none in the reviewed files; only 192.0.2.0/24 addresses, invented names and synthetic stub accounts.
- Product names outside the product pack: none in packs/system/agile-platform or tests/fixtures/case-index; the corpus takes the names as a parameter.
- Hand-written enumerations of model vocabulary axes: none. The entry kind uses the generated EntryKind type; tag categories, vague phrases and stop words are pack data, not axes.
- Which nodes are cases: by my reading, cases-nodes.ts matches the case-review projection under caseRule marked (tagged groups, marked cases, nested cases, preconditions, steps, each case once), and the parity tests on the corpus and fixture maps pass.
- Totality on hostile input: caseNodes, textCommands, the cases producer, rootsPlan/rootsProject and the sync plan; I found no throw path.
- The positional mapping never mislabels under the current hub/knowledge batching (it only degrades to unknown): checked by reading produceList, listBatches, callBatch and withinCap.
- Size claims: the tree content averages 178 bytes per document, so the 50,000-document cap fits the 16 MiB json@1 limit. Pack manifests are current, and the typecheck is clean for the reviewed files.

## 原始规格

PACKAGE agile-case-index - the agile tree read and the case index of the product pack.
Read first: packs/product/famx/README.md and functions (locate.ts, commands.ts, ids.ts, naming.ts, sync-plan.ts, api.ts and the adapters written for product@1), packs/workflow/case-review/functions (project.ts, tags.ts) and tables (the vague expected phrases, the case rules), packs/system/agile-platform (system.json and functions), contracts/src/product.ts, resources.ts and views.ts, the brief docs/hub-r4-architecture.md sections 6, 6a and 8, and the model elements K01 K02 (node tools/show-element.ts).
DELIVER:
1. agile system pack: a read agile:tree:roots: every root of the resource settings.roots, one request per root; the original is the responses as received, the derived content is JSON {roots:[{id,title}], documents:[{id,title,ancestors,root}]} with ancestors the labels of the folders above the document from the root down; cached per revision; at most 4 requests in flight and the delays and limits the system profile format offers. Document reads stay agile:mindmap:<id> (original, content, meta). Read-only by construction (route list only).
2. product famx, sync: the plan function reads agile:tree:roots (a start page or a fetch of the plan, as the sync declaration allows), locates every document with locate.ts, and lists in each build's sources.case_documents the ids agile:mindmap:<id> of the documents whose version line is not later than the build's line and not earlier than the option min_line (default: a real line), from the roots of BOTH name families; documents with no located line are not listed and are counted in the plan note by reason; an alias build without a tree of its own lists nothing.
3. product famx, producer cases (entry kind case): inputs documents {source: case_documents, many: true, batch: 40, optional: true} and tree {source: tree}. For each document and each case node (tagged rule OR marked rule from the case-review tables; a case once) extract the command phrases of the case title and of its path (commands.ts) and resolve each against the command catalog of the build (built from the tree slot with the existing command-tree functions). ONE entry per (case, resolved command): kind case, path = the command node path, statement = '<document>:<node> | <title>', data {document, node, title, path_labels, priority, tags, negative, expected_count, has_expected (some leaf expected text exists), vague_expected (every expected text is one of the vague phrases of the case-review tables), steps_count, commands (all resolved command paths of the case), stories, defects (ids from the title and ancestors with ids.ts), line, train, module (locate.ts), autoid}; fragments = the case node selector into the document (the selector form the case-review pack already uses); applicability null. A case with no command phrase, or none that resolves, produces no entry; the warnings carry counts by reason and at most 20 examples, so that the incompleteness (about half of the real cases name no extractable command) is disclosed; the product pack declares NO catalog over case entries. Pure TypeScript, deterministic, safe on hostile input, fast enough for 3,000 documents x 60 cases in batches of 40 within the scale targets of the knowledge package.
4. product.json: the producer cases with its inputs; other producers and catalogs unchanged (the commands catalog is the definition entries of the command-tree producer).
5. Fixtures and tests: a synthetic agile tree and 300 synthetic documents with known case and command truth (invented commands, 192.0.2.0/24 for addresses), stub responses for the tree read; unit tests of every function; a table of at least 40 titles and paths with the commands that must resolve (shorthand, abbreviations, negative cases with no, quoted arguments, a command inside a longer sentence) and those that must not (words that merely look like commands), written BEFORE the code runs; metamorphic checks (renaming a document changes no entry but its key; reordering cases changes nothing; the same document twice does not double anything). If the knowledge package does not yet support list slots when you test (another agent is adding them), test the functions directly and write the integration test as a skipped test with the reason in your README, never as a pass.
