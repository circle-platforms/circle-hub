# Generate device commands without opening closed actions

Source: the owner's 2026-11-12 11:10 correction to the morning task brief. The previous executor-action opening task is withdrawn.

Allowed paths:

- `docs/hub-r4-tasks/codex-1112-c1-generator.md`
- `packs/workflow/case-compile/SKILL.md`
- `packs/workflow/case-compile/README.md`
- `packs/workflow/case-compile/functions/authoring-brief.ts`
- `packs/workflow/case-compile/pack.test.ts`

Keep closed executor actions closed. The writer follows the build's manual and command tree to implement the same authored effect using allowed device command methods. When naming is supported, use the existing local placeholder expansion consistently through creation, use, query and cleanup within the case. Do not infer arbitrary command-argument substitution from assertion captures or reuse names from previous device output.

No runner contract, environment profile or executor definition is changed. No dynamic command interpolation capability is added. The integrator updates the package version and manifests after merging. Verification is limited to the existing authoring-brief test file; no new proof-by-wording test is added.

`node --test packs/workflow/case-compile/tools/authoring-brief.test.ts`: 9 passed, 0 failed, 0 skipped. No other test file, type check or full suite was run.

The integration suite found the existing pack test still expected the old sentence about device-generated values. Its wording assertion is updated statically to retain same-case use, rejection of previous output and rejection of existing device state. No test or type check was run for this correction; the integrator will rerun the failed file after the full suite finishes.
