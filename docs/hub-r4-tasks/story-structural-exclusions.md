# Use structured omission facts for story traceability

The story projection currently searches a human-readable view note to decide whether case counts can be exact. That
violates the structural-evidence rule and makes the decision depend on wording. The Hub already knows how many index
entries it excludes while generating each view; expose that count in the Hub-generated metadata artifact for the same
read, without changing index-view bytes. Consume the numeric field exactly, and keep older incomplete views conservative
when their metadata does not establish the fact. Do not infer status from notes or change old assertions.

Use synthetic data and cover the same view with different note wording, an omission without a note, unavailable legacy
metadata and the real Hub metadata producer. Patch and re-sign the story workflow pack with its own tool. This finding is
independent of the real run's previously observed invalid-input refusal; its cause has not yet been established.

Allowed paths: this task page, `hub/knowledge/views.ts`, `hub/knowledge/README.md`, new synthetic knowledge tests, and
`packs/workflow/story-traceability/`.
