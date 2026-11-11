# B2 技能说明措辞

依据所有者 2026-11-12 任务书与同日勘定措辞，重写四份技能说明。流程使用用例重组、脚本编写、脚本合并、上机验证、失败分析；结论带原始用例 ID 加标题，状态、判断、原因和决定者使用勘定取值。模型填写的机器字段和引用留在代码部分，不转述给使用者。

范围：

- `packs/workflow/case-compile/SKILL.md`
- `packs/workflow/case-compile/recompose/SKILL.md`
- `packs/workflow/case-compile/tools/delivery.md`
- `packs/workflow/case-compile/tools/fidelity.md`
- `packs/workflow/case-compile/pack.test.ts` 的既有措辞断言
- 上述两包的 `pack.json`，由各自工具重新签名
- 本任务页

保留 A3 的原始用例与手册不一致处理、A5 的每条原始用例一个编写者及全部工具参数。主技能预算仍为 9630 字符。包版本由集成者统一处理；不改模型、代码表或工具行为。

唯一测试命令是 `node --test packs/workflow/case-compile/pack.test.ts`。其余检查由集成者按本次任务书执行。
