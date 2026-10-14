---
permalink: /design/en/
nav_order: 3
---

# circle-hub design

This is the design finalized on 2026-10-13. Later development and adaptation of existing capabilities follow it. Each document writes only decisions and reasons, and does not write implementation progress; implementation progress is in the [phase record](../../README.md#阶段记录). These pages are translations of the [Chinese originals](../README.md); where the two differ, the Chinese text is authoritative.

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
| [Permission policy export](permission-export.md) | The fourth harness-neutral item: hub-permission/1 computed from the scope role presets and the Tool annotations; a mapping table and sample configuration for Claude Code, Codex CLI, OpenCode, Gemini CLI and Cursor; what cannot be expressed, stated as such |
| [Harness format survey](harness-formats.md) | The on-disk formats of Skill / Command / Agent / Instruction / Hook / MCP server in Claude Code, Codex CLI, OpenCode, Gemini CLI and Cursor: paths, fields, what maps onto the neutral manifests and what does not, each with its source; the basis for the adapters and knownCompatible |

The rules from the two handoff documents (client-api-handoff, case-execution-handoff) have been merged into the documents above; the passage-by-passage mapping is in [handoff-map.md](handoff-map.md) (for trimming the handoffs into change records, not itself a design specification).

Two principles run through all of the documents, from earlier decisions: determined content is given to the script, and the rest is given to the model to judge and disclosed in full (ADR 0024); local cancel, remote stop, and task delivery are recorded separately (ADR 0025).

## License

The architecture standards, design diagrams and terminology in the specifications listed above, and in their Chinese originals in the parent folder, are licensed under the [Creative Commons Attribution 4.0 International License (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).

Copyright (c) 2026 qingshanfeihu. Anyone who quotes, reuses, adapts or builds on these specifications, in a document, a product or another project, must keep a clear attribution to Circle Hub and qingshanfeihu, a link to the original at <https://github.com/circle-platforms/circle-hub/tree/main/docs/design>, a link to the CC BY 4.0 license, and a note of any changes made, as the license requires. A suitable attribution:

> Based on the Circle Hub design specifications by qingshanfeihu, <https://github.com/circle-platforms/circle-hub/tree/main/docs/design>, licensed under CC BY 4.0.

The license covers the specifications as texts and drawings. It grants no right to the Circle or Circle Hub names, the Circle logo or the application icons; see [NOTICE](../../../NOTICE). The rest of `docs/` and the code are under the [Apache License 2.0](../../../LICENSE).
