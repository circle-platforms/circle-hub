# Task: Read a frozen feeding cut in bounded index batches

Real knowledge views can repeatedly query the same retraction index and one binding/usage index per feeding object. A product with thousands of feeding records can keep a `start_run` waiting for minutes. The view must retain the complete product-wide notes and the frozen offset; filtering to the requested root alone would silently change those facts.

For a frozen offset, add a bounded record-index batch read that preserves indexed values, record order, sequence positions and existing record verification. Use it for the product entries, retractions, source heads, bindings and usages of a feeding cut. Keep every existing per-record/source authorization check and all current validity, missing, retraction and conflict behavior. Leave live/unfrozen reads on their existing path unless their semantics can be preserved exactly.

Scope: `hub/records/api.ts`, `hub/records/store.ts`, `hub/records` tests, `hub/knowledge/feeding.ts`, its synthetic tests and README, and this task page. Do not change contracts, production data, stored records, packs, permission rules or unrelated assertions. Use synthetic data only.

Add a real temporary-PostgreSQL test showing that a frozen cut retains the same objects, bindings, retractions and usages as the existing path while index reads grow by batches instead of one per object. Run affected checks and relevant tests; deployment needs a verified service window and must not mistake a disconnected client for a stopped operation.
