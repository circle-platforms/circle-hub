# Linux sandbox startup capability preflight

Follow-up to linux-server-migration: readiness must verify the Node permission revocation required by the real bootstrap.

Allowed paths:

- `hub/rules/sandbox/isolation.ts`
- `hub/rules/sandbox/linux-probe-capability.test.ts`
- `hub/rules/README.md`
- `docs/hub-r4-tasks/linux-probe-capability.md`

The startup probe uses actual Node permission grants and verifies their revocation, with named private diagnostics for
missing or ineffective drop support. Existing OS attestation remains mandatory. Synthetic regressions cover absent,
no-op and throwing drop implementations. No model, real system, credentials or deployment is used.

Validation: package agent does not run tests or typecheck at the integrator's explicit request to coordinate concurrency.
Integrator must run the new test, typecheck and affected Linux/macOS suites before integration. No merge or push here.
