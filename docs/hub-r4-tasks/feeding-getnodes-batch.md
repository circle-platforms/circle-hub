# Batch feeding reads for knowledge nodes

A real single-node `get_nodes` read over a product with thousands of feeding records took about eighteen minutes on the
current Hub; the client timed out first. The live `FeedingLayer.entries` path performs retraction and source-head index
lookups per record, while frozen cuts already have a batched implementation. Confirm the query-growth problem with
synthetic records and reuse the batch path for live reads where the store supports it. Preserve the legacy fallback,
the exact reader's current access, immutable offset, source-head and retraction behavior. Do not cache authorization
across operations or weaken any existing assertion. Record what the synthetic test measures; it does not claim to have
established that this is the only cause of the real latency.

Allowed paths: this task page, `hub/knowledge/feeding.ts`, `hub/knowledge/README.md`, and synthetic knowledge tests.
Use the affected-test runner and merge through merge-locked.sh after the current feeding-root-views branch is integrated.
