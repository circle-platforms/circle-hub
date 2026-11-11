# 原始用例和手册冲突的收口

依据所有者 2026-11-12 任务书 A3，分支 `it-author-conflict`。审阅并收口已有改动，由集成者合并进 `infotest-pass-audit`。

可改路径：

- `packs/workflow/case-compile/functions/delivery.ts`
- `packs/workflow/case-compile/functions/author-conflict.test.ts`
- `packs/workflow/case-compile/functions/recompose-check.test.ts`
- `packs/workflow/case-compile/SKILL.md`
- `packs/workflow/case-compile/pack.json`
- `packs/workflow/case-compile/pack.test.ts`
- `packs/workflow/case-compile/recompose/SKILL.md`
- `packs/workflow/case-compile/recompose/pack.json`
- `packs/workflow/case-compile/recompose/tools/submit-records.test.ts`
- `packs/workflow/case-compile/tools/assemble-delivery.ts`
- `packs/workflow/case-compile/tools/assemble-delivery.test.ts`
- `packs/workflow/case-compile/tools/delivery.md`
- 本页

用例重组时由主代理向使用者集中询问原始用例和手册的冲突，已有裁定不再问。暂不编写的用例按原有字段保留原因和下一步。交付工具增加第四种收口，逐字核对原始用例和手册引文；冲突是否成立和如何处理由使用者决定。

本项只运行 `node --test packs/workflow/case-compile/tools/assemble-delivery.test.ts`。最终全量由集成者统一运行。不修改设计模型和代码表，不采集真实设备数据，不 push、不部署。
