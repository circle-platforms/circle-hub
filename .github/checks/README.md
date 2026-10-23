# Docs and CI checks

Owned by the docs package. Run them with:

```sh
node --test --test-concurrency=1 ".github/checks/*.test.ts"
npx tsc --noEmit -p .github/checks
```

The `docs` job of `.github/workflows/checks.yml` runs both.

| File | Checks |
|---|---|
| `docs-rules.ts`, `docs.test.ts` | Every current published page under `docs/` links only to what the docs site can serve: the site is built from `docs/` alone, so a file outside it is linked by its absolute GitHub URL on `main`, and that file must exist in this tree. The vocabulary tables of the generic-model pages equal `contracts/generated/vocabulary.ts`. The decided and deferred counts of the model's pending items, as the pages state them, equal `contracts/model.json`. Every decision in `docs/hub-r4-progress.md` names its source. All tracked text outside `foundation/` and `references/` is checked for personal machine paths and protected build-name shapes, including code, tests, ops and extensionless configuration. Synthetic path exceptions are explicit and restricted to named test files. |
| `test-summary.ts`, `test-summary.test.ts` | Reads what `node --test` printed and writes the counts and every skipped test or suite to the job summary. It fails when no test ran, when one failed or was cancelled, or when the run printed no summary: `node --test` itself succeeds when its pattern matches no file. |
| `workflow.test.ts` | Each test job of `checks.yml` keeps its output and counts it with `test-summary.ts`, also after a failure, and no job reads a secret. |

Limits: pages that open with a historical or superseded banner are records and keep their original links, some of which do not work on the site. The link check does not follow anchors. The machine-path check covers user homes, root-home paths and variable-data paths, plus personal tilde and Windows home forms; generic tool paths and the OS template `~/Library` are allowed. Non-file URL tokens are excluded per match, while file URLs and adjacent local paths are still checked. Mounted user-home paths and the macOS private variable-data prefix are included; root-home and variable-data matches retain path boundaries so unrelated nested directory names are not mistaken for machine roots. Windows drive letters and the Users folder may have either case; separators may be forward slashes or literal or escaped backslashes. POSIX directory names remain case-sensitive. The build-name check rejects release and beta names for protected minor lines regardless of case or name family, including branch names without a patch suffix. Existing hits fail the repository checks and must be reported to the integrator, not silently allow-listed. Git supplies the file inventory; every tracked regular file is scanned with NULs removed, and symbolic links are checked by their stored target text without being followed. Frozen archives are excluded; a missing tracked path fails instead of being silently skipped.
