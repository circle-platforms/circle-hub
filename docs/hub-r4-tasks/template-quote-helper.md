# Prepare template category quotation spans

The template-gap classification slot requires an absolute raw-source byte span. Circle previously had to calculate those spans manually even though the mindmap parser and the package's quotation verifier already know the document structure. Provide local tools that parse an explicitly supplied original with the installed mindmap-format parser, then locate exact candidate quotations in the selected node. Case ownership is checked by Hub at submission. They do not decide categories, call Hub, alter the source, invent a model identity, or replace Hub's boundary verification.

The source may contain JSON escapes or be double encoded. Locate the decoded quotation in the selected node and return its exact original byte slice and absolute offset; no text normalization. A missing or ambiguous match remains unresolved. Verify source digest; Hub checks case ownership; the output is a preparation aid, not an accepted result.

Scope: `packs/skill/mindmap-format/tools/`, that pack's manifest and README; `packs/workflow/template-gap` manifest, SKILL.md and README; tests beside those tools and the minimum version expectations that name the changed pack. Both packs are bumped and signed by their owning tools. Existing parser and acceptance semantics remain unchanged.

The existing local-tools endpoint loads workflow methods only, so an installed parser-only skill cannot be downloaded. Extend its existing port in `hub/ports.ts`, `hub/runs/packs/ports.ts` and `hub/server/local-tools.ts` to serve tools from an installed skill to active users, preserving the current version/withdrawal checks and cache reauthorization. Add synthetic port and loopback HTTP tests. This is an affected port change: run the full checks required by decision 80.
