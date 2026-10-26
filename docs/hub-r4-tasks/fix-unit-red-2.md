# Fix the two remaining unit failures

## Scope

- `hub/runs/engine/admin-note.test.ts` and `hub/runs/engine/start.test.ts`
- `packs/workflow/case-compile/functions/command-obligations.ts`
- `packs/workflow/case-compile/{pack-files.ts,pack.test.ts,publish.test.ts,pack.json}`
- `packs/workflow/case-compile/tables/workbook-format.json` and regenerated publication samples
- This task page

## Root causes and basis

The admin-note failure is a false-positive assertion, not a runtime disclosure: it prohibited the substring `404`
anywhere in a structured response containing content-addressed references. The fullcheck failed only this last
assertion, while the source-specific admin note was present. A deterministic valid synthetic JSON fixture padded
with sixteen newline characters has SHA-256 `629e67bd69de440493791d8a38e7339202da597b5613134846a4d58fe5f70b8b`;
it reproduces the same failure before the assertion fix. The test now requires the exact internal error in the
source's admin note, the neutral structured unavailable reason in the stored parse action, and absence of the full
internal error in the user answer. Hash substrings are not interpreted as error facts.

The vocabulary scan correctly rejects the handwritten `unknown | refute` in command obligations. Use a subset
of the existing generated `Verdict` type; no new vocabulary or scan exemption is needed. This is a type ownership
regression with no behavior change. Bump case-compile 3.4.2 to 3.4.3, regenerate workbook publication samples and
re-sign its manifest in the same commit.

The adjacent start-run test had the same substring assertion over parse-action digests; it now checks the exact internal
error while retaining its neutral structured unavailable assertion. This prevents the same false positive there.

## Validation

- Initial requested files: 24 passed, one vocabulary failure; the admin test was intermittent.
- Deterministic hash fixture before the assertion fix: three passed, one admin-note failure.
- Requested files, all contracts/generator tests, case-compile manifest and publication tests: 384 passed, zero failed/skipped.
- `npm run typecheck`: passed.
- `node tools/gen-contracts.ts --check`: 132 files match; no generated changes or vocabulary exceptions.
- `node packs/workflow/case-compile/pack-files.ts --check`: fresh manifest for 3.4.3.
- Adjacent `hub/runs/engine/start.test.ts`: 15 passed, zero failed/skipped (399 total checks across the two runs).
