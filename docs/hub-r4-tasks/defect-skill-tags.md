# Align defect-to-case author guidance with declared resource tags

The work skill and its submission examples still tell authors to use the legacy `tags` field and capitalized labels. The current R2 contract keeps `tags` only as legacy text; the shape check reads the explicitly declared `resource` field and compares each value exactly with the published `tables/resource-tags.json` texts. A draft with only the old field is undeclared, and an undeclared variant is an advisory structural violation.

Correct the skill and its examples to use `resource`, a declared exact test-type value, and an explicit stable draft id. Refer to the published table for the closed values instead of inventing aliases. Add a synthetic test that reads the examples and confirms their resource and id fields satisfy the existing check. Keep all old checks and assertions, bump the workflow pack patch version and regenerate its signature with its owning tool.

Scope: `packs/workflow/defect-to-case/SKILL.md`, its two submission examples, `pack-files.ts`, `pack.json`, the version-pinned publication assertion, its README and a synthetic test, plus this task page. No real documents, credentials or system identifiers.
