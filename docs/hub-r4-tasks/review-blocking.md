# 任务：R5 A4 评审阻断项

依据 `docs/hub-r5-brief.md` 工作项 A4 和所有者的评审分解报告。规程正本是 InfoTest 的 `test-list-review` 与 `review-verifier`，只按结构迁移，不运行或导入旧实现，不复制任何真实取值。

## 判定与边界

- 第 9 项是实现回归：`contracts/model.json` 已要求保留原文文本序列、禁止空白折叠，但核心 matcher 和 `quote@1` 仍折叠空白。严格逐字比对按所有者对 L16 的更正留在核心，不迁入技能包；普通表格的空白规范化不改。
- 第 13 项是期望落后：包内已有 P0–P7 和严重度区间数据及文字规程，但初评 `level` 没有检查，复核也未按最终仍成立的发现核区间。补结构检查，不按数量或关键词自动评级。
- 第 15 项是期望落后：核心已有 `predecessor: "required"` 机制，复核包未声明，导致可开出无法满足独立性的运行。
- 第 16 项是实现回归：规程已有“需要修正即 PARTIAL”，但 PASS 分支遗漏 `partial`。
- 第 18 项是期望落后：现有终稿只聚合回执已有块，未冻结完整识别参数和整份目标（根或显式子树）的预期条目集，因而不能证明未进入任何块的条目没有遗漏。由初评投影冻结范围，初评与复核的函数事实传递快照，终稿比较预期、交付、重叠和遗漏；不从文本猜。
- 第 20 项是实现回归：终稿规程已要求唯一结论和 gap 同等级，但实现只核第一条 verdict，且未核 gap rank。
- 第 14 项是期望落后（旧 fork 的迁移映射），不是核心实现回归：fork 只提供新上下文，不提供独立身份；继续比较观察会话、精确 `model_id` 和显式 `model_family_id`。缺声明保持 unknown，同会话、同模型或同族不独立，不从名称推族，不声称物理或密码学身份证明。

## 可改路径

- 本任务页。
- `contracts/src/tables.ts` 及生成器对应生成文件（只同步严格引文说明，不改模型）。
- `hub/refs/**`、`hub/rules/**` 中引文匹配、解释器、文档与测试。
- `hub/knowledge/feeding.ts`、`hub/knowledge/feeding.test.ts`：旧 `src` 范围引文的 UTF-8 字节切片及合成回归（同一严格引文契约）。
- `hub/server/submit-load.test.ts`：新增等级与范围检查对应的调用计数；60 秒预算和原有批处理断言不变。
- `scripts/real/gold/quote-widths.ts`、`scripts/real/gold/compile-check.ts` 中独立引文预言机及其合成测试；不运行真实脚本或系统。
- `scripts/real/lib/inject.test.ts`、`scripts/real/accept/defect-to-case-compare.test.ts` 中旧空白折叠预期，以及 `defect-to-case/publish.test.ts` 的版本断言；只改合成验证。
- `packs/workflow/case-review/**`、`packs/workflow/case-review-verify/**`、`packs/workflow/case-review-report/**`。
- `packs/workflow/defect-to-case/{pack.json,requirements.json,checks.json,tables/quotes.json}`、`packs/workflow/knowledge-contribution/{pack.json,pack-files.ts,README.md}` 及其官方命令生成的文件：仅同步核心严格引文的现行说明，历史版本记录不改。
- `tests/acceptance/**` 中评审链测试。

不改 `foundation/circle`、`references`、其他产品或工作包，不碰钥匙串、环境配置和真实系统。改包内文件时在同一个提交升版本并重签，提交只暂存显式路径，测试并发不超过 2。

## 验证

先保留相关测试基线：499 通过、0 失败、0 跳过。新增或调整合成样例覆盖仅空白不同的引文、严重度越界、缺前驱、PASS+partial、未交付和从未进入块的条目、非默认识别参数、多个终稿结论及 gap 等级。完成类型检查、相关包测试和评审验收，记录真实计数与跳过项。
