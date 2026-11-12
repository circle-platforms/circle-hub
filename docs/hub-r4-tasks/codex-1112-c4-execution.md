# Add the isolated table-cell executor

Source: the fifth local task brief and the integrator's shared interface.

Allowed paths:

- `docs/hub-r4-tasks/codex-1112-c4-execution.md`
- `scripts/real/bed-side/`

Implement a pure cell selector, a per-call assembly and an independent execution entry with its own source-derived contract. Keep the shared framework and the original submission handler unchanged. The new submission route reuses the original lease, request, launch and result protocol.

Development executes only our files and synthetic framework, gateway and device fixtures. No owner home, credential store, real service or reference module is run or imported. Only `scripts/real/bed-side/table-cell.test.ts` is checked here; integration checks and package versions belong to the integrator.
