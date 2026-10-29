# Correct template category submission guidance

The published skill calls the SlotClaim text member `statement`, while the Hub's `SlotClaim` contract requires `text`.
It also does not explain that a `src:` suffix range is relative to fragment text whereas CategoryJudgment's
`quote.identity.span` is an absolute range in the original source bytes. Explain both forms, preserve exact raw JSON
escaping, and leave an unknown with a mechanical byte-location exit when the client cannot determine a span. Do not
change a schema, a check, the parser, old runs or their records. Patch and re-sign the workflow pack.

Allowed paths: this page, `packs/workflow/template-gap/SKILL.md`, its README, manifest and synthetic tests/support.
Run the affected-test tool, then merge through the locked workflow.
