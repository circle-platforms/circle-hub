# Preserve unknown story-index key coverage

A case index may report `truncated` because feeding sources have no locked-root projection or a conflicting binding,
even when all currently visible keys have been listed. The story-traceability projection currently compares only the
visible key count with `total_keys`, so it can claim that an absent story has no indexed cases while unseen feeding
objects could still provide that key. An unrelated per-key cut, however, need not hide other keys.

Add an explicit optional structural key-space completeness fact to `index-view@1`, generated through the contract
tool. The Hub computes it only from its own pagination, selection and unresolved feeding facts; it must not infer the
fact from note text. Preserve positive known links and per-key cut evidence when the field proves the key space is
complete. An absent key in an incomplete or legacy view without this fact stays unknown with missing facts
and a next action. Existing tests' assertions remain unchanged apart from the package-version literal; synthetic fixtures
that assert a complete key space may declare the new fact. Old records remain readable and their bytes are not rewritten.
Patch and resign any changed pack.

Allowed paths: this page, `contracts/src/views.ts` and generated contracts, `hub/knowledge/views.ts`,
`hub/knowledge/complete-view.ts` and synthetic knowledge tests, `packs/workflow/story-traceability/**`, and synthetic
shared fixtures as needed, including the PLM story integration tests' index fixtures. Run the affected-test tool; when it reports full, run the required complete
suite once, then merge-locked.sh.
