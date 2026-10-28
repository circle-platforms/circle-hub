# Select feeding candidates for requested nodes

The live `get_nodes` path reads and authorizes every feeding source in a product before it filters entries to the
requested node paths. A real one-node request over thousands of records exceeded the client timeout. Retain the exact
existing node-match rule, but select candidates from the immutable feeding structure before reading each candidate's
source. Authorization, source readability, frozen offsets, source heads and retractions must still be checked for every
candidate. Missing batch support keeps the original per-record fallback. Do not cache authorization across operations.

Reproduce with a synthetic locked tree and forty feeding cases: reading an unrelated node must not read their common
original forty times; a related node still returns exactly the valid entries, observes a frozen cut, and refuses an
unauthorized reader. This measures source reads, not the entire real request latency.

Allowed paths: this task page, `hub/knowledge/feeding.ts`, `hub/knowledge/service.ts`, `hub/knowledge/README.md`, and
synthetic knowledge tests. Run the affected-test tool and merge through merge-locked.sh.
