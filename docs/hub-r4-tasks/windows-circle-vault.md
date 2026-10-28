---
title: Windows user-scope credential adapter
---

# Windows user-scope credential adapter

Owner instruction: inspect Circle's encrypted credential chain read-only and reuse its user-scope protection approach for a headless Hub. Pin koffi 3.3.3 in the integration task; no Electron runtime dependency. Linux remains first. Windows x64 and ARM64 need synthetic GitHub runner evidence.

Branch: `task/windows-circle-vault`, based on `hub-redesign`.

Allowed paths:

- `hub/platform/windows-dpapi.ts`
- `hub/platform/windows-dpapi.test.ts`
- `hub/platform/windows-vault-README.md`
- `docs/hub-r4-tasks/windows-circle-vault.md`

Do not modify Circle, package/lock files, factories, workflows, HANDOFF, real systems or credentials. Do not run tests, push or merge. Commit with explicit paths and signoff.

This change supplies DPAPI and an independent encrypted-file KeychainStore adapter. Windows service deployment and production factory integration remain unavailable pending native runner validation and the vault-wide ACL/migration checks. It does not make Windows deployment available.

Integrator continuation: complete native user/profile checks, protected ACL and create-only encrypted-file persistence; keep default factories unchanged until Windows evidence is available. Additional owned paths: `hub/platform/windows-keychain.ts`, `hub/platform/windows-files.ts`, `hub/platform/windows-keychain.test.ts`.

## Native runner receipt and continuation

Integrator reports GitHub run [40637119213](https://github.com/circle-platforms/circle-hub/actions/runs/40637119213) at public commit `33dbb2f`: Windows x64 and ARM64 each ran the credential fixtures with 8 passed, 1 non-Windows-only skipped, 0 failed; the earlier access violation did not recur. This proves the tested current-user synthetic fixtures only, not a service account, cross-user isolation, migration or FileVault. The prior failing receipt remains recorded in the package note.

The owner authorized completing the cross-platform vault. The integrator explicitly extends this task to `hub/records/vault.ts`, corresponding tests and the narrow public seam wiring in `hub/records/api.ts` and `hub/records/index.ts`; retain the key-transfer branch's read-only verify when merging. Additional platform paths: `hub/platform/windows-vault.ts`, `hub/platform/windows-vault.test.ts`. No local tests while the macOS full run occupies the machine; synthetic-only runner checks remain scheduled by the integrator.

Continuation owns the new seam test `hub/records/vault-storage.test.ts` in addition to the platform paths above. `hub/platform/windows-files.ts` now has new, as-yet-unvalidated rename/enumeration/stat code; its earlier current-user CI receipt does not establish these additions. No production factory is enabled by this branch.
