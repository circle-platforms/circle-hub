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
