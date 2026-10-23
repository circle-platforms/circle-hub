# template-gap 1.1.0: document categories and command coverage

This workflow is a production run: both requirements are facts, computed and stored at start_run. It fills no item
slot, generates no cases and calls no model. The documents are the judged subject. Both checks are static,
bookkeeping and advisory: a missing category is a factual gap, not an instruction to change the source in the Hub.
Model elements: W01/W02, C04/C05, K02, T01/T02; decision 35 item 19.

## Inputs and the locked scope

- `documents`: required, many, subject; agile:mindmap or a JSON upload. A document is one item. Around 30 ordinary
  documents fit a batch; large maps or command fan-out require smaller batches.
- Product binding requires `commands@1`. The caller supplies product and build; the pack names no product.
- `case_index`: optional, one, expected, accepts knowledge:index. Read
  `knowledge:index:<product>:<same build>?kind=case&key=document&only=<agile document ids>&fields=document,node,commands,title,path_labels`.
  only must equal the agile documents of this run, no more or fewer; uploads are excluded. An all-upload run need not
  bind an index. Missing case_index is a recoverable evidence gap for agile documents, never an empty index.
- Admission checks index-view@1, case/document, root and product identity, required fields, entry identities/tree
  references, exact only, and completeness facts. Contradictions refuse the whole start_run with
  `template-gap.index_invalid`; its fix names the locked build and exact only. No partial result is accepted then.

The index is frozen in context.groups with its source receipt. Command paths are opaque values already parsed by the
product producer. This workflow does not scan titles, steps or expected results to infer commands. The current upstream
producer extracts commands from titles and ancestors; hub-view-scope may extend that to steps/expected results without
changing this consumer.

## The unchanged 24-category requirement

`coverage` uses the admitted template-v3-coverage.json table and coverage@1. All 24 categories remain required, including
the nine command categories; they do not disappear because an index or command is missing. categoryFacts still recognizes
categories by the existing canonical test-type tags and literal keywords. The case-review template table is untouched;
parity.test.ts retains its declared required-flag difference.

