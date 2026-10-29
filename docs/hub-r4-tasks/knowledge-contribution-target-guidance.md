# Correct knowledge contribution target guidance

The contribution admission boundary requires a locked product and root. The current skill incorrectly tells callers to
omit product, version and build, so a valid observation is refused before its quotation can be checked. Correct the skill
and package README to explain how an explicitly declared target locks the run and what to do when that fact is missing.
Keep the admission rules, existing runs, source records and sample expectations unchanged. Patch the pack version and
regenerate its owned snapshots and manifest with its own tool. Use synthetic examples and run the affected tests.

Allowed paths: this task page and `packs/workflow/knowledge-contribution/`.
