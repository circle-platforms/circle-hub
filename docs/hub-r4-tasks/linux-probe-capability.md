# Linux sandbox startup capability preflight

Historical task: decision 82 later retired the per-child attestation and its temporary permission grants; the proof-only
`linux-policy-ab.ts` script was removed. Its past measurements below are historical, not current instructions. Actual
bubblewrap/AppArmor isolation and the corresponding Linux isolation tests remain.

Follow-up to linux-server-migration: readiness must verify the Node permission revocation required by the real bootstrap.

Allowed paths:

- `hub/rules/sandbox/isolation.ts`
- `hub/rules/sandbox/linux-probe-capability.test.ts`
- `hub/rules/README.md`
- `docs/hub-r4-tasks/linux-probe-capability.md`

The startup probe uses actual Node permission grants and verifies their revocation, with named private diagnostics for
missing or ineffective drop support. Existing OS attestation remains mandatory. Synthetic regressions cover absent,
no-op and throwing drop implementations. No model, real system, credentials or deployment is used.

## Coordinated verification

Initial implementation intentionally ran no tests. The integrator subsequently assigned this agent an exclusive VM window
and authorized the following checks at test concurrency 2. No mainline merge or push was performed.

macOS, Node 24.17.0:

- Initial `npx tsc --noEmit` failed because the isolated tree had no dependencies. After temporarily linking the main
  development dependency directory, the same command exited 0. The temporary link was removed after verification.
- `node --test --test-concurrency=2 hub/rules/sandbox/linux-probe-capability.test.ts`: 3 passed, 1 skipped, 0 failed.
  The real-revocation test explicitly skipped because this Node lacks `permission.drop`; the missing/no-op/throwing
  synthetic regressions passed.
- The same command with `linux-isolation.test.ts`, `linux-probe-capability.test.ts`, `orphan-linux.test.ts` and
  `resident-linux.test.ts`: 9 passed, 5 skipped, 0 failed. Skips were actual Linux isolation, actual permission revocation,
  Linux orphan cleanup and the two Linux process-tree tests.

Dedicated synthetic Linux VM, Node 24.22.1:

- Copied only `git ls-files` paths with `rsync --from0 --files-from` into a new temporary directory on the VM disk.
  `npm ci` and `npx tsc --noEmit` exited 0. An earlier dependency install with `--ignore-scripts` also exited 0;
  the subsequent ordinary `npm ci` was the installation used for verification.
- Confirmed no existing Hub sandbox profile before installation. Ran
  `CIRCLE_HUB_SYNTHETIC_APPARMOR_TEST=1 node --test --test-concurrency=2 hub/rules/sandbox/testing/linux-policy-ab.ts`:
  7 passed, 0 skipped, 0 failed, including missing drop and cached-readiness policy weakening controls.
- Reconfirmed no existing Hub profile, generated the policy from this tree, installed it with `apparmor_parser -a`
  (never replacing an existing profile), and ran `node --test --test-concurrency=2` with the four files above plus
  `hub/rules/sandbox/sandbox.test.ts`: 39 passed, 1 skipped, 0 failed. The skip was the existing isolation-unavailable
  refusal case because operating-system isolation was available. Actual revocation, OS denial of network/write/exec,
  unbound reads and the synthetic missing-drop regression all ran successfully.
- Removed only the test-owned policy, confirmed no Hub profile remained, deleted the test directory and released the VM.

These are local synthetic checks, not deployment or real-system evidence. Full integrator checks remain required.

Independent review: Antigravity examined fixed implementation commit `1d123e32` and its synthetic test cases without
running tests or contacting a production system. The reviewer found no remaining issue in the permission-revocation
readiness check. This static result does not substitute for the Linux VM tests or the full integration suite above.
