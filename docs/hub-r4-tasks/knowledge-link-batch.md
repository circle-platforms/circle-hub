# Task: Batch knowledge relation traversal

The real Hub has a large composition, and reading a knowledge node can spend minutes in relation preparation. The relation reader currently looks up every tree node individually; multiple reads can repeat the work. This branch addresses the proven traversal cost without changing relation semantics, permissions, reference checks or stored data.

Use bounded batches for tree-node and missing-entry reads while keeping the same validation, missing-record behavior and exact relation results. Add a synthetic large-tree test that records read counts and checks outputs, plus tests for missing or invalid node records. Investigate concurrent requests separately; do not assume the full-tree traversal is the only cause of the real delay.

Scope: `hub/knowledge/store.ts`, `hub/knowledge/links.ts`, their synthetic tests, `hub/knowledge/README.md` and this task page. No real data enters Git. Do not touch unrelated work or weaken assertions.

Run the risk-based checks and relevant tests. Deployment must preserve running jobs and leases; a local cancellation is not evidence that a server operation stopped.
