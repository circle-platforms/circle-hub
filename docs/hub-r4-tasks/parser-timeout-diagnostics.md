# Distinguish parser timeouts

The simplification plan asks for the existing long-running failures to be diagnosed before assigning a cause. The same `SANDBOX_TIMEOUT` currently covers a single child exceeding its limit and the enclosing document operation reaching its deadline. They need different recovery descriptions; the latter does not prove that any one function timed out.

Attach the declared skill/parser/function identity to failures from actual parser sandbox calls and show only safe identity fields in the private administrator note. Never report pack output, original text or a machine path. State when an operation deadline elapsed without claiming a child caused it. Keep the protocol code and all access and isolation rules unchanged. Synthetic tests cover both deadline kinds and a failure through the real parser sandbox. This change does not claim to resolve the historic real T2-3 timeout or implement the planned queryable long-operation state.

Scope: `hub/refs` parser diagnostics, `hub/server/tools.ts`, `hub/runs/engine/exact.ts`, and synthetic tests in those areas. Verify with `wf/affected-tests.py` at its CPU-adaptive setting; do not access live services or real data.
