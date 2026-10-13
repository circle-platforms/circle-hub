# circle-hub design

This is the design finalized on 2026-10-13. Later development and adaptation of existing capabilities follow it. Each document writes only decisions and reasons, and does not write implementation progress; implementation progress is in the [phase record](../../README.md#阶段记录).

| Document | What it answers |
|---|---|
| [Object standard and data flow](object-standard.md) | Which five parts make up the four objects; how one piece of work passes through A C E B D; how a new capability fills in the adaptation sheet |
| [Terms and states](vocabulary.md) | The fixed Chinese–English terms; state enumerations and colors; the handling and display rules at scale |
| [Levels and elements](levels-and-elements.md) | The entry is a session; five levels, deeper one by one; which diagram, table, description, and buttons each level uses; twelve action words |
| [Approvals and the enforcement chain](approvals-and-enforcement.md) | Approval only on a Change set; a run goes through the Enforcement chain, and the only results are pass / error / unknown; the platform is not an approver |
| [Roles and scope](roles.md) | Administrator / member / guest granted by scope; the two-person rule; a sole administrator's own decision; machine identity |
| [Integration with Circle](circle-integration.md) | hub extends Circle's menu instead of opening another section; the sync model; what is not visible with only Circle installed |
| [Product-line pack exemplar](product-line-pack.md) | The deliverables for bringing one product line in: directory layout, adaptation sheet, acceptance checklist, with a synthetic product line as the sample |
| [Harness primitive specification](harness-primitives.md) | The primitives by which hub governs any harness: the governed / not-governed list, the neutral list, the import and export adapter for each harness, the generic transport with hub itself as an MCP server, and where the primitives sit in the four objects and five elements |

Two principles run through all of the documents, from earlier decisions: determined content is given to the script, and the rest is given to the model to judge and disclosed in full (ADR 0024); local cancel, remote stop, and task delivery are recorded separately (ADR 0025).
