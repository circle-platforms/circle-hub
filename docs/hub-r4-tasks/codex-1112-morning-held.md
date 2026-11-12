# Locate held-source details in the model-reference text

Allowed paths:

- `docs/hub-r4-tasks/codex-1112-morning-held.md`
- `tests/acceptance/59-held-source-observation.test.ts`

The current start reply tells the reader that the source is incomplete and names the next step. Its second text block retains the exact object-existence observation, pending-review note and source-system next step. Update the existing assertions to those locations without changing the source, fixture, hidden-content checks, null manifest metadata, permissions or one-time administrator request.

This change is static while the integrator runs acceptance. No test or type check was run here; the integrator will check the failed file after the complete result is available.
