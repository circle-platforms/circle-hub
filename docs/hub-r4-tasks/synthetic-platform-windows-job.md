# Synthetic Windows Job verification

Scope: a local public branch based on the existing synthetic platform matrix. Allowed paths are this task page, `.github/workflows/platform-matrix.yml`, `hub/rules/sandbox/windows.ts`, `hub/rules/sandbox/windows.test.ts`, `hub/rules/sandbox/isolation.ts` and `hub/rules/sandbox/sandbox.ts`.

The Job primitives and synthetic tests use the publication transform T on the source parent and new blobs, followed by `git merge-file` against the public files. The transform protects opaque hashes and dependency integrity values. Three adjacent Linux conflicts in isolation were resolved by retaining the public code and adding only the Windows import and fail-closed guards; sandbox merged without conflicts. No private task or progress history is imported. The subsequent KnownDLL and exact koffi 3.3.3 version checks and their synthetic counterexamples were merged through the same transform without conflicts; the loader does not consult environment paths.

The workflow runs exactly the Windows Job test file on the existing Windows x64 and ARM64 runners. Existing contracts, vault checks and the Windows readiness rejection remain unchanged. Job cleanup does not establish network or filesystem isolation; Windows pack execution remains unavailable even with synthetic OS opt-out.

No local tests or native execution ran for this change while Linux validation is active. This branch is for synthetic GitHub runner verification only; its workflow does not publish a release or deploy to a production system. Windows native results remain unverified until the workflow executes.
