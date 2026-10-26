# Repair acceptance scenarios after structural rule migrations

Owner authorization: repair all 49 failing acceptance tests at 918efe93, branch fix-acceptance. FAMX belongs to pi and is excluded. Allowed paths: tests/acceptance/**, tests/fixtures/**, this task page, scripts/real/benchmark/inject.{ts,test.ts}; demonstrated regressions require hub/knowledge/{sync.ts,sync-unreleased-alias.test.ts,README.md}, hub/server/{text.ts,tools.ts,feeding-text.test.ts,README.md}, packs/workflow/case-review/{functions/expected-quality.ts,functions/expected-quality.test.ts,README.md,api.ts,pack.json}, contracts/{README.md,src/submission.ts}, regenerated submission/tool schemas, and hub/runs/engine identity submission, lineage, reuse and replay code/tests and README, with any published pack change versioned and signed together.

Baseline: 109 acceptance tests, 60 pass, 49 fail, no skipped tests (owner fullcheck TAP).

## Root causes and migration rationale

- R3 introduced the optional expected_quality judgment slot. Scripted review submissions must explicitly send an empty list when no judgment is supplied. This preserves undeclared/pending judgment rather than inventing a judgment from prose. Requirement inventories include the new item requirement.
- R2 treats resource values as exact declarations. Configuration is not configuration; variants remain advisory structural violations. Negative membership uses the exact declared negative literal only.
- R6 no longer infers PLM identities from prose titles. Source-binding scenarios explicitly declare stories and bugs through the existing parameters, preserving their source-read assertions.
- R5 runtime-contract@2 preserves a recoverable original contract identity. Extending its original entries requires recomputing both original identity and the augmented declaration, with the profile pinning the original identity.

- Optional expected_quality had a code regression: an empty judgment was treated as forged evidence when a complete expected leaf was available (notably carry-over). It now remains unknown with the exact missing judgment and next step. Nonempty malformed claims still refute. case-review is bumped and re-signed to 1.1.23.
- The synthetic bed does not enable spec_index or legacy case_index. It must disclose that no unversioned root is declared; it cannot assert a closed empty root without a source inventory.
- Hub sync's final alias check wrongly demanded a root for unpublished aliases whose unpublished base was intentionally skipped. It now uses structured release state; published aliases still require a produced base. Tests cover both across reruns.
- Feeding text was appended after the 30,000-character renderer budget. Both normal and fallback answers now fit the disclosure into that same budget with explicit omission/recovery and the original trace.
- The benchmark injector still used a negative-tag regex. It now calls the published exact resource declaration helper. Injected structural defects are compared by newly introduced codes, since an existing advisory R2 violation must not mask a new structural failure. A second expected leaf preserves existing tag violations and introduces no structural violation.

- A04's explicit identity contract existed but was not accepted by submit_result or propagated into author lineage. Report scenarios remained blocked by independence_unknown after their draft-slot migration. The optional model_identity input now consumes exactly model-identity@1; stored submissions supply exact model/family IDs across handover, reuse and effect replay. Legacy submissions keep their missing-family state. Model warrants use the declared model_id, never the display text; account independence stays unchanged.

## Baseline failure inventory

Every baseline failing leaf is retained. Shared-slot failures cascade from the same missing required slot shape; the table records additional failures exposed after admission was repaired.

| Scenario file | Baseline failures | Root cause and resolution |
| --- | ---: | --- |
| 01-normal-review | 6 | New requirement inventory and slot; exact tags, explicit PLM IDs, no inferred searches or fabricated unversioned root |
| 02-quote-mismatch | 2 | Shared draft slot migration preserves the quote-refusal assertions |
| 03-command-membership-contradicted | 1 | Shared draft slot migration preserves catalog contradiction |
| 04-negative-case-param-out-of-range | 1 | Shared draft slot migration preserves typed range refutation |
| 05-cross-item-claims | 1 | Shared draft slot migration preserves cross-item judgments |
| 08-second-product-pack | 1 | Shared draft slot and five-requirement inventory |
| 10-item-reuse | 2 | Shared slot, explicit fresh slot, empty optional judgment remains unknown on reuse |
| 13-idempotence | 1 | Shared draft slot; immutable transitional result behavior retained |
| 14-knowledge-sync | 1 | Unpublished alias excluded from production is not a failed root |
| 15-aliasing-end-to-end | 1 | Shared draft slot migration |
| 16-agile-mindmap-review | 2 | Explicit source IDs and shared slot; additionally repaired post-layout feeding budget overflow |
| 17-hub-restart | 2 | Shared draft slot migration; append-only persisted results retained |
| 19-concurrency | 2 | Shared draft slot migration; concurrent current results retained |
| 20-injected-defects | 4 | Shared slot; individual-code delta; exact declared negative removal; multiple expected leaves do not erase tag violations |
| 21-model-violations | 3 | Shared draft slot migration preserves intentional invalid-submission refusals |
| 22-fact-model-independence | 3 | Shared slot; distinct explicit scripted identities, fact terminals remain independent of model judgment |
| 26-review-report | 8 | Shared slot followed by explicit model identity wiring; fulfilled declarations enable reports, absent/same-family cases remain blocked |
| 28-device-run | 7 | Recoverable original contract pin, full typed inspect authority/effect closure from the locked catalog; parseable tampering changes expectation text within its source quote |
| 31-predecessor-default | 1 | Shared draft slot migration; no implicit predecessor fallback introduced |
| Total | 49 | No tests removed or skipped |

## Validation

Full acceptance rerun completed on synthetic loopback connectors and temporary PostgreSQL: 109 tests, 109 passed, 0 failed, 0 cancelled, 0 skipped (baseline 60 passed / 49 failed). Focused reruns followed new changes or remaining failures. No deployment or real-system evidence is claimed.

Completed checks:

- Changed semantic, budget, sync and injection regressions: 104/104 passed, no skips.
- Model identity, handover, legacy immutability, reuse and effect replay: 30/30 passed, no skips.
- Contract tests: 336/336 passed; generated contracts match all 129 files.
- Documentation checks: 210/210 passed; typecheck passed.
- Published case-review validation/sample checks passed with version 1.1.23 and a regenerated manifest.
- A broader diagnostic run including case-review's old unit tests: 328 tests, 317 passed, 11 failed. Every failing test also appears in the owner's baseline unit TAP: old tag normalization/spelling expectations, legacy subject expectations, table inventory, runtime-import scanner, and the repository-wide handwritten-axis scanner. These are outside the assigned acceptance failures and were not relaxed or deleted. This is not a claim that the repository's unit suite is green.