The default case_rule is marked (tags or the team's case marker); tagged remains available for document-level coverage.
An untagged marked candidate is counted as a case, with no invented test-type tag. marked_only discloses such cases;
untagged retains the existing restrictive-tagged-rule disclosure. The separate hub-pack-findings follow-up owns the
broader untagged-count and always-present covered changes; this task does not implement them.

## Command identity and revision matching

`command_coverage` requires marked, the product producer's default case-key rule. tagged produces the definite
`template-gap.case_rule_mismatch` conclusion, with a next action to rerun using the default (omit case_rule or use marked).
Knowledge sync cannot fix a rule mismatch. Uploads always get not_indexed instead of being mistaken for indexed agile data.

Cases connect by (document, case key), plus normalized title and ordered path_labels. The case key is the existing
case-review-compatible identity; no new key/command parser was added. Header normalization is NFKC plus Unicode whitespace
collapse/trim, preserving case. Labels keep their ancestor order. If a stable key has a different title or ancestor label,
it is not a matching current case revision: withhold its old command membership, report it among unmatched cases, and
require knowledge sync and a new read/run. Multiple index entries for one matching key count the case once per command.
Conflicting revisions under one key are also unmatched, not arbitrarily selected.

A shared parent-pointer graph freezes case headers/ancestors once; expected-result leaf text is omitted from that graph.
Every node text is normalized once for matching. A long shared title is not copied into every case's path. The existing
long-label/deep-tree tests still run within their original time bounds and the projection's 8 MiB output cap.
Truncated producer titles/label lists are not accepted by prefix matching: after one sync/re-read still cannot establish
identity, report the field-fidelity/capability gap. Do not silently guess a command or loop forever on sync.

## Command facts, evidence and skips

For each document and each command present in its admitted index, fields.command_coverage contains:

- unique matching case count;
- all nine categories from template-v3.json whose group is command, whether present or absent;
- per-category case count, sorted evidence case ids (at most 20), and their sorted tree: references;
- missing categories and declared skips, plus completeness and unmatched-case facts.

Full category membership comes from categoryFacts before display evidence is capped. It is reused for document and
command reports; command/category universes are not taken from the item's display rows. The command subject builder
reconstructs from frozen index/case facts, so dropping a display command/category cannot make it optional. Facts cite the
locked tree and cases; the original index-view receipt remains in frozen groups. JSON entry enumeration order does not
change the items or pure check conclusions. Real source-byte changes still change their src: provenance; positional or
numbered duplicate case keys retain the existing document-order limitation.

skipped entries are `{category, reason, document?, command?}`. Only the user's explicit declaration is allowed, with a
nonblank reason. No command means the existing document skip and all its commands. A command means only that exact indexed
path and a command-group category; it does not skip document-level coverage or another command. Unknown targets and
conflicting/overlapping declarations refuse start_run as skip_invalid, rather than being dropped. Skips are listed apart
and never manufacture observed cases.

## Conclusions and recovery

- Every command with all nine categories observed or explicitly skipped: support.
- Complete evidence but missing categories: refute `template-gap.command_shortfall`, data.missing names the categories.
- A complete index omits an agile document: refute `template-gap.not_indexed`, naming root/build. Uploads get the same
  code with the action to rerun using the agile document id.
- All cases match but none has a parsed command: refute `template-gap.no_commands`, with the case count and the action
  to put commands into titles/ancestors, sync and rerun.
- No bound index: transitional unknown, data.missing includes case_index, with the binding/rerun action.
- skipped sources, truncation/cut keys, or unmatched case revisions: known command supports survive; potential
  shortfalls become missing-input unknowns. An additional document conclusion discloses unmatched count/ids, skipped
  sources, truncation and the view's unplaced count/notes, because more commands may be unread. It never says full coverage.

The unplaced count is the current index-view notes' whole-root count, not this document's count. Unplaced entries are
included in the index at the root; unplaced is not synonymous with a missing source. The exact view notes are preserved.
A note that cannot be read as a count is disclosed as unavailable, not made zero.

Every package-generated unknown carries missing facts, next_action and recovery: action, document/build (or failed check)
object, event deadline and one-attempt bound. Deadline: before this round's final report; rerun immediately once facts
are supplied. Sync/re-read once, then report a definite source, field-fidelity or index-read capability gap if still
incomplete. The six MCP tools have no sync tool: the client must request the authorized integrator's sync and follow its
receipt before rerunning, or state that capability gap. The Hub does not invoke a model or perform an undeclared action.
SKILL.md specifies the continuation; an unknown is not a successful final verification.

Summaries stay within 480 characters. Calculated complete reports say “按命令：N 个命令，K 个缺类别”. Partial reports label
only read commands/potential gaps; unbound/unsupported modes say not calculated or rule mismatch, without presenting
unknown coverage as zero. The all-missing, five-digit-case-count worst cases remain tested.

## Unversioned documents: handoff to kb-unversioned

A document moved to the product's unversioned scope will never appear in a version-build index. not_indexed therefore
has a conditional action: obtain the unversioned root from its run receipt/knowledge entry point, then use get_nodes on
`tree:<unversioned root>/` to inspect that scope. Until kb-unversioned lands, report that missing capability instead of
repeatedly trying other builds. This package currently accepts only the locked version root as case_index; it does not
pretend an unversioned root is a build root. After kb-unversioned merges, its owner/integrator must update the concrete
root-discovery interface, this next-action text, and the cross-scope binding/index contract if command coverage is to
include those entries. No fictional `knowledge:index:...:unversioned` address is promised here.

## Published samples and transitional examples

There are 13 author samples: coverage has two positives/four negatives, command_coverage two positives/five negatives.
They pass the real publication check and retain author_samples_only. No external evidence or real-bed proof is claimed.

**合约缺口：当前样例合约不收“期望未知”。** samples/positive only permits support; samples/negative requires a refutation.
Pure unknown and support-plus-document-unknown therefore cannot be published as those sample polarities. By integrator
authorization, four paired scenes live in examples/command_*.json, with synthetic mindmap/index inputs, exact check
subjects and independently declared before/after expectations. Both synthetic conformance tests and production runs on
the real registry/engine check them; every unknown must carry missing facts plus action, object and deadline, and the
restored side must resolve to support or refutation.

The integrator's model revision must add **期望过渡未知** samples, including the recovery obligation/expiry and resolved
counterpart; after generation/admission support exists, move these pairs into samples/ and rerun publication. The current
pack does not invent an undeclared polarity or turn an unknown into a false refutation to satisfy admission.

## Verification and ownership

Run `npx tsc --noEmit`, `node --test --test-concurrency=1 "packs/workflow/template-gap/**/*.test.ts"`, and
`node packs/workflow/template-gap/api.ts check`. `node .../testing/examples.ts` rewrites the upload example and paired
scenes then signs; `api.ts sign` refreshes pack.json. Tooling/tests/testing/README are excluded from published files.

Tests cover root/only/schema admission, multi-command/multi-entry deduplication, scoped skips, evidence limits, 9-class
removal/restoration, case/index permutations, monotone known support under new unmatched cases, stable-key title/label
drift, default-rule mismatch, bounded unknown recovery, publication, sandbox limits, and production runs over agile
documents plus an upload with temporary PostgreSQL and synthetic knowledge/read ports. Tests skip explicitly where OS
isolation is unavailable; a skip is not a pass. No real environment, system, deployment or model is used.

## Remaining package decisions

The case rule and identities remain shared with case-review: a tagged group that loses all child cases can itself become
a case; duplicate/id-less keys depend on document order; uploads are named by source SHA and change identity on byte
permutation. Those limits were not redefined here. Advisory keyword matches and user-declared skips do not replace a
judgment of applicability; the existing engine need to mark declared-skip-dependent support remains.

## Open questions

1. **已定（决定 35 第 19 项）**：24 个类别全部必选，另按命令核验 9 个类别；不因命令缺失或投影省略而缩减。
2. A tagged priority-1 node's role and numbered/id-less case identities remain the existing shared case-review policy.
3. Migration of transitional samples and the unversioned read/binding interface are the explicit integrator needs above.
