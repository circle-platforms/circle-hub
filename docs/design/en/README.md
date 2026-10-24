---
permalink: /design/en/
nav_order: 6
---

# circle-hub design

The design authority is the generic model in [contracts/model.json](https://github.com/circle-platforms/circle-hub/blob/main/contracts/model.json); the [generic model](generic-model.md) page summarises it, and where the two differ the model wins. The "Current" table holds the summary, the checklist and a research proposal. The "Superseded" table holds design pages from the time of the old server; each one says at the top what replaced it, and they are kept as records only. These pages translate the [Chinese originals](../README.md); where they differ, the Chinese text is authoritative. Implementation progress is in the [Hub r4 progress](../../hub-r4-progress.md).

## Current

| Document | What it answers |
|---|---|
| **[Generic model](generic-model.md)** | **73 elements in 11 groups, three invariants, the vocabulary, the seven kernel names, and what milestone 1 uses** |
| [Object standard: the five-element checklist](object-standard.md) | The four objects are the four homes; the five elements are a design checklist and a record-page layout, not storage partitions |
| [Truth-Docked Architecture: Foundations, Conditional Claims, and a Product Research Framework](truth-docked-architecture.md) | Research proposal and mathematical audit: foundations, conditional claims and counterexamples, open obligations; not a description of an implementation |

## Superseded

| Document | What it answered | Where to look now |
|---|---|---|
| [Approvals and the enforcement chain](approvals-and-enforcement.md) | Change-set approvals, the enforcement chain, the error-code catalogue | Authorization records B04, publish check T02, boundary validation T03, the two mandatory boundaries P11 |
| [Roles and scope](roles.md) | Administrator / member / guest by scope, the two-person rule | Permission role R01 (user, administrator), visibility R02 |
| [Terms and states](vocabulary.md) | The old terms, state enumerations and colours | The model's vocabulary (generated into `contracts/generated/vocabulary.ts`) |
| [Levels and elements](levels-and-elements.md) | Five levels of interface in Circle | No Hub-specific interface in Circle; a read-only console (runs, knowledge, packs, system administration) |
| [Integration with Circle](circle-integration.md) | hub extending Circle's menus | Circle connects as an ordinary MCP client (D06) |
| [Product-line pack exemplar](product-line-pack.md) | The `product-line/1` pack | Task pack T01, publish record and publish check T02 |
| [Execution flows in product-line packs](execution-flow-packs.md) | Execution flows and `module-execute` | Effect writes, leases and executors (B06, D04, the write declarations of D03, the executor part of D07) are implemented by `hub/dispatch`; the read part of D03 and the resource part of D07 are implemented by the connectors package, and MCP annotations follow D03 |
| [Harness primitive specification](harness-primitives.md) | The neutral `hub-*/1` manifests and adapters | Six MCP tools (D06) and task packs (T01) |
| [Permission policy export](permission-export.md) | `hub-permission/1` | R01; tool categories follow the MCP annotations (D03, D06) |
| [Harness format survey](harness-formats.md) | On-disk formats of five harnesses (surveyed 2026-10-13) | No longer needed: the Hub does not import or export harness primitives |
| [Handoff-to-design map](handoff-map.md) | Where the two handoffs went in the design | Both handoffs are now historical records |

Two earlier principles still hold: determined content is given to scripts, and the rest is given to the model to judge and disclosed in full ([ADR 0024](https://github.com/circle-platforms/circle-hub/blob/main/references/platform/snapshot/docs/decisions/0024-truth-and-disclosure-principle.md)); local cancel, remote stop and task delivery are recorded separately ([ADR 0025](https://github.com/circle-platforms/circle-hub/blob/main/references/platform/snapshot/docs/decisions/0025-complete-product-task-delivery.md)).

## License

The architecture standards, design diagrams and terminology in the specifications listed above, and in their Chinese originals in the parent folder, are licensed under the [Creative Commons Attribution 4.0 International License (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).

Copyright (c) 2026 qingshanfeihu. Anyone who quotes, reuses, adapts or builds on these specifications, in a document, a product or another project, must keep a clear attribution to Circle Hub and qingshanfeihu, a link to the original at <https://github.com/circle-platforms/circle-hub/tree/main/docs/design>, a link to the CC BY 4.0 license, and a note of any changes made, as the license requires. A suitable attribution:

> Based on the Circle Hub design specifications by qingshanfeihu, <https://github.com/circle-platforms/circle-hub/tree/main/docs/design>, licensed under CC BY 4.0.

The license covers the specifications as texts and drawings. It grants no right to the Circle or Circle Hub names, the Circle logo or the application icons; see [NOTICE](https://github.com/circle-platforms/circle-hub/blob/main/NOTICE). The rest of `docs/` and the code are under the [Apache License 2.0](https://github.com/circle-platforms/circle-hub/blob/main/LICENSE).
