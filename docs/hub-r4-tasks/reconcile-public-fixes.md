# Task: Carry the public fixes after the R7 snapshot back into the integration tree

Branch `reconcile-public-fixes`, opened from hub-redesign at 85568696. The public repository received fixes after the R7
merge that the integration tree does not have: the 30-second skill parse limit, the split-document answer, the macOS
pack extraction and orphan sweep fixes, the concurrent key delete, the capture lock recovery, the union-typed command
signatures in defect-to-case and case-compile, test timing by growth ratio and CPU time, observation-lock waits,
`fileURLToPath`, test coverage of every tracked test file and the dependency advisories. Carry the same behaviour back
with the private identities, adopt the pack numbers of the public R8 snapshot for equivalent content (case-compile 3.8.7,
defect-to-case 1.6.22) or the next free number above both lineages (knowledge-contribution 1.3.11), and regenerate
manifests with each pack's own tool. Also keep a recovered `rec:` read unknown once its feeding record is retracted.

CI workflows, `.github/`, the public shard and acceptance runners, the public sandbox diagnostics switch, Windows-only
changes and the root changelog, README, CONTRIBUTING and AGENTS texts are not carried. No production deployment.

Allowed paths:

- `hub/dispatch/recovery.test.ts`, `hub/dispatch/rounds.test.ts`, `hub/dispatch/testing/context.ts`
- `hub/platform/file-key.ts`, `hub/platform/file-key.test.ts`, `hub/platform/release.test.ts`
- `hub/refs/README.md`, `hub/refs/adversarial.test.ts`, `hub/refs/sandbox-diagnostic.ts`, `hub/refs/sandbox-diagnostic.test.ts`,
  `hub/refs/skill-lazy-parity.test.ts`, `hub/refs/skill-lazy-support.ts`, `hub/refs/skill-parse-limits.test.ts`, `hub/refs/skills.ts`
- `hub/requests/service.test.ts`
- `hub/rules/README.md`, `hub/rules/sandbox/orphans.ts`, `hub/rules/sandbox/orphans.test.ts`, `hub/rules/sandbox/sandbox.test.ts`
- `hub/runs/engine/README.md`, `hub/runs/packs/extract.ts`, `hub/runs/packs/extract.test.ts`
- `hub/server/README.md`, `hub/server/recover-read.ts`, `hub/server/recover-read-record.test.ts`, `hub/server/submit-load.test.ts`
- `hub/testing/README.md`, `hub/testing/growth.ts`, `hub/testing/growth.test.ts`
- `package.json`, `package-lock.json`
- `packs/skill/html-format/functions/html.test.ts`, `packs/skill/xml-format/functions/resource.test.ts`
- `packs/workflow/case-compile/`: `README.md`, `pack-files.ts`, `pack.json`, `pack.test.ts`, `publish.test.ts`,
  `functions/bed.ts`, `functions/command-obligations.ts`, `functions/command-policy.ts`, `functions/profile.ts`,
  `functions/inverse-alternatives.test.ts`, `functions/profile.test.ts`, `tables/runtime-profile-format.json`,
  `tables/workbook-format.json` and the four regenerated `samples/*/typed-dispatch_policy.json` and
  `samples/*/typed-workbook_verified.json`
- `packs/workflow/defect-to-case/`: `README.md`, `pack-files.ts`, `pack.json`, `publish.test.ts`,
  `functions/case-identity.ts`, `functions/union-identity.test.ts`
- `packs/workflow/knowledge-contribution/`: `README.md`, `pack-files.ts`, `pack.json`, `tools/jev/generated.json`,
  `tools/operation-capture/generated.json`, `tools/operation-capture/lib/state.ts`, `testing/jev-review.test.ts`,
  `testing/operation-capture.test.ts`, `testing/operation-distribution.test.ts`
- `packs/workflow/template-gap/testing/command-samples.ts`
- `scripts/real/accept/id-spot-check.test.ts`, `scripts/real/gold/builds.test.ts`, `scripts/real/gold/catalog-marks.test.ts`
- `tests/acceptance/T8-1-second-product.test.ts`, `tests/acceptance/oracle/differential.test.ts`
- `tools/run-unit-tests.ts`, `tools/run-unit-tests.test.ts`
- `docs/hub-r4-tasks/reconcile-public-fixes.md`

Verification: the workspace's affected-tests helper with `--run` against the merge base with hub-redesign. The sandbox,
`hub/testing` and dependency changes make it a wide change, so the complete pre-deployment run also covers this branch
after `npm ci` brings the shared `node_modules` to the new lockfile.

Rules: synthetic fixtures and scripted models only; no real data, credentials, internal addresses or local paths; no
change to generated contracts, `foundation/` or `references/`; never weaken an assertion to make a test pass.
