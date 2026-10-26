# Restore memo and review integration checks

Owner authorized takeover of fix-hub-red and its eight uncommitted files. Latest hub-redesign df11452e was merged with signoff before further changes. The original binary diff was preserved as fix-hub-red-inherited.patch in the acceptance handoff before editing.

Allowed paths: hub/knowledge/{memo.test.ts,review.test.ts,README.md}, packs/workflow/case-review-verify tests and README/manifest, packs/product/famx/{functions/sync.ts,functions/sync-device.test.ts,README.md,pack.json}, tools/gen-contracts.ts and its shared vocabulary tests, generated verification vocabulary/table, and this task page. The inherited produce.ts and three shared fixture edits were reviewed and returned to the merged mainline contents for the reasons below; their original changes remain in the handoff patch.

## Decisions on inherited work

- The global resource-tag rewrites would erase explicit undeclared-label counterexamples, changed generated JSON inconsistently with its generator and affected unrelated acceptance tests. Preserve the existing shared fixtures; use explicit source parameters locally and the already declared negative case for positive negative-command coverage. Label variants stay raw and advisory.
- The inherited producer change removed the current build from known_builds. That is an authority input used for structured applicability checks, so it cannot be removed to stabilize a cache key. Tests comparing repeated identical input first register a frozen inventory through the same Builds.record boundary as sync. Inventory changes must still invalidate calls.
- Inline/parted composition comparison must account for each entry's actual applicability admission record. Normalize only applicability_context.composition in the comparison, and independently assert the exact inline/parted digest. Do not strip arbitrary fields named composition.
- Keep device aliases after withheld-base filtering, preserving aliases of retained unpublished builds for explicit includeUnreleased syncs. The inherited released-only restriction is removed. The inherited FAMX manifest version downgrade is replaced with a forward version bump and regenerated signature.
- Review submissions use only slots declared by their workflow. Empty optional expected_quality means unjudged. Scripted identities are explicit model-identity@1 declarations. No name-derived family inference.

## Baseline

Owner reported end-to-end: 17 tests, 11 failing. Takeover run after merging df11452e with the inherited patch: 46 tests (end-to-end plus memo/review), 35 passed, 11 failed, no skips.

## Validation

The target end-to-end/memo/review run is green: 47/47, no cancelled or skipped tests. The prior combined takeover run was 46 tests / 11 failed; one inventory regression was added. The original end-to-end's 17 cases are retained. The owner's unit baseline also recorded memo 3 and review 2 failures; these files did not change between that baseline and df11452e.

The runtime implementation correction is the dangling device alias after a withheld base. The broader verification package test also exposed a stale copied types.ts with a handwritten legacy tag union. Its exact-copy assertion is retained: synchronize the type definitions and add verification to the existing vocabulary generator target list, including the same closed resource-tag table. No handwritten enum or external runtime import is introduced. Remaining corrections are fixture/expectation migrations: complete frozen memo input, composition admission identity, declared workflow slots, explicit model identities and source ids, and unknown absence under an incomplete endpoint grammar. The Lumen source lacks a structural empty parameter table for GET /v1/health; it must not produce an absence fact for PATCH or older DELETE. These unknowns retain missing facts and bound exits.

FAMX moves forward to 1.7.7 and case-review-verify to 1.1.8, with regenerated manifests. No shared fixture bytes or knowledge production authority were weakened. Final checks:

- Complete case-review-verify package plus knowledge memo/review: 73/73 passed, 0 failed/cancelled/skipped
- Original end-to-end: 17 tests retained, 11 failures reduced to zero
- Memo/review: baseline 29 tests with 5 failures; now 30/30 including the added authority-inventory regression
- FAMX device alias, pinned build and case-sync tests: 23/23 passed, 0 skipped
- Generator tests: 10/10 passed; verify:contracts confirms all 131 generated files match
- Documentation checks: 211/211 passed, 0 skipped
- npm run typecheck passed
- Both forward-version manifests match their published files; the real registry publish/sample checks pass in the integration bed

 Synthetic loopback services and temporary PostgreSQL only; no real-system or deployment claim.
