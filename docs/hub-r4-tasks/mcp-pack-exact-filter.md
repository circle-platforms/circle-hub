# Task: Make task-pack descriptions reachable within the MCP text budget

When a user has many assigned workflows, `list_task_packs` can truncate the later pack descriptions and direct the caller to the console. A Circle session limited to the six Hub tools then cannot discover a named pack's input slots or requirements.

Add an optional exact pack ID filter and a continuation offset to `list_task_packs`. Filter only the already-authorized summaries; absent, unassigned and nonmatching IDs all yield the same empty result. When the text budget omits entries, provide an exact continuation call with the same filters and the next offset. Keep existing requests and their structured results compatible. Do not use aliases, prefixes or fuzzy matching.

Scope: `contracts/src/tools.ts` and generated contracts; `hub/server/tools.ts`, `hub/server/text.ts`, their tests and README; this task page. Fixtures are synthetic. Do not alter other assertions, packages, credentials, external systems or archived files.

Verify generated contracts, types, docs and affected tests under the current risk-based policy. A real deployment and verification use the owner's authorized procedure and must not interrupt an active job or lease.
