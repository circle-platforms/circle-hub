# Locate feeding diagnostics in the model-reference text

Allowed paths:

- `docs/hub-r4-tasks/codex-1112-morning-feeding.md`
- `hub/knowledge/feeding-bounds-identity.test.ts`

The current MCP reply puts reader prose in the first text block and the complete checked answer under the model-reference heading in the second. Update the existing failed-function assertion to read that second block. Keep the diagnostic code, sanitized message, permissions, immutable original record and deduplication assertions unchanged.

This change is static while the integrator's full suite is running. No test or type check was run here; the integrator will check the failed file after the full result is available. No runtime source or fixture changes are included.
