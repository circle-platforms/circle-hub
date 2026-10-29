# Batch discovery of build production indexes

Listing known builds currently looks up the latest production separately for every distinct base, including bases with
no production index. At large build inventories this produces thousands of empty queries during run targeting. Discover
which exact production-index keys exist in bounded batches; for keys that exist, retain the existing per-base newest-valid
production rule, including exact product and base identity checks. If batch discovery fails, use the original per-base
path for that batch. Do not reinterpret or skip historical records, change the selection rules, or assume an absent index
proves anything beyond the current lookup.

Add synthetic tests for thousands of empty keys, existing and duplicate/case-colliding keys, failed discovery and production
history parity. Bound the number of returned records in concurrent batches. Allowed paths: this page,
`hub/knowledge/builds.ts`, the knowledge README and synthetic knowledge tests. Run the affected-test tool against the
merge base and merge through the locked workflow. Real performance remains unverified until an authorized switch.
