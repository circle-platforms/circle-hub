---
permalink: /design/en/
nav_order: 6
---

# circle-hub design

The design authority is the generic model in [contracts/model.json](https://github.com/circle-platforms/circle-hub/blob/main/contracts/model.json); the [generic model](generic-model.md) page summarises it, and where the two differ the model wins. The "Current" table holds the summary and the checklist; superseded design pages from the old server live in Git history. These pages translate the [Chinese originals](../README.md); where they differ, the Chinese text is authoritative. Implementation progress is in the [Hub r4 progress](../../hub-r4-progress.md).

## Current

| Document | What it answers |
|---|---|
| **[Generic model](generic-model.md)** | **73 elements in 11 groups, three invariants, the vocabulary, the seven kernel names, and what milestone 1 uses** |
| [Object standard: the five-element checklist](object-standard.md) | The four objects are the four homes; the five elements are a design checklist and a record-page layout, not storage partitions |

Two earlier principles still hold: determined content is given to scripts, and the rest is given to the model to judge and disclosed in full (ADR 0024); local cancel, remote stop and task delivery are recorded separately (ADR 0025).

## License

The architecture standards, design diagrams and terminology in the specifications listed above, and in their Chinese originals in the parent folder, are licensed under the [Creative Commons Attribution 4.0 International License (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).

Copyright (c) 2026 qingshanfeihu. Anyone who quotes, reuses, adapts or builds on these specifications, in a document, a product or another project, must keep a clear attribution to Circle Hub and qingshanfeihu, a link to the original at <https://github.com/circle-platforms/circle-hub/tree/main/docs/design>, a link to the CC BY 4.0 license, and a note of any changes made, as the license requires. A suitable attribution:

> Based on the Circle Hub design specifications by qingshanfeihu, <https://github.com/circle-platforms/circle-hub/tree/main/docs/design>, licensed under CC BY 4.0.

The license covers the specifications as texts and drawings. It grants no right to the Circle or Circle Hub names, the Circle logo or the application icons; see [NOTICE](https://github.com/circle-platforms/circle-hub/blob/main/NOTICE). The rest of `docs/` and the code are under the [Apache License 2.0](https://github.com/circle-platforms/circle-hub/blob/main/LICENSE).
